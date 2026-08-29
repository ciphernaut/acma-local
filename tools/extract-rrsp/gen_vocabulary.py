"""Regenerate vocabulary.py from the ACMA spreadsheet oracle.

Usage: python gen_vocabulary.py "../../docs/Table of Frequency Band Allocations xlsx.xlsx"

The spreadsheet (ARSP 2017 vintage, see docs/spectrum-remediation-sprints.md) lists
one row per (band, service) with an already-normalised `Service Name` column.  That
column is the closed ITU service vocabulary the line-joiner needs.  It is a *source
of names*, not a source of allocations — the spreadsheet is two editions behind
current law.

ITU-only services (ones that appear in the Region columns but never in the
Australian table) are not in the spreadsheet; they are listed in EXTRA_NAMES below
and must be added by hand when extract.py reports an unmatched name.
"""

from __future__ import annotations

import pathlib
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# Services that appear only in the ITU Region columns, never in the Australian
# table, so the spreadsheet does not list them.  Add here when extract.py
# reports an unmatched name that is a genuine ITU service.
EXTRA_NAMES = [
    "RADIOLOCATION-SATELLITE",
    "SPACE OPERATION",
    "TIME SIGNAL",
]


def canon(name: str) -> str:
    """Canonical comparison form: upper, dashes unified, no space around dashes."""
    s = re.sub(r"[\u2010-\u2015\u2212-]", "-", name.upper())
    s = re.sub(r"\s*-\s*", "-", s)
    return re.sub(r"\s+", " ", s).strip()


def _sheet_rows(path: pathlib.Path, sheet: str) -> list[dict[str, str]]:
    z = zipfile.ZipFile(path)
    shared = [
        "".join(t.text or "" for t in si.iter(NS + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si")
    ]
    rows = []
    for row in ET.fromstring(z.read(sheet)).iter(NS + "row"):
        cells: dict[str, str] = {}
        for c in row.findall(NS + "c"):
            col = re.match(r"[A-Z]+", c.get("r") or "").group()
            v = c.find(NS + "v")
            if c.get("t") == "s" and v is not None:
                cells[col] = shared[int(v.text)]
            elif v is not None:
                cells[col] = v.text or ""
            else:
                cells[col] = ""
        rows.append(cells)
    return rows


def main(xlsx: pathlib.Path) -> None:
    rows = _sheet_rows(xlsx, "xl/worksheets/sheet2.xml")
    names = set()
    for r in rows:
        name, lo = r.get("E", ""), r.get("A", "")
        if not name or not lo or name == "Service Name":
            continue
        if name.startswith("("):  # "(NOT ALLOCATED)" is a marker, not a service
            continue
        names.add(canon(name))
    names.update(canon(n) for n in EXTRA_NAMES)

    out = pathlib.Path(__file__).with_name("vocabulary.py")
    body = "\n".join(f'    "{n}",' for n in sorted(names))
    out.write_text(
        '"""ITU service-name vocabulary — GENERATED, do not hand-edit.\n\n'
        "Regenerate with gen_vocabulary.py.  Source: the Service Name column of\n"
        "ACMA's Table of Frequency Band Allocations spreadsheet, plus EXTRA_NAMES.\n"
        '"""\n\n'
        "from __future__ import annotations\n\n"
        "import re\n\n"
        "SERVICE_NAMES: frozenset[str] = frozenset((\n"
        f"{body}\n"
        "))\n\n\n"
        "def canon(name: str) -> str:\n"
        '    """Canonical comparison form: upper, dashes unified, no space around dashes."""\n'
        '    s = re.sub(r"[\\u2010-\\u2015\\u2212-]", "-", name.upper())\n'
        '    s = re.sub(r"\\s*-\\s*", "-", s)\n'
        '    return re.sub(r"\\s+", " ", s).strip()\n\n\n'
        "def is_known(name: str) -> bool:\n"
        "    return canon(name) in SERVICE_NAMES\n\n\n"
        "def is_strict_prefix(name: str) -> bool:\n"
        '    """True if `name` is a proper prefix of some longer service name."""\n'
        "    c = canon(name)\n"
        "    if not c:\n"
        "        return False\n"
        "    return any(n != c and n.startswith(c + ' ') for n in SERVICE_NAMES)\n"
    )
    print(f"Wrote {out} with {len(names)} names")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    main(pathlib.Path(sys.argv[1]))
