import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two HTML entries and one raw TS entry.
//
// `background/index.ts` is the only bundle that touches wasm — the manifest
// declares it `"type": "module"`, so static imports are fine there. The new
// tab page must never import it: putting wasm instantiation on the paint
// path is exactly what this architecture exists to avoid, and the e2e suite
// asserts the built newtab bundle contains no wasm reference.
//
// TARGET_BROWSER switches the output directory only. Every entry compiles
// identically for both browsers; `src/lib/ext.ts` picks the right runtime
// API at load time.
const targetBrowser = process.env.TARGET_BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  root: resolve(__dirname),
  build: {
    outDir: targetBrowser === "firefox" ? "dist-firefox" : "dist",
    emptyOutDir: true,
    target: "es2022",
    // Extension pages each live in their own isolated JS world with no
    // shared module cache, so Vite's modulepreload polyfill is meaningless
    // and Chrome logs a cross-world resource mismatch for it. Every target
    // browser here has native modulepreload anyway.
    modulePreload: false,
    rollupOptions: {
      input: {
        newtab: resolve(__dirname, "src/newtab/newtab.html"),
        settings: resolve(__dirname, "src/settings/settings.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
