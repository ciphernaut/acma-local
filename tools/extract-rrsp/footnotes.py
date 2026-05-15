"""Extract footnote dictionaries from raw PDF page text.

Australian footnotes (pages 112–119): refs match AUS\\d+[A-Z]*.
International footnotes (pages 120–214): refs match \\d{1,3}[A-Z]{0,2}.
Running headers and footers are dropped.
"""

from __future__ import annotations

import re
from typing import TypedDict


class Footnote(TypedDict):
    ref: str
    text: str
    page: int


_AUS_REF = re.compile(r"^(AUS\d+[A-Z]*)(.*)$")
_INTL_REF = re.compile(r"^(\d{1,3}[A-Z]{0,2})\s+(.+)$")
_PAGE_NUMBER_ONLY = re.compile(r"^\s*\d+\s*$")
_HEADER_PATTERNS = [
    re.compile(r"^Australian Radiofrequency Spectrum Plan 2021", re.IGNORECASE),
    re.compile(r"^Part\s+\d+\s+", re.IGNORECASE),
]


def is_running_header(line: str) -> bool:
    if _PAGE_NUMBER_ONLY.match(line):
        return True
    return any(p.match(line) for p in _HEADER_PATTERNS)


def parse_footnote_block(
    lines: list[str], *, is_australian: bool, page: int
) -> list[Footnote]:
    """Walk lines, emitting one Footnote per detected reference start.

    `page` is recorded on every footnote produced. The caller is responsible
    for chunking lines per-page when walking multi-page extracts.
    """
    ref_pattern = _AUS_REF if is_australian else _INTL_REF
    out: list[Footnote] = []
    current_ref: str | None = None
    buf: list[str] = []

    def flush() -> None:
        if current_ref is not None:
            text = " ".join(part.strip() for part in buf if part.strip())
            out.append({"ref": current_ref, "text": text, "page": page})

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if is_running_header(line):
            continue
        m = ref_pattern.match(line)
        if m:
            flush()
            current_ref = m.group(1)
            rest = m.group(2).strip()
            buf = [rest] if rest else []
        else:
            if current_ref is not None:
                buf.append(line)
    flush()
    return out
