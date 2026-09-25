/**
 * Settings that follow you between browsers, over OpenSync.
 *
 * `chrome.storage.sync` already carries the config — within one signed-in
 * profile of one browser. This carries it across the boundary that cannot:
 * Chrome to Firefox, work profile to personal, a machine signed into nothing.
 * The engine is the OpenSync client, vendored into this repository because there is
 * deliberately only ever one copy of it — two copies of a wire format do not
 * disagree at compile time, they disagree by losing data.
 *
 * # Why this lives in the worker
 *
 * The wasm core is three quarters of a megabyte, and the new tab page is not
 * allowed to touch wasm at all — the e2e suite asserts as much, because
 * instantiating wasm on the paint path is the exact thing this extension's
 * architecture exists to avoid. So every OpenSync call happens here, and the
 * settings page drives it by message.
 *
 * A service worker is killed after thirty seconds idle, which would normally
 * rule out a pairing handshake that waits two minutes for someone to type a
 * code on another device. WebSocket activity resets that timer (Chrome 116+,
 * and the manifest already requires 121), and pairing is nothing but websocket
 * traffic, so the worker stays up for exactly as long as the conversation.
 */
// Imported per module rather than through the client's `index.ts`. That
// barrel also re-exports `account.ts`, which needs `nostr-tools` for a
// feature nothing here calls — and a bundler following the barrel pulls the
// package in, which is a dependency and 7 KB of shipped JavaScript bought for
// nothing. The modules themselves are the same vendored copy either way.
import { Payload, Namespace, generateAccountKey, parseAccountKey } from "../../vendor/opensync-client/session";
import { PairingCode, Invitation, grantAccount, joinAccount, endpointsFor } from "../../vendor/opensync-client/pairing";
import { assumeTls, HOSTED_RELAY_WS, HOSTED_RELAY_HTTP } from "../../vendor/opensync-client/hosted";
import { NotAdmittedError } from "../../vendor/opensync-client/relay";
import { boot } from "./opensync-wasm";
import { ext, KEY, getLocal, getSync, setLocal, setSync } from "../lib/ext";
import { decide, decode, encode, fingerprint, type SyncBody, type SyncDoc } from "../lib/sync-doc";
import type { Config, LocalState } from "../lib/types";

/**
 * The relay this build points at by default.
 *
 * The engine's own constant, not a copy of it. It is a value in four
 * languages already — `crates/opensync-core/src/relay_url.rs`, the client's
 * `hosted.ts`, and openkeyboard's `Store.kt` and `Store.swift` — and
 * `opensync/scripts/check-hosted-relay.sh` fails when they disagree. A relay
 * address that differs between two surfaces of one product does not present
 * as a mismatch; it presents as one device that syncs and one that does not.
 * This file was a fifth hardcoded copy until `hosted.ts` existed to import.
 *
 * Deliberately not an OpenTabs address. An OpenSync *account* is one keypair
 * holding one namespace per product, so somebody already paired for another
 * one is already paired for this. A relay per app would repeat a pairing the
 * engine's whole design says should happen once.
 *
 * It is still only a default: the field beside it stays editable, and a relay
 * is one binary and a directory.
 */
export const DEFAULT_RELAY = HOSTED_RELAY_WS;

/**
 * One account can hold several products; this is OpenTabs' shelf on it.
 *
 * `tabs:main`, not `opentabs:main` — the suite's namespaces are the short
 * product word, as `vault:main`, `clipboard:main` and `secrets:main` already
 * are. Changed while nothing had ever been published under the old name: a
 * namespace rename after the fact does not fail, it silently leaves the old
 * shelf full and the new one empty.
 */
const NAMESPACE = "tabs:main";
const FILENAME = "settings.json";

const ALARM = "opentabs:sync";
/** Often enough that a change follows you to the next machine you sit at. */
const EVERY_MINUTES = 15;

export interface SyncState {
  enabled: boolean;
  relayWs: string;
  relayHttp: string;
  accountSecret: string;
  namespaceKey: string;
  /** What this browser calls itself on the other devices' status lines. */
  device: string;
  /** Fingerprint of the document both sides last agreed on. */
  agreedHash: string;
  agreedUpdated: number;
  /** When this device's content last stopped matching `agreedHash`. */
  localUpdated: number;
  lastRun: number;
  lastAction: string;
  lastError: string | null;
}

const BLANK: SyncState = {
  enabled: false,
  relayWs: DEFAULT_RELAY,
  relayHttp: "",
  accountSecret: "",
  namespaceKey: "",
  device: "",
  agreedHash: "",
  agreedUpdated: 0,
  localUpdated: 0,
  lastRun: 0,
  lastAction: "",
  lastError: null,
};

