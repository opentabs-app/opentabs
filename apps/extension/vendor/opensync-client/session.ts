// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
import init, {
  Clipboard,
  effectiveRpId,
  generateAccountKey,
  Namespace,
  originVerdict,
  pageOrigin,
  parseAccountKey,
  parseVaultKey,
  Passkeys,
  rpIdVerdict,
  Secrets,
} from "./wasm/opensync_wasm.js";
import { QuotaError, Relay, Signer } from "./relay";

export {
  QuotaError,
  Relay,
  Signer,
  Clipboard,
  Secrets,
  Passkeys,
  Namespace,
  originVerdict,
  rpIdVerdict,
  effectiveRpId,
  pageOrigin,
  parseAccountKey,
  parseVaultKey,
  generateAccountKey,
};

let started: Promise<void> | null = null;

/**
 * Where the compiled core comes from: a URL to fetch (a bundler's `.wasm`
 * asset), bytes, a `Response`, or an already compiled module.
 */
export type WasmSource = string | URL | Request | Response | BufferSource | WebAssembly.Module;

/**
 * Instantiate the wasm module once per page.
 *
 * With no argument it comes from the base64 copy inlined beside the glue,
 * which is what a single-file bundle (the Obsidian plugin, an extension's
 * service worker, the Node checks) needs: nothing to fetch, the same path on
 * desktop and mobile. That copy is 1.65 MB of JavaScript, so it is loaded by a
 * dynamic import — esbuild without splitting folds it back into the bundle,
 * and a bundler that serves `.wasm` as an asset never has to ship it.
 *
 * A web app passes the asset's URL instead, which compiles while it streams.
 * Whichever call comes first wins; later calls share its promise, so library
 * code can keep calling `ready()` with no argument after the host chose.
 * A failed start is not cached, so the next call tries again.
 *
 * **In a service worker, the host must call `ready(url)` first unless its
 * bundler inlines the dynamic import.** `import()` is disallowed inside a
 * `ServiceWorkerGlobalScope` by the HTML spec whatever the manifest says —
 * `"type": "module"` enables *static* import only. esbuild with `bundle: true`
 * and no splitting folds this one back into the bundle, so OpenPassword's
 * worker never reaches it; a bundler that preserves it, as Vite does, rejects
 * here. The catch below is what makes that say so, because otherwise Vite's
 * own preload helper handles the rejection by calling `window.dispatchEvent`
 * and the reported error is `window is not defined`, four frames from
 * anything to do with wasm.
 */
/** The inlined copy, or an error that names why there is not one here. */
async function inlineWasm(): Promise<string> {
  try {
    return (await import("./wasm/inline")).WASM_BASE64;
  } catch (cause) {
    // Read off globalThis rather than naming the type: a web app's tsconfig
    // has no service-worker lib, and this file is compiled by both.
    const scope = (globalThis as { ServiceWorkerGlobalScope?: new () => unknown })
      .ServiceWorkerGlobalScope;
    const worker = !!scope && globalThis instanceof scope;
    const error = new Error(
      worker
        ? "ready() with no argument needs a dynamic import, which a service worker " +
          "may not do. Either call ready(url) with the .wasm asset's URL, or bundle " +
          "this worker with esbuild, which folds the import back in."
        : "could not load the inlined wasm; call ready(url) with the .wasm asset's URL",
    );
    // Assigned rather than passed: `new Error(msg, { cause })` is ES2022, and
    // the extension compiles against an older lib — so the tidier form breaks
    // a consumer's typecheck rather than this file's.
    (error as { cause?: unknown }).cause = cause;
    throw error;
  }
}

export function ready(source?: WasmSource): Promise<void> {
  if (!started) {
    started = (async () => {
      const input = source ?? base64ToBytes(await inlineWasm());
      if (input instanceof Uint8Array && input.length === 0) {
        throw new Error("this build does not include the inline wasm; call ready(url) first");
      }
      await init({ module_or_path: input });
    })().catch((e) => {
      started = null;
      throw e;
    });
  }
  return started;
}

export interface Keys {
  /** Identifies the account to the relay. Never sees payload content. */
  accountSecret: string;
  /** Encrypts everything before it leaves the device. */
  namespaceKey: string;
}

export interface Endpoint {
  ws: string;
  http: string;
}

interface Pointer {
  root: string;
  generation: number;
  updated_at: number;
}

interface ManifestJson {
  generation: number;
  updated_at: number;
  entries: Record<string, { size: number; mtime: number; chunks: { content: string; blob: string; len: number }[] }>;
}

