// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
/**
 * Who signs for the account: a key this page holds, a signer extension, or a
 * remote signer.
 *
 * The relay needs three things from an account — a signature on its AUTH
 * answer, on every pointer it publishes and on every blob upload — and
 * signing in with Nostr adds a fourth: NIP-44 to and from itself, to seal
 * and open the vault key. All three kinds of signer can do all four, so the
 * relay takes the interface and never learns which it has.
 *
 * Asynchronous throughout, because two of the three are a round trip: an
 * extension may put up a prompt, and a bunker is a message to an app on a
 * phone that somebody has to approve.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import * as nip44 from "./nip44";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface EventTemplate {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

export interface NostrSigner {
  /** The account's public key, hex (x-only). */
  readonly pubkey: string;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, payload: string): Promise<string>;
  /** Drop any connection the signer holds. Optional; most hold none. */
  close?(): Promise<void> | void;
}

/**
 * Which signer an install uses, as it is remembered between visits.
 *
 * Never the secret itself for the two signers that exist to keep it away
 * from this page. A pasted key stays where it always lived, in the
 * settings' `accountSecret`, and is recorded here only as "key".
 */
export type SignerChoice =
  | { kind: "key"; pubkey: string }
  | { kind: "nip07"; pubkey: string }
  | { kind: "bunker"; pubkey: string; bunker: string; clientSecret: string };

/* ------------------------------------------------------------ a raw key */

/**
 * A secret key held by this page. What every install used before Nostr
 * sign-in, and still what a pasted nsec becomes.
 */
export class Signer implements NostrSigner {
  readonly pubkey: string;

  constructor(private readonly secret: Uint8Array) {
    this.pubkey = bytesToHex(schnorr.getPublicKey(secret));
  }

  static generate(): Signer {
    return new Signer(schnorr.utils.randomPrivateKey());
  }

  static fromHex(hex: string): Signer {
    return new Signer(hexToBytes(hex));
  }

  toHex(): string {
    return bytesToHex(this.secret);
  }

  /** Synchronous, for the pairing channel's throwaway keys. */
  sign(kind: number, tags: string[][], content: string, createdAt: number): NostrEvent {
    const event = { pubkey: this.pubkey, created_at: createdAt, kind, tags, content };
    // NIP-01's canonical form, byte for byte, or the id will not match.
    const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const id = bytesToHex(sha256(utf8ToBytes(canonical)));
    return { ...event, id, sig: bytesToHex(schnorr.sign(id, this.secret)) };
  }

  async signEvent(t: EventTemplate): Promise<NostrEvent> {
    return this.sign(t.kind, t.tags, t.content, t.created_at);
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return nip44.encrypt(nip44.conversationKey(this.secret, peer), plaintext);
  }

  async nip44Decrypt(peer: string, payload: string): Promise<string> {
    return nip44.decrypt(nip44.conversationKey(this.secret, peer), payload);
  }
}

/* ---------------------------------------------------- a signer extension */

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, payload: string): Promise<string>;
  };
}

/** `window.nostr`, or OKX's copy of it, once one has been injected. */
export function findNip07(): Nip07 | null {
  const w = globalThis as { nostr?: Nip07; okxwallet?: { nostr?: Nip07 } };
  for (const p of [w.nostr, w.okxwallet?.nostr]) {
    if (p && typeof p.getPublicKey === "function" && typeof p.signEvent === "function") return p;
  }
  return null;
}

/** Extensions inject late and at different moments; wait a little for one. */
export async function waitForNip07(timeoutMs = 2000): Promise<Nip07 | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = findNip07();
    if (found || Date.now() >= deadline) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export class Nip07Signer implements NostrSigner {
  private constructor(
    private readonly provider: Nip07,
    readonly pubkey: string,
  ) {}

  /**
   * Connect to the extension, and insist it holds `expected` when given.
   *
   * The check matters: an extension can hold several keys and switch
   * between them, and syncing under the wrong one is a silent empty vault.
   */
  static async open(expected?: string, timeoutMs = 2000): Promise<Nip07Signer> {
    const provider = await waitForNip07(timeoutMs);
    if (!provider) throw new SignerError("No Nostr signer extension answered on this page.");
    if (!provider.nip44 || typeof provider.nip44.encrypt !== "function") {
      throw new SignerError(
        "Your signer extension cannot encrypt with NIP-44, which sync needs. Update it, or use a remote signer.",
      );
    }
    let pubkey: string;
    try {
      pubkey = await provider.getPublicKey();
    } catch (e) {
      throw new SignerError(`Your signer extension refused: ${message(e)}`);
    }
    if (expected && pubkey !== expected) {
      throw new SignerError(
        "Your signer extension is holding a different key from the one this account uses. Switch it to that key and try again.",
      );
    }
    return new Nip07Signer(provider, pubkey);
  }

  async signEvent(t: EventTemplate): Promise<NostrEvent> {
    const event = await this.provider.signEvent({ ...t });
    if (event.pubkey !== this.pubkey) throw new SignerError("the extension signed with a different key");
    return event;
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return this.provider.nip44!.encrypt(peer, plaintext);
  }

  nip44Decrypt(peer: string, payload: string): Promise<string> {
    return this.provider.nip44!.decrypt(peer, payload);
  }
}