export async function state(): Promise<SyncState> {
  return { ...BLANK, ...(await getLocal<Partial<SyncState>>(KEY.sync, {})) };
}

/**
 * Every read-modify-write of the sync record, one at a time.
 *
 * There is no compare-and-set in `chrome.storage`, so two overlapping updates
 * each read the old record and the later write wins the whole object — not
 * just its own fields. That is not theoretical: applying the account's
 * document fires a storage event, the storage event marks this device
 * changed, and its patch was landing on top of the one that had just recorded
 * the agreement. `agreedHash` went back to empty, which is exactly the state
 * that means "never synced" — so a freshly paired browser pulled the account
 * again on every single cycle and could never send anything of its own.
 *
 * Found by pairing two real browsers. One browser cannot produce it.
 */
let queue: Promise<unknown> = Promise.resolve();

function queued<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  // Swallowed here only; the caller still sees the rejection through `next`.
  queue = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function patchNow(changes: Partial<SyncState>): Promise<SyncState> {
  const next = { ...(await state()), ...changes };
  await setLocal(KEY.sync, next);
  return next;
}

function patch(changes: Partial<SyncState>): Promise<SyncState> {
  return queued(() => patchNow(changes));
}

export function linked(s: SyncState): boolean {
  return Boolean(s.relayWs && s.accountSecret && s.namespaceKey);
}

/**
 * The two shapes of one relay address.
 *
 * A typed scheme always wins; a bare `host:port` is handed to the engine's
 * `assumeTls`, which decides from the shape of the host. This used to assume
 * TLS for anything bare, which is wrong for a relay on a LAN, and before that
 * assumed plaintext, which is wrong for one with a name. Neither guess is
 * right for everybody, so the guess lives in one place for the whole suite.
 */
export function mirror(url: string): { ws: string; http: string } {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return { ws: "", http: "" };
  if (trimmed.startsWith("ws://")) return { ws: trimmed + "/", http: "http://" + trimmed.slice(5) };
  if (trimmed.startsWith("wss://")) return { ws: trimmed + "/", http: "https://" + trimmed.slice(6) };
  if (trimmed.startsWith("https://")) return { ws: "wss://" + trimmed.slice(8) + "/", http: trimmed };
  if (trimmed.startsWith("http://")) return { ws: "ws://" + trimmed.slice(7) + "/", http: trimmed };
  return assumeTls(trimmed)
    ? { ws: `wss://${trimmed}/`, http: `https://${trimmed}` }
    : { ws: `ws://${trimmed}/`, http: `http://${trimmed}` };
}

// ---------- the document, read from and written to storage ----------

async function readBody(): Promise<SyncBody> {
  const [config, local] = await Promise.all([
    getSync<Config | null>(KEY.config, null),
    getLocal<LocalState>(KEY.local, {}),
  ]);
  return { config: config ?? ({ version: 1, instances: [], theme: "", assistant: "" } as Config), local };
}

/**
 * Take the account's document as this device's own.
 *
 * Whole-value writes, not a merge into what is here. A merge would resurrect
 * every to-do and every topic anyone had deleted anywhere, which is the
 * classic way a sync feature quietly becomes a thing people turn off.
 */
async function writeBody(body: SyncBody): Promise<void> {
  await setSync(KEY.config, body.config);
  await setLocal(KEY.local, body.local);
}

/** The engine publishes both halves of its own address; infer only for others. */
function hostedHttpFor(ws: string): string {
  return ws === HOSTED_RELAY_WS ? HOSTED_RELAY_HTTP : mirror(ws).http;
}

async function openPayload(s: SyncState): Promise<Payload> {
  await boot();
  return Payload.open(
    { accountSecret: s.accountSecret, namespaceKey: s.namespaceKey },
    { ws: s.relayWs, http: s.relayHttp || hostedHttpFor(s.relayWs) },
    NAMESPACE,
    FILENAME,
  );
}

// ---------- the cycle ----------

export interface RunResult {
  ok: boolean;
  action: "push" | "pull" | "idle" | "off" | "error" | "blocked";
  why: string;
}

let running: Promise<RunResult> | null = null;

/**
 * One pull, one decision, at most one write. Never two at once: an alarm and
 * a settings page pressing Sync now would otherwise race each other into
 * publishing two generations from the same starting pointer.
 */
export function run(): Promise<RunResult> {
  if (!running) running = cycle().finally(() => { running = null; });
  return running;
}

