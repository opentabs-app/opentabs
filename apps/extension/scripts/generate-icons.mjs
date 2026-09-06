// The extension's icons. The mark itself lives in `icon.mjs`, shared with
// the website's favicon set — see the note there for why.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { png } from "./icon.mjs";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

for (const size of [16, 48, 128]) {
  writeFileSync(resolve(out, `icon${size}.png`), png(size));
}
console.log("icons written:", out);
