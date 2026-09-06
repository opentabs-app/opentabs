#!/usr/bin/env bash
# Ship the OpenTabs site and marketplace to the production box.
#
# Builds locally and rsyncs the result. Does **not** touch nginx, TLS or the
# API container — those are one-time steps in DEPLOY.md, and a script that
# edits live server blocks is a script that can take down every other site on
# the machine.
#
#   ./deploy/deploy.sh            # site + marketplace
#   ./deploy/deploy.sh --api      # …and rebuild/restart the API on the box
set -euo pipefail

HOST="${OPENTABS_HOST:-root@104.36.65.54}"
# rsync over an explicit key, so a deploy does not stop to ask for a
# password halfway through.
SSH_KEY="${OPENTABS_SSH_KEY:-$HOME/.ssh/id_ed25519}"
RSH="ssh -i $SSH_KEY -o BatchMode=yes"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/5  Building the marketplace"
( cd "$HERE/apps/marketplace" && npm run build )

say "2/5  Checking the backend domain did not leak into the bundle"
# The masking is a property of the built files, and one hardcoded URL undoes
# it. Refuse to ship rather than find it in someone's network panel.
#
# The vendored sign-in element is excluded: it is @openapps/ui's own built
# output and names the platform in its default configuration, which this site
# overrides with base-url. It is not ours to rewrite.
if grep -rq --exclude-dir=openapps "openapps\.network" "$HERE/apps/marketplace/dist"; then
  echo "REFUSING TO DEPLOY: openapps.network appears in the built bundle:" >&2
  grep -rl --exclude-dir=openapps "openapps\.network" "$HERE/apps/marketplace/dist" >&2
  exit 1
fi
echo "  clean"

say "3/5  Shipping the site to $HOST:/var/www/opentabs"
# No --delete: /tabs/v1/ lives in this directory and is written on the server
# by cron, not by this repository. Deleting what we did not ship would remove
# the feeds every deploy and leave two groups blank until the next cron run.
rsync -av -e "$RSH" \
  --exclude 'tabs/' \
  "$HERE/apps/site/" "$HOST:/var/www/opentabs/"

say "4/5  Shipping the marketplace to $HOST:/var/www/opentabs-market"
# --delete here: it is a build output and nothing but this folder belongs
# there. Stale fingerprinted assets otherwise accumulate forever.
rsync -av --delete -e "$RSH" \
  "$HERE/apps/marketplace/dist/" "$HOST:/var/www/opentabs-market/"

if [[ "${1:-}" == "--api" ]]; then
  say "5/5  Rebuilding the API on the box"
  # From the server's own clone. The image is built there because the target
  # is x86_64 Linux and rusqlite compiles bundled C.
  # shellcheck disable=SC2029
  $RSH "$HOST" 'cd /opt/opentabs && git pull --ff-only && ./deploy/run-market-api.sh --build'
else
  say "5/5  Skipping the API (pass --api to rebuild it)"
fi

say "Verifying what the server actually serves"
# Not optional. Every nginx bug in this suite so far shipped because the
# config was reasoned about rather than exercised.
"$HERE/deploy/verify.sh" || {
  echo "Deployed, but the live checks above failed." >&2
  exit 1
}
say "Done."
