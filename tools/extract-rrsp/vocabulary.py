"""ITU service-name vocabulary — GENERATED, do not hand-edit.

Regenerate with gen_vocabulary.py.  Source: the Service Name column of
ACMA's Table of Frequency Band Allocations spreadsheet, plus EXTRA_NAMES.
"""

from __future__ import annotations

import re

SERVICE_NAMES: frozenset[str] = frozenset((
    "AERONAUTICAL MOBILE",
    "AERONAUTICAL MOBILE-SATELLITE",
    "AERONAUTICAL RADIONAVIGATION",
    "AMATEUR",
    "AMATEUR-SATELLITE",
    "BROADCASTING",
    "BROADCASTING-SATELLITE",
    "EARTH EXPLORATION-SATELLITE",
    "FIXED",
    "FIXED-SATELLITE",
    "INTER-SATELLITE",
    "LAND MOBILE",
    "LAND MOBILE-SATELLITE",
    "MARITIME MOBILE",
    "MARITIME MOBILE-SATELLITE",
    "MARITIME RADIONAVIGATION",
    "METEOROLOGICAL AIDS",
    "METEOROLOGICAL-SATELLITE",
    "MOBILE",
    "MOBILE-SATELLITE",
    "RADIO ASTRONOMY",
    "RADIODETERMINATION-SATELLITE",
    "RADIOLOCATION",
    "RADIOLOCATION-SATELLITE",
    "RADIONAVIGATION",
    "RADIONAVIGATION-SATELLITE",
    "SPACE OPERATION",
    "SPACE RESEARCH",
    "STANDARD FREQUENCY AND TIME SIGNAL",
    "STANDARD FREQUENCY AND TIME SIGNAL-SATELLITE",
    "TIME SIGNAL",
))


def canon(name: str) -> str:
    """Canonical comparison form: upper, dashes unified, no space around dashes."""
    s = re.sub(r"[\u2010-\u2015\u2212-]", "-", name.upper())
    s = re.sub(r"\s*-\s*", "-", s)
    return re.sub(r"\s+", " ", s).strip()


def is_known(name: str) -> bool:
    return canon(name) in SERVICE_NAMES


def is_strict_prefix(name: str) -> bool:
    """True if `name` is a proper prefix of some longer service name."""
    c = canon(name)
    if not c:
        return False
    return any(n != c and n.startswith(c + ' ') for n in SERVICE_NAMES)
