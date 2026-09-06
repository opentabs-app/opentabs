// Drive the real extension and print the diagnostics the user will see.
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const dist = resolve(process.cwd(), "dist");
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/settings.html`);

// Turn on trending and AI, exactly as the user did.
await page.evaluate(async () => {
  const got = await chrome.storage.sync.get("opentabs:config");
  const cfg = got["opentabs:config"];
  for (const i of cfg.instances) if (["ai", "trending"].includes(i.id)) i.enabled = true;
  await chrome.storage.sync.set({ "opentabs:config": cfg });
});

const res = await page.evaluate(() => chrome.runtime.sendMessage({ type: "diagnostics" }));
console.log("\nGroup            def        srcs resolved  granted  origins");
for (const r of res.rows.filter((r) => r.enabled)) {
  console.log(
    `${r.name.padEnd(16)} ${r.def.padEnd(10)} ${String(r.sources).padStart(4)} ${String(r.resolved).padStart(8)}  ${String(r.granted).padStart(7)}  ${r.origins.length}`,
  );
}
const ai = res.rows.find((r) => r.id === "ai");
console.log("\nAI opts is a plain object:", ai.optsIsObject);
console.log("AI origins:", ai.origins.join(", ") || "(none)");
const tr = res.rows.find((r) => r.id === "trending");
console.log("trending origins:", tr.origins.join(", ") || "(none)");
await ctx.close();
