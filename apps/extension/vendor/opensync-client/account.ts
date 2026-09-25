// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
/**
 * Signing in with a Nostr key: the account is the npub, and the vault key is
 * sealed to it.
 *
 * The browser half of `crates/opensync-nostr/src/account.rs`, and the record
 * is the same record, byte for byte in meaning:
 *
 * ```text
 * kind 30078, d = "opensync:keys", by the account's own npub
 * content = nip44(own key → own key, {"v":1,"vault":"ovault1…","created_at":…})
 * ```
 *
 * Any device signed in with the same key — pasted, in an extension, or in a
 * bunker on a phone — reads it and has the vault. A device that had its own
 * random keys before this existed brings its data along rather than
 * starting over.
 */
import { decode, encodeBytes, npubEncode } from "nostr-tools/nip19";
import { hexToBytes } from "@noble/hashes/utils";
import { Relay } from "./relay";
import { Nip07Signer, RemoteSigner, Signer, type NostrSigner, type SignerChoice } from "./signer";
import { Payload, ready, type Endpoint, type Keys } from "./session";
import { Namespace, parseAccountKey, parseVaultKey } from "./wasm/opensync_wasm.js";

/** The record's `d` tag. Not a namespace anybody syncs files into. */
export const KEYS_RECORD = "opensync:keys";

/** What signing in found. The same three answers as the Rust `Setup`. */
export type Setup = "joined" | "created" | "adopted";

export interface SignedIn {
  setup: Setup;
  /** `ovault1…`, whatever form this device's old key was in. */
  namespaceKey: string;
  pubkey: string;
  npub: string;
}

