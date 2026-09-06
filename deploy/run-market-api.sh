#!/usr/bin/env bash
# Build and run the marketplace API on the production box.
#
#   ./deploy/run-market-api.sh            # build if needed, then run
#   ./deploy/run-market-api.sh --build    # force a rebuild first
#   ./deploy/run-market-api.sh --logs
#   ./deploy/run-market-api.sh --stop
#
# Runs ON THE SERVER, from a clone of this repository. The image is built
# there because the target is x86_64 Linux and rusqlite compiles bundled C —
# neither of which survives a cross-compile from a Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=opentabs-market-api:prod
CONTAINER=opentabs-market-api
VOLUME=opentabs-market-data
ENV_FILE=deploy/market-api.env
PORT=8095

case "${1:-}" in
  --stop) docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "stopped"; exit 0 ;;
  --logs) exec docker logs -f "$CONTAINER" ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy deploy/market-api.env.example and fill it in." >&2
  exit 2
fi
# Catch the mistake the env file warns about, here rather than in a like
# token nobody can explain six months from now.
if grep -qE '^[A-Z_]+="' "$ENV_FILE"; then
  echo "$ENV_FILE has quoted values. docker --env-file takes them literally." >&2
  grep -nE '^[A-Z_]+="' "$ENV_FILE" >&2
  exit 2
fi

if [[ "${1:-}" == "--build" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building $IMAGE …"
  docker build -f deploy/Dockerfile -t "$IMAGE" .
fi

docker volume create "$VOLUME" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Bound to loopback. nginx is the only thing that should reach it, and the
# service does not terminate TLS.
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -v "$VOLUME:/data" \
  -p "127.0.0.1:$PORT:$PORT" \
  "$IMAGE" >/dev/null

sleep 1
if ! curl -sS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "Started, but /health did not answer. Logs:" >&2
  docker logs --tail 40 "$CONTAINER" >&2
  exit 1
fi
echo "opentabs-market-api healthy on 127.0.0.1:$PORT"
