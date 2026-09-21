/**
 * OpenSync's wasm core, started the way the engine asks a host to start it.
 *
 * `ready()` takes the wasm from wherever the host has it, and memoises the
 * promise — so whichever call comes first wins and every later `ready()` in
 * library code shares it. That last part is what matters here: `Payload.open`
 * calls `ready()` with no argument, and with no argument the engine reaches
 * for its inlined base64 copy **through a dynamic `import()`**.
 *
 * A service worker cannot do that. Dynamic import is disallowed inside
 * `ServiceWorkerGlobalScope` by the HTML spec, whatever the manifest says
 * about modules — `wasm-loader.ts` says the same thing about `tabs_core`.
 * What it looks like when it happens is worth writing down, because the error
 * names nothing relevant: the import rejects, Vite's preload helper runs its
 * error path, and that path calls `window.dispatchEvent`. So a service worker
 * reports `window is not defined`, four frames from anything to do with wasm
 * or with sync.
 *
 * Handing `ready()` the asset URL avoids the import entirely, and is the path
 * the engine documents for a host that serves the file. Vite rewrites the
 * `new URL(…, import.meta.url)` below into the hashed asset it emits, exactly
 * as it does for the extension's own core.
 */
import { ready } from "../../vendor/opensync-client";

const WASM_URL = new URL(
  "../../vendor/opensync-client/wasm/opensync_wasm_bg.wasm",
  import.meta.url,
);

export function boot(): Promise<void> {
  return ready(WASM_URL);
}
