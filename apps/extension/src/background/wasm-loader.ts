/**
 * The wasm host. Service worker only.
 *
 * A static import, not `import()`: dynamic import is disallowed inside
 * `ServiceWorkerGlobalScope` by the HTML spec regardless of `"type":
 * "module"` — that only enables *static* import/export. Vite bundles the
 * glue and rewrites the generated `new URL('..._bg.wasm', import.meta.url)`
 * into a hashed asset reference.
 *
 * MV3 also blocks `WebAssembly.instantiate` under the default CSP unless
 * `'wasm-unsafe-eval'` is in the manifest. It is; removing it silently
 * breaks every function here.
 */
import initWasm, * as core from "../wasm-gen/tabs_core.js";

let ready: Promise<void> | null = null;

/**
 * Instantiate once per worker lifetime. MV3 evicts the worker after ~30s
 * idle and every wake re-runs this — which is fine, because it happens on an
 * alarm where latency is invisible, never on the paint path.
 */
export async function wasm(): Promise<typeof core> {
  ready ??= initWasm().then(() => undefined);
  await ready;
  return core;
}
