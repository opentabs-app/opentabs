#!/usr/bin/env bash
# Refresh the vendored @openapps/ui bundle used by the marketplace sign-in.
#
# Run from a checkout that sits inside the openapps monorepo, which is where
# the bundle is built. See apps/marketplace/public/openapps/README.md for why
# it is vendored rather than depended on.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/../ui-elements/dist/bundle"
DEST="$HERE/apps/marketplace/public/openapps"

[[ -d "$SRC" ]] || { echo "No bundle at $SRC. Run 'npm run build' in ui-elements." >&2; exit 2; }

# openapps-login's *static* imports. If a fourth chunk ever appears here the
# copy below misses it and sign-in 404s at the moment someone presses the
# button — so the graph is re-read each time rather than assumed.
mapfile -t CHUNKS < <(grep -o 'from"\./[^"]*"' "$SRC/openapps-login.js" \
  | sed 's|from"\./||; s|"$||; s|\.js$||' | sort -u)
# The Nostr fallbacks, loaded by dynamic import only if someone opens one of
# those forms. Copied so that path works; costs nothing to anyone else.
LAZY=(esm-ZDSEP2UJ nip46-PMGLFUAT pure-F6KPRDZ5)

mkdir -p "$DEST"
for f in openapps-login openapps-signout "${CHUNKS[@]}" "${LAZY[@]}"; do
  [[ -f "$SRC/$f.js" ]] || { echo "missing $SRC/$f.js" >&2; exit 1; }
  # Strip the sourceMappingURL: the maps are not vendored, and a 404 per
  # chunk in devtools reads like a broken deploy.
  sed '/^\/\/# sourceMappingURL=/d' "$SRC/$f.js" > "$DEST/$f.js"
  echo "  $f.js"
done
cp "$HERE/../tokens/tokens.css" "$DEST/tokens.css"
echo "vendored into $DEST"