async function cycle(): Promise<RunResult> {
  const s = await state();
  if (!s.enabled || !linked(s)) return { ok: true, action: "off", why: "sync is off" };

  let payload: Payload | null = null;
  try {
    payload = await openPayload(s);
    const body = await readBody();
    const localHash = fingerprint(body);

    const bytes = await payload.pull();
    const remote = bytes ? decode(bytes) : null;
    // Bytes we cannot read are another version of OpenTabs, not damage. Say
    // so and touch nothing — overwriting would destroy the newer device's
    // settings to make this older one feel tidy.
    if (bytes && !remote) {
      await patch({ lastRun: Date.now(), lastAction: "idle", lastError: "the account holds settings from a newer OpenTabs" });
      return { ok: false, action: "error", why: "the account holds settings from a newer OpenTabs" };
    }

    const agreed = s.agreedHash ? { hash: s.agreedHash, updated: s.agreedUpdated } : null;
    const plan = decide(localHash, s.localUpdated, remote, agreed);

    if (plan.action === "pull" && remote) {
      await writeBody(remote);
      // The write we just made is the agreement, not a local edit. Recording
      // the fingerprint here is what stops the resulting storage event being
      // read back as "this device changed something".
      await patch({
        agreedHash: fingerprint(remote),
        agreedUpdated: remote.updated,
        localUpdated: remote.updated,
        lastRun: Date.now(),
        lastAction: "pull",
        lastError: null,
      });
      return { ok: true, action: "pull", why: plan.why };
    }

    if (plan.action === "push") {
      const updated = Math.max(s.localUpdated, remote ? remote.updated + 1 : Date.now());
      const doc: SyncDoc = { v: 1, updated, device: s.device || deviceName(), ...body };
      await payload.push(encode(doc));
      await patch({
        agreedHash: localHash,
        agreedUpdated: updated,
        localUpdated: updated,
        lastRun: Date.now(),
        lastAction: "push",
        lastError: null,
      });
      return { ok: true, action: "push", why: plan.why };
    }

    await patch({ agreedHash: localHash, lastRun: Date.now(), lastAction: "idle", lastError: null });
    return { ok: true, action: "idle", why: plan.why };
  } catch (e) {
    // A relay that has not admitted this account is not a fault and retrying
    // it forever cannot help — somebody has to admit the key, or the field
    // has to point somewhere else. It gets its own action so the pane can say
    // that, rather than showing it as one more failed attempt.
    const admission = e instanceof NotAdmittedError;
    const why = e instanceof Error ? e.message : String(e);
    await patch({
      lastRun: Date.now(),
      lastAction: admission ? "blocked" : "error",
      lastError: why,
    });
    return { ok: false, action: admission ? "blocked" : "error", why };
  } finally {
    payload?.close();
  }
}

/**
 * Notice that something on this device changed.
 *
 * Driven by the storage event rather than by every call site that writes a
 * setting — there are a dozen of those across the worker, the settings page
 * and the new tab, and one of them would always be forgotten.
 *
 * The fingerprint is the guard that makes it safe: a write that leaves the
 * content identical to what was last agreed is not an edit, so pulling the
 * account's document does not immediately look like a local change and push
 * it straight back.
 */
