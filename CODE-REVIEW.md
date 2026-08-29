# Code review — spectrum-plan rebuild (v1.10.0)

**Scope:** `111b97b..HEAD` (the 17-commit `spectrum-rebuild` series; `origin/main` is already at HEAD, so the range diff against upstream was empty).
Files reviewed: `src/spectrum_plan.ts`, `src/db.ts`, `src/import_spectrum_plan.ts`, `src/index.ts`, `scripts/generate-spectrum-seed.ts`, `tools/extract-rrsp/*.py`, plus the generated `seed/spectrum_plan_source.yaml` / `seed/spectrum_plan.sql` and the new tests.

**Method:** read every hunk, then loaded `seed/spectrum_plan.sql` into a real SQLite database under the new DDL to validate the shipped data. The seed applies cleanly (552 AU allocations, 810 region allocations, 52 AU footnotes, 687 international footnotes, no duplicate PKs, every cited footnote ref resolves) — but the contents have several verifiable defects, listed below.

---

## High

### 1. One-service-per-line parsing corrupts 216 of 552 AU rows (39%)
`tools/extract-rrsp/cell_parser.py:65`

`parse_cell` treats every non-footnote line as a separate service, but the PDF wraps long service names across lines.

Concrete: 1 559–1 610 MHz (contains GPS L1, 1575.42 MHz) has raw text

```
1 559 – 1 610
AERONAUTICAL
RADIONAVIGATION
RADIONAVIGATION–
SATELLITE (space-to-
Earth) (space-to-space)
208B 328B 329A
341 AUS87 AUS103
```

and produces five "services": `AERONAUTICAL`, `RADIONAVIGATION`, `RADIONAVIGATION–`, `SATELLITE (SPACE-TO-`, `EARTH)`.

Worse, `primary` is computed on the pre-uppercase fragment (`_is_primary(name)` is called before `name.upper()`), so `SATELLITE (space-to-` evaluates to `primary: false` — a **primary** ITU allocation is reported to the user as secondary.

398 of 2045 AU service entries are fragments; 216 of 552 rows are affected. `get_frequency_allocation` surfaces this verbatim.

### 2. A whole PDF page is silently dropped; page 58 is missing from the seed
`tools/extract-rrsp/extract.py:84`

`_page_unit` only scans the first 5 lines for a bare `kHz`/`MHz`/`GHz` token and returns `None` otherwise; the page is then skipped by `if not unit: continue` with no warning or counter.

Physical page 58 has **zero** rows in both `spectrum_allocations` and `spectrum_region_allocations` (pages 57 and 59 are present), leaving a hole at **161.9875–162.0375 MHz** — a real VHF marine / land-mobile segment. A lookup at 162.0 MHz returns `match_count: 0` and "No allocation found in the Australian Radiofrequency Spectrum Plan", which is wrong, not merely missing.

`_build_allocation_row` returning `None` on parse failure (line 62) and `for row in tbl[2:]` (line 93) drop rows the same way, with no diagnostic to detect it.

### 3. Thousands-separator parsing joins arbitrary digit runs; no `end > start` validation anywhere
`tools/extract-rrsp/frequency.py:7`

`_RANGE_PATTERN` accepts `\d+(?:\s\d+)*` and `_strip_thousands` removes all whitespace, so the render artefact `1 6121.35 – 1 626.5` parsed as 16 121.35 MHz → 1 626.5 MHz.

The shipped seed contains:

```
spectrum_region_allocations(region=3, freq_start_hz=16121350000, freq_end_hz=1626500000)
```

Any query in 1 621.35–1 626.5 MHz (Iridium / MSS) misses its Region 3 row entirely, and the row is unreachable at 16.12 GHz as well.

The TypeScript twin `parseFrequencyRange` (`src/spectrum_plan.ts:73`) *does* throw on `end < start` — but it is now dead code. The Python path has no such guard, and neither does the generator nor the DDL.

### 4. Region-scoped overlay ops emit `VALUES(undefined, …)`
`scripts/generate-spectrum-seed.ts:122`

`seed/patches/README.md` documents `replace_allocation` with `region: 3` at the **op** level and a `new:` block without `region`. `applyOverlay` (lines 74–80) puts that object into `region_allocations`, and line 122 interpolates `${a.region}` → the literal string `undefined`.

The generator writes the file happily; the failure surfaces later as a SQLite syntax error when the seed is executed. `insert_allocation` (line 83) reads `region` from `op.new` while replace/delete read it from `op` — the two are inconsistent, and no test covers a region-scoped overlay. Nothing validates overlay-supplied fields (`page`, `unit`, numeric bounds) before interpolation.

### 5. `--reseed` drops the spectrum tables before the generated SQL is proven loadable
`src/import_spectrum_plan.ts:75`

