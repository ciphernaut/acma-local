# Extraction Rules for ACMA Frequency Allocation Tables

The PDF layout is irregular and requires a set of rules to transform the raw table data into the YAML schema.

## 1. Page Selection
- Allocation tables: physical pages **31–112** (inclusive).
- Australian footnotes: pages **112–119**.
- International footnotes: pages **120–214**.
- Each allocation page starts with a unit header (`kHz`, `MHz`, or `GHz`).

## 2. Table Structure
The Part 2 table on each page has two main columns:
- **Column 1: ITU Radio Regulations Table of Allocations** — split into three sub-columns: Region 1, Region 2, Region 3.
- **Column 2: Australian Table of Allocations** — the AU surface (primary for our use).

Each table cell may contain multiple lines: a frequency sub-range (bold), one or more service names (ALL CAPS for primary, Title Case for secondary), parenthetical qualifiers, and trailing or inline footnote refs.

## 3. Frequency Range Extraction
- Standard form: `8.3 – 9` (en-dash; sometimes hyphen). Regex: `(\d+(?:[\s ]?\d+)*(?:\.\d+)?)\s*[–-]\s*(\d+(?:[\s ]?\d+)*(?:\.\d+)?)`.
- `Below X` → `(0, X)` in the unit of the page header.
- Numbers may contain thousands separators (space or NBSP), e.g. `1 606.5`.

## 4. Service Decomposition (from a cell)
- ALL CAPS line ⇒ primary service.
- Title Case (e.g. `Fixed`, `Maritime mobile`) ⇒ secondary service.
- Parenthetical content attached to the previous service ⇒ qualifier (e.g. `(radiobeacons)`, `(Earth-to-space)`).
- Numeric / `AUS\d+\w*` tokens at the end of a service line ⇒ inline footnotes for that service.
- Numeric / `AUS\d+\w*` tokens on their own line at the bottom of the cell ⇒ cell-level footnotes (apply to the whole cell).

## 5. Per-Region vs AU
- AU rows go into `au_allocations` in the YAML.
- Region 1/2/3 cells produce one row each in `region_allocations`. Their sub-range boundaries DO NOT have to match AU. A horizontally-merged cell that spans, say, R1+R2 produces one row per region it covers (each row carries the same content).

## 6. Footnotes — Australian (pages 112–119)
- Lines starting with `AUS\d+\w*` begin a new footnote.
- Continuation lines (no AUS-prefix match) append to the current footnote's text.
- Drop running header/footer lines: `Part 3*`, `Australian Radiofrequency Spectrum Plan 2021`, and pure-page-number lines (`^\s*\d+\s*$`).

## 7. Footnotes — International (pages 120–214)
- Lines starting with a numeric / alphanumeric token (`\d{1,3}[A-Z]{0,2}`) begin a new footnote.
- Continuation handling same as §6.
- Drop the same running headers/footers.
- The international footnotes also include grouping/section intro lines (e.g. `5.1A`) interleaved among the numbered refs — preserve these as their own footnote entries verbatim.

## 8. Token Normalisation
- Footnote refs uppercase: `aus49` → `AUS49`.
- Existing case in the actual numeric/alpha suffix preserved: `67A` stays `67A`, never `67a`.
- Whitespace inside numbers (`1 606.5`) stripped when computing `freq_*_hz`, preserved in `raw`.