export function noteLocalChange(): Promise<void> {
  return queued(async () => {
    const s = await state();
    if (!s.enabled || !linked(s)) return;
    const hash = fingerprint(await readBody());
    if (hash === s.agreedHash) return;
    if (s.localUpdated > s.agreedUpdated) return; // already marked dirty
    await patchNow({ localUpdated: Date.now() });
  });
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox/.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : "Chrome";
  const os = /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// ---------- enrolling ----------

/**
 * Start an account on this device and publish what is already here.
 *
 * The first device is the only one that may push its own settings without
 * looking: there is nothing on the relay to lose yet.
 */
export async function start(relay: string, device: string): Promise<SyncState> {
  await boot();
  const { ws, http } = mirror(relay);
  if (!ws) throw new Error("Type the address of the relay to sync through");
  await patch({
    enabled: true,
    relayWs: ws,
    relayHttp: http,
    accountSecret: generateAccountKey(),
    namespaceKey: Namespace.generateKey(),
    device: device.trim() || deviceName(),
    agreedHash: "",
    agreedUpdated: 0,
    localUpdated: Date.now(),
    lastError: null,
  });
  const result = await run();
  if (!result.ok) throw new Error(result.why);
  return state();
}

/**
 * Show a code, and hand this account to whoever answers it correctly.
 *
 * One call is one code and one attempt — a wrong answer spends it, which is
 * what lets it be short enough to read down a phone line.
 */
let pending: Promise<void> | null = null;

export async function offer(): Promise<{ code: string; uri: string }> {
  const s = await state();
  if (!linked(s)) throw new Error("Turn sync on here first");
  await boot();
  const code = PairingCode.generate();
  const text = code.text;
  const uri = new Invitation(s.relayWs, code).uri;
  // Kept here rather than returned: the settings page asks for the code in one
  // message and waits for the answer in another, and a promise does not
  // survive the trip between them.
  const grant = grantAccount(
    s.relayWs,
    code,
    {
      accountSecret: s.accountSecret,
      namespaceKey: s.namespaceKey,
      namespace: NAMESPACE,
      relayWs: s.relayWs,
      relayHttp: s.relayHttp,
      grantedBy: s.device || deviceName(),
    },
    parseAccountKey(s.accountSecret),
  );
  // Nothing awaits this yet, and an unhandled rejection would take the worker
  // down with it. The real answer is handed over by `awaitOffer`.
  grant.catch(() => {});
  pending = grant;
  return { code: text, uri };
}

/** Resolves when a device has answered the code, or rejects saying why not. */
export function awaitOffer(): Promise<void> {
  return pending ?? Promise.reject(new Error("no code is waiting"));
}

/**
 * Take an account from a code shown on another device.
 *
 * Whatever this browser had configured is about to be replaced by the
 * account's settings — `decide` pulls on a first sync precisely so that
 * joining never wipes the account you were invited into. The settings pane
 * says so before the button is pressed.
 */
export async function join(relay: string, code: string, device: string): Promise<SyncState> {
  if (!code.trim()) throw new Error("Type the code from the other device");
  await boot();

  // An invitation carries its own relay address, and wins over the field: a
  // pasted opensync://pair… line is the form that cannot be mistyped.
  let { ws, http } = mirror(relay);
  try {
    ws = mirror(Invitation.parse(code.trim()).relayWs).ws;
    http = "";
  } catch {
    /* a bare ten-character code; the relay has to come from the field */
  }
  if (!ws) throw new Error("Type the relay address from the other device, or paste the whole opensync://pair… line");

  const granted = await joinAccount(ws, code.trim());
  const reachable = endpointsFor(ws, granted);
  await patch({
    enabled: true,
    relayWs: reachable.ws,
    relayHttp: reachable.http || http || mirror(reachable.ws).http,
    accountSecret: granted.accountSecret,
    namespaceKey: granted.namespaceKey,
    device: device.trim() || deviceName(),
    // No agreement on record, so the first cycle takes the account's document.
    agreedHash: "",
    agreedUpdated: 0,
    localUpdated: 0,
    lastError: null,
  });
  const result = await run();
  if (!result.ok) throw new Error(result.why);
  return state();
}

/**
 * Re-seal everything under a new key.
 *
 * The only delete the protocol really has: a relay may ignore a deletion
 * request and anything ever fetched was ever copied, so making the old bytes
 * unreadable is the guarantee that can actually be kept. Every other device
 * loses access until it is paired again — publishing the new key sealed under
 * the old one would hand it straight back to the device being removed.
 */
export async function rotate(): Promise<{ message: string }> {
  const s = await state();
  if (!linked(s)) throw new Error("Sync is not set up on this device");
  await boot();
  const key = Namespace.generateKey();
  const payload = await openPayload(s);
  try {
    const { stranded, swept } = await payload.rotate(key);
    await patch({ namespaceKey: key, agreedHash: "", agreedUpdated: 0, localUpdated: Date.now() });
    return {
      message:
        swept === stranded
          ? `Rotated. ${stranded} old blob${stranded === 1 ? "" : "s"} removed from the relay.`
          : `Rotated. ${stranded - swept} of ${stranded} old blobs stay on the relay as ciphertext nothing can read.`,
    };
  } finally {
    payload.close();
  }
}

/**
 * Forget the account on this device only.
 *
 * The settings stay exactly as they are — unlinking is "stop syncing", not
 * "undo everything that ever synced", and a button that emptied the browser
 * would be a trap.
 */
export async function unlink(): Promise<void> {
  await setLocal(KEY.sync, { ...BLANK });
}

// ---------- when it runs ----------

export async function schedule(): Promise<void> {
  const s = await state();
  if (!s.enabled || !linked(s)) {
    await ext.alarms.clear(ALARM);
    return;
  }
  await ext.alarms.create(ALARM, { periodInMinutes: EVERY_MINUTES, delayInMinutes: 0.5 });
}

export const ALARM_NAME = ALARM;
