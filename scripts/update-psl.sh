#!/usr/bin/env bash
# Regenerate the public suffix table from publicsuffix.org.
#
#     ./scripts/update-psl.sh
#
# The table decides where a tab is filed. Hand-maintained, it was 145 entries
# and correct for the countries somebody had thought of; the real list is
# 8,882 multi-label rules and is what every browser uses. Generated rather
# than curated, so it cannot quietly fall behind the web.
#
# The output is committed. Fetching at build time would make the build need
# the network and make two builds of the same commit differ.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/crates/tabs-core/src/tabs/psl.rs"
SRC="https://publicsuffix.org/list/public_suffix_list.dat"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -fsS --max-time 60 "$SRC" -o "$TMP"
python3 "$HERE/scripts/psl_to_rust.py" "$TMP" "$OUT"
echo "wrote $OUT"
