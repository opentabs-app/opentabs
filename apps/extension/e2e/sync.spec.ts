/**
 * Settings crossing between two browsers, through a real relay.
 *
 * Two persistent profiles, two copies of the built extension, one relay
 * process. Nothing here is stubbed: the pairing is a real SPAKE2 exchange
 * over a real websocket, and the settings that arrive on the second profile
 * were sealed on the first.
 *
 * The two browsers are the whole point. A single-profile test can show that
 * bytes make it to the relay and back, and would have passed on every version
 * of this code — including the ones where a newly joined device pushed its
 * own defaults over the account it had just been invited into.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay, type Relay } from "./relay";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

let relay: Relay;
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => relay?.stop());

interface Device {
  context: BrowserContext;
  worker: Worker;
  id: string;
}

async function launch(): Promise<Device> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  return { context, worker, id: new URL(worker.url()).host };
}

/** The config as this profile's storage actually holds it. */
const readConfig = (d: Device) =>
  d.worker.evaluate(async () => (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"]);

const readLocal = (d: Device) =>
  d.worker.evaluate(async () => (await chrome.storage.local.get("opentabs:local"))["opentabs:local"]);

/**
 * The worker writes a default config on install, and a test that raced it saw
 * its own theme replaced by "auto" a moment later. Wait for the default to be
 * there, then change it.
 */
async function settled(d: Device) {
  await d.worker.evaluate(async () => {
    const key = "opentabs:config";
    for (let i = 0; i < 100; i++) {
      if ((await chrome.storage.sync.get(key))[key]) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the worker never wrote a default config");
  });
}

async function writeTheme(d: Device, theme: string) {
  await settled(d);
  await d.worker.evaluate(async (t) => {
    const key = "opentabs:config";
    const got = (await chrome.storage.sync.get(key))[key] as Record<string, unknown>;
    await chrome.storage.sync.set({ [key]: { ...got, theme: t } });
  }, theme);
}

async function openSync(d: Device) {
  const page = await d.context.newPage();
  await page.goto(`chrome-extension://${d.id}/settings.html`);
  await page.click('#nav button[data-pane="sync"]');
  return page;
}

test("settings cross from one browser to another, and changes flow back", async () => {
  const a = await launch();
  const b = await launch();

  try {
    // Something to recognise on the far side, set before sync is ever on.
    await writeTheme(a, "midnight-a");
    await a.worker.evaluate(async () => {
      await chrome.storage.local.set({
        "opentabs:local": {
          scratch: "written on A",
          // A bearer secret. It travels because sealing it is the point.
          apiKey: "weather-key-from-a",
          todos: [{ id: "t1", text: "from A", due: null, hasTime: false, done: false, created: 1 }],
        },
      });
    });

    // --- A turns sync on -------------------------------------------------
    const pageA = await openSync(a);
    await pageA.fill("#syncrelay", relay.ws);
    await pageA.fill("#syncdevice", "Browser A");
    await pageA.click("#syncstart");
    await expect(pageA.locator("#syncon")).toBeVisible();
    await expect(pageA.locator("#syncstatus")).toContainText("Browser A");
    await expect(pageA.locator("#syncstatus")).toContainText("Sent this browser's settings");

    // --- A shows a code, B answers it ------------------------------------
    await pageA.click("#syncadd");
    await expect(pageA.locator("#syncuri")).toContainText("opensync://pair");
    const invitation = (await pageA.locator("#syncuri").textContent())!.trim();

    // B has its own settings, and is about to lose them — which is correct.
    await writeTheme(b, "not-what-we-want");

    const pageB = await openSync(b);
    await pageB.fill("#syncdevice", "Browser B");
    await pageB.fill("#syncjoin", invitation);
    await pageB.click("#syncjoinbtn");
    await expect(pageB.locator("#syncon")).toBeVisible({ timeout: 60_000 });
    await expect(pageA.locator("#syncwait")).toContainText("Done", { timeout: 60_000 });

    // The account's settings, not B's own. This is the assertion that a
    // one-browser test cannot make.
    expect((await readConfig(b) as { theme: string }).theme).toBe("midnight-a");
    const localB = (await readLocal(b)) as { scratch?: string; apiKey?: string; todos?: { text: string }[] };
    expect(localB.scratch).toBe("written on A");
    expect(localB.apiKey).toBe("weather-key-from-a");
    expect(localB.todos?.[0]?.text).toBe("from A");

    // --- and back the other way ------------------------------------------
    await writeTheme(b, "changed-on-b");
    await pageB.click("#syncnow");
    await expect(pageB.locator("#syncstatus")).toContainText("Sent this browser's settings");

    await pageA.click("#syncnow");
    await expect(pageA.locator("#syncstatus")).toContainText("Took the other device's settings");
    expect((await readConfig(a) as { theme: string }).theme).toBe("changed-on-b");

    // --- a device that changed nothing must not look like an editor ------
    await pageA.click("#syncnow");
    await expect(pageA.locator("#syncstatus")).toContainText("everything already matches");

    // --- the keys never leave storage.local ------------------------------
    const leaked = await a.worker.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)));
    expect(leaked).not.toContain("opentabs:sync");
    const held = await a.worker.evaluate(async () => (await chrome.storage.local.get("opentabs:sync"))["opentabs:sync"]);
    expect((held as { namespaceKey: string }).namespaceKey).toBeTruthy();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("turning sync off leaves the settings alone", async () => {
  const a = await launch();
  try {
    await writeTheme(a, "keep-me");
    const page = await openSync(a);
    await page.fill("#syncrelay", relay.ws);
    await page.click("#syncstart");
    await expect(page.locator("#syncon")).toBeVisible();

    await page.click("#syncunlink");
    await expect(page.locator("#syncoff")).toBeVisible();
    expect((await readConfig(a) as { theme: string }).theme).toBe("keep-me");
  } finally {
    await a.context.close();
  }
});
