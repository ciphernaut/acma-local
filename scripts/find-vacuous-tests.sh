#!/usr/bin/env bash
# Find tests that can pass without asserting anything.
#
# This is an AUDIT AID, not a gate. It is heuristic and produces false positives —
# on first run it flagged six tests, of which two were real. Triage the output by
# hand; do not wire it into CI.
#
# The class it hunts is one this repo has shipped repeatedly: an assertion nested
# inside `if (rows.length > 0)` against a fixture database that has no rows, so the
# expectations never execute and the test is green for the wrong reason.
#
#   npm run check:vacuous-tests
#
# Two idioms are NOT vacuous and are recognised as assertions:
#   - a helper that throws (assertExactViolations, an explicit `throw new Error`)
#   - `if (r.kind === 'x')` used to narrow a TypeScript union, where an
#     `expect(r.kind).toBe('x')` immediately above has already asserted it
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec python3 - "$@" <<'PY'
import re, pathlib

ASSERTION = re.compile(r'\bexpect\(|\bthrow new |assertExactViolations\(')

def blocks(src):
    lines, out, depth, start = src.splitlines(), [], 0, None
    for i, line in enumerate(lines):
        if start is None and re.match(r'\s*(test|it)\(', line):
            start, depth = i, 0
        if start is not None:
            depth += line.count('{') - line.count('}')
            if depth <= 0 and i > start:
                out.append((start, '\n'.join(lines[start:i + 1])))
                start = None
    return out

flagged = 0
for f in sorted(pathlib.Path('tests').rglob('*.test.ts')):
    for start, body in blocks(f.read_text()):
        name = re.search(r"(?:test|it)\(\s*['\"`](.+?)['\"`]", body)
        name = name.group(1) if name else '?'
        if not ASSERTION.search(body):
            print(f"  {f}:{start+1}  no assertions at all   {name[:58]}")
            flagged += 1
            continue
        # Strip every if-block, then see whether any assertion survives outside.
        outside = re.sub(r'if\s*\([^)]*\)\s*\{.*?\n\s*\}', '', body, flags=re.S)
        if ASSERTION.search(body) and not ASSERTION.search(outside):
            # Narrowing guard? An expect on the same expression just above the if.
            guard = re.search(r'if\s*\(\s*(\w+)\.(\w+)\s*===', body)
            narrowing = guard and re.search(
                rf'expect\(\s*{guard.group(1)}\.{guard.group(2)}\s*\)', body)
            note = 'TS narrowing, probably fine' if narrowing else 'ASSERTIONS ONLY RUN INSIDE A CONDITIONAL'
            print(f"  {f}:{start+1}  {note}   {name[:58]}")
            if not narrowing:
                flagged += 1

print()
print(f"{flagged} test(s) worth a look. Triage by hand — this check is heuristic.")
PY
