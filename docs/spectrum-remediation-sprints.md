# Spectrum plan remediation — sprint plan

Source of work: `CODE-REVIEW.md` (15 findings against the v1.10.0 `spectrum-rebuild` series, `111b97b..c6a1f3e`).

## Context

v1.10.0 is already on `main`, so this is follow-up remediation, not a PR gate. Two findings are user-visible today:

- **#8** — every install upgraded from 1.9 hits `no such column: services_json` on `get_frequency_allocation` until someone runs a reseed.
- **#1 / #3** — the shipped seed reports primary allocations as secondary (40% of AU rows carry at least one mangled service name) and drops a VHF marine segment. Wrong answers from the tool whose job is answering "what is this frequency allocated to".

## Two fix loops

The findings split into two groups with different tooling, different languages, and different verification:

| | Loop A — code | Loop B — data |
|---|---|---|
| Findings | #4 #5 #6 #8 #9 #10 #11 #12 #14 #15 | #1 #2 #3 #7 |
| Files | `scripts/generate-spectrum-seed.ts`, `src/*.ts` | `tools/extract-rrsp/*.py` |
| Verify with | `npm test` | re-extract → regenerate → diff seed |
| Needs the PDF | no | **yes** (gitignored; SHA-256 pinned in `seed/spectrum_plan_source.yaml` `meta.pdf_sha256`) |

They touch disjoint files, so Loop A and Loop B can run in parallel once Sprint 1 lands.

## Sprints

| # | Sprint | Findings | Est. | Depends on | Blocked by a decision? |
|---|---|---|---|---|---|
| 1 | Seed invariants gate ✅ | — | 0.5 d | — | no |
| 2 | Generator & CLI correctness ✅ | #4 #5 #6 #10 #11 | 1 d | S1 | no |
| 3 | Runtime & upgrade path ✅ | #8 #9 #12 #14 #15 | 0.5 d | — | no |
| 4 | Extractor arithmetic & page coverage | #3 #2 | 0.5 d | S1, PDF | no |
| 5 | Service reconstruction | #1 #16 | 1–2 d | S1, S4, PDF | **yes** |
| 6 | Region semantics | #7 | 0.5–1 d | S1, PDF | **yes** |
| 7 | Regenerate, validate, release 1.10.1 | — | 0.5 d | all | no |

Total ≈ 5 days sequential; ≈ 3.5 with Loop A and Loop B in parallel.

**Status:** Sprints 1-3 are done on `fix/spectrum-remediation` (Loop A complete). Sprints 4-7 remain and need `pip install pdfplumber` plus the source PDF.

### Sprint 1 — Seed invariants gate

Spec: `docs/spectrum-sprint-01-seed-invariants.md`.

A characterization test over the shipped `seed/spectrum_plan.sql` that asserts the properties the data should have had all along, with today's known defects recorded as an explicit baseline. Turns #1/#2/#3 into machine-checkable acceptance criteria for Sprints 4–6 and stops any *new* defect from riding in on a regenerated seed. No production code changes.

This goes first because its absence is why all of this shipped. `tools/extract-rrsp/audit.py` was meant to be this gate, but `return 0 if suspicious < 200 else 1` tolerates ~200 bad rows and passes on the current data.

### Sprint 2 — Generator & CLI correctness

- **#4** carry `region` through `replace_allocation`/`delete_allocation` into the emitted SQL; reconcile the op-level vs `new`-level `region` inconsistency; validate overlay-supplied rows before interpolation (numeric bounds, required fields) instead of emitting `undefined`.
- **#6** emit `last_patch_date` from overlay `meta`, so the "last patched X" branch at `src/index.ts:1053` stops being dead code.
- **#5** load the generated SQL into temp tables (or a SAVEPOINT) and swap on success, so a bad generation can no longer empty a working DB.
- **#10** generate to a tempdir; only copy the patch into `seed/patches/` once generation succeeds.
- **#11** regenerate the tracked seed only when `--patch` was supplied.

#4 and #5 compound — a region-scoped overlay today produces `undefined` SQL *and* wipes the tables on the way through — so land them together. Add the region-overlay test case that Sprint 1's suite doesn't cover (`tests/generate-spectrum-seed.test.ts` currently exercises AU ops only).

### Sprint 3 — Runtime & upgrade path

- **#8** call `spectrumSchemaIsLegacy(db)` in the `get_frequency_allocation` handler and return the existing "run `--reseed`" message instead of letting a raw SQLite error escape.
- **#9** strip `BEGIN`/`COMMIT` from the seed before `db.exec`, or wrap the load in a SAVEPOINT, so a failed spectrum bootstrap stops silently rolling back the emission-table bootstrap that shares the connection.
- **#12** `fileURLToPath` in `scripts/generate-spectrum-seed.ts`.
- **#14** `ORDER BY` on the region lookup.
- **#15** logger instead of `console.error`.

