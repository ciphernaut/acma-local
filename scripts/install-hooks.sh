#!/usr/bin/env bash
# Install the repo's hooks into .git/hooks/.
#
# Deliberately NOT `git config core.hooksPath .githooks`: that setting is
# per-repo but exclusive, so it would silently disable a global hooks directory
# if the user has one.  Copying into .git/hooks/ keeps a global dispatcher that
# chains to "$(git rev-parse --git-dir)/hooks/<name>" working.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/.githooks"
DEST="$(git -C "$REPO_ROOT" rev-parse --git-dir)/hooks"
DEST="$(cd "$REPO_ROOT" && cd "$DEST" && pwd)"

mkdir -p "$DEST"
installed=0
for hook in "$SRC"/*; do
    [ -f "$hook" ] || continue
    name="$(basename "$hook")"
    target="$DEST/$name"
    if [ -e "$target" ] && ! grep -q 'gitleaks' "$target" 2>/dev/null; then
        echo "note: $target already exists and is not ours — backing it up to $name.local"
        mv "$target" "$target.local"
    fi
    install -m 0755 "$hook" "$target"
    echo "installed $name -> $target"
    installed=$((installed + 1))
done

echo "$installed hook(s) installed."

hooks_path="$(git -C "$REPO_ROOT" config --get core.hooksPath || true)"
if [ -n "$hooks_path" ]; then
    echo
    echo "note: core.hooksPath is set to '$hooks_path'."
    echo "      Git will run hooks from there instead of .git/hooks/. That is fine if"
    echo "      it chains to \"\$(git rev-parse --git-dir)/hooks/<name>\"; otherwise the"
    echo "      hooks just installed will not run. Verify with:"
    echo "        git commit --allow-empty -m 'hook check'"
fi
