# RRSP Extractor

> Provenance, the reproduction recipe, expected row counts, and the source-document
> errata with their evidence: [`docs/spectrum-provenance.md`](../../docs/spectrum-provenance.md).

Parses the Australian Radiofrequency Spectrum Plan (PDF) into
`seed/spectrum_plan_source.yaml`. This YAML is the canonical source for the
`spectrum_*` SQLite tables; the SQL seed is generated from it.

Section page ranges are discovered from page text, so the extractor is not tied
to one edition — but the errata below are, since they name exact strings on exact
pages.

## Source PDF

- Compilation: `F2025C01105` (Compilation No. 1, 9 Oct 2025, incorporating
  `F2025L01230` / WRC-23) — <https://www.legislation.gov.au/F2025C01105>
- SHA256: `5c22bd127b930fb85ad52ce5e9b8a039976d400edd07ec87488c51aeda8edc59`
- The PDF is not committed to this repository. Download it locally before running,
  and check the hash — the extractor prints the hash of whatever it is given.

The previous baseline, ARSP 2021 as made (`F2021L00617`, SHA256
`074e71a752eaa86ffaca002401849baf5018dc07647330a6f4d5796321375aa4`), ceased to be
in force on 8 October 2025.

## Run

Python packages are managed with [uv](https://docs.astral.sh/uv/).

```bash
uv venv                                   # from the repo root
uv pip install --python .venv -r tools/extract-rrsp/requirements.txt

.venv/bin/python tools/extract-rrsp/extract.py docs/<source>.pdf
# Writes ../../seed/spectrum_plan_source.yaml
```

The run reports everything it could not handle cleanly — pages with no unit banner
or column header, cells with no parsable frequency range, service names outside the
vocabulary, coverage gaps and duplicated bands, and each `SOURCE_ERRATA` entry that
fired or failed to fire. Nothing is dropped silently. `audit.py` (a line-count
heuristic that tolerated ~200 bad rows) was retired in favour of this reporting plus
the shipped-data gate in `tests/seed_invariants.test.ts`.

The service vocabulary is generated, not hand-written:

```bash
.venv/bin/python tools/extract-rrsp/gen_vocabulary.py \
    "docs/Table of Frequency Band Allocations xlsx.xlsx"
```

## Tests

```bash
pytest tests/ -v
```
