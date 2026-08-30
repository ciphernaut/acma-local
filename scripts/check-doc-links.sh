#!/usr/bin/env bash
# Verify that every URL cited in the documentation actually resolves.
#
# Provenance is only worth something if a reader can follow it. A citation that
# 404s is indistinguishable from an invented one — and this repo shipped exactly
# that: the Wayback link for the vocabulary spreadsheet was transcribed without
# its `?la=en` query string, so it returned 404 while the underlying capture was
# real. Nothing in the test suite could have noticed.
#
# Not wired into `npm test` or the default CI job: it needs network, and third
# party outages would make the suite flaky. Run it after editing docs, and before
# publishing anything that other people will rely on.
#
#   npm run check:doc-links
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

FILES=(docs/*.md ./*.md tools/extract-rrsp/README.md)
fail=0
checked=0

# Not every URL-shaped string in prose is a citation. Skipped:
#   loopback and shell variables      illustrative, not fetchable
#   '<' or '..'                       template placeholders and elided examples
#   the Wayback CDX endpoint          400s without the query parameters that the
#                                     surrounding example supplies
skip_re='localhost|127\.0\.0\.1|<|\.\.|\$\{?[A-Z_]+\}?|example\.(com|org)|web\.archive\.org/cdx/'

urls=$(grep -ohE 'https?://[^ )>`"]+' "${FILES[@]}" 2>/dev/null \
        | sed 's/[.,;:]$//' | sort -u)

while read -r url; do
    [ -n "$url" ] || continue
    if printf '%s' "$url" | grep -qE "$skip_re"; then
        printf '  skip   %s\n' "$url"
        continue
    fi
    checked=$((checked + 1))
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 45 -L "$url" 2>/dev/null || echo 000)
    case "$code" in
        2*|3*) printf '  %-6s %s\n' "$code" "$url" ;;
        *)     printf '  %-6s %s   <-- UNREACHABLE\n' "$code" "$url"; fail=1 ;;
    esac
done <<< "$urls"

echo
if [ "$fail" -ne 0 ]; then
    echo "One or more documented URLs did not resolve. Fix the citation, or record" >&2
    echo "how to find the source another way (an archive CDX query, an identifier)." >&2
    exit 1
fi
echo "All $checked documented URLs resolve."
