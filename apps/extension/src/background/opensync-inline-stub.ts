/**
 * Stands in for the engine's inlined copy of its own wasm.
 *
 * Aliased over `opensync/packages/client/src/wasm/inline` at build time. The
 * module is imported by the engine's `ready()`, which is why it cannot simply
 * be dropped — but its value is only ever read when nothing has instantiated
 * the wasm yet, and `boot()` in `opensync-wasm.ts` always has.
 *
 * If that ever stops being true the failure is loud and immediate: `init`
 * refuses empty bytes with a magic-word error on the first sync, rather than
 * doing something subtle.
 */
export const WASM_BASE64 = "";
