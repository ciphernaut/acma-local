"""Parse a single PDF table cell into structured services and footnotes.

A cell is a multi-line string. Per extraction-rules.md §4:
- ALL CAPS line is a primary service.
- Title Case line is a secondary service.
- Parenthetical content attached to the previous service line is a qualifier.
- Numeric / AUS-prefixed tokens at the end of a service line are inline footnotes.
- Numeric / AUS-prefixed tokens on a line of their own at the cell bottom are cell-level footnotes.
"""

from __future__ import annotations

import re
from typing import TypedDict, NotRequired


class Service(TypedDict):
    name: str
    primary: bool
    inline_footnotes: list[str]
    qualifier: NotRequired[str]


class ParsedCell(TypedDict):
    services: list[Service]
    footnotes: list[str]
    raw: str


_FOOTNOTE_TOKEN = re.compile(r"\b(?:(?i:AUS)\d+[A-Z]*|\d{1,3}[A-Z]{0,2})\b")
_QUALIFIER = re.compile(r"\((?:[^()]|\([^()]*\))*\)")


def _normalise_token(tok: str) -> str:
    return tok.upper() if tok.lower().startswith("aus") else tok


def _strip_footnotes(line: str) -> tuple[str, list[str]]:
    """Return (line_without_footnotes, list_of_tokens)."""
    tokens = [_normalise_token(m.group(0)) for m in _FOOTNOTE_TOKEN.finditer(line)]
    cleaned = _FOOTNOTE_TOKEN.sub("", line).strip()
    return cleaned, tokens


def _is_footnote_only(line: str) -> bool:
    """True if a line contains only footnote tokens (and whitespace)."""
    stripped = _FOOTNOTE_TOKEN.sub("", line).strip()
    return stripped == "" and bool(_FOOTNOTE_TOKEN.search(line))


def _is_primary(name: str) -> bool:
    """Primary services are ALL CAPS in source. Punctuation/spaces/digits don't count."""
    letters = [c for c in name if c.isalpha()]
    return len(letters) > 0 and all(c.isupper() for c in letters)


def parse_cell(raw: str) -> ParsedCell:
    services: list[Service] = []
    cell_footnotes: list[str] = []

    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if not lines:
        return {"services": [], "footnotes": [], "raw": raw}

    for line in lines:
        # Skip explicit "(Not allocated)" - treated as no services.
        if line.lower() == "(not allocated)":
            continue

        if _is_footnote_only(line):
            _, tokens = _strip_footnotes(line)
            cell_footnotes.extend(tokens)
            continue

        # Pull qualifier first (parenthetical), then strip footnotes.
        qualifier_match = _QUALIFIER.search(line)
        qualifier = qualifier_match.group(0) if qualifier_match else None
        line_without_qual = _QUALIFIER.sub("", line).strip() if qualifier else line

        name, tokens = _strip_footnotes(line_without_qual)
        name = name.strip()
        if not name:
            cell_footnotes.extend(tokens)
            continue

        service: Service = {
            "name": name.upper(),
            "primary": _is_primary(name),
            "inline_footnotes": tokens,
        }
        if qualifier:
            service["qualifier"] = qualifier
        services.append(service)

    return {"services": services, "footnotes": cell_footnotes, "raw": raw}
