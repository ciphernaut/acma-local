"""Extract the 2021 ACMA Spectrum Plan PDF to a canonical YAML.

Usage: python extract.py <path/to/pdf>

Reads pages 31–112 (allocations), 112–119 (Australian footnotes),
120–214 (international footnotes). Writes ../../seed/spectrum_plan_source.yaml.
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import sys
from datetime import datetime, timezone

import pdfplumber
from ruamel.yaml import YAML

from cell_parser import parse_cell
from footnotes import is_running_header
from frequency import parse_range

EXTRACTOR_VERSION = "1.0.0"

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT_YAML = REPO_ROOT / "seed" / "spectrum_plan_source.yaml"

ALLOCATION_PAGES = range(30, 112)    # physical 31–112
AU_FOOTNOTE_PAGES = range(111, 119)  # physical 112–119; page 112 intentionally appears in both (split page)
INTL_FOOTNOTE_PAGES = range(119, 214) # physical 120–214


def _sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _page_unit(page) -> str | None:
    text = page.extract_text() or ""
    for line in text.splitlines()[:5]:
        token = line.strip().lower()
        if token == "khz":
            return "kHz"
        if token == "mhz":
            return "MHz"
        if token == "ghz":
            return "GHz"
    return None


def _build_allocation_row(cell_text: str, unit: str, page: int) -> dict | None:
    parts = [p.strip() for p in cell_text.splitlines() if p.strip()]
    if not parts:
        return None
    first = parts[0]
    rest = "\n".join(parts[1:])
    try:
        start, end = parse_range(first, unit)
    except ValueError:
        return None
    parsed = parse_cell(rest)
    return {
        "freq_start_hz": start,
        "freq_end_hz": end,
        "unit": unit,
        "page": page,
        "services": parsed["services"],
        "footnotes": parsed["footnotes"],
        "raw": cell_text,
    }


def _extract_allocations(pdf) -> tuple[list[dict], list[dict]]:
    au_rows: list[dict] = []
    region_rows: list[dict] = []

    for page_num in ALLOCATION_PAGES:
        page = pdf.pages[page_num]
        unit = _page_unit(page)
        if not unit:
            continue
        tables = page.extract_tables()
        for tbl in tables:
            # pdfplumber replicates both header rows on every page: row 0 is
            # the column group labels ("Column 1: ITU Radio Regulation" etc.)
            # and row 1 is the sub-labels ("Region 1", "Region 2", …, "Australian
            # Table of Allocation").  Verified against page indices 30–32 and 105
            # (sampled kHz, MHz, and GHz band pages).  Skip both unconditionally.
            for row in tbl[2:]:
                if not any(row):
                    continue
                cells = (list(row) + [None] * 4)[:4]
                r1_cell, r2_cell, r3_cell, au_cell = cells

                if au_cell and au_cell.strip():
                    au_row = _build_allocation_row(au_cell, unit, page_num + 1)
                    if au_row:
                        au_rows.append(au_row)

                for region_idx, cell in enumerate([r1_cell, r2_cell, r3_cell], start=1):
                    if cell and cell.strip():
                        region_row = _build_allocation_row(cell, unit, page_num + 1)
                        if region_row:
                            region_row["region"] = region_idx
                            region_rows.append(region_row)

    return au_rows, region_rows


def _extract_footnotes(pdf, page_range, *, is_australian: bool) -> list[dict]:
    if is_australian:
        ref_pattern = re.compile(r"^(AUS\d+[A-Z]*)(.*)$")
    else:
        ref_pattern = re.compile(r"^(\d{1,3}[A-Z]{0,2})\s+(.+)$")

    all_results: list[dict] = []
    current_ref: str | None = None
    current_buf: list[str] = []
    current_page: int | None = None

    def flush() -> None:
        if current_ref is not None and current_buf:
            text = " ".join(part.strip() for part in current_buf if part.strip())
            all_results.append({"ref": current_ref, "text": text, "page": current_page})

    for page_num in page_range:
        page = pdf.pages[page_num]
        text = page.extract_text() or ""
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if is_running_header(stripped):
                continue
            m = ref_pattern.match(stripped)
            if m:
                flush()
                current_ref = m.group(1)
                rest = m.group(2).strip()
                current_buf = [rest] if rest else []
                current_page = page_num + 1
            else:
                if current_ref is not None:
                    current_buf.append(stripped)
    flush()
    return all_results


def main(pdf_path: pathlib.Path) -> None:
    print(f"Reading: {pdf_path}")
    pdf_sha = _sha256(pdf_path)
    print(f"SHA256:  {pdf_sha}")

    with pdfplumber.open(pdf_path) as pdf:
        au_rows, region_rows = _extract_allocations(pdf)
        au_fns = _extract_footnotes(pdf, AU_FOOTNOTE_PAGES, is_australian=True)
        intl_fns = _extract_footnotes(pdf, INTL_FOOTNOTE_PAGES, is_australian=False)

    doc = {
        "meta": {
            "generation": 2,
            "source": {
                "title": "Australian Radiofrequency Spectrum Plan 2021",
                "subtitle": "Including general information",
                "url": "https://www.acma.gov.au/sites/default/files/2021-07/Australian%20Radiofrequency%20Spectrum%20Plan%202021_Including%20general%20information.pdf",
                "pdf_sha256": pdf_sha,
                "pdf_published": "2021-07",
            },
            "extracted_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "extractor_version": EXTRACTOR_VERSION,
        },
        "au_allocations": au_rows,
        "region_allocations": region_rows,
        "au_footnotes": au_fns,
        "intl_footnotes": intl_fns,
    }

    OUTPUT_YAML.parent.mkdir(parents=True, exist_ok=True)
    yaml = YAML(typ="rt")
    yaml.width = 4096
    yaml.default_flow_style = False
    with OUTPUT_YAML.open("w") as f:
        yaml.dump(doc, f)

    print(f"\nWrote {OUTPUT_YAML}")
    print(f"  au_allocations:     {len(au_rows)}")
    print(f"  region_allocations: {len(region_rows)}")
    print(f"  au_footnotes:       {len(au_fns)}")
    print(f"  intl_footnotes:     {len(intl_fns)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python extract.py <path/to/pdf>", file=sys.stderr)
        sys.exit(1)
    main(pathlib.Path(sys.argv[1]))
