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
| 4 | Extractor rewrite — sections, ranges, services, merges | #2 #3 #1 #16 #7 | 2–3 d | S1, PDF | no |
| 5 | Oracle invariant — agree with the ACMA spreadsheet | — | 0.5 d | S1, S4 | no |
| 6 | Regenerate, triage diff, release 1.11.0 | — | 0.5 d | all | no |

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


## Source document change (2025 compilation)

`docs/F2025C01105.pdf` is **not** the 2021 baseline. It is:

> Australian Radiofrequency Spectrum Plan (**2025 Update**) 2021 — Compilation No. 1,
> compilation date 9 October 2025, including amendment F2025L01230, registered 26/11/2025.
> SHA-256 `5c22bd127b930fb85ad52ce5e9b8a039976d400edd07ec87488c51aeda8edc59`, 221 pages.

The YAML pins `074e71a7…` (the 2021 original), so this supersedes the baseline rather than reproducing it — it is the current law, and better data than what ships today.

**Rebasing to it is a product decision, not just a bug fix.** Consequences:

- `meta.generation` goes to 3; the shipped allocations change wholesale.
- Every Sprint-1 baseline (I1–I8) is keyed to the *current* seed and resets. The invariants stop being characterisation baselines and become straight pass/fail on real properties — the intended endgame, but it means **extractor fixes can no longer be verified by a clean seed diff**: legislative changes and parser fixes would arrive in the same diff. If the 2021 PDF can be obtained, extract it first with the fixed extractor to separate the two effects; otherwise verification rests on the invariants plus band spot-checks.
- `published_date` becomes 2025-10-09, so `get_frequency_allocation`'s ≥3-year staleness warning correctly stops firing.
- Overlays in `seed/patches/` reset against the new generation (there are none today).

### The hardcoded page ranges are all wrong for it

| Section | `extract.py` assumes | Actual in F2025C01105 |
|---|---|---|
| Allocation tables | 31–112 | **17–106** |
| Australian footnotes | 112–119 | **107–113** |
| International footnotes | 120–214 | **114–218** |

Running the extractor as-is against this PDF would read AU-footnote pages as allocation tables. Sprint 4 must **discover** the sections from page text, not hardcode them — which is the same "never skip silently" theme as #2.

### Measured merge behaviour (623 rows, pages 17–106)

| Shape | Rows |
|---|---|
| One cell spanning R1–R3 (R1 holds the text, R2/R3 `None`) | **404 (65%)** |
| Row with its own R3 cell | 114 |
| Row with an empty AU cell (vertical merge candidate) | 68 |
| Row with an empty R1 cell | 72 |

The current extractor attributes every merged cell to region 1 alone, so **R3 is missing about 65% of its allocations** — the mechanism behind #7, and why 2 400 MHz returns `regions[3]: null`.

The same probe shows why #16 splits by column: in a merged row R1 packs the range and first service onto one line (`'1 710 – 1 930 FIXED\nMOBILE 384A…'`) while the AU cell puts them on separate lines (`'1 710 – 1 930\nFIXED\n…'`). Both forms occur, so the fix must split the range prefix off the first line and fall through to the next line when the remainder is empty.

### Decision — region semantics (resolved)

`regions[n] === null` is a **bug, not a contract**. The measurement above settles it: 65% of rows are a single cell spanning R1–R3, so the nulls are dropped data, not "no allocation in that region". Horizontal merges propagate the merged content to every region they span; vertical merges propagate down the frequency rows they cover. The response shape is unchanged and `src/index.ts:305`'s "R1/R2 contrast" wording stays accurate — the field simply becomes correct. No `same_as_region_1` marker.

### Toolchain

Python packages are managed with **uv**; `uv` reaches PyPI from this environment, so Loop B is unblocked:

```bash
uv venv && uv pip install --python .venv -r tools/extract-rrsp/requirements.txt
```

The source PDF stays out of git (`.gitignore`), with its SHA-256 pinned in the YAML `meta` block, per existing convention.

## Decisions — all resolved

1. **Rebase to the 2025 compilation — yes.** `F2021L00617` ceased to be in force on 8 October 2025, so the shipped seed states superseded law; that makes the rebase forced rather than optional. The verification cost is covered by the oracle below: a seed diff hunk is either in `F2025L01230`'s 259 amendment items, in the spreadsheet's agreement set, or a parser bug.
2. **Service reconstruction — vocabulary-driven.** The closed vocabulary is no longer something to hand-write: the oracle's `Service Name` column supplies all 30 names, already normalised. Greedily join lines while the result is a prefix of a known name. Fixes #1 and the `primary` misclassification together; #16 falls out of the same range-prefix split.
3. **Region null semantics — propagate merges** (see above).
4. **Version — 1.11.0, not 1.10.1.** The underlying law changed, not just the parser.

## Validation oracle — `docs/Table of Frequency Band Allocations xlsx.xlsx`

ACMA's own spreadsheet edition of the table: 1,566 rows, one per (band, service), with an explicit `Status` column (PRIMARY/secondary), direction qualifiers split into `Additional Notes`, and footnote refs per row. 549 bands, zero overlaps, zero fragmented names — it is the structured form the extractor has been trying to reconstruct, and it covers 161.9875–162.0375 MHz (the band lost with the page-58 skip) and gives GPS L1 as a single correct primary `RADIONAVIGATION - SATELLITE` row.

**It is not a source.** Internal mtime 2018-08-01, pre-WRC-19 boundaries (51.4–52.6 GHz where the 2021 seed has 51.4–52.4), so it is the ARSP 2017 table — one edition behind the baseline, two behind current law. ACMA retired it in the 2019 CMS migration; the Wayback Machine holds a single capture (24 March 2019) byte-identical to the copy in `docs/`, and there are no other revisions to diff.

**It is an oracle.** 542 of ~550 band boundaries already match the 2021 seed. Where the extractor and the spreadsheet agree on a band untouched by WRC-19/23, the parse is right; where they disagree, it is either a real legislative change or a parser bug — a far smaller set to triage than a 29k-line seed diff. Its `Footnote lookup` sheet (2,381 applicability rows over 709 refs, 873 service-scoped, with R1/R2/R3/Aus flags) has no equivalent in the seed at all.

## Instrument history

| Instrument | Made | In force |
|---|---|---|
| `F2021L00617` — ARSP 2021 | 20 May 2021 | 24 May 2021 – 8 Oct 2025 |
| `F2025L01230` — Variation 2025 (No. 1) | — | Schedule 1, items 1–259 (WRC-23) |
| `F2025C01105` — Compilation 1 | 9 Oct 2025 | current |

## Hotfix path

If 1.10.1 can't wait for the data work: Sprint 3 alone is shippable in half a day and fixes the upgrade break (#8), and Sprint 2's #5/#10 remove the destructive-reseed footgun. Both are code-only — no seed regeneration, no PDF.
