"""Frequency range and unit parsing for RRSP cells."""

from __future__ import annotations

import re

# A number in the source is written with thousands separated by a space (or a
# non-breaking space): "1 626.5", "420 000".  Groups after the first are exactly
# three digits — without that constraint "1 6121.35" parses as 16 121.35 instead
# of being rejected as the render artefact it is.
#
# A number written without separators ("3000 - 420 000" on the last table page)
# is also accepted, as the second alternative.  Order matters: the grouped form
# must be tried first so "3 000" reads as one number rather than as "3".
_NUMBER = r"\d{1,3}(?:[  ]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?"

_RANGE_PATTERN = re.compile(rf"^({_NUMBER})\s*[‐-―−-]\s*({_NUMBER})")
_BELOW_PATTERN = re.compile(rf"^Below\s+({_NUMBER})\b", re.IGNORECASE)

_UNIT_MULTIPLIERS = {
    "khz": 1_000,
    "mhz": 1_000_000,
    "ghz": 1_000_000_000,
}


def unit_to_hz_multiplier(unit: str) -> int:
    try:
        return _UNIT_MULTIPLIERS[unit.lower()]
    except KeyError as e:
        raise ValueError(f"Unknown unit: {unit!r}") from e


def _strip_thousands(num_str: str) -> str:
    return re.sub(r"[\s ]", "", num_str)


def _to_hz(num_str: str, multiplier: int) -> int:
    cleaned = _strip_thousands(num_str)
    if "." in cleaned:
        return int(round(float(cleaned) * multiplier))
    return int(cleaned) * multiplier


def split_range_prefix(raw: str, unit: str) -> tuple[int, int, str]:
    """Split a leading frequency range off `raw`.

    Returns (start_hz, end_hz, remainder).  The range is only recognised at the
    START of the text — a number appearing later belongs to a service qualifier or
    a footnote, not to the band.  The remainder is whatever follows the range on
    that line, which in a merged cell is the first service name:

        "1 710 – 1 930 FIXED"  ->  (1710000000, 1930000000, "FIXED")
        "8.3 – 9"              ->  (8300, 9000, "")

    Raises ValueError if no range is present or if end <= start.
    """
    multiplier = unit_to_hz_multiplier(unit)
    text = raw.strip()

    below = _BELOW_PATTERN.match(text)
    if below:
        end = _to_hz(below.group(1), multiplier)
        if end <= 0:
            raise ValueError(f"Non-positive upper bound: {raw!r}")
        return 0, end, text[below.end() :].strip()

    match = _RANGE_PATTERN.match(text)
    if not match:
        raise ValueError(f"Could not parse frequency range: {raw!r}")

    start = _to_hz(match.group(1), multiplier)
    end = _to_hz(match.group(2), multiplier)
    if end <= start:
        raise ValueError(
            f"Inverted or empty frequency range: {raw!r} -> {start} .. {end} Hz"
        )
    return start, end, text[match.end() :].strip()


def parse_range(raw: str, unit: str) -> tuple[int, int]:
    """Backwards-compatible wrapper: the range only, remainder discarded."""
    start, end, _ = split_range_prefix(raw, unit)
    return start, end
