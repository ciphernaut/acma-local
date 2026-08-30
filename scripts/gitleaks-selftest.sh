#!/usr/bin/env bash
# Prove the secret scanner still works.
#
# A scanner that cannot detect is worse than no scanner, because it looks like
# assurance.  This is not theoretical: while writing .gitleaks.toml, one invalid
# value (`regexTarget = "TGT"`) made gitleaks report "no leaks found" for every
# fixture below, with no warning and exit code 0.  Silence is not success.
#
# Run it in CI and after any edit to .gitleaks.toml.
set -uo pipefail

CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.gitleaks.toml"
GITLEAKS="${GITLEAKS:-gitleaks}"

if ! command -v "$GITLEAKS" >/dev/null 2>&1; then
    echo "gitleaks not on PATH. Install: https://github.com/gitleaks/gitleaks/releases" >&2
    echo "  or set GITLEAKS=/path/to/gitleaks" >&2
    exit 127
fi

fail=0

# Returns 0 when a leak was reported.  The output is captured rather than piped
# into grep: gitleaks exits 1 when it finds something, and under `pipefail` that
# non-zero status would propagate even though grep matched, turning every real
# detection into an apparent miss.
scan() {
    local out
    out="$(printf '%s\n' "$1" | "$GITLEAKS" stdin --no-banner --redact -c "$CONFIG" 2>&1)"
    [[ "$out" == *"leaks found: "* && "$out" != *"leaks found: 0"* ]]
}

must_detect() {
    if scan "$2"; then printf '  detected   %s\n' "$1"
    else printf '  MISSED     %s\n' "$1"; fail=1; fi
}

must_ignore() {
    if scan "$2"; then printf '  FALSE POS  %s\n' "$1"; fail=1
    else printf '  clean      %s\n' "$1"; fi
}

# Fixtures are ASSEMBLED AT RUNTIME from neutral fragments, never written as
# literals, and never assigned to a variable whose NAME looks credential-ish.
#
# A scanner cannot tell a test fixture from a real credential, and neither can
# GitHub push protection -- it blocked this very file (AWS key id, AWS secret,
# Slack token) until the literals were split. Our own .gitleaks.toml allowlists
# this path, which is precisely why our scan stayed green while GitHub's did not:
# an allowlist hides the file from US, not from everyone else.
#
# Verify after editing, using the DEFAULT rules so this repo's allowlist cannot
# mask the result:   gitleaks dir scripts/gitleaks-selftest.sh --no-banner
# That must report no leaks, while the run below still detects every fixture.
f1="AKIA"; f2="Z7HG3KLMNOPQRSTU"
f3="kQ7bZp2Xr9TnLm"; f4="4WcV1yHs8UdF3g"; f5="Je6RaOiPzNxB"
f6="ghp"; f7="_016C7869F2f4C8b1234567890abcdefghij"
f8="xoxb"; f9="-263594206564-2343594206574-FGvBqxRTvTGVaHtqLp2sMkKz"
fa="-----BEGIN OPENSSH PRIVATE KEY"; fb="-----"
fc="k3Jf9sQzL2mN"; fd="pR7vX1bY4tW8cH6dA0eU"
fe="8fJ2kLm9Qp4R"; ff="tY7wZx1Vb6Nc3Hs5Ug0D"
fg="hunter2hunter"; fh="2hunter2"

echo "Secrets the scanner must catch:"
must_detect "AWS access key id"        "$f1$f2"
must_detect "AWS secret access key"    "aws_secret_access_key = \"$f3$f4$f5\""
must_detect "GitHub personal token"    "token: $f6$f7"
must_detect "Slack bot token"          "SLACK=$f8$f9"
must_detect "private key block"        "$fa$fb
MIIEowIBAAKCAQEAx7Zq9vTn3mKp2wQrLd8yFhJc4NvBgTzXs5Wm1PoQeRtYuIaS"
# The three below exercise this repo's own rules, so a config that fails to load
# its custom section is caught rather than silently degrading to the defaults.
must_detect "bearer token in .env"     "MCP_BEARER_TOKEN=$fc$fd"
must_detect "password literal"         "password = \"$fg$fh\""
must_detect "client_secret literal"    "client_secret: $fe$ff"

echo "Known-safe patterns in this repo that must NOT fire:"
must_ignore "SHA-256 provenance"       'pdf_sha256: 5c22bd127b930fb85ad52ce5e9b8a039976d400edd07ec87488c51aeda8edc59'
must_ignore "credential read from env" 'password = args.password'
must_ignore "documented placeholder"   'AUTH_TOKEN=your_token_here_placeholder'
must_ignore "public ACMA endpoint"     'const MANIFEST = "https://backend.acma.gov.au/rrl/v1/Extracts";'

echo
if [ "$fail" -ne 0 ]; then
    echo "SELF-TEST FAILED — the scanner is not behaving as configured." >&2
    echo "Fix .gitleaks.toml before relying on it; a green scan right now means nothing." >&2
    exit 1
fi
echo "Self-test passed: $GITLEAKS is detecting and allowlisting as configured."
