# RRSP 2021 Extractor

Parses the Australian Radiofrequency Spectrum Plan 2021 (PDF) into
`seed/spectrum_plan_source.yaml`. This YAML is the canonical source for the
`spectrum_*` SQLite tables; the SQL seed is generated from it.

## Source PDF

- URL: <https://www.acma.gov.au/sites/default/files/2021-07/Australian%20Radiofrequency%20Spectrum%20Plan%202021_Including%20general%20information.pdf>
- SHA256: `074e71a752eaa86ffaca002401849baf5018dc07647330a6f4d5796321375aa4`
- The PDF is not committed to this repository. Download it locally before running.

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
