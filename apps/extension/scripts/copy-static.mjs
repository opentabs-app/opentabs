// Copy the manifest, icons and fonts into the build output.
//
// Firefox gets a different manifest (event-page background, options_ui, a
// gecko id) but byte-identical JS — the runtime difference is handled in
// src/lib/ext.ts, not by compiling twice.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const firefox = process.env.TARGET_BROWSER === "firefox";
const out = resolve(root, firefox ? "dist-firefox" : "dist");

mkdirSync(out, { recursive: true });

const manifestSrc = resolve(root, "public", firefox ? "manifest.firefox.json" : "manifest.json");
writeFileSync(resolve(out, "manifest.json"), readFileSync(manifestSrc));

for (const dir of ["icons", "fonts"]) {
  const from = resolve(root, "public", dir);
  if (existsSync(from)) cpSync(from, resolve(out, dir), { recursive: true });
}

// Vite emits HTML entries at their source paths (dist/src/newtab/newtab.html).
// The manifest names them at the root, and the pages already reference their
// assets absolutely ("/newtab.js", "/assets/main.css"), so a plain move is
// enough — nothing inside needs rewriting.
for (const [from, to] of [
  ["src/newtab/newtab.html", "newtab.html"],
  ["src/settings/settings.html", "settings.html"],
]) {
  const src = resolve(out, from);
  if (existsSync(src)) {
    renameSync(src, resolve(out, to));
  }
}
rmSync(resolve(out, "src"), { recursive: true, force: true });
// Vite copies public/ wholesale, so the *other* browser's manifest tags
// along. Drop it: a build should contain exactly one manifest.
rmSync(resolve(out, "manifest.firefox.json"), { force: true });

console.log(`static copied -> ${out}${firefox ? " (firefox)" : ""}`);