interface Commit {
  pointer: string;
  root: string;
  generation: number;
  blobs: { id: string; bytes: Uint8Array }[];
}

/**
 * One namespace holding a handful of small files.
 *
 * The clipboard and the secret store are each a single payload of a few
 * kilobytes, rewritten whole on each change. A cleverer layout would buy
 * nothing at that size and cost the thing that matters most here, which is
 * that the read path and the write path are short enough to hold in your head.
 *
 * Vaults are the case that needs the full engine; these are not.
 *
 * # Why several files rather than several namespaces
 *
 * OpenPassword keeps passwords and passkeys side by side, and the obvious
 * alternative — a second namespace with its own pointer — was rejected for
 * one reason: **rotation**. Re-sealing under a new key is the only real
 * delete this protocol has, and across two namespaces it becomes two
 * operations that can half-succeed. A crash between them strands one half of
 * a user's vault under a key nobody holds any more. One pointer, one
 * manifest, one generation, one `rotate` — and the atomicity is the engine's
 * rather than every caller's to remember.
 *
 * The cost is that a commit rebuilds the manifest from what was staged, so
 * every file has to be pushed together. `pushAll` enforces that rather than
 * trusting callers to know it.
 */
export class Payload {
  private pointer: Pointer | null = null;
  /** Every file this namespace holds. See `pushAll` for why all of them. */
  private readonly files: string[];

  constructor(
    private ns: Namespace,
    private readonly relay: Relay,
    private readonly namespace: string,
    files: string | string[],
  ) {
    this.files = typeof files === "string" ? [files] : [...files];
    if (this.files.length === 0) throw new Error("a payload needs at least one file");
  }

  static async open(
    keys: Keys,
    endpoint: Endpoint,
    namespace: string,
    files: string | string[],
  ): Promise<Payload> {
    await ready();
    // Both keys go through the Rust decoder, so `nsec1…`, `ovault1…` and bare
    // hex all work, and a key pasted into the wrong field is rejected here
    // with a reason rather than producing a vault nobody can read.
    return new Payload(
      new Namespace(keys.namespaceKey),
      new Relay(
        endpoint.ws,
        endpoint.http.replace(/\/$/, ""),
        Signer.fromHex(parseAccountKey(keys.accountSecret)),
      ),
      namespace,
      files,
    );
  }

  close(): void {
    this.relay.close();
  }

