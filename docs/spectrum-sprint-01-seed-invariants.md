# Sprint 1 spec — seed invariants gate

**Deliverable:** `tests/seed_invariants.test.ts`
**Production code changed:** none
**Estimate:** 0.5 day
**Depends on:** nothing. Blocks Sprints 4–6.

## Objective

Assert, over the shipped `seed/spectrum_plan.sql`, the structural properties the spectrum data should have had all along — and record today's known defects as an **exact baseline** rather than a tolerance.

Two jobs:

1. **Acceptance criteria for Sprints 4–6.** Findings #1, #2, #3 stop being prose and become failing assertions with known values. A sprint is done when its baseline entry can be deleted and the suite stays green.
2. **Regression gate for every future regeneration.** The seed is generated from a 29k-line YAML by a Python extractor against a gitignored PDF; nothing today would notice a newly mangled page in the diff.

`tools/extract-rrsp/audit.py` was intended as this gate, but `return 0 if suspicious < 200 else 1` tolerates ~200 bad rows and passes on the current data. It stays as an extraction-time triage tool; this suite is the shipped-data gate.

## Baseline mechanism

Each invariant computes the **set of violations** and asserts deep equality against a `KNOWN_DEFECTS` constant at the top of the file. Not a count, not a ceiling — the exact violating rows.

Consequences, both wanted:

- A **new** defect fails immediately, even if it's "no worse than before".
- **Fixing** a known defect also fails, until the corresponding baseline entry is deleted in the same commit. That deletion is the definition of done for Sprints 4–6.

Every entry carries the finding number and the sprint that clears it:

```ts
/** #3 — frequency.py joins arbitrary space-separated digit runs. Cleared by Sprint 4. */
const KNOWN_INVERTED_RANGES = [
    { table: 'spectrum_region_allocations', region: 3, freq_start_hz: 16121350000, freq_end_hz: 1626500000, page: 69 },
] as const;
```

Prefer `test.failing()` only where a violation genuinely can't be enumerated; everything below can be.

## Fixture loading

Follow `freshSpectrumDb()` in `tests/bootstrap_spectrum_plan.test.ts`: an in-memory DB built from `TABLE_METADATA` DDL for the five `spectrum_*` tables, then `db.exec(readFileSync(SEED_PATH))` directly — **not** via `bootstrapSpectrumPlan`, so the gate tests the data, not the loader. Load once in `beforeAll`; ~9k inserts into `:memory:` is well under a second, so this belongs in the fast `npm test` suite.