Smallest sprint, highest user-visible payoff (#8). Independent of Sprint 2 — different files, no shared state.

### Sprint 4 — Extractor arithmetic & page coverage

- **#3** require thousands groups to be exactly three digits (`\d{1,3}(?:\s\d{3})*`) so `1 6121.35` stops parsing as 16 121.35 MHz; raise on `end <= start` the way the TypeScript `parseFrequencyRange` already does.
- **#2** stop `continue`-ing past a page whose unit line is unreadable — carry the last-seen unit forward or infer it from row magnitude, and **fail the run** with a list of skipped pages rather than silently dropping them. Same treatment for `_build_allocation_row` returning `None` and the unconditional `tbl[2:]` header skip.

Clears the Sprint 1 baseline entries for inverted ranges, page 58, and the AU contiguity gap.

**Do not simply anchor the range regex.** The obvious fix for #3 — require thousands groups of exactly three digits and match the whole line — rejects 381 of the 1041 distinct first lines in the current seed, because the ITU region columns pack the range and the first service onto one line (`'1 164 – 1 215 AERONAUTICAL RADIONAVIGATION 328'`). Measured, not assumed.

The correct shape is to split the range *prefix* off the first line and hand the remainder to `parse_cell` along with the other lines — which is also the fix for #16. So #3 and #16 share a fix site: do the split first (Sprint 5), then tighten the numeric grammar against the isolated prefix, where anchoring is safe and `1 6121.35` can be rejected outright rather than silently reinterpreted.

### Sprint 5 — Service reconstruction

**#1** and **#16**, the big one. Needs a design decision (below) before implementation.

**#16** (found during Sprint 4 prep, see CODE-REVIEW.md): `_build_allocation_row` assumes the frequency range occupies its own line and parses services from `parts[1:]`. In the ITU region columns pdfplumber usually packs the range and the first service onto one line, so that service — normally the band's primary — is discarded. 327 of 810 region rows lose one; many ship `services: []`. Fix: split the range off the first line and feed the remainder to `parse_cell` with the other lines. Baselined as invariant I8.

Both are about reconstructing a cell's services from its lines, so they share a fix site and should land together.

The obvious heuristics don't cover the observed cases: "a line ending in `–` joins the next" handles `RADIONAVIGATION–` + `SATELLITE`, but not `STANDARD FREQUENCY` + `AND TIME SIGNAL`, which is all-caps with no continuation marker. Recommended approach: greedily join lines while the result remains a prefix of a name in the closed ITU service vocabulary (~40 names). That also fixes the `primary` misclassification for free, because classification then runs on the joined name rather than on a lowercase fragment (`_is_primary` is currently called before `name.upper()`).

Alternative: geometry-based continuation detection from pdfplumber word positions — more general, fiddlier, no vocabulary to maintain.

### Sprint 6 — Region semantics

**#7**. A product decision, not a bug fix: when the PDF merges a row across regions, pdfplumber yields text only in the leading column, so `regions[2]`/`regions[3]` come back `null` and read as "no allocation in that region" (e.g. 2 400 MHz R3). Either propagate merged cells to all three regions (needs cell-span geometry, response shape unchanged) or keep the nulls and add an explicit marker plus a docs correction at `src/index.ts:305`.

### Sprint 7 — Regenerate, validate, release

Re-extract → bump `EXTRACTOR_VERSION` and YAML `meta.generation` → regenerate SQL → **read the seed diff**. It will be large, so confidence comes from Sprint 1's invariants plus a spot-check of known bands: FM (87.1 MHz), GPS L1 (1575.42 MHz), 2.4 GHz ISM, the 162 MHz marine gap, the 1 621 MHz MSS row. Then 1.10.1 with a changelog note that existing DBs need `--reseed` again.

## Decisions needed

1. **Sprint 5** — vocabulary-driven line joining, or geometry-driven? Vocabulary is more robust for this document and gives the `primary` fix for free; geometry generalises to future editions.
2. **Sprint 6** — does `regions[n] === null` mean "no ITU allocation" or "merged with Region 1"? This is a tool-contract change either way.
3. **Sprint 7** — ship the data fix as 1.10.1, or hold for a re-extraction against a newer ACMA edition if one exists?

## Hotfix path

If 1.10.1 can't wait for the data work: Sprint 3 alone is shippable in half a day and fixes the upgrade break (#8), and Sprint 2's #5/#10 remove the destructive-reseed footgun. Both are code-only — no seed regeneration, no PDF.
