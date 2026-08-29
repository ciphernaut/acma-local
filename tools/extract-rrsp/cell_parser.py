"""Parse a single PDF table cell into structured services and footnotes.

A cell is a multi-line string.  The PDF wraps long service names across lines, so
lines are **joined** before they are parsed — see `join_wrapped_lines`.  Parsing a
line then works by matching the longest known service name (vocabulary.py) as a
prefix; whatever follows the name is a qualifier ("except aeronautical mobile",
"(space-to-Earth)", "(passive)").

Per extraction-rules.md §4:
- ALL CAPS name is a primary service; Title Case is secondary.
- Numeric / AUS-prefixed tokens at the end of a service line are inline footnotes.
- Numeric / AUS-prefixed tokens on a line of their own are cell-level footnotes.
"""

from __future__ import annotations

import collections
import re
from typing import TypedDict, NotRequired

from vocabulary import SERVICE_NAMES, canon, is_strict_prefix

# Names the vocabulary did not recognise, reported by extract.py at the end of a
# run so a missing ITU service surfaces instead of being silently mangled.
UNMATCHED: collections.Counter[str] = collections.Counter()


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
_DASH_END = re.compile(r"[‐-―−-]$")
_MAX_NAME_WORDS = max(len(n.split(" ")) for n in SERVICE_NAMES)


def _normalise_token(tok: str) -> str:
    return tok.upper() if tok.lower().startswith("aus") else tok


_PAREN_SPAN = re.compile(r"\((?:[^()]|\([^()]*\))*\)")


def _strip_footnotes(line: str) -> tuple[str, list[str]]:
    """Return (line_without_footnotes, list_of_tokens).

    Parenthesised spans are masked first: a qualifier like "(20 kHz)" or
    "(2 500 kHz)" contains bare numbers that are part of the qualifier, not
    footnote references.
    """
    spans = [m.group(0) for m in _PAREN_SPAN.finditer(line)]
    masked = _PAREN_SPAN.sub("\x00", line)

    tokens = [_normalise_token(m.group(0)) for m in _FOOTNOTE_TOKEN.finditer(masked)]
    cleaned = _FOOTNOTE_TOKEN.sub("", masked)

    for span in spans:
        cleaned = cleaned.replace("\x00", span, 1)
    return cleaned.strip(), tokens


def _is_footnote_only(line: str) -> bool:
    """True if a line contains only footnote tokens (and whitespace)."""
    stripped = _FOOTNOTE_TOKEN.sub("", line).strip()
    return stripped == "" and bool(_FOOTNOTE_TOKEN.search(line))


def _unbalanced_paren(text: str) -> bool:
    return text.count("(") > text.count(")")


def _starts_lowercase(line: str) -> bool:
    for ch in line:
        if ch.isalpha():
            return ch.islower()
    return False


def _is_not_allocated(line: str) -> bool:
    return line.lower().strip().strip("()") == "not allocated"


def _is_parenthetical(line: str) -> bool:
    """A line that opens with '(' continues the service above it — it is a
    qualifier the PDF pushed onto its own line, e.g. '(20 kHz)'."""
    return line.lstrip().startswith("(")


def join_wrapped_lines(lines: list[str]) -> list[str]:
    """Rejoin service names the PDF wrapped across lines.

    Four signals, applied in order to decide whether the *next* line continues
    the current one:

    1. The line ends with a dash — a mid-word break ("EARTH EXPLORATION–" +
       "SATELLITE").  Joined with no separator.
    2. The line has an unclosed parenthesis — a qualifier split across lines
       ("FIXED–SATELLITE (EARTH-" + "TO-SPACE)").  Joined with no separator when
       the line ends with a dash, otherwise with a space.
    3. The next line starts with a lowercase letter, or opens with "(" — a
       continuation, never a new service, since services are ALL CAPS or Title
       Case ("MOBILE except aeronautical" + "mobile", "STANDARD FREQUENCY AND
       TIME SIGNAL" + "(20 kHz)").
    4. The line canonicalises to a proper prefix of a known service name
       ("STANDARD FREQUENCY" + "AND TIME SIGNAL").

    Footnote-only lines never join; they terminate the run.
    """
    out: list[str] = []
    buf: str | None = None

    def flush() -> None:
        nonlocal buf
        if buf is not None:
            out.append(buf)
            buf = None

    for line in lines:
        if _is_footnote_only(line) or _is_not_allocated(line):
            flush()
            out.append(line)
            continue
        if buf is None:
            buf = line
            continue

        stem, _ = _strip_footnotes(buf)
        if _DASH_END.search(buf.rstrip()):
            buf = buf.rstrip()[:-1] + "-" + line.lstrip()
        elif _unbalanced_paren(buf):
            buf = f"{buf} {line}"
        elif _starts_lowercase(line) or _is_parenthetical(line):
            buf = f"{buf} {line}"
        elif is_strict_prefix(stem):
            buf = f"{buf} {line}"
        else:
            flush()
            buf = line

    flush()
    return out


def _match_name(text: str) -> tuple[str, str] | None:
    """Split `text` into (service_name, qualifier) on the longest vocabulary match.

    Returns None when no known service name starts the text.
    """
    words = text.split()
    for n in range(min(len(words), _MAX_NAME_WORDS), 0, -1):
        candidate = " ".join(words[:n])
        if canon(candidate) in SERVICE_NAMES:
            return candidate, " ".join(words[n:]).strip()
    return None


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

    joined = join_wrapped_lines(lines)

    for idx, line in enumerate(joined):
        if _is_not_allocated(line):
            continue

        if _is_footnote_only(line):
            _, tokens = _strip_footnotes(line)
            # A footnote-only line in the MIDDLE of a cell continues the footnote
            # list of the service above it; only a trailing run belongs to the
            # cell as a whole.
            more_services_follow = any(
                not _is_footnote_only(rest) and not _is_not_allocated(rest)
                for rest in joined[idx + 1 :]
            )
            if more_services_follow and services:
                services[-1]["inline_footnotes"].extend(tokens)
            else:
                cell_footnotes.extend(tokens)
            continue

        text, tokens = _strip_footnotes(line)
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            cell_footnotes.extend(tokens)
            continue

        matched = _match_name(text)
        if matched is not None:
            name, qualifier = matched
            primary = _is_primary(name)
        elif text.startswith("(") and services:
            # A bare qualifier on its own line repeats the service above it with a
            # different direction — the ITU table writes the second direction of a
            # satellite service that way:
            #     FIXED-SATELLITE (space-to-Earth) 484A
            #                     (Earth-to-space) 516
            name, qualifier = services[-1]["name"], text
            primary = services[-1]["primary"]
        else:
            UNMATCHED[text] += 1
            name, qualifier = text, ""
            primary = _is_primary(text)

        service: Service = {
            "name": canon(name),
            "primary": primary,
            "inline_footnotes": tokens,
        }
        if qualifier:
            service["qualifier"] = qualifier
        services.append(service)

    return {"services": services, "footnotes": cell_footnotes, "raw": raw}
