/**
 * The document that travels between devices, and the rule that decides which
 * way it moves.
 *
 * `storage.sync` already follows a *browser profile*. This does not replace
 * it; it crosses the boundary that one cannot — Chrome to Firefox, a work
 * profile to a personal one, a machine that is not signed into anything. The
 * bytes are sealed on the device by OpenSync before they leave, so the relay
 * holds ciphertext and a public key and knows nothing else.
 *
 * Everything travels, secrets included: calendar addresses, the weather key,
 * the X token. Those are excluded from the copy-paste config string for the
 * obvious reason — it is plaintext someone pastes into a chat window. Here
 * they are sealed, and leaving them behind would mean a newly paired device
 * still needing a manual round of setup for the only fields that are actually
 * annoying to retype.
 *
 * No storage access and no network in this file: it is the part worth
 * testing directly.
 */
import { configHashOf } from "./payload";
import type { Config, LocalState } from "./types";

export const DOC_VERSION = 1;

/** What is under sync. Anything not named here is derived and refetchable. */
export interface SyncBody {
  config: Config;
  local: LocalState;
}

export interface SyncDoc extends SyncBody {
  v: number;
  /** ms since epoch: when the writing device last *changed* something. */
  updated: number;
  /** Whoever wrote it, so a status line can say "changed on Work laptop". */
  device: string;
}

/**
 * A stable fingerprint of the content, ignoring who wrote it and when.
 *
 * This is what makes the sync rule below able to tell "the other device
 * changed something" from "the other device merely synced". Without it every
 * push looks like a change to everyone else, and two idle devices ping-pong
 * a document neither of them edited.
 */
export function fingerprint(body: SyncBody): string {
  return configHashOf({ config: body.config, local: body.local });
}

export function encode(doc: SyncDoc): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

/**
 * Read a document off the relay.
 *
 * Returns null rather than throwing for anything unrecognisable. A document
 * this build cannot read is not an error state to put in front of someone —
 * it means another version of OpenTabs wrote it, and the answer is to leave
 * it alone rather than to overwrite it or to break.
 */
export function decode(bytes: Uint8Array): SyncDoc | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const doc = parsed as Partial<SyncDoc>;
  if (doc.v !== DOC_VERSION) return null;
  if (!doc.config || typeof doc.config !== "object") return null;
  return {
    v: DOC_VERSION,
    updated: typeof doc.updated === "number" ? doc.updated : 0,
    device: typeof doc.device === "string" ? doc.device : "another device",
    config: doc.config as Config,
    local: (doc.local ?? {}) as LocalState,
  };
}

/** What both sides last agreed on. Null until this device has ever synced. */
export interface Agreed {
  hash: string;
  updated: number;
}

export type Plan =
  | { action: "push"; why: string }
  | { action: "pull"; why: string }
  | { action: "idle"; why: string };

/**
 * Which way the document moves.
 *
 * Last-writer-wins over the whole document, but only for a *genuine*
 * collision. Because both sides carry a fingerprint of what was last agreed,
 * the common cases — one side edited, the other did not — resolve without
 * anyone's work being weighed against anyone else's. Only two devices edited
 * since the last sync reaches the timestamp, and then the newer edit wins and
 * the older one is lost.
 *
 * That last sentence is the honest limitation. Merging a to-do list properly
 * needs per-item timestamps and tombstones for deletes, or a delete on one
 * device comes back from the other. That is a bigger change than sync itself
 * and it should be its own decision, so this does the simple thing and says
 * so plainly in the settings pane.
 *
 * The first sync on a newly paired device is the one asymmetric case: with no
 * agreement on record and a document already on the relay, it **takes** the
 * remote. A device that has just joined an account holds defaults it never
 * chose, and pushing those would wipe the account it was invited into.
 */
export function decide(
  localHash: string,
  localUpdated: number,
  remote: SyncDoc | null,
  agreed: Agreed | null,
): Plan {
  if (!remote) return { action: "push", why: "nothing on the relay yet" };

  const remoteHash = fingerprint(remote);
  if (remoteHash === localHash) return { action: "idle", why: "already the same" };

  if (!agreed) {
    return { action: "pull", why: "first sync on this device — taking the account's settings" };
  }

  const localChanged = localHash !== agreed.hash;
  const remoteChanged = remoteHash !== agreed.hash;

  if (!localChanged && !remoteChanged) {
    // Different content, yet neither side differs from what was agreed. Only
    // reachable if the fingerprint function changed under us; taking the
    // remote is the choice that converges rather than fighting.
    return { action: "pull", why: "the agreed fingerprint no longer matches either side" };
  }
  if (!localChanged) return { action: "pull", why: `changed on ${remote.device}` };
  if (!remoteChanged) return { action: "push", why: "changed here" };

  return remote.updated > localUpdated
    ? { action: "pull", why: `both changed — ${remote.device} edited more recently` }
    : { action: "push", why: "both changed — this device edited more recently" };
}
