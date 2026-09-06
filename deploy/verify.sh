#!/usr/bin/env bash
# What the live hosts actually serve. Run after every deploy.
#
# `curl -sS`, never bare `-s`: plain `-s` hides the error, so a certificate
# or DNS problem prints nothing at all and reads as an empty response.
set -uo pipefail

fail=0
# Every check has a deadline. A host that is down, or a DNS answer that
# points somewhere silent, must fail its own line rather than hang the run —
# a verification script you have to Ctrl-C is one nobody runs after a deploy.
check() { # description, expected, actual
  if [[ "$3" == *"$2"* ]]; then printf '  \033[32mok\033[0m   %s\n' "$1"
  else printf '  \033[31mFAIL\033[0m %s\n       wanted %q, got %q\n' "$1" "$2" "$3"; fail=1; fi
}

echo "opentabs.app"
check "site answers 200"            "200" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://opentabs.app/)"
check "www redirects to the apex"   "301" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://www.opentabs.app/)"
check "privacy page is there"       "200" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://opentabs.app/privacy.html)"
check "apps feed is JSON"           "apps" "$(curl -sS --max-time 10 https://opentabs.app/tabs/v1/apps.json | head -c 200)"
# The extension reads the feeds from an extension origin, so this header is
# the difference between a group that fills and one that is silently blank.
check "feeds allow cross-origin reads" "access-control-allow-origin: *" \
  "$(curl -sS --max-time 10 -o /dev/null -D - https://opentabs.app/tabs/v1/apps.json | tr 'A-Z' 'a-z')"

echo "market.opentabs.app"
check "site answers 200"            "200" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://market.opentabs.app/)"
health=$(curl -sS --max-time 10 https://market.opentabs.app/health)
check "API health"                  '"ok":true' "$health"
# The single most confusing failure this deployment can have: the service is
# up, browsing works, and every publish and every like answers 401 because it
# never fetched the platform's key set. `"keys":0` is that, said out loud.
check "API can verify a token"      '"keys":1'  "$health"
check "browse returns a listing set" "listings" \
  "$(curl -sS --max-time 10 'https://market.opentabs.app/v1/packs?limit=1' | head -c 200)"
# The one that matters and the one that is invisible: /v1/ must reach the API
# rather than fall through to the SPA's index.html, which would answer 200
# with HTML and look like the API is "up".
check "an unknown pack 404s rather than serving the app" "404" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://market.opentabs.app/v1/packs/no-such-pack)"
check "a deep link survives a refresh" "200" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' 'https://market.opentabs.app/#/pack/anything')"
# Vendored lazily by the sign-in dialog. A 404 here means nobody can sign in,
# and nothing else on the page would show it.
check "the sign-in element is served" "200" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://market.opentabs.app/openapps/openapps-login.js)"

echo "auth.opentabs.app"
check "platform health"             '"ok":true' "$(curl -sS --max-time 10 https://auth.opentabs.app/healthz)"
# The API verifies every bearer token against this document. If it is not
# served here, publishing and liking fail with 401 and nothing says why.
check "JWKS is published"           "Ed25519" "$(curl -sS --max-time 10 https://auth.opentabs.app/.well-known/jwks.json)"
check "sign-in page is served"      "200" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://auth.opentabs.app/signin)"

# CORS is the one that fails silently, so check it with a real preflight.
# A HEAD request gets no CORS headers at all, so `curl -I` returns nothing
# whether the origin is allowed or not.
echo "CORS, as the extension sees it"
preflight=$(curl -sS --max-time 10 -o /dev/null -D - -X OPTIONS \
  -H "Origin: chrome-extension://fake" \
  -H "Access-Control-Request-Method: GET" \
  https://market.opentabs.app/v1/packs | tr 'A-Z' 'a-z')
check "marketplace API allows an extension origin" "access-control-allow-origin" "$preflight"

exit $fail