  /** Reassemble one manifest entry from its chunks. */
  private async read(entry: ManifestJson["entries"][string]): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (const chunk of entry.chunks) {
      const sealed = await this.relay.getBlob(chunk.blob);
      if (!sealed) throw new Error("the store is missing a chunk");
      // Verified against what the manifest promised, every time. The AEAD tag
      // proves it was sealed with our key; the hash proves it is the blob we
      // asked for and not a different, equally valid one of ours.
      parts.push(this.ns.openChunk(sealed, chunk.content));
    }
    return concat(parts);
  }

  /**
   * What the remote holds for every declared file.
   *
   * A file the relay has never been given is `null` rather than absent, so a
   * caller destructuring the result cannot mistake "not published yet" for
   * "this file is not one of ours".
   */
  async pullAll(): Promise<Record<string, Uint8Array | null>> {
    const out: Record<string, Uint8Array | null> = {};
    for (const file of this.files) out[file] = null;

    const hex = await this.relay.fetchPointer(this.namespace);
    if (!hex) return out;

    const pointer: Pointer = this.ns.openPointer(hex);
    const sealedManifest = await this.relay.getBlob(pointer.root);
    if (!sealedManifest) throw new Error("the relay is advertising a manifest it does not hold");

    const manifest: ManifestJson = this.ns.openManifest(sealedManifest);
    for (const file of this.files) {
      const entry = manifest.entries[file];
      if (!entry) continue;
      const bytes = await this.read(entry);
      // A zero-length file reads as `null`, not as empty bytes. `rotate` pads
      // a file that has never been published so that `pushAll` accepts the
      // set, and every caller here goes on to hand what it got to a CBOR
      // decoder — which rejects an empty input rather than treating it as an
      // empty store. "Published as nothing" and "never published" are the
      // same thing to everyone upstream, so they answer the same.
      out[file] = bytes.length ? bytes : null;
    }
    this.pointer = pointer;
    return out;
  }

  /** What the remote holds, or null if nothing has ever been published. */
  async pull(): Promise<Uint8Array | null> {
    if (this.files.length !== 1) {
      throw new Error("this payload holds several files — use pullAll");
    }
    return (await this.pullAll())[this.files[0]];
  }

  /**
   * Publish every file, together.
   *
   * **All of them, every time**, and the method throws rather than accepting a
   * subset. A commit rebuilds the manifest from what was staged, so a push
   * carrying only `secrets.cbor` does not leave `passkeys.cbor` alone — it
   * publishes a manifest in which `passkeys.cbor` does not appear, and every
   * passkey on the account is gone. Requiring the full set turns that into an
   * exception on the first run rather than a data loss report later.
   *
   * Blobs first, pointer last, always. Publishing the pointer first would
   * leave a peer fetching a manifest that names content nobody has yet.
   */
  async pushAll(files: Record<string, Uint8Array>): Promise<void> {
    const missing = this.files.filter((f) => !(f in files));
    if (missing.length) {
      throw new Error(`pushAll must carry every file: ${missing.join(", ")} was not supplied`);
    }

    this.ns.clear();
    // Everything supplied, not merely everything declared. `rotate` hands over
    // whatever the manifest held, which may include a file this caller has
    // never heard of — and dropping it here would be the same silent deletion
    // this method exists to prevent, arriving by the other door.
    for (const [file, bytes] of Object.entries(files)) this.ns.stage(file, bytes);

    const generation = BigInt((this.pointer?.generation ?? 0) + 1);
    const commit: Commit = this.ns.commit(generation, BigInt(Math.floor(Date.now() / 1000)));

    for (const blob of commit.blobs) {
      if (await this.relay.hasBlob(blob.id)) continue;
      await this.relay.putBlob(blob.bytes);
    }
    await this.relay.publishPointer(this.namespace, commit.pointer);
    this.pointer = null; // re-read on the next pull
  }

  /** Publish `bytes`, for a payload holding one file. */
  async push(bytes: Uint8Array): Promise<void> {
    if (this.files.length !== 1) {
      throw new Error("this payload holds several files — use pushAll");
    }
    return this.pushAll({ [this.files[0]]: bytes });
  }

  /**
   * Re-seal this payload under `newKey`, so everything already on the relay
   * becomes ciphertext nobody holds a key for.
   *
   * The only meaningful delete the protocol has: a relay may ignore a deletion
   * request, and anything ever fetched was ever copied, so making the old
   * bytes unreadable is the guarantee that can actually be kept. The sweep
   * afterwards is tidying, and its `swept` count is reported next to
   * `stranded` precisely so a caller cannot mistake one for the other.
   *
   * Every other device on this account loses access until it is paired again.
   * That is not an oversight: publishing the new key sealed under the old one
   * would hand it to the device you were rotating away from.
   *
   * **Everything in the manifest is carried**, not merely the declared files.
   * A rotation is the one operation that rewrites the whole namespace, and a
   * file this caller happens not to know about is still somebody's data.
   *
   * Note that `pushAll` does not read the relay first, so unlike a vault sync
   * there is no moment here where a pointer sealed under the replaced key has
   * to be opened.
   */
  async rotate(newKey: string): Promise<{ stranded: number; swept: number }> {
    const stranded = new Set<string>();
    const carried: Record<string, Uint8Array> = {};

    const hex = await this.relay.fetchPointer(this.namespace);
    if (hex) {
      // Everything must be readable under the old key before the key is
      // swapped. Getting that order wrong publishes a manifest with holes and
      // destroys the only key that could have filled them.
      const pointer: Pointer = this.ns.openPointer(hex);
      stranded.add(pointer.root);
      const sealedManifest = await this.relay.getBlob(pointer.root);
      if (!sealedManifest) throw new Error("the relay is advertising a manifest it does not hold");
      const manifest: ManifestJson = this.ns.openManifest(sealedManifest);
      for (const entry of Object.values(manifest.entries)) {
        for (const chunk of entry.chunks) stranded.add(chunk.blob);
      }
      for (const [name, entry] of Object.entries(manifest.entries)) {
        try {
          carried[name] = await this.read(entry);
        } catch {
          throw new Error(`the store is missing a chunk of ${name} — nothing was rotated`);
        }
      }
    }

    this.ns = new Namespace(newKey);
    this.pointer = null;
    // Every declared file has to be present for `pushAll`; one that has never
    // been published yet rotates as empty rather than blocking the rotation.
    if (Object.keys(carried).length) {
      for (const file of this.files) carried[file] ??= new Uint8Array();
      await this.pushAll(carried);
    }

    let swept = 0;
    for (const id of stranded) if (await this.relay.deleteBlob(id)) swept += 1;
    return { stranded: stranded.size, swept };
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