interface KeysRecord {
  v: number;
  vault: string;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export function npubOf(pubkeyHex: string): string {
  return npubEncode(pubkeyHex);
}

/** The hex pubkey inside an `npub1…`, or null if it is not one. */
export function pubkeyOfNpub(npub: string): string | null {
  try {
    const decoded = decode(npub.trim());
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

/** A vault key as `ovault1…`, from either form the settings may hold. */
export function vaultString(key: string): string {
  return encodeBytes("ovault", hexToBytes(parseVaultKey(key)));
}

/** Seal a vault key into a record's content. */
export async function sealVault(signer: NostrSigner, vault: string, createdAt = now()): Promise<string> {
  await ready();
  // Field order as the Rust struct serialises it, so a record reads the same
  // whichever side wrote it.
  const record: KeysRecord = { v: 1, vault: vaultString(vault), created_at: createdAt };
  return signer.nip44Encrypt(signer.pubkey, JSON.stringify(record));
}

/** Open a record's content, returning the vault key as `ovault1…`. */
export async function openVault(signer: NostrSigner, content: string): Promise<string> {
  let record: KeysRecord;
  try {
    record = JSON.parse(await signer.nip44Decrypt(signer.pubkey, content));
  } catch (e) {
    throw new Error(`the sync record on the relay could not be opened with this key: ${message(e)}`);
  }
  if (record.v !== 1) {
    throw new Error(`the sync record is version ${record.v}, newer than this app — update it`);
  }
  if (typeof record.vault !== "string" || !record.vault.startsWith("ovault1")) {
    throw new Error("the sync record does not hold a vault key");
  }
  await ready();
  // Through the Rust decoder: a checksum failure here is a corrupt record,
  // and syncing under a key that merely looks right would be worse.
  return vaultString(record.vault);
}

/** Read and open the sealed vault key, if the account has one. */
export async function readVaultKey(relay: Relay, signer: NostrSigner): Promise<string | null> {
  const content = await relay.fetchRecord(KEYS_RECORD);
  return content ? openVault(signer, content) : null;
}

/** Publish the sealed vault key, replacing any earlier one. */
export async function writeVaultKey(relay: Relay, signer: NostrSigner, vault: string): Promise<void> {
  await relay.publishRecord(KEYS_RECORD, await sealVault(signer, vault));
}

/**
 * Sign this device in with a Nostr key.
 *
 * `existing` is the vault key this device already holds, if it was set up
 * with random keys before. It is used only when the account has no record
 * yet; an account that already has one wins, and the caller moves this
 * device's old data across with {@link moveNamespace}.
 */
export async function signInWithNostr(
  signer: NostrSigner,
  endpoint: Endpoint,
  existing?: string | null,
): Promise<SignedIn> {
  await ready();
  const relay = new Relay(endpoint.ws, endpoint.http.replace(/\/$/, ""), signer);
  const done = (setup: Setup, namespaceKey: string): SignedIn => ({
    setup,
    namespaceKey,
    pubkey: signer.pubkey,
    npub: npubOf(signer.pubkey),
  });
  try {
    const found = await readVaultKey(relay, signer);
    if (found) return done("joined", found);

    const [setup, vault]: [Setup, string] = existing
      ? ["adopted", vaultString(existing)]
      : ["created", Namespace.generateKey()];
    await writeVaultKey(relay, signer, vault);
    // Read it back. Two devices signing in to a brand-new account in the
    // same second each write a record and the relay keeps one: the loser
    // must use the winner's key, or it syncs into a vault nobody else opens.
    const settled = (await readVaultKey(relay, signer)) ?? vault;
    return done(settled === vault ? setup : "joined", settled);
  } finally {
    relay.close();
  }
}

/**
 * Copy one namespace from an old identity into the Nostr one.
 *
 * Reads everything the old keys can read and merges it into what the new
 * account already holds — merged, not overwritten, so an account with data
 * keeps it and gains this device's too. The old copy is left where it was:
 * it is ciphertext under keys this device stops using, and deleting it would
 * cost a device that has not moved yet everything.
 *
 * `merge` is the app's own union for its files, the same one a sync uses.
 * Returns how many files came across; zero when there was nothing to move.
 */
export async function moveNamespace(options: {
  endpoint: Endpoint;
  from: Keys;
  to: Keys;
  namespace: string;
  files: string[];
  merge: (
    into: Record<string, Uint8Array | null>,
    from: Record<string, Uint8Array | null>,
  ) => Record<string, Uint8Array>;
}): Promise<number> {
  const { endpoint, from, to, namespace, files } = options;
  const old = await Payload.open(from, endpoint, namespace, files);
  let held: Record<string, Uint8Array | null>;
  try {
    held = await old.pullAll();
  } finally {
    old.close();
  }
  const count = Object.values(held).filter(Boolean).length;
  if (!count) return 0;

  const next = await Payload.open(to, endpoint, namespace, files);
  try {
    let there: Record<string, Uint8Array | null> = Object.fromEntries(files.map((f) => [f, null]));
    try {
      there = await next.pullAll();
    } catch (e) {
      // The same identity under a different vault key is the one case where
      // the pointer there is the one just read, sealed under the old key.
      // Anything else — a relay failure — is not ours to paper over.
      if (!samePubkey(from, to)) throw e;
    }
    await next.pushAll(options.merge(there, held));
  } finally {
    next.close();
  }
  return count;
}

function samePubkey(a: Keys, b: Keys): boolean {
  try {
    const pa = a.signer?.pubkey ?? Signer.fromHex(parseAccountKey(a.accountSecret)).pubkey;
    const pb = b.signer?.pubkey ?? Signer.fromHex(parseAccountKey(b.accountSecret)).pubkey;
    return pa === pb;
  } catch {
    return false;
  }
}

/**
 * The signer a saved choice describes, reconnected.
 *
 * `accountSecret` is where a pasted key has always lived; a choice of
 * "key", or no choice at all (an install from before sign-in), signs with
 * it. The other two never had a secret here to begin with.
 */
export async function openSigner(
  choice: SignerChoice | undefined,
  accountSecret: string,
  options: { onAuthUrl?: (url: string) => void } = {},
): Promise<NostrSigner> {
  if (choice?.kind === "nip07") return Nip07Signer.open(choice.pubkey);
  if (choice?.kind === "bunker") {
    return RemoteSigner.open(choice.bunker, {
      clientSecret: choice.clientSecret,
      expected: choice.pubkey,
      onAuthUrl: options.onAuthUrl,
    });
  }
  await ready();
  return Signer.fromHex(parseAccountKey(accountSecret));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Publish a new vault key after a rotation, so a device that signs in next
 * gets the key that opens the vault now rather than the one rotated away.
 */
export async function republishVaultKey(signer: NostrSigner, endpoint: Endpoint, vault: string): Promise<void> {
  await ready();
  const relay = new Relay(endpoint.ws, endpoint.http.replace(/\/$/, ""), signer);
  try {
    await writeVaultKey(relay, signer, vault);
  } finally {
    relay.close();
  }
}
