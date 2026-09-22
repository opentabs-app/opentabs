# Vendored: the OpenSync browser client

**Generated. Do not edit anything in this directory.**

Copied from the engine's `packages/client/src` by
`scripts/vendor-opensync.mjs`, so that this repository builds on its own: a
CI runner clones one repository and has no engine beside it. The only change
is a `@ts-nocheck` line atop each `.ts` file; the script says why.

`wasm/opensync_wasm_bg.wasm` is the compiled Rust core, built from the
`opensync-*` crates in the engine repository. `wasm/inline.ts` is an empty
stub, not the engine's base64 copy: the extension loads the binary instead.

## Licence

This directory is **not** under the repository's AGPL-3.0. It is OpenSync's
code and keeps OpenSync's licence: MIT OR Apache-2.0, at your option (the
engine's `Cargo.toml` and README). Both are permissive and combine with the
AGPL in the rest of the extension.

To refresh, with the engine checked out beside this repository:

    npm run vendor:opensync        # copy again
    npm run vendor:opensync:check  # fail if the copy has drifted

The check runs in `npm test`. Where the engine is absent it passes quietly.