/* ------------------------------------------------------ a remote signer */

/** A phone may need unlocking and a tap; be generous, but not forever. */
const BUNKER_TIMEOUT_MS = 90_000;

interface Bunker {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(pubkey: string, payload: string): Promise<string>;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export class RemoteSigner implements NostrSigner {
  private constructor(
    private readonly bunker: Bunker,
    readonly pubkey: string,
    /** What to remember so a reload reconnects without asking again. */
    readonly choice: Extract<SignerChoice, { kind: "bunker" }>,
  ) {}

  /**
   * Connect to a bunker (NIP-46).
   *
   * `clientSecret` is this app's own key towards the bunker. A new one means
   * a new connection the person approves; the remembered one reconnects
   * quietly, which is why it is kept with the choice rather than thrown away
   * as the sign-in button does.
   */
  static async open(
    input: string,
    options: { clientSecret?: string; expected?: string; onAuthUrl?: (url: string) => void } = {},
  ): Promise<RemoteSigner> {
    const [{ BunkerSigner, parseBunkerInput, toBunkerURL }, { generateSecretKey }] = await Promise.all([
      import("nostr-tools/nip46"),
      import("nostr-tools/pure"),
    ]);
    const pointer = await parseBunkerInput(input.trim()).catch(() => null);
    if (!pointer) {
      throw new SignerError("That is not a bunker:// address or a NIP-05 name — copy it from your signer app.");
    }
    const fresh = !options.clientSecret;
    const clientSecret = options.clientSecret ? hexToBytes(options.clientSecret) : generateSecretKey();
    const bunker = BunkerSigner.fromBunker(clientSecret, pointer, {
      onauth: (url: string) => options.onAuthUrl?.(url),
    }) as unknown as Bunker;
    try {
      const pubkey = await withTimeout(
        (async () => {
          // Only a new client connects. A remembered one is already known to
          // the bunker, and the pointer's one-time secret has been spent.
          if (fresh) await bunker.connect();
          return bunker.getPublicKey();
        })(),
        BUNKER_TIMEOUT_MS,
        "Your remote signer did not answer — check it is running and try again.",
      );
      if (options.expected && pubkey !== options.expected) {
        throw new SignerError("That remote signer holds a different key from the one this account uses.");
      }
      // The one-time secret is not kept: it has done its job, and a stored
      // copy is one more thing a reader of this storage could replay.
      const bunkerUrl = toBunkerURL({ ...pointer, secret: null });
      return new RemoteSigner(bunker, pubkey, {
        kind: "bunker",
        pubkey,
        bunker: bunkerUrl,
        clientSecret: bytesToHex(clientSecret),
      });
    } catch (e) {
      await bunker.close().catch(() => undefined);
      throw e instanceof SignerError ? e : new SignerError(message(e));
    }
  }

  private call<T>(work: Promise<T>): Promise<T> {
    return withTimeout(work, BUNKER_TIMEOUT_MS, "Your remote signer did not answer in time.");
  }

  async signEvent(t: EventTemplate): Promise<NostrEvent> {
    return this.call(this.bunker.signEvent({ ...t }));
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return this.call(this.bunker.nip44Encrypt(peer, plaintext));
  }

  nip44Decrypt(peer: string, payload: string): Promise<string> {
    return this.call(this.bunker.nip44Decrypt(peer, payload));
  }

  async close(): Promise<void> {
    await this.bunker.close().catch(() => undefined);
  }
}

/* ---------------------------------------------------------------- misc */

export class SignerError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SignerError";
  }
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "the signer refused";
}

function withTimeout<T>(work: Promise<T>, ms: number, detail: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignerError(detail)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