`resetSpectrumTables(db)` runs, then `db.exec(sql)`. If the SQL is malformed (see #4) or the file is missing, the tables have already been dropped and recreated empty, and the process exits with the spectrum data gone from a previously working DB.

Combined with #4 this is reachable via the exact upgrade path in the CHANGELOG. Load into temp tables, or wrap drop+load in a SAVEPOINT.

---

## Medium

### 6. `last_patch_date` is never written — always `null`, even after overlays
`scripts/generate-spectrum-seed.ts:145`

`metaPairs` emits `generation`, `source_title`, `published_date`, `pdf_sha256`, `imported_at`, `extractor_version`, `row_counts` — no `last_patch_date`. Overlay `meta` (`patch_id`, `source.published_date`) is discarded entirely.

`readSourceMeta` (`src/spectrum_plan.ts:263`) reads that key and `src/index.ts:1053` branches on it, so the "last patched X" warning is unreachable and every response claims the plan is "not patched" no matter how many overlays were applied.

### 7. Merged ITU cells make `regions[2]` / `regions[3]` null, presented as "no allocation"
`tools/extract-rrsp/extract.py:104`, `src/spectrum_plan.ts:235`

When the PDF merges a row across regions, pdfplumber yields text only in the leading column, so the content lands in `region_allocations` as region 1 and R2/R3 get nothing. Region 2 has 58 range gaps; region 3 has 52.

At 2 400 MHz, R1 and R2 return rows and R3 returns `null` even though the ITU table does allocate that band in Region 3. The tool doc (`src/index.ts:305`) sells `regions` as "R1/R2/R3 contrast", so a null reads as a genuine regional difference. Either propagate merged cells to all three regions, or add an explicit `inherited_from` / `same_as_region_1` marker.

### 8. An un-reseeded 1.9 DB throws a raw SQLite error instead of the friendly message
`src/index.ts:1037`

`initializeDatabase` uses `CREATE TABLE IF NOT EXISTS`, so an existing 1.9 database keeps the legacy `spectrum_allocations` columns **and** its rows. The guard only checks `COUNT(*) === 0`, so it passes, and `lookupFrequencyAllocation` then fails with `no such column: services_json`, which propagates out of the handler as a JSON-RPC error.

This is the state of every upgraded install until a full sync or a manual reseed. Call `spectrumSchemaIsLegacy(db)` here and return the existing "Run `npm run import-spectrum-plan -- --reseed`" message.

### 9. The seed's own `BEGIN`/`COMMIT` now runs verbatim; a mid-file failure leaks an open transaction
`src/spectrum_plan.ts:148`

`applyReseed` used to strip `BEGIN TRANSACTION` / `COMMIT` and wrap the load in a SAVEPOINT. `bootstrapSpectrumPlan` now `db.exec`s the file as-is.

If it throws (see #4), the error is swallowed by the catch but the transaction stays open, and `bootstrapEmissionTables(bsDb, …)` — called on the **same** connection at `src/sync.ts:502` — has its inserts rolled back when the connection closes. A bad spectrum seed silently leaves the emission decoder tables empty too.

### 10. The patch file is copied into `seed/patches/` before it is validated
`src/import_spectrum_plan.ts:58`

`fs.copyFileSync(patchArg, dest)` runs first; the generator then throws on a malformed overlay (`Footnote X not found`, `already exists`, bad YAML). The bad file is now permanently in `seed/patches/`, so every subsequent `generate-spectrum-seed` run — including the one inside the `bootstrapSpectrumPlan` data path — fails until the operator manually deletes it. Generate to a temp dir first, or remove the copy on failure.

### 11. Plain `--reseed` unconditionally rewrites the git-tracked `seed/spectrum_plan.sql`
`src/import_spectrum_plan.ts:64`

The CHANGELOG's upgrade instruction (`npm run import-spectrum-plan -- --reseed`) shells out to `npx tsx scripts/generate-spectrum-seed.ts` even with no `--patch`, so a user who only wants to load the committed seed gets a rewritten tracked file — plus a hard runtime dependency on `tsx`, `js-yaml`, and the 29k-line YAML. Regenerate only when `--patch` was supplied.

---

## Low

### 12. `new URL(import.meta.url).pathname` instead of `fileURLToPath`
`scripts/generate-spectrum-seed.ts:162`

Any repo path containing a space or non-ASCII character yields a percent-encoded path, and `readFileSync` fails with ENOENT on `seed/spectrum_plan_source.yaml`. `src/import_spectrum_plan.ts:24` and `src/sync.ts:497` both use `fileURLToPath` correctly; this one is the odd one out.

### 13. Test iterates a property that does not exist
`tests/get_frequency_allocation.test.ts:20`

`for (const idx of (meta as any).indexes ?? [])` — `TABLE_METADATA` entries expose `post_load_ddl`, not `indexes`, so the loop is always empty and the range indexes are never created in the test DB. The `as any` cast hides it from the type checker. Harmless today, but it silently disables the only test-side coverage of the index the lookup depends on.

### 14. Region lookup uses `LIMIT 1` with no `ORDER BY`
`src/spectrum_plan.ts:235`

The AU query orders by `freq_start_hz, freq_end_hz` and counts matches; the region query takes an arbitrary row and reports no overlap warning. Given the inverted range in #3, region rows are demonstrably not guaranteed non-overlapping, so this can return a different row across runs or after a vacuum.

### 15. `console.error` reintroduced in a module converted to `log.*` in 1.9.0
`src/spectrum_plan.ts:132`

The 1.9.0 changelog records ~40 `console.error` sites in this exact file rewritten to the logger. This new legacy-schema message bypasses `LOG_LEVEL` and cannot be suppressed. Same pattern at `src/import_spectrum_plan.ts:59` and `:63`.

---

## Notes (verified OK, no action)

- `seed/spectrum_plan.sql` applies cleanly against the new DDL — no duplicate primary keys in any of the five tables, so dropping the `INSERT OR REPLACE` crutch in `c6a1f3e` holds.
- Every footnote ref cited by an allocation (733 distinct) resolves against the AU/international footnote tables — zero dangling refs.
- AU allocations are contiguous and non-overlapping apart from the single page-58 gap in #2.
- The half-open lookup interval (`? >= freq_start_hz AND ? < freq_end_hz`) matches the plan's band-boundary convention; only an exact query at the 420 THz upper limit falls outside, which is not a practical concern.
- `fs.copyFileSync(src, src)` when a patch already lives in `seed/patches/` is safe — libuv short-circuits same-inode copies before truncating.
