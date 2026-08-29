"""Extract the ACMA Spectrum Plan PDF to a canonical YAML.

Usage: python extract.py <path/to/pdf>

Sections are discovered from page text, not hardcoded — they moved between the
2021 original and the 2025 compilation.  Writes ../../seed/spectrum_plan_source.yaml.
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import sys
from datetime import datetime, timezone

import pdfplumber
from ruamel.yaml import YAML

from cell_parser import parse_cell, UNMATCHED
from footnotes import is_running_header
from frequency import split_range_prefix

EXTRACTOR_VERSION = "2.0.0"

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT_YAML = REPO_ROOT / "seed" / "spectrum_plan_source.yaml"

# Section page ranges are DISCOVERED, not hardcoded: they moved between the 2021
# original and the 2025 compilation (allocations 31-112 -> 17-106, Australian
# footnotes 112-119 -> 107-113, international 120-214 -> 114-218), and running with
# stale constants reads footnote pages as allocation tables.
_ALLOCATION_MARKER = re.compile(r"Column 1:\s*ITU Radio Regulations", re.IGNORECASE)
_AU_FOOTNOTE_MARKER = re.compile(r"Australian Footnotes", re.IGNORECASE)
_INTL_FOOTNOTE_MARKER = re.compile(r"International Footnotes", re.IGNORECASE)

# Typographic errors in the source document itself, corrected explicitly so the
# fix is auditable and cannot rot silently: each entry must fire, and the run
# reports any that did not.  Do NOT loosen the parsing rules to absorb these —
# that is how "1 6121.35" became a 16 GHz band in generation 2.
#
# Each entry rewrites the FIRST occurrence of `find` in a cell's text on `page`,
# narrowed by an optional `contains` discriminator when one page holds two cells
# that both match.  Every correction is corroborated by an independent source,
# named in `why`.
SOURCE_ERRATA: list[dict] = [
    {
        "page": 57,
        "find": "1 6121.35 – 1 626.5",
        "replace": "1 621.35 – 1 626.5",
        "why": "Regions 1 and 2 and the Australian column on the same row all "
               "read '1 621.35 – 1 626.5'.",
    },
    {
        "page": 37,
        "find": "40.98 – 41.105",
        "contains": "Space research",
        "replace": "40.98 – 41.015",
        "why": "The 2021 edition (F2021L00617 p51) has 40 980 000-41 015 000 Hz "
               "with footnotes 160/161 and a Space research entry.",
    },
    {
        "page": 37,
        "find": "40.98 – 41.105",
        "contains": "161A",
        "replace": "41.015 – 42",
        "why": "The PDF repeats the previous band's range here.  The 2021 edition "
               "(F2021L00617 p51) has 41 015 000-42 000 000 Hz with footnotes "
               "160/161/161A and no Space research entry.",
    },
    {
        "page": 105,
        "find": "Amateur\u2013satellite\n49",
        "replace": "Amateur\u2013satellite\n149",
        "why": "247.2-248 GHz cites '49', which is not a footnote in this plan. "
               "The Australian column on the same row and every neighbouring row "
               "cite 149 (radio astronomy protection); the leading 1 is dropped.",
    },
]


def _find_erratum(page: int, cell_text: str) -> dict | None:
    for e in SOURCE_ERRATA:
        if e["page"] != page or e["find"] not in cell_text:
            continue
        if "contains" in e and e["contains"] not in cell_text:
            continue
        return e
    return None


def _sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _page_unit(page) -> str | None:
    """The unit banner ('kHz'/'MHz'/'GHz') printed at the top of an allocation page."""
    text = page.extract_text() or ""
    for line in text.splitlines()[:6]:
        token = line.strip().lower()
        if token in ("khz", "mhz", "ghz"):
            return {"khz": "kHz", "mhz": "MHz", "ghz": "GHz"}[token]
    return None


def _find_sections(pdf) -> dict[str, list[int]]:
    """Locate the allocation and footnote sections by page text.

    Hardcoding page numbers is how the 2021 extractor came to skip a page
    silently and would have read footnote pages as tables in the 2025
    compilation.  Every page is classified; nothing is assumed.
    """
    allocations: list[int] = []
    au_footnotes: list[int] = []
    intl_footnotes: list[int] = []

    texts = [page.extract_text() or "" for page in pdf.pages]

    marked = [i for i, text in enumerate(texts) if _ALLOCATION_MARKER.search(text)]
    if not marked:
        raise SystemExit("No allocation pages found — is this the Spectrum Plan PDF?")

    # Continuation pages do not repeat the "Column 1: ITU Radio Regulations"
    # banner, so the section is the CONTIGUOUS SPAN between the first and last
    # page that does.  Taking only the marked pages silently dropped pages 37 and
    # 89 — the same class of hole as the missing page 58 in generation 2.
    allocations = list(range(marked[0], marked[-1] + 1))

    # Footnote sections follow the table.  Restricting the search to pages after
    # the last allocation page keeps the table of contents — which names both
    # footnote parts — out of the result.
    for i in range(allocations[-1] + 1, len(texts)):
        text = texts[i]
        if _INTL_FOOTNOTE_MARKER.search(text):
            intl_footnotes.append(i)
        elif _AU_FOOTNOTE_MARKER.search(text):
            au_footnotes.append(i)
    return {
        "allocations": allocations,
        "au_footnotes": au_footnotes,
        "intl_footnotes": intl_footnotes,
    }


def _column_boxes(tbl, ext) -> tuple[list[tuple[float, float]], int] | None:
    """Return ([(x0, x1) per column], first_data_row_index) from the label row.

    The label row is the one carrying 'Region 1' / 'Australian'; everything above
    it is a header, everything below is data.
    """
    for ri, row_text in enumerate(ext):
        joined = " ".join(t or "" for t in row_text)
        if "Region 1" in joined and "Region 3" in joined:
            cells = tbl.rows[ri].cells
            if len(cells) < 4 or any(c is None for c in cells[:4]):
                return None
            return [(float(c[0]), float(c[2])) for c in cells[:4]], ri + 1
    return None


def _derive_columns(tbl) -> list[tuple[float, float]] | None:
    """Recover column boundaries from the table's own cell edges.

    Continuation pages omit the label row, and their columns do not always sit at
    the same x as the labelled pages (page 37 uses 69/177/279/385/526 where a
    labelled page uses 36/170/304/438/572).  Merged cells only ever span existing
    edges, so the distinct edge set recovers the true columns.
    """
    edges: set[float] = set()
    for row in tbl.rows:
        for c in row.cells:
            if c is not None:
                edges.add(round(float(c[0]), 1))
                edges.add(round(float(c[2]), 1))
    ordered = sorted(edges)
    if len(ordered) != 5:
        return None
    return [(ordered[i], ordered[i + 1]) for i in range(4)]


_HEADER_TEXT = re.compile(
    r"Column \d:|Region [123]\b|Australian Table of", re.IGNORECASE
)


def _is_header_cell(text: str) -> bool:
    return bool(_HEADER_TEXT.search(text))


def _covered_columns(bbox, columns) -> list[int]:
    """Indices of the columns a cell rectangle spans.

    A cell merged across Regions 1-3 has one rectangle covering all three column
    boxes; attributing it to column 0 alone is what left Region 3 empty for ~65%
    of rows.
    """
    x0, x1 = float(bbox[0]), float(bbox[2])
    covered = []
    for idx, (cx0, cx1) in enumerate(columns):
        overlap = min(x1, cx1) - max(x0, cx0)
        if overlap > 0.5 * (cx1 - cx0):
            covered.append(idx)
    return covered


def _build_allocation_row(cell_text: str, unit: str, page: int, stats: dict) -> dict | None:
    """Parse one table cell into an allocation row.

    The range is split off the FIRST LINE and the remainder handed to the cell
    parser: in a merged cell the PDF packs the range and the first service onto
    one line ('1 710 - 1 930 FIXED'), and discarding that line dropped a service
    from 40% of region rows.
    """
    erratum = _find_erratum(page, cell_text)
    if erratum is not None:
        cell_text = cell_text.replace(erratum["find"], erratum["replace"], 1)
        stats["errata_applied"].append(
            f"p{page}: {erratum['find']!r} -> {erratum['replace']!r} ({erratum['why']})"
        )
        stats["errata_fired"].add(id(erratum))

    parts = [p.strip() for p in cell_text.splitlines() if p.strip()]
    if not parts:
        return None
    try:
        start, end, remainder = split_range_prefix(parts[0], unit)
    except ValueError as e:
        stats["unparsed_cells"].append(f"p{page}: {e}")
        return None

    body = "\n".join(([remainder] if remainder else []) + parts[1:])
    parsed = parse_cell(body)
    return {
        "freq_start_hz": start,
        "freq_end_hz": end,
        "unit": unit,
        "page": page,
        "services": parsed["services"],
        "footnotes": parsed["footnotes"],
        "raw": cell_text,
    }


def _extract_allocations(pdf, pages: list[int]) -> tuple[list[dict], list[dict], dict]:
    au_rows: list[dict] = []
    region_rows: list[dict] = []
    stats: dict = {
        "unparsed_cells": [],
        "pages_without_unit": [],
        "pages_without_table": [],
        "errata_applied": [],
        "errata_fired": set(),
        "pages_using_carried_columns": [],
        "pages_using_derived_columns": [],
    }

    last_unit: str | None = None
    last_columns: list[tuple[float, float]] | None = None
    for page_num in pages:
        page = pdf.pages[page_num]
        unit = _page_unit(page)
        if unit is None:
            # Carry the previous page's unit rather than skipping the page: a
            # missing banner is a rendering quirk, not an empty page, and
            # skipping silently is what lost 161.9875-162.0375 MHz.
            unit = last_unit
            stats["pages_without_unit"].append(page_num + 1)
        if unit is None:
            raise SystemExit(
                f"Page {page_num + 1} is the first allocation page and has no unit banner"
            )
        last_unit = unit

        tables = page.find_tables()
        if not tables:
            stats["pages_without_table"].append(page_num + 1)
            continue

        for tbl in tables:
            ext = tbl.extract()
            found = _column_boxes(tbl, ext)
            if found is None:
                # Continuation pages do not repeat the label row, and a page whose
                # rows are all merged across Regions 1-3 can collapse to two
                # columns.  Column x-positions are fixed document-wide, so carry
                # the last known geometry rather than skipping the page.
                derived = _derive_columns(tbl)
                if derived is not None:
                    columns, first_data_row = derived, 0
                    stats["pages_using_derived_columns"].append(page_num + 1)
                elif last_columns is not None:
                    columns, first_data_row = last_columns, 0
                    stats["pages_using_carried_columns"].append(page_num + 1)
                else:
                    stats["pages_without_table"].append(page_num + 1)
                    continue
            else:
                columns, first_data_row = found
                last_columns = columns

            seen: set[tuple[float, ...]] = set()
            for ri in range(first_data_row, len(tbl.rows)):
                for ci, bbox in enumerate(tbl.rows[ri].cells):
                    if bbox is None:
                        continue
                    key = tuple(round(float(v), 2) for v in bbox)
                    if key in seen:
                        continue
                    seen.add(key)

                    text = ext[ri][ci] if ci < len(ext[ri]) else None
                    if not text or not text.strip():
                        continue
                    if _is_header_cell(text):
                        continue

                    covered = _covered_columns(bbox, columns)
                    if not covered:
                        continue

                    row = _build_allocation_row(text, unit, page_num + 1, stats)
                    if row is None:
                        continue

                    for col in covered:
                        if col == 3:
                            au_rows.append(dict(row))
                        else:
                            region_rows.append({**row, "region": col + 1})

    return au_rows, region_rows, stats


# The ref is matched as a PREFIX of the first word, not as the whole word: the PDF
# sets longer refs hard against their text, so pdfplumber emits "228AAThe" as a
# single token.  A ref letter is only a ref letter when it is NOT followed by a
# lowercase letter — that boundary is where the ref ends and the sentence begins,
# so "228AAThe" splits as ref "228AA" + text "The", while "228A" stays whole.
_AUS_REF_PATTERN = re.compile(r"^(AUS\d+(?:[A-Z](?![a-z]))*)")
_INTL_REF_PATTERN = re.compile(r"^(\d{1,3}(?:[A-Z](?![a-z])){0,3})")


def _discover_ref_style(pdf, page_range, *, is_australian: bool) -> tuple[float, float] | None:
    """Find the (x0, font size) of footnote ref tokens.

    Scans the first three pages of the section and returns the MINIMUM x0
    among all words whose text matches the ref pattern.  Using minimum rather
    than the first match avoids picking up pattern-matching tokens that appear
    in running headers or inline within body text at larger x0 values (e.g. the
    standalone '4' in 'International Footnotes Part 4' at x0≈518).

    Real footnote refs sit at the left margin; body-text numbers like
    '1 625 kHz' are indented further right.

    The font size is returned too.  A page-bottom note of the document itself
    ("10  Pursuant to Resolution 99 ...") also sits at the left margin and matches
    the ref pattern, but is set as a 6.5 pt superscript against the refs' 12 pt —
    without the size gate those notes enter the table as footnotes 2, 3, 4, ...
    """
    pattern = _AUS_REF_PATTERN if is_australian else _INTL_REF_PATTERN
    candidates: list[tuple[float, float]] = []
    for page_num in list(page_range)[:3]:
        words = pdf.pages[page_num].extract_words(extra_attrs=["top", "size"])
        for w in words:
            m = pattern.match(w["text"])
            if m and m.group(1):
                candidates.append((float(w["x0"]), float(w["size"])))
    if not candidates:
        return None

    ref_x0 = min(x0 for x0, _ in candidates)
    sizes = [size for x0, size in candidates if abs(x0 - ref_x0) < 5.0]
    modal_size = max(set(sizes), key=sizes.count)
    return ref_x0, modal_size


def _extract_footnotes(pdf, page_range, *, is_australian: bool) -> list[dict]:
    """Extract footnotes using positional (x0) analysis rather than line-text
    regex matching.  The old approach matched continuation lines that began with
    embedded numbers like '1 625 kHz' or '442 GHz', producing 41 corrupt
    international footnote entries.  Real ref tokens sit at the left margin
    (ref_x0); continuation lines start further right."""
    style = _discover_ref_style(pdf, page_range, is_australian=is_australian)
    if style is None:
        return []
    ref_x0, ref_size = style

    TOLERANCE = 5.0
    LINE_TOP_TOLERANCE = 3.0
    pattern = _AUS_REF_PATTERN if is_australian else _INTL_REF_PATTERN

    out: list[dict] = []
    current_ref: str | None = None
    current_buf: list[str] = []
    current_page: int | None = None

    def flush() -> None:
        nonlocal current_ref, current_buf
        if current_ref is not None:
            text = " ".join(part.strip() for part in current_buf if part.strip())
            if text:
                out.append({"ref": current_ref, "text": text, "page": current_page})

    for page_num in page_range:
        page = pdf.pages[page_num]
        words = page.extract_words(extra_attrs=["top", "size"])

        # Group words into lines by their 'top' coordinate (tolerance ~3 px).
        lines: list[list[dict]] = []
        for w in words:
            placed = False
            for line in lines:
                if abs(float(line[0]["top"]) - float(w["top"])) < LINE_TOP_TOLERANCE:
                    line.append(w)
                    placed = True
                    break
            if not placed:
                lines.append([w])

        # Sort words within each line by x0; sort lines top-to-bottom.
        for line in lines:
            line.sort(key=lambda w: float(w["x0"]))
        lines.sort(key=lambda ln: float(ln[0]["top"]))

        for line in lines:
            text = " ".join(w["text"] for w in line)
            stripped = text.strip()
            if not stripped:
                continue
            if is_running_header(stripped):
                continue
            first = line[0]
            # A new footnote starts only when the FIRST word in the line sits at
            # the left margin (within TOLERANCE) AND matches the ref pattern.
            # Body-text numbers like "1 625 kHz" appear as continuation lines
            # whose first word is indented (higher x0), so they fall through to
            # the else branch below.
            #
            # Extra guard: some footnotes contain multi-column frequency-range
            # tables where large MHz/GHz values are split across space boundaries
            # by the PDF renderer (e.g. "1 330–1 400 MHz" becomes the tokens
            # "1", "330–1", "400").  The lone "1" sits at the left margin and
            # matches the pattern, but the NEXT token always starts with
            # digits-then-dash (e.g. "330–"), which is never how real footnote
            # body text begins.  Detecting that guards against false ref starts.
            second_text = line[1]["text"] if len(line) > 1 else ""
            # Guard: a lone digit/short-number at the margin is a false ref
            # start when the next token on the same line also begins with a
            # digit.  This covers two PDF rendering artefacts:
            #
            # 1. Multi-column frequency tables split "1 330–1 400 MHz" into
            #    tokens "1", "330–1", "400" — second token starts with digit
            #    AND contains "–".
            # 2. Cross-reference numbers like "3 340.1 The allocation …"
            #    split into "3", "340.1", "The" — second token is a decimal.
            #
            # In both cases the second word starts with a digit, whereas real
            # footnote body text always starts with a capital letter or "(".
            is_body_fragment = not is_australian and bool(
                second_text and re.match(r"^\d", second_text)
            )
            SIZE_TOLERANCE = 0.5
            ref_match = pattern.match(first["text"])
            # Footnote body text always begins a sentence.  Inside the multi-column
            # band lists (e.g. page 127) a continuation line can start at the left
            # margin with something that looks like a ref — "322 -328.6 MHz, ..." —
            # but its remainder starts with a dash or a digit, never a capital.
            starts_a_sentence = False
            if ref_match and ref_match.group(1):
                remainder = (
                    first["text"][ref_match.end(1):]
                    + " "
                    + " ".join(w["text"] for w in line[1:])
                ).strip()
                # Some refs carry a trailing "*" annotation ("208B* In the
                # frequency bands: ..."); it belongs to neither the ref nor the
                # text, so allow it here and strip it below.
                starts_a_sentence = bool(re.match(r'^\*?\s*[A-Z(\u201c"]', remainder))
            if (
                abs(float(first["x0"]) - ref_x0) < TOLERANCE
                and abs(float(first["size"]) - ref_size) < SIZE_TOLERANCE
                and ref_match
                and ref_match.group(1)
                and starts_a_sentence
                and not is_body_fragment
            ):
                flush()
                current_ref = ref_match.group(1)
                head = first["text"][ref_match.end(1):]
                tail = " ".join(w["text"] for w in line[1:]).strip()
                rest = re.sub(r"^\*\s*", "", f"{head} {tail}".strip())
                current_buf = [rest] if rest else []
                current_page = page_num + 1
            else:
                if current_ref is not None:
                    current_buf.append(stripped)

    flush()
    return out


def main(pdf_path: pathlib.Path) -> None:
    print(f"Reading: {pdf_path}")
    pdf_sha = _sha256(pdf_path)
    print(f"SHA256:  {pdf_sha}")

    with pdfplumber.open(pdf_path) as pdf:
        sections = _find_sections(pdf)
        print(
            f"Sections: allocations {_span(sections['allocations'])}, "
            f"AU footnotes {_span(sections['au_footnotes'])}, "
            f"international footnotes {_span(sections['intl_footnotes'])}"
        )
        au_rows, region_rows, stats = _extract_allocations(pdf, sections["allocations"])
        au_fns = _extract_footnotes(pdf, sections["au_footnotes"], is_australian=True)
        intl_fns = _extract_footnotes(pdf, sections["intl_footnotes"], is_australian=False)

    doc = {
        "meta": {
            "generation": 3,
            "source": {
                "title": "Australian Radiofrequency Spectrum Plan (2025 Update) 2021",
                "subtitle": "Compilation No. 1, including F2025L01230",
                "url": "https://www.legislation.gov.au/F2021L00617/latest/text",
                "pdf_sha256": pdf_sha,
                "pdf_published": "2025-10-09",
                "compilation": "F2025C01105",
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

    for line in _coverage_anomalies(au_rows, region_rows):
        print(f"  ? {line}")

    # Nothing is dropped quietly: every skip is reported, because a silent
    # `continue` is what put a hole at 161.9875-162.0375 MHz in generation 2.
    problems = 0
    for line in stats["errata_applied"]:
        print(f"\n  · source erratum applied — {line}")
    unfired = [e for e in SOURCE_ERRATA if id(e) not in stats["errata_fired"]]
    if unfired:
        problems += len(unfired)
        print(f"  ! {len(unfired)} SOURCE_ERRATA entry did not fire — the source may "
              f"have been corrected upstream; verify and remove: "
              f"{[(e['page'], e['first_line']) for e in unfired]}")
    if stats["pages_using_derived_columns"]:
        print(f"\n  · {len(stats['pages_using_derived_columns'])} page(s) had no column "
              f"header; columns derived from cell edges: "
              f"{stats['pages_using_derived_columns']}")
    if stats["pages_using_carried_columns"]:
        print(f"\n  ! {len(stats['pages_using_carried_columns'])} page(s) had no column "
              f"header (carried the previous geometry): "
              f"{stats['pages_using_carried_columns']}")
    if stats["pages_without_unit"]:
        print(f"  ! {len(stats['pages_without_unit'])} page(s) had no unit banner "
              f"(carried the previous unit): {stats['pages_without_unit']}")
    if stats["pages_without_table"]:
        problems += len(stats["pages_without_table"])
        print(f"  ! {len(stats['pages_without_table'])} allocation page(s) yielded no "
              f"parsable table: {stats['pages_without_table']}")
    if stats["unparsed_cells"]:
        problems += len(stats["unparsed_cells"])
        print(f"  ! {len(stats['unparsed_cells'])} cell(s) had no parsable range:")
        for line in stats["unparsed_cells"][:20]:
            print(f"      {line}")
        if len(stats["unparsed_cells"]) > 20:
            print(f"      ... and {len(stats['unparsed_cells']) - 20} more")
    if UNMATCHED:
        problems += sum(UNMATCHED.values())
        print(f"  ! {len(UNMATCHED)} service name(s) not in the vocabulary "
              f"(add to EXTRA_NAMES in gen_vocabulary.py if genuine):")
        for name, count in UNMATCHED.most_common(20):
            print(f"      {count:4d}  {name!r}")
    if problems:
        print(f"\n  {problems} item(s) need attention — see above.")


def _coverage_anomalies(au_rows: list[dict], region_rows: list[dict]) -> list[str]:
    """Report gaps and duplicated bands.

    These are usually defects in the source document rather than in the parser —
    they are reported, never silently corrected, so a human can check them against
    the legislation before the seed ships.
    """
    out: list[str] = []
    groups = {"AU": au_rows}
    for rg in (1, 2, 3):
        groups[f"R{rg}"] = [r for r in region_rows if r.get("region") == rg]

    for label, rows in groups.items():
        bands = sorted({(r["freq_start_hz"], r["freq_end_hz"]) for r in rows})
        for i in range(1, len(bands)):
            if bands[i][0] > bands[i - 1][1]:
                out.append(
                    f"{label}: no allocation between {bands[i - 1][1]:,} Hz and "
                    f"{bands[i][0]:,} Hz"
                )
        seen: dict[tuple[int, int], int] = {}
        for r in rows:
            key = (r["freq_start_hz"], r["freq_end_hz"])
            seen[key] = seen.get(key, 0) + 1
        for key, count in seen.items():
            if count > 1:
                out.append(
                    f"{label}: band {key[0]:,}-{key[1]:,} Hz appears {count} times"
                )
    return out


def _span(pages: list[int]) -> str:
    if not pages:
        return "none"
    return f"{pages[0] + 1}-{pages[-1] + 1} ({len(pages)} pages)"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python extract.py <path/to/pdf>", file=sys.stderr)
        sys.exit(1)
    main(pathlib.Path(sys.argv[1]))
