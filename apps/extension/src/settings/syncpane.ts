/**
 * The Sync pane.
 *
 * Every OpenSync call is a message to the service worker, never a call from
 * here. Two reasons, and both matter: the wasm core is three quarters of a
 * megabyte and belongs in the one bundle already carrying wasm, and the
 * account secret and vault key stay in the worker, where a settings page
 * cannot put them into a screenshot or a devtools panel by accident.
 *
 * No `innerHTML`: a device name and a relay address both come from a person
 * typing, and this page is the most privileged place either could land.
 */
import { ext } from "../lib/ext";

type Deps = {
  $: (id: string) => HTMLElement;
  toast: (m: string) => void;
};

interface View {
  enabled: boolean;
  linked: boolean;
  relayWs: string;
  device: string;
  lastRun: number;
  lastAction: string;
  lastError: string | null;
}

const send = <T,>(msg: unknown): Promise<T> => ext.runtime.sendMessage(msg) as Promise<T>;

function ago(ms: number): string {
  if (!ms) return "never";
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

/** What the last cycle did, said as an outcome rather than a verb. */
function outcome(v: View): string {
  if (v.lastError && v.lastAction !== "blocked") return `Last try failed: ${v.lastError}`;
  switch (v.lastAction) {
    case "push": return `Sent this browser's settings ${ago(v.lastRun)}.`;
    case "pull": return `Took the other device's settings ${ago(v.lastRun)}.`;
    case "idle": return `Checked ${ago(v.lastRun)} — everything already matches.`;
    // Not a failure to retry. Somebody has to let this account in, or the
    // address has to change — so the sentence says which, and the word
    // "failed" is deliberately absent.
    case "blocked": return `${v.lastError} Ask whoever runs it to admit this device, or point the address at a relay of your own.`;
    default: return "Not synced yet.";
  }
}

let busy = false;

async function refresh(d: Deps): Promise<View> {
  const v = await send<View>({ type: "syncState" });
  const on = v.enabled && v.linked;
  (d.$("syncoff") as HTMLElement).hidden = on;
  (d.$("syncon") as HTMLElement).hidden = !on;
  if (on) {
    d.$("syncstatus").textContent = `${v.device || "This browser"} · ${v.relayWs} — ${outcome(v)}`;
  } else {
    (d.$("syncrelay") as HTMLInputElement).value = v.relayWs;
    (d.$("syncdevice") as HTMLInputElement).value = v.device;
  }
  return v;
}

/** Run one action, keeping the button unpressable while it is in flight. */
async function once(d: Deps, button: HTMLButtonElement, label: string, work: () => Promise<string>) {
  if (busy) return;
  busy = true;
  const was = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    d.toast(await work());
  } catch (e) {
    d.toast(e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = was;
    await refresh(d);
  }
}

function fail(r: { ok?: boolean; error?: string } | undefined, fallback: string): void {
  if (!r?.ok) throw new Error(r?.error ?? fallback);
}

export function initSyncPane(d: Deps) {
  const relay = () => (d.$("syncrelay") as HTMLInputElement).value;
  const device = () => (d.$("syncdevice") as HTMLInputElement).value;

  (d.$("syncstart") as HTMLButtonElement).addEventListener("click", (e) =>
    void once(d, e.currentTarget as HTMLButtonElement, "Starting…", async () => {
      const r = await send<{ ok: boolean; error?: string }>({ type: "syncStart", relay: relay(), device: device() });
      fail(r, "could not start");
      return "Sync is on. Add your other devices from here.";
    }));

  (d.$("syncjoinbtn") as HTMLButtonElement).addEventListener("click", (e) =>
    void once(d, e.currentTarget as HTMLButtonElement, "Joining…", async () => {
      const code = (d.$("syncjoin") as HTMLInputElement).value;
      const r = await send<{ ok: boolean; error?: string }>({ type: "syncJoin", relay: relay(), code, device: device() });
      fail(r, "could not join");
      (d.$("syncjoin") as HTMLInputElement).value = "";
      return "Joined. This browser now has the account's settings.";
    }));

  (d.$("syncnow") as HTMLButtonElement).addEventListener("click", (e) =>
    void once(d, e.currentTarget as HTMLButtonElement, "Syncing…", async () => {
      const r = await send<{ ok: boolean; action: string; why: string }>({ type: "syncRun" });
      if (!r.ok) throw new Error(r.why);
      return r.action === "idle" ? "Already up to date." : r.action === "pull" ? "Took the newer settings." : "Sent this browser's settings.";
    }));

  /**
   * A code, then a wait.
   *
   * One code is one attempt: a wrong answer spends it, which is exactly what
   * lets it be ten characters instead of sixty. So the code is shown once and
   * the pane says plainly what happened to it.
   */
  (d.$("syncadd") as HTMLButtonElement).addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    if (busy) return;
    busy = true;
    button.disabled = true;
    const box = d.$("synccodebox") as HTMLElement;
    try {
      const r = await send<{ ok: boolean; code?: string; uri?: string; error?: string }>({ type: "syncOffer" });
      fail(r, "could not make a code");
      box.hidden = false;
      d.$("synccode").textContent = r.code!;
      d.$("syncuri").textContent = r.uri!;
      d.$("syncwait").textContent = "Waiting for the other device to answer…";
      const done = await send<{ ok: boolean; error?: string }>({ type: "syncOfferDone" });
      d.$("syncwait").textContent = done.ok
        ? "Done — that device now has this account."
        : `Pairing stopped: ${done.error ?? "unknown"}`;
    } catch (err) {
      box.hidden = false;
      d.$("syncwait").textContent = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  /**
   * Two presses, and the second is what does it.
   *
   * Rotation cannot be undone and it locks out every device that is not
   * paired again. One mis-tap is not an acceptable way to reach that.
   */
  let armed = false;
  const rotateBtn = d.$("syncrotate") as HTMLButtonElement;
  rotateBtn.addEventListener("click", (e) => {
    if (!armed) {
      armed = true;
      rotateBtn.textContent = "Press again to rotate — this locks out every other device";
      setTimeout(() => {
        armed = false;
        rotateBtn.textContent = "Rotate the key";
      }, 6000);
      return;
    }
    armed = false;
    rotateBtn.textContent = "Rotate the key";
    void once(d, e.currentTarget as HTMLButtonElement, "Rotating…", async () => {
      const r = await send<{ ok: boolean; message?: string; error?: string }>({ type: "syncRotate" });
      fail(r, "could not rotate");
      return r.message!;
    });
  });

  (d.$("syncunlink") as HTMLButtonElement).addEventListener("click", (e) =>
    void once(d, e.currentTarget as HTMLButtonElement, "Turning off…", async () => {
      const r = await send<{ ok: boolean; error?: string }>({ type: "syncUnlink" });
      fail(r, "could not turn off");
      return "Sync is off on this browser. Nothing was deleted.";
    }));
}

export function showSyncPane(d: Deps) {
  void refresh(d);
}
