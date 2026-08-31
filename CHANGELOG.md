# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **KML exports load as real GIS layers.** Attributes are now emitted as `ExtendedData` against a typed `Schema`, so OGR — and therefore QGIS — exposes them as filterable, styleable fields. Previously every value lived inside the HTML `<description>` balloon and a GIS saw only `Name` and `Description`; verified with `ogrinfo`. Whole-number columns are typed `int`, numeric `float`, the rest `string`.
- **`export_kml` takes a `flavour`** — `earth` (default, unchanged: HTML popup plus attributes) or `qgis`, which omits the popup. A GIS reads attributes from `ExtendedData` and shows the balloon markup as a large useless `Description` field; dropping it cut a 189-site export from 624 KB to 240 KB.
- **`npm run check:doc-links`** verifies that every URL cited in the documentation resolves. Provenance is only useful if a reader can follow it, and a citation that 404s cannot be told apart from an invented one.

### Fixed
- **KML attribute values were truncated at 200 characters** with an ellipsis, silently losing the tail of long lists — 4 cells in a 189-site export, including licence-number lists. Values are now written in full, and XML metacharacters are escaped in `ExtendedData`.
- **The Wayback citation for the vocabulary spreadsheet 404'd.** It was transcribed into `docs/spectrum-provenance.md` without its `?la=en` query string. The capture itself is real — re-verified as HTTP 200, 170,453 bytes, SHA-256 `adf935d5…`, byte-identical to the committed file — but the link as published could not be followed. Replaced with the archive CDX query that finds the capture plus the raw `id_` download, so the source can be located without trusting a transcribed URL.

### Changed
- **`execute_sql` and `export_kml` docs now cover the three traps that bite in practice** (fetched via `describe_tool`): don't terminate a query with a semicolon; always check `truncated`, because the 500-row cap is hard, has no pagination, and silently shortens any `export_kml` built from that result (aggregates are computed inside SQLite and are never truncated, so `SELECT COUNT(*)` sizes a result set safely); and `export_kml` takes each placemark title from a column named `NAME`, so aliasing it away leaves every placemark titled "ACMA Site".