The seed carries its own `BEGIN TRANSACTION`/`COMMIT`, which is fine on a fresh connection outside a transaction (see finding #9 for when it isn't).

## Invariants

Measured against `seed/spectrum_plan.sql` at `c6a1f3e`.

### I1 — no inverted or empty ranges
`freq_end_hz > freq_start_hz` in both allocation tables.
**Status: FAILS.** AU: 0 violations. Region: 1 — `(region 3, 16121350000 → 1626500000, page 69)`, from raw `1 6121.35 – 1 626.5`. Finding #3, cleared by Sprint 4.

### I2 — every source page contributes rows
Each page in 31–112 appears in `spectrum_allocations` ∪ `spectrum_region_allocations`.
**Status: FAILS.** Missing: `[58]`. Finding #2, cleared by Sprint 4.

### I3 — AU allocations tile the spectrum
Sorted by `freq_start_hz`: each row's `freq_start_hz` equals the previous row's `freq_end_hz` (no gaps, no overlaps), first row starts at 0, last ends at 420 000 000 000 000 (420 THz).
**Status: FAILS.** One gap: `161987500 → 162037500` (a real VHF marine/land-mobile segment, collateral from the page-58 drop). Zero overlaps. Envelope is correct. Finding #2, cleared by Sprint 4.

Do **not** apply this to `spectrum_region_allocations` — R2/R3 have 58 and 52 legitimate-looking gaps that are an artefact of merged-cell attribution (finding #7), and asserting contiguity there would prejudge the Sprint 6 decision.

### I4 — service names are whole
No service name matches a fragment signal. Precedence-ordered, mutually exclusive, evaluated on the stored (uppercased) name:

| Kind | Test | AU | Region |
|---|---|---|---|
| `trailing-dash` | `/[–-]$/` | 306 | 167 |
| `unbalanced-paren` | `count('(') !== count(')')` | 205 | 122 |
| `leading-conjunction` | `/^(AND\|OR)\b/` | 14 | 1 |
| `bare-satellite` | name is exactly `SATELLITE` | 77 | 30 |

**Status: FAILS.** AU: 602 of 2045 service entries (29%) across 223 of 552 rows (40%). Region: 320 of 2161 (15%) across 119 of 810 (15%). Finding #1, cleared by Sprint 5.

Baseline these as a sorted list of `{table, freq_start_hz, freq_end_hz, region?, name, kind}` — not a count. The count alone would let Sprint 5 trade one fragment for another.

This is a heuristic, deliberately: it catches the mechanical damage without needing the ITU vocabulary. When Sprint 5 introduces that vocabulary, tighten I4 to "every service name is in the vocabulary" and drop the heuristic.

### I5 — footnote refs resolve
Every ref in `footnotes_json` and in `services[].inline_footnotes`, across both tables, exists in `spectrum_australian_footnotes` (refs matching `/^AUS/i`) or `spectrum_international_footnotes` (all others).
**Status: PASSES** — 733 distinct refs, 0 dangling. Pure regression guard.

### I6 — meta is complete and honest
`spectrum_plan_meta` contains `generation`, `source_title`, `published_date`, `pdf_sha256`, `imported_at`, `extractor_version`, `row_counts`; and `row_counts` matches the actual table counts.
**Status: PASSES** — `{"au_allocations":552,"region_allocations":810,"au_footnotes":52,"intl_footnotes":687}`, all correct.

Do not assert `last_patch_date` yet — the generator never writes it (finding #6). Add that assertion in Sprint 2, guarded on `seed/patches/` being non-empty.

### I7 — frequencies are within the plan envelope
All `freq_start_hz`/`freq_end_hz` in `[0, 420e12]` in both tables.
**Status: PASSES.** Catches unit-multiplier errors that I1 would miss (a GHz value parsed as Hz stays ordered).

## Test layout

```
describe('seed invariants', () => {
  beforeAll(loadSeedIntoMemory)
  test('I1 no inverted or empty ranges')
  test('I2 every source page 31-112 contributes rows')
  test('I3 AU allocations tile 0 Hz - 420 THz without gaps or overlaps')
  test('I4 no fragmented service names')
  test('I5 every cited footnote ref resolves')
  test('I6 meta keys present and row_counts accurate')
  test('I7 all frequencies within the plan envelope')
})
```

Failure messages must print the offending rows (table, range, page, name) — the whole point is that Sprint 4/5 can work straight from the output.

## Acceptance criteria

- `npm test` is green with the baseline in place.
- Every `KNOWN_*` entry names its finding number and clearing sprint in a doc comment.
- Deleting any baseline entry makes exactly one test fail, with a message that identifies the row.
- Temporarily corrupting the seed (e.g. flipping one `freq_end_hz`) makes exactly one test fail. Verify this by hand before calling the sprint done — a gate that can't fail is worse than no gate.
- No changes under `src/`, `scripts/`, `seed/`, or `tools/`.

## Out of scope

- Fixing any of #1/#2/#3 (Sprints 4–5).
- Retiring or retuning `audit.py`'s threshold (Sprint 4).
- Region contiguity assertions (blocked on the Sprint 6 decision).
- Anything touching the extractor or the PDF.

## Risks

- **The heuristic in I4 may flag a legitimate name.** Review the 602 + 320 flagged entries once while baselining; if a real service name trips a signal, narrow that signal rather than adding an exception.
- **Baseline churn.** Sprints 4–6 will each delete a large block. That's intended; the diff is the evidence the sprint worked.
