#!/usr/bin/env bash
# Build tabs-core for the extension's service worker.
#
# wasm-bindgen's generated glue is schema-versioned against the CLI binary,
# so the crate pin in the workspace Cargo.toml and the installed CLI must
# match exactly. A mismatch fails here with a message that does not name the
# real cause, which is why the check is explicit.
set -euo pipefail
cd "$(dirname "$0")/../../.."

CRATE_VER=$(grep -m1 'wasm-bindgen = "=' Cargo.toml | sed 's/.*"=\(.*\)".*/\1/')
CLI_VER=$(wasm-bindgen --version | awk '{print $2}')
if [ "$CRATE_VER" != "$CLI_VER" ]; then
  echo "wasm-bindgen mismatch: crate pins $CRATE_VER, CLI is $CLI_VER" >&2
  echo "  cargo install wasm-bindgen-cli --version $CRATE_VER --locked" >&2
  exit 1
fi

cargo build -p tabs-core --release --target wasm32-unknown-unknown
# --target web, not bundler. The bundler target emits a bare
# `import * as wasm from "./tabs_core_bg.wasm"`, which needs wasm-ESM support
# Vite does not have without a plugin. The web target instead emits
# `new URL("tabs_core_bg.wasm", import.meta.url)`, which Vite rewrites into a
# normal hashed asset — and its default-exported init() is fetch-based, so it
# works from a service worker where dynamic import() is forbidden.
wasm-bindgen \
  --target web \
  --out-dir apps/extension/src/wasm-gen \
  target/wasm32-unknown-unknown/release/tabs_core.wasm

echo "wasm: $(du -h apps/extension/src/wasm-gen/tabs_core_bg.wasm | cut -f1)"