### Fixed
- **`execute_sql` no longer rejects a query whose string literal contains a semicolon.** The multiple-statement guard was `wrapped.includes(';')`, which does not respect quoting, so `SELECT CASE WHEN x=0 THEN 'note; here' END` failed with "Multiple SQL statements are not allowed." Replaced with `hasStatementSeparator()`, which skips single-quoted strings (including `''` escapes), `"`/`` ` ``/`[]` quoted identifiers, and `--` / slash-star comments, and flags only a separator outside all of them. A real `SELECT 1; DROP TABLE …` is still rejected.
- **Two built-in sample queries were unrunnable.** "Most common modulation type across all devices" and "All FM analogue telephony devices" ended with a trailing `;`, so `list_sample_queries` advertised queries `execute_sql` refused — and which would have been a syntax error regardless once wrapped in `SELECT * FROM (...) LIMIT n`. A test now asserts every sample query passes the validator.
- The scanner is inlined in `src/sql_worker.ts` and `src/sql_worker.cjs` (the worker cannot import from `src/sql.ts`; ESM resolution differs between `tsx` and `dist/`). A test compares the three copies with types, comments and whitespace normalised, so the standing drift hazard fails loudly instead of silently.


## [1.11.0] - 2026-08-30

> **Upgrading.** The spectrum plan data is replaced wholesale: the baseline moves from
> the ARSP 2021 as made (`F2021L00617`, which ceased to be in force on 8 October 2025)
> to compilation `F2025C01105` (9 October 2025, incorporating `F2025L01230` / WRC-23).
> Existing databases must run `npm run import-spectrum-plan -- --reseed`; a database
> upgraded from 1.9 or earlier needs it in any case, since `get_frequency_allocation`
> now detects the legacy schema and says so. No RRL data is affected.

### Added
- **`LOG_LEVEL` env var** (`error` / `warn` / `info` (default) / `debug`). All in-source logging goes through `src/logger.ts`; lower levels suppress noisier ones. `DEBUG_NETWORK` kept as a legacy alias.
- **Richer `/health` endpoint** — now returns JSON with `status`, `version`, `dataAsOf`, `lastSyncAt`, `remoteAsOf`, `behindByHours`, `isSyncing`. Optional `?deep=1` parameter opens the DB read-only and runs a probe SELECT; responds 500 / `status: degraded` if the DB is unreachable.
- Logger has its own test suite (`tests/logger.test.ts`, 4 cases).

### Changed
- ~40 `console.error('[X] ...')` call sites across `src/sync.ts`, `src/spectrum_plan.ts`, `src/index.ts`, and `src/import_spectrum_plan.ts` rewritten to `log.info` / `log.warn` / `log.error`. Message text and `[CHANNEL]` prefixes preserved so existing `grep` muscle memory still works.
- `DEBUG_NETWORK=true` no longer needs a special check at the call site — it now flows through the logger's level threshold.

### Added
- **`docs/spectrum-provenance.md`** — the chain from published law to shipped SQL: inputs and their SHA-256s, the reproduction recipe, expected row counts and expected warnings, and each of the four typographic errors in the source document with the evidence for its correction.
- **The rebuild is byte-reproducible.** `meta.extracted_at` was the only non-deterministic field; `SOURCE_DATE_EPOCH` now pins it, so two runs over the same PDF produce identical YAML and identical SQL.
- **Provenance travels with the data.** `spectrum_plan_meta` now also carries `source_url`, `source_compilation`, `source_principal_instrument`, `source_amending_instruments`, `source_series_url`, `toolchain` (Python and pdfplumber versions), `vocabulary` (source path, name count, SHA-256), `sections` (the discovered page ranges), and `errata` — every correction applied to the source text with its reasoning. Anyone holding only the database can see which instrument it came from and where it departs from that instrument, without this repo. Asserted by invariant I6.

### Fixed
- **Region-scoped overlay patches produced invalid SQL.** `region` is written at the operation level (as `seed/patches/README.md` documents) but belongs on the row, so a `replace_allocation` whose `new:` block omitted it reached the generated file as the literal `VALUES(undefined, ...)` — a seed that generates cleanly and fails only when SQLite executes it. `region` is now carried onto the row, accepted at the operation level for `insert_allocation` too, and validated as 1-3. Every interpolated field of an overlay row is checked first, so a missing `page` or an inverted range now fails generation with a message naming the field.
- **`--reseed` is atomic.** It previously dropped and recreated the spectrum tables *before* the generated SQL was known to load, so a bad seed emptied a working database. The drop and the load now share a savepoint and roll back together.
- **A malformed patch no longer poisons `seed/patches/`.** `--patch` copied the overlay in before generation ran; a bad file then broke every later generation, including the bootstrap path, until someone deleted it by hand. The copy is reverted if generation fails.
- **`--reseed` no longer regenerates the tracked seed as a side effect** — it applies the committed `seed/spectrum_plan.sql`. Pass `--patch` (or run `scripts/generate-spectrum-seed.ts`) to regenerate.
- **`last_patch_date` is now written** to `spectrum_plan_meta`, taken from the last applied overlay's `source.published_date` or its `YYYY-MM-DD` filename prefix. It was never emitted, so `source.last_patch_date` was always `null` and `get_frequency_allocation`'s "last patched" warning branch was unreachable.
- **`get_frequency_allocation` on a pre-1.10 database** now returns a "run `--reseed`" message instead of a raw SQLite `no such column` error. The emptiness guard passed (legacy rows are present), so the lookup fell straight through to columns that do not exist there. Affects every install upgraded from 1.9 without a full sync.
- **Seed loads run inside a SAVEPOINT**, with the seed file's own `BEGIN`/`COMMIT` stripped first (`bootstrapSpectrumPlan`, `applyReseed`, `import-spectrum-plan --reseed`). A load that failed part-way previously left the transaction OPEN on the connection, silently rolling back the emission-table bootstrap that shares it in `performFullSync`.
- **`npm test -- <file>` now selects that file.** `--testPathIgnorePatterns` is a yargs array option and was greedily consuming the trailing positional, so the named file was *ignored* and every other suite ran — reporting green for a file that never executed. The script now ends with `--`.
- `scripts/generate-spectrum-seed.ts` resolves its repo root via `fileURLToPath` rather than `URL.pathname`, which percent-encodes: any repo path containing a space failed to locate the source YAML.
- **The extractor no longer drops content silently.** A page whose unit banner was unreadable was skipped outright (`if not unit: continue`), losing 161.9875–162.0375 MHz; the unit is now carried forward from the previous page. Section page ranges are discovered from page text instead of hardcoded, the allocation section is taken as a contiguous span so continuation pages without the column header are not lost, and column geometry is derived from the table's own cell edges when the label row is absent. Every page, cell, and service name the run could not handle cleanly is now reported at the end of the run.
- **Wrapped service names are rejoined (#1).** `parse_cell` treated every line as a separate service, so `RADIONAVIGATION–` / `SATELLITE (space-to-` / `Earth)` became three services, and `primary` was computed on the fragment — reporting a *primary* GPS L1 allocation as secondary. Lines are now joined on four signals (trailing dash, unclosed parenthesis, lowercase or parenthetical continuation, and vocabulary prefix) and matched against a closed 31-name ITU service vocabulary. 922 fragmented entries across 40% of rows are gone; whatever follows the matched name becomes a `qualifier`.
- **The service on the frequency line is no longer discarded (#16).** `_build_allocation_row` parsed the range out of the first line and threw the line away, but a merged cell packs the range and first service together (`1 710 – 1 930 FIXED`). 327 of 810 region rows lost a service — usually the band's primary — and many shipped `services: []`, which reads as "not allocated".
- **Merged ITU cells populate every region they span (#7).** A cell merged across Regions 1–3 was attributed to Region 1 alone, so Region 3 was missing ~65% of its allocations and `regions[3]` came back `null` — indistinguishable from "no allocation in that region". Cells are now mapped to columns by rectangle overlap. Region row counts go from 810 (R3 largely absent) to 554 / 552 / 546 with no coverage gaps.
- **Frequency grammar tightened (#3).** Thousands groups must be exactly three digits and `end > start` is enforced, so the render artefact `1 6121.35 – 1 626.5` is rejected rather than silently read as 16 121.35 MHz → 1 626.5 MHz. Four typographic errors in the source document are corrected through an explicit, individually-justified `SOURCE_ERRATA` table; each entry must fire, and the run reports any that does not.
- **Footnote extraction fixes.** The running-header pattern was pinned to `Spectrum Plan 2021`, so the compilation's footer bled into 112 footnote texts and page-bottom document notes entered the table as footnotes 2, 3, 4, …; refs are now gated on font size (12 pt vs the 6.5 pt superscript) and the pattern is edition-agnostic. Refs set hard against their text (`228AAThe use of…`) are matched as a word prefix, recovering 228AA/228AB/286AA and friends, and a candidate whose remainder does not begin a sentence is rejected, which removes the false starts inside multi-column band lists.
- **`tests/get_frequency_allocation.test.ts` creates its indexes.** `for (const idx of (meta as any).indexes ?? [])` iterated a property that does not exist — `TABLE_METADATA` exposes `post_load_ddl`, a string — so the range index the lookup depends on was never created in the test DB, and the `as any` hid it from the type checker.
- **`npm run test:integration` no longer appears to hang.** The suite spawns the server via `npx`, which forks `node` as a grandchild; `serverProcess.kill()` signalled only the `npx` wrapper, leaving the server holding port 3001 so jest never exited ("Jest did not exit one second after the test run has completed"). The tests had already passed in ~8 s, but the command sat for minutes and left an orphan listening on 3001. The server is now spawned `detached` and torn down by process group.
- `tools/extract-rrsp/audit.py` retired: its line-count heuristic passed on data with ~200 bad rows (`return 0 if suspicious < 200 else 1`), and line joining now makes raw-lines-vs-services a meaningless ratio. The extractor's own reporting and `tests/seed_invariants.test.ts` cover it precisely.
- ITU region lookup sorts before `LIMIT 1` instead of returning an arbitrary overlapping row.
- Remaining `console.error` diagnostics in `src/spectrum_plan.ts` and `src/import_spectrum_plan.ts` routed through `src/logger.ts`, completing the 1.9.0 conversion.


## [1.10.0] - 2026-05-15

### Changed
- Rebuilt the `spectrum_*` data from the 2021 ACMA Radiofrequency Spectrum Plan PDF. The canonical source is `seed/spectrum_plan_source.yaml`, extracted from the PDF via `tools/extract-rrsp/extract.py`. `seed/spectrum_plan.sql` is generated from the YAML by `scripts/generate-spectrum-seed.ts`.
- `spectrum_allocations` schema: `freq_start_hz` + `freq_end_hz` (composite PK), `unit`, `page`, `services_json`, `footnotes_json`, `raw`. Legacy columns dropped (`frequency_range`, `region1`, `region2`, `region3`, `common`, `australian_table_of_allocations`, `footnote_ref`).
- New table `spectrum_region_allocations` stores ITU Region 1/2/3 allocations independently of AU sub-range boundaries.
- `get_frequency_allocation` response shape: `allocation` (AU primary, nullable) + `regions` (R1/R2/R3 contrast, each nullable) + `resolved_footnotes` (flat AU+intl text map). `source` carries `published_date` + `last_patch_date`.

### Added
- Patch overlay format under `seed/patches/*.yaml`. See `seed/patches/README.md` for the operation set.
- `scripts/generate-spectrum-seed.ts` composes YAML + overlays into SQL.
- `tools/extract-rrsp/` — Python extractor for the 2021 ACMA Spectrum Plan PDF.

### Upgrade notes
Existing databases need a re-bootstrap of the spectrum tables:

```
npm run import-spectrum-plan -- --reseed
```

## [1.9.0] - 2026-05-15

### Added
- `decode_emission_designator` MCP tool — parse the ITU/ACA emission designator stored in `device_details.EMISSION` into structured fields (bandwidth, modulation, signal nature, info type, optional signal-detail + multiplex).
- `search_devices_by_emission` MCP tool — find devices/licences by decoded descriptor (modulation, info type, signal nature, etc.). Accepts code letters or description substrings; ambiguous matches return an explicit candidate list.
- Five lookup tables (`emission_modulation`, `emission_signal_nature`, `emission_info_type`, `emission_signal_detail`, `emission_multiplex`) with the full code alphabet from the ACA "Emission characteristics of radio transmissions" booklet (ITU worldwide standard, 1982). Auto-bootstrapped on full sync from `seed/emissions.sql`.
- `npm run import-emissions` / `npm run dump-emissions` scripts for reseeding and regeneration from `CODE_TABLES`.
- Two sample queries (`list_sample_queries`) demonstrating SUBSTR joins against `emission_modulation`.

### Changed
- Tool count 16 → 18; table count 26 → 31.

### Upgrade notes
- The new `emission_*` tables are auto-populated by the next full sync. To seed them immediately on an existing database without triggering a sync, run `npm run import-emissions`.

## [1.8.0] - 2026-05-14

### Added
- **Spectrum-plan integration.** Embedded the Australian Radiofrequency Spectrum Plan (ARSP) as a lookup-only dataset alongside the RRL mirror:
  - 4 new tables: `spectrum_allocations` (with `freq_start_hz`/`freq_end_hz` range index), `spectrum_australian_footnotes`, `spectrum_international_footnotes`, `spectrum_plan_meta`.
  - Canonical seed file `seed/spectrum_plan.sql` committed to git (548 allocations, 52 AU footnotes, 498 international footnotes from the ARSP 2018 baseline). Auto-applied at the tail of `performFullSync` when spectrum tables are empty.
  - New MCP tool **`get_frequency_allocation(freq_hz)`** returning matching allocations, joined AU + international footnotes, source provenance, and a staleness warning when the base data is ≥ 3 years old.
  - New CLI: `npm run import-spectrum-plan -- --reseed [--source <path>]`, `-- --patch <path>`, and `npm run dump-spectrum-plan`. Supports `.sql` dumps and legacy `.db` source schemas with automatic frequency-range normalisation.
- **CI workflow** at `.github/workflows/test.yml` — matrix-tests on Node 18/20/22 with `npm ci`, `npm run build`, and `npm test` on every push and PR to `main`.
- **`engines.node >= 18`** declared in `package.json`.
- **Graceful shutdown** on `SIGTERM` / `SIGINT`: closes MCP transports, finishes in-flight HTTP requests, hard-exits via 30s watchdog if stuck.
- **`npm run test:integration`** for the network end-to-end suite; **`npm run test:all`** for both.

### Changed
- **`npm test`** now runs the fast 153-test suite by default (was: the whole suite including the flaky network integration tests). `NODE_OPTIONS='--experimental-vm-modules'` is now set in the script — bare `npm test` used to error out on ESM imports.
- **`initializeDatabase()`** is now called at the start of both the MCP server (`src/index.ts`) and the spectrum-plan CLI (`src/import_spectrum_plan.ts`). Existing DBs synced under older releases automatically gain newer tables without manual intervention.
- **README** refreshed to cover all 16 MCP tools, both transports (stdio + Streamable HTTP/SSE on `:3000`), the spectrum-plan workflow, and the patch-amendment loop.

### Fixed
- **`parseFrequencyRange`** open-ended branch — `'1-' GHz` now correctly returns `freq_start_hz = 1_000_000_000` (was: always the 3 THz sentinel).
- **`applyReseed`** is now atomic (savepoint-wrapped) so a mid-load failure rolls back to the prior state. NULL `unit` source rows are skipped with a warning instead of silently defaulting to MHz.
- **Source DB schema mismatch** — the legacy ARSP `.db` uses uppercase unit tokens (`KHZ`, `MHZ`, `GHZ`) and `ref` / `text` footnote columns. `parseFrequencyRange` is now case-insensitive on units; `copyFromSourceDb` reads the real column names.
- **`sql_worker.cjs`** — CTE/`WITH` queries now accepted by the worker thread (was silently rejected; the matching fix to `src/sql.ts` shipped in 1.7.0 but the CJS mirror was missed).

### Security
- **`npm audit fix`** resolved 11 vulnerabilities: 1 critical (`handlebars`, transitive), 5 high (including direct `axios` — multiple SSRF / prototype-pollution / DoS CVEs), 5 moderate. All non-breaking lockfile updates within existing semver ranges; no direct dependency changes.

## [1.7.0] - 2026-05-14

### Added
- **Sync migration to ACMA's `/v1/Extracts` manifest API** (replacing the legacy `web.acma.gov.au` 3-URL pipeline of `spectra_rrl.zip` + `datetime-of-extract.txt` + `.rrl_update`).
  - Pure decision function `decideSyncAction(asOf, manifest, mode, lastSync, now)` returning a discriminated `SyncAction` (`noop` | `full` | `incremental` | `gap-exceeded`). 12-hour cooldown; never auto-pulls the 70 MB full extract on `mode='auto'`.
  - Per-mode meta timestamps: `last_full_sync`, `last_incremental_sync`, surfaced through `sync_data`'s response.
- **Schema expansion (T1–T4) — 17 new tables.**
  - **T1 — 10 ACMA lookup tables:** `client_type`, `fee_status`, `industry_cat`, `licence_service`, `licence_subservice` (composite PK), `licence_status`, `nature_of_service`, `class_of_station`, `licensing_area`, `antenna_polarity`. JOINed by `src/logic.ts` for human-readable names in search results.
  - **T2 — Broadcasting:** `bsl` + `bsl_area`, with the `search_bsl` MCP tool.
  - **T3 — Spectrum auth:** `auth_spectrum_freq` (4-col composite PK), `auth_spectrum_area` (2-col composite PK), and the `search_spectrum_band(freq_hz)` tool with NULL-safe overlap.
  - **T3 — Satellite:** `satellite` table; surfaced in `get_licence_details`.
  - **T4 — Application narrative:** `applic_text_block` (~168 MB), `reports_text_block`, and an **FTS5 virtual table** `applic_text_block_fts` over `APTB_TEXT`. Rebuilt during full sync; incrementally maintained.
  - **T4 — `search_application_text(query)`** MCP tool backed by FTS5.
- **SQL backend hardening (matterfront hydration pattern).**
  - `execute_sql` accepts CTEs (`WITH ... SELECT`); runs in a worker thread inside a `BEGIN…ROLLBACK` sandbox.
  - **`describe_schema(tables?)`** introspects columns + indexes + row counts.
  - **`describe_tool(name)`** returns full markdown documentation; `tools/list` now carries lean one-line summaries (matterfront pattern).
  - `list_sample_queries` categorised (6 categories) and paginated.
  - Contextual **`_hints`** in every search/detail result, pointing at the natural next tool to call.
  - **`explain_query(sql)`** wrapper over `EXPLAIN QUERY PLAN`.
  - `ANALYZE` runs at the tail of full sync to refresh query-planner statistics.
- **Schema drift tolerance** — `importCsv` and `applyCsvDiff` now filter unknown CSV columns via `PRAGMA table_info`; logs `[SYNC] foo: skipping N unknown CSV column(s)` instead of failing.
- **`BslAreaId` column** added to the `licence` table (ACMA pushed it mid-sprint).
- **`DATE_ISSUED` / `DATE_OF_EFFECT` / `DATE_OF_EXPIRY`** columns added to `auth_spectrum_freq`.

### Changed
- `device_details` change-zips arrive as `device_detail.csv` (singular); the full extract uses `device_details.csv` (plural). `csvToTable` handles the alias.
- Author rewritten on the migration commit range from in-session OS identity to `Sage Grigull <ciphernaut@proton.me>`; all `Co-Authored-By: Claude` trailers removed.

### Documentation
- New `CLAUDE.md` covering the architecture, three-timestamp model, decision-table semantics, project gotchas, and environment variables.
- Process / planning artefacts moved out of `docs/` and into `docs/superpowers/` (gitignored).

## [1.6.x and earlier]

Pre-manifest pipeline against `https://web.acma.gov.au/offline-rrl/...`. Core schema of 5 tables (`client`, `licence`, `site`, `device_details`, `antenna`) and the original MCP tool surface (`search_*`, `get_*_details`, `sync_data`).
