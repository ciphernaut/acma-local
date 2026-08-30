# Spectrum plan seed — provenance and reproduction

`seed/spectrum_plan.sql` is generated, never hand-edited. This document is the
chain from published law to shipped SQL: what the inputs are, how to reproduce
the output byte-for-byte, and every place the extractor departs from the source
text, with the evidence for each departure.

## Inputs

| Input | Identity | SHA-256 |
|---|---|---|
| Spectrum Plan PDF | `F2025C01105` — Compilation No. 1, 9 Oct 2025 | `5c22bd12…8edc59` |
| Service vocabulary | `docs/Table of Frequency Band Allocations xlsx.xlsx` | `adf935d5…1baa92e` |

Both hashes are recorded in `seed/spectrum_plan_source.yaml` under `meta` and in
the database itself in `spectrum_plan_meta` (`pdf_sha256`, `vocabulary`), so a
database can be traced to its inputs without the repo.

### The PDF

The *Australian Radiofrequency Spectrum Plan (2025 Update) 2021*, Compilation
No. 1, compiled 9 October 2025, incorporating amendment `F2025L01230`
(*Variation 2025 (No. 1)*, Schedule 1 items 1–259, giving effect to WRC-23).

- Compilation: <https://www.legislation.gov.au/F2025C01105>
- Series: <https://www.legislation.gov.au/Series/F2021L00617>

Instrument history — one principal instrument, one amendment:

| Instrument | Made | In force |
|---|---|---|
| `F2021L00617` — ARSP 2021 | 20 May 2021 | 24 May 2021 – 8 Oct 2025 |
| `F2025L01230` — Variation 2025 (No. 1) | — | Schedule 1, items 1–259 |
| `F2025C01105` — Compilation No. 1 | 9 Oct 2025 | current |

The PDF is **gitignored** (`docs/*.pdf`) because it is a large binary published
elsewhere. Download it from the compilation page above and check the hash before
extracting; the extractor prints the hash of whatever it was given.

The register's `/text` and `/downloadPdf` routes serve a single-page-app shell.
The machine-readable text of an instrument lives at:

```
https://www.legislation.gov.au/<ID>/asmade/<date>/text/original/epub/OEBPS/document_1/document_1.html
```

That is how `F2025L01230` was checked while investigating the errata below.

### The vocabulary spreadsheet

ACMA's own spreadsheet edition of the table, used **only** for the closed set of
ITU service names — never for allocations. It is the ARSP **2017** table (internal
mtime 2018-08-01; pre-WRC-19 boundaries, e.g. 51.4–52.6 GHz where the 2021 plan
has 51.4–52.4), so it is two editions behind current law. ACMA retired it in the
2019 CMS migration; the only surviving copy is a single Wayback capture of
24 March 2019, byte-identical to the file committed here:

The `?la=en` query string is part of the archived URL and the capture 404s without
it. Rather than trust a transcribed link, find the capture yourself:

```bash
curl -G http://web.archive.org/cdx/search/cdx \
  --data-urlencode "url=acma.gov.au/-/media/Spectrum-Engineering/Information/Spreasheet/Table-of-Frequency-Band-Allocations-xlsx.xlsx" \
  --data-urlencode "matchType=prefix" \
  --data-urlencode "fl=timestamp,original,statuscode,digest"
# 20190324125652 https://acma.gov.au/-/media/.../Table-of-Frequency-Band-Allocations-xlsx.xlsx?la=en 200 DLGCDJ4JR4FDJVDLRV5RV3MUORJIZRSB
```

Raw bytes (the `id_` modifier suppresses the archive's rewriting), which hash to the
`adf935d5…` pinned above:

```bash
curl -L -o check.xlsx \
  "https://web.archive.org/web/20190324125652id_/https://acma.gov.au/-/media/Spectrum-Engineering/Information/Spreasheet/Table-of-Frequency-Band-Allocations-xlsx.xlsx?la=en"
sha256sum check.xlsx
```

Its second role is as a **validation oracle**: 542 of ~550 of its band boundaries
match the 2021 seed, and 94% of the bands it shares with the current extraction
have identical service sets. The residual differences are WRC-19/23 changes
(EESS added across 40–50 MHz, AMS(R)S at 117.975–137 MHz, broadcasting removed at
7.1–7.2 MHz), which is the expected shape for a two-edition gap.

## Reproducing the seed

```bash
uv venv
uv pip install --python .venv -r tools/extract-rrsp/requirements.txt

# 1. Vocabulary (only needed if the spreadsheet changes)
.venv/bin/python tools/extract-rrsp/gen_vocabulary.py \
    "docs/Table of Frequency Band Allocations xlsx.xlsx"

# 2. PDF -> canonical YAML.  SOURCE_DATE_EPOCH pins the only non-deterministic
#    field (meta.extracted_at) so the output is byte-reproducible.
SOURCE_DATE_EPOCH=1760000000 \
    .venv/bin/python tools/extract-rrsp/extract.py docs/F2025C01105.pdf

# 3. YAML (+ any overlays in seed/patches/) -> SQL
npx tsx scripts/generate-spectrum-seed.ts

# 4. Verify
npm test -- tests/seed_invariants.test.ts
.venv/bin/python -m pytest tools/extract-rrsp/tests -q
```

Without `SOURCE_DATE_EPOCH` the run is still fully deterministic apart from
`meta.extracted_at` in the YAML and `imported_at` in the SQL.

### Expected output

| | rows |
|---|---|
| `au_allocations` | 558 |
| `region_allocations` | 1652 (R1 554, R2 552, R3 546) |
| `au_footnotes` | 54 |
| `intl_footnotes` | 727 |

Sections discovered: allocations pp. 17–106, Australian footnotes pp. 107–113,
international footnotes pp. 114–218. The run also reports, and these are expected:

- page 40 and page 89 have no unit banner — the previous page's unit is carried;
- page 37 has no column header — geometry is derived from the table's cell edges;
- page 89 has no column header — the previous page's geometry is carried;
- four source errata applied (below). **Every entry must fire**; one that does not
  is reported as a problem, because it means the source changed underneath it.

Nothing else should be reported. A page that yields no rows, a cell with no
parsable range, a service name outside the vocabulary, a coverage gap or a
duplicated band are all printed and all mean something needs looking at.

## Errata — where the seed departs from the source text

The source document contains four typographic errors. Each is corrected by an
explicit entry in `SOURCE_ERRATA` (`tools/extract-rrsp/extract.py`) that rewrites
one exact string on one page; nothing is inferred by pattern. The entries are
copied into `seed/spectrum_plan_source.yaml` and into `spectrum_plan_meta.errata`
so they are visible to anyone holding only the data.

**The parsing rules were deliberately not loosened to absorb these.** Widening the
frequency grammar to accept `1 6121.35` is exactly how that value became a 16 GHz
band in the previous generation: a silent misparse is worse than a loud rejection.

### 1. Page 57 — `1 6121.35 – 1 626.5` → `1 621.35 – 1 626.5`

The Region 3 cell of the 1 621.35–1 626.5 MHz row (Iridium/MSS). Regions 1 and 2
and the Australian column **on the same row** all read `1 621.35 – 1 626.5`.

Under the previous grammar this parsed as 16 121.35 MHz → 1 626.5 MHz — an
inverted range spanning most of the table. It is now rejected outright, so
without the erratum Region 3 would simply be absent across the band.

### 2 and 3. Page 37 — two stacked cells both reading `40.98 – 41.105`

The ITU column has two consecutive cells whose first line is identical. They are
distinguished by content: one contains `Space research` and footnotes `160 161`,
the other contains footnote `161A`.

- with `Space research` → `40.98 – 41.015`
- with `161A` → `41.015 – 42`

Evidence, all inside the 2025 document:

- **Footnote 161A, which the second cell cites**, reads "the frequency bands
  **41.015**–41.665 MHz and 43.35–44 MHz". 41.015 is a real boundary named in this
  document, and it is the lower bound of the band that cites it.
- **`41.105` occurs exactly once in the whole compilation** — this row. It is not a
  boundary anywhere else.
- The band that follows in reading order is `42 – 44`, so the second cell must end
  at 42.

Corroborated independently by the 2021 edition (`F2021L00617` p51), which has
`40 980 000–41 015 000` with footnotes 160/161 and a Space research entry, and
`41 015 000–42 000 000` with footnotes 160/161/161A and none — matching the two
cells service-for-service and footnote-for-footnote, which is what pins each
corrected range to its cell.

**The error originates in the law as made, not in the compilation's typesetting.**
The amending instrument `F2025L01230` carries the same `40.98 – 41.105` twice and
never mentions 41.015. Uncorrected, the ITU column states one band twice and
leaves 41.105–42 MHz with no allocation shown in any region.

### 4. Page 105 — footnote `49` → `149`

The 247.2–248 GHz ITU cell cites footnote `49`, which does not exist in this plan
(international refs begin at 53), so it fails the "every cited footnote resolves"
invariant. The Australian column on the same row cites `149`, as does every
neighbouring row in the block (241–242.2, 242.2–244.2, 244.2–247.2). Footnote 149
is the radio-astronomy protection footnote, which is what this band is allocated
for. A dropped leading `1`.

## What guards this

- `tests/seed_invariants.test.ts` — eight invariants over the **shipped** seed:
  no inverted ranges, every allocation page contributes rows, AU allocations tile
  0 Hz–420 THz with no gap or overlap, no fragmented service names, every cited
  footnote resolves, meta present and row counts accurate, no service text lost
  from the frequency line, all frequencies within the envelope. Each asserts the
  **exact set** of violations against a baseline, so a new defect fails even if it
  is "no worse than before", and *fixing* a known defect fails until its baseline
  entry is deleted in the same commit. All baselines are currently empty.
- `tools/extract-rrsp/tests` — 41 unit tests over the joining, matching and
  grammar rules.
- The extractor's own end-of-run report, described above.

`tools/extract-rrsp/audit.py` was retired: its heuristic passed on data with ~200
bad rows (`return 0 if suspicious < 200 else 1`).

- `npm run check:doc-links` — every URL cited in the docs must resolve. Provenance
  is only worth something if a reader can follow it, and a citation that 404s is
  indistinguishable from an invented one. This repo shipped exactly that: the
  Wayback link above was transcribed without its `?la=en` query string, so it
  returned 404 while the capture behind it was real and byte-identical. Needs
  network, so it is not in `npm test`; run it after editing docs.
