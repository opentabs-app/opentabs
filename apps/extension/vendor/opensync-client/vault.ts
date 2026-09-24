// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
import { Namespace } from "./wasm/opensync_wasm.js";
import { Relay, type RelayOptions } from "./relay";
import { ready, signerOf, type Endpoint, type Keys } from "./session";
import * as wasm from "./wasm/opensync_wasm.js";

/**
 * A vault of files, synced as one namespace.
 *
 * This loop used to live only inside the Obsidian plugin. It moved here so
 * that every surface syncing a vault — the plugin, OpenMarkdown in the
 * browser, anything after — runs the same code over the same wasm: a
 * disagreement between two copies of *this* is not a compile error, it is a
 * file moved to the trash on somebody else's device. `checks/vaultcheck.ts`
 * drives it against a real relay.
 *
 * What it does, in order, and unchanged in behaviour from the plugin:
 *
 * 1. Stage the vault, commit, read the relay's pointer (never write blind).
 * 2. Nothing remote: publish. Same content: adopt theirs.
 * 3. We did not diverge from the last synced manifest: fast-forward.
 * 4. We did: merge in wasm (whole-file last-writer-wins with conflict copies
 *    named after the device whose version is inside), apply, republish.
 *
 * What it does *not* do any more, because each one was measured:
 *
 * - **Re-read every file on every sync.** A local index records the size
 *   and mtime each file had when it last matched the synced manifest, and a
 *   byte cache keeps what was already read. A vault with no local changes is
 *   not staged or sealed at all; a vault with one change reads one file.
 * - **`HEAD` every blob before publishing.** Blobs the relay's own manifest
 *   names are on the relay by construction, so only the new ones are asked
 *   about — in parallel, or with one `/list` when there are many.
 * - **Fetch chunks for files it already has.** An entry whose chunks match
 *   what this device holds is not downloaded.
 * - **Wait for a local edit before pulling.** `watch()` holds a live
 *   subscription to the pointer, so a device that never edits still hears
 *   every other device's changes.
 */

/**
 * What the free plan carries: the file types a vault is *written* in, as
 * opposed to the ones it accumulates.
 *
 * Chosen by weight rather than by importance. A note, a canvas, a Bases
 * table and an Excalidraw drawing are all a few kilobytes of text; a
 * screenshot, a PDF or a voice memo is three orders of magnitude bigger, and
 * attachments are the only thing here that costs real money to keep. The list
 * is deliberately an allow-list: a file type nobody anticipated is far more
 * likely to be a new kind of binary than a new kind of prose.
 */
export const FREE_EXTENSIONS: readonly string[] = [
  "md", // notes, and Excalidraw drawings, which are markdown
  "canvas", // Obsidian Canvas
  "base", // Obsidian Bases
  "excalidraw", // the legacy Excalidraw format, plain JSON
  "json", // plugin data, and drawings
  "csv", // tables, Dataview sources
  "txt",
  "svg", // diagrams — vector, so text, and small
  "css", // themes and snippets
  "yaml",
  "yml",
  "bib", // citations
  "drawio", // diagrams.net, which is XML
];

export interface Pointer {
  root: string;
  generation: number;
  updated_at: number;
}

export interface ManifestEntry {
  size: number;
  mtime: number;
  chunks: { content: string; blob: string; len: number }[];
}

export interface ManifestJson {
  generation: number;
  updated_at: number;
  entries: Record<string, ManifestEntry>;
  /** The device that published it. Absent on manifests written before the field existed. */
  device?: string;
  /** The extensions the publisher was carrying. Absent means everything. */
  scope?: string[];
}

interface Commit {
  /** Hex, because it rides in a Nostr event's content field. */
  pointer: string;
  root: string;
  generation: number;
  blobs: { id: string; bytes: Uint8Array }[];
}

interface MergeOutcome {
  merged: ManifestJson;
  conflicts: { path: string; copy_path: string }[];
}

/**
 * Does this manifest have anything to say about `path`?
 *
 * `false` means the device that wrote it was not carrying this kind of file,
 * so the path's absence is silence rather than a deletion. Mirrors
 * `Manifest::covers` in the engine; the two must agree, because one decides
 * what the merge keeps and the other decides what gets moved to the trash.
 */
export function covers(manifest: Pick<ManifestJson, "scope">, path: string): boolean {
  if (!manifest.scope) return true;
  const ext = extensionOf(path);
  return ext !== "" && manifest.scope.includes(ext);
}

/** The blob endpoint beside a relay: same host, the other scheme. */
export function storageFor(ws: string): string {
  if (!ws) return "";
  if (ws.startsWith("wss://")) return `https://${ws.slice(6).replace(/\/+$/, "")}`;
  if (ws.startsWith("ws://")) return `http://${ws.slice(5).replace(/\/+$/, "")}`;
  return "";
}

/**
 * Is this device storing on the relay we pay for?
 *
 * Only then does a plan mean anything. A relay of your own is unmetered,
 * because the storage is yours and so is the bill — what is sold is running
 * the server, so the gate reads the relay's host rather than a receipt.
 */
export function isMetered(relayWs: string, hostedRelay: string, plan: "free" | "supporter"): boolean {
  if (plan === "supporter") return false;
  const hosted = hostedRelay.trim();
  if (!hosted) return false;
  const host = (url: string) => {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return "";
    }
  };
  const ours = host(hosted) || hosted.toLowerCase();
  const mine = host(relayWs);
  return mine !== "" && mine === ours;
}

/** Same files, same bytes — mtime and generation deliberately ignored. */
export function sameContent(a: ManifestJson, b: ManifestJson): boolean {
  const ak = Object.keys(a.entries);
  if (ak.length !== Object.keys(b.entries).length) return false;
  return ak.every((path) => b.entries[path] !== undefined && sameEntry(a.entries[path], b.entries[path]));
}

function sameEntry(x: ManifestEntry | undefined, y: ManifestEntry | undefined): boolean {
  return (
    !!x &&
    !!y &&
    x.chunks.length === y.chunks.length &&
    x.chunks.every((c, i) => c.content === y.chunks[i].content)
  );
}

/** A file as the host sees it. `mtime` in milliseconds, whatever the host's clock. */
export interface FileStat {
  path: string;
  size: number;
  mtime: number;
}

/**
 * The storage a vault lives in. Each app implements this over its own file
 * API — Obsidian's `app.vault`, OpenMarkdown's, a directory in Node.
 */
export interface VaultHost {
  /** Every file this device syncs. The loop applies the plan's scope itself. */
  list(): Promise<FileStat[]>;
  /** One file, or `null` if it does not exist. */
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Uint8Array>;
  /** Create or replace, making parent folders as needed. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Remove a file another device deleted. The host decides whether that means a trash folder. */
  delete(path: string): Promise<void>;
  /**
   * Called before a remote change replaces or removes a local file, so the
   * host can snapshot it (OpenMarkdown hands it to file recovery).
   */
  beforeReplace?(path: string, reason: "remote-update" | "remote-delete"): Promise<void>;
  /** Local changes as they happen. Optional: without it, the index still finds them. */
  watch?(onChange: (path: string) => void): () => void;
}

/** What must survive a restart: without it, the next fork merges against nothing. */
export interface SyncState {
  pointer: Pointer | null;
  base: ManifestJson | null;
  /** Size and mtime of each file when it last matched `base`. */
  index?: Record<string, { size: number; mtime: number }>;
}

export interface StateStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}

export interface SyncOutcome {
  /** What happened, in one word, for a status line. */
  kind: "up-to-date" | "published" | "pulled" | "merged";
  /** Paths written from another device. */
  pulled: string[];
  /** Paths removed because another device deleted them. */
  deleted: string[];
  /** Blobs uploaded. */
  pushed: number;
  conflicts: { path: string; copy_path: string }[];
  /** Files present here that this device's plan does not carry. */
  heldBack: string[];
  generation: number;
}

export interface VaultSyncOptions {
  keys: Keys;
  endpoint: Endpoint;
  /** `vault:main` for a plugin-compatible vault. */
  namespace: string;
  /**
   * This device's name, sealed into what it publishes so another device can
   * name a conflict copy after it. Make it the device ("Edge on macOS"),
   * never the vault: two devices on one vault share the vault's name, and a
   * copy "from My vault" on both sides tells nobody anything.
   */
  device: string;
  /** Carry every file, rather than `FREE_EXTENSIONS`. Pass `wants && !isMetered(…)`. */
  carryAll: boolean;
  host: VaultHost;
  state: StateStore;
  /** Parallel blob requests. */
  concurrency?: number;
  /** Bytes kept in memory so an unchanged file is not read again to be staged. */
  cacheBytes?: number;
  relay?: RelayOptions;
  /** A local change the host reported, for a scheduler to act on. */
  onLocalChange?: (path: string) => void;
}

const LIST_THRESHOLD = 24;
const MAX_CACHED_FILE = 4 * 1024 * 1024;

/** One vault, one namespace, one relay. */
export class VaultSync {
  private ns: Namespace;
  readonly relay: Relay;
  private state: SyncState = { pointer: null, base: null, index: {} };
  private readonly cache = new Map<string, { size: number; mtime: number; bytes: Uint8Array }>();
  private cached = 0;
  /** Paths the host reported changed since they were last staged. */
  private touched = new Set<string>();
  /** Paths this loop is writing right now, whose change events are its own. */
  private readonly applying = new Set<string>();
  /** Blobs known to be on the relay without asking. */
  private readonly uploaded = new Set<string>();
  private lastPointerHex: string | null = null;
  private running: Promise<SyncOutcome> | null = null;
  private queued: Promise<SyncOutcome> | null = null;
  private readonly unwatchHost: (() => void) | null = null;
  private readonly concurrency: number;
  private readonly cacheBytes: number;
  private closed = false;

  private constructor(private readonly o: VaultSyncOptions) {
    this.ns = new Namespace(o.keys.namespaceKey);
    this.relay = new Relay(
      o.endpoint.ws,
      o.endpoint.http.replace(/\/$/, ""),
      // Through the Rust decoder, so `nsec1…` and bare hex both work — or
      // the extension or remote signer the account signed in with.
      signerOf(o.keys),
      o.relay,
    );
    this.concurrency = Math.max(1, o.concurrency ?? 6);
    this.cacheBytes = o.cacheBytes ?? 64 * 1024 * 1024;
    this.unwatchHost =
      o.host.watch?.((path) => {
        if (this.applying.has(path)) return;
        this.touched.add(path);
        o.onLocalChange?.(path);
      }) ?? null;
  }

  static async open(o: VaultSyncOptions): Promise<VaultSync> {
    await ready();
    const sync = new VaultSync(o);
    const saved = await o.state.load();
    if (saved) sync.state = { pointer: saved.pointer ?? null, base: saved.base ?? null, index: saved.index ?? {} };
    return sync;
  }

  get generation(): number {
    return this.state.pointer?.generation ?? 0;
  }

  /** Is this path being written by the loop itself right now? */
  isApplying(path: string): boolean {
    return this.applying.has(path);
  }

  /** Tell the loop a file changed, for hosts without `watch`. */
  markDirty(path: string): void {
    this.touched.add(path);
  }

  private get scope(): string[] | undefined {
    return this.o.carryAll ? undefined : [...FREE_EXTENSIONS];
  }

  private inScope(path: string): boolean {
    return this.o.carryAll || FREE_EXTENSIONS.includes(extensionOf(path));
  }

  /** Files here that this device does not publish, so an interface can say so. */
  async heldBack(): Promise<string[]> {
    if (this.o.carryAll) return [];
    return (await this.o.host.list()).map((f) => f.path).filter((p) => !this.inScope(p));
  }

  /**
   * Files that differ from what was last synced: changed, new, or deleted
   * here. What a file explorer badges as "not synced yet".
   */
  async pending(): Promise<string[]> {
    const files = (await this.o.host.list()).filter((f) => this.inScope(f.path));
    const base = this.state.base;
    const index = this.state.index ?? {};
    const out: string[] = [];
    const here = new Set<string>();
    for (const f of files) {
      here.add(f.path);
      const known = index[f.path];
      if (!base?.entries[f.path] || !known || known.size !== f.size || known.mtime !== f.mtime || this.touched.has(f.path)) {
        out.push(f.path);
      }
    }
    for (const path of Object.keys(base?.entries ?? {})) {
      if (!here.has(path) && this.inScope(path)) out.push(path);
    }
    return out;
  }

  /**
   * Sync once. Calls made while one is running share a single follow-up run,
   * so a burst of triggers costs two syncs, not one per trigger.
   */
  sync(): Promise<SyncOutcome> {
    if (this.closed) return Promise.reject(new Error("this vault sync was closed"));
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
      return this.running;
    }
    if (!this.queued) {
      this.queued = this.running
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.sync();
        });
    }
    return this.queued;
  }

  /**
   * Hear other devices' publishes as they happen.
   *
   * `onRemote` fires when the relay announces a pointer this device has not
   * already synced to. It does not sync by itself: the host decides when,
   * because only the host knows whether this tab is the one that syncs.
   */
  /**
   * This account's public identity, `npub1…`. It is what the relay sees as the
   * author of this vault's events: safe to show and to share, and the same on
   * every device of the account. The secret keys are never derivable from it.
   * Null when the engine's wasm predates the npub encoder.
   */
  get npub(): string | null {
    // Added to the engine's wasm after the first browser build; older bindings
    // simply have no npub to show rather than failing to load.
    const encode = (wasm as { encodeNpub?: (hex: string) => string }).encodeNpub;
    return encode ? encode(this.relay.pubkey) : null;
  }

  /** Whether the relay connection is open (for a status line). */
  get connected(): boolean {
    return this.relay.connected;
  }

  /** Called when the relay connection opens or closes. Returns an unsubscribe. */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    return this.relay.onConnectionChange(listener);
  }

  watch(onRemote: () => void): () => void {
    let lastHeard: string | null = null;
    return this.relay.subscribePointer(this.o.namespace, (hex) => {
      // The relay sends the stored pointer on every (re)subscribe as well as
      // live, so the same one can arrive twice: news once, not twice.
      if (hex === this.lastPointerHex || hex === lastHeard) return;
      lastHeard = hex;
      try {
        const incoming = this.ns.openPointer(hex) as Pointer;
        if (incoming.root === this.state.pointer?.root) return;
      } catch {
        // Not readable with our key — rotated elsewhere. Let the sync say so.
      }
      onRemote();
    });
  }

  close(): void {
    this.closed = true;
    this.unwatchHost?.();
    this.relay.close();
    this.cache.clear();
  }

  // ---- the loop ---------------------------------------------------------------

  private async runOnce(): Promise<SyncOutcome> {
    const touched = this.touched;
    this.touched = new Set();
    try {
      return await this.syncWith(touched);
    } catch (e) {
      // What was dirty is still dirty.
      for (const p of touched) this.touched.add(p);
      throw e;
    }
  }

  private async syncWith(touched: Set<string>): Promise<SyncOutcome> {
    const { host } = this.o;
    const all = await host.list();
    const stats = new Map(all.map((f) => [f.path, f] as const));
    const local = all.filter((f) => this.inScope(f.path));
    const heldBack = this.o.carryAll ? [] : all.map((f) => f.path).filter((p) => !this.inScope(p));
    const base = this.state.base;
    const outcome: SyncOutcome = { kind: "up-to-date", pulled: [], deleted: [], pushed: 0, conflicts: [], heldBack, generation: this.generation };

    const unchanged = (f: FileStat) => {
      const known = this.state.index?.[f.path];
      return !!known && known.size === f.size && known.mtime === f.mtime && !touched.has(f.path);
    };
    const localChanged =
      !base ||
      local.some((f) => !base.entries[f.path] || !unchanged(f)) ||
      Object.keys(base.entries).some((p) => this.inScope(p) && !stats.has(p));

    // ---- nothing changed here: a pull, and usually not even that ----------------
    if (!localChanged && base) {
      const remoteHex = await this.relay.fetchPointer(this.o.namespace);
      if (remoteHex) {
        const incoming = this.ns.openPointer(remoteHex) as Pointer;
        if (incoming.root === this.state.pointer?.root) {
          this.lastPointerHex = remoteHex;
          return outcome;
        }
        const theirs = await this.fetchManifest(incoming);
        this.lastPointerHex = remoteHex;
        if (!sameContent(base, theirs)) {
          await this.apply(theirs, { stats, touched, ours: null, mine: new Map(), outcome, localPaths: local.map((f) => f.path) });
          outcome.kind = "pulled";
        }
        this.state.pointer = incoming;
        this.state.base = theirs;
        await this.reindex(theirs, stats, outcome);
        outcome.generation = incoming.generation;
        return outcome;
      }
      // The relay has nothing: a new relay, or a wiped one. Publish what we hold.
    }

    // ---- something changed: stage, seal, then read before writing ---------------
    const staged = await this.stage(local, touched);
    const commit = this.commit((this.state.pointer?.generation ?? 0) + 1);
    const ours = this.manifestOf(commit);
    const mine = new Map(commit.blobs.map((b) => [b.id, b.bytes] as const));

    const remoteHex = await this.relay.fetchPointer(this.o.namespace);
    if (!remoteHex) {
      outcome.pushed = await this.publish(commit, new Set());
      this.state.base = ours;
      this.reindexStaged(ours, staged);
      await this.save();
      outcome.kind = "published";
      outcome.generation = commit.generation;
      return outcome;
    }

    const incoming = this.ns.openPointer(remoteHex) as Pointer;
    if (base && this.state.pointer && incoming.root === this.state.pointer.root) {
      // Nobody published since we last synced, so theirs *is* the base and a
      // three-way merge would hand back exactly ours. Publish it, without
      // fetching a manifest we already hold or sealing the vault twice.
      this.lastPointerHex = remoteHex;
      if (sameContent(base, ours)) {
        // Touched but not changed — a save of identical text. Remember the new stats.
        this.reindexStaged(base, staged);
        await this.save();
        return outcome;
      }
      outcome.pushed = await this.publish(commit, blobsOf(base, incoming));
      this.state.base = ours;
      this.reindexStaged(ours, staged);
      await this.save();
      outcome.kind = "published";
      outcome.generation = commit.generation;
      return outcome;
    }
    const theirs = await this.fetchManifest(incoming);
    this.lastPointerHex = remoteHex;
    const known = blobsOf(theirs, incoming);

    if (sameContent(ours, theirs)) {
      this.state.pointer = incoming;
      this.state.base = theirs;
      this.reindexStaged(theirs, staged);
      await this.save();
      outcome.generation = incoming.generation;
      return outcome;
    }

    const weDiverged = base ? !sameContent(base, ours) : local.length > 0;
    if (!weDiverged) {
      // A plain fast-forward. Merging here would manufacture conflict copies
      // out of an ordinary update, which is the bug users notice first.
      await this.apply(theirs, { stats, touched, ours, mine, outcome, localPaths: local.map((f) => f.path), staged });
      this.state.pointer = incoming;
      this.state.base = theirs;
      await this.reindex(theirs, stats, outcome);
      outcome.kind = "pulled";
      outcome.generation = incoming.generation;
      return outcome;
    }

    const result = this.ns.mergeManifests(
      base ?? null,
      ours,
      theirs,
      this.o.device,
      today(),
      BigInt(Math.floor(Date.now() / 1000)),
    ) as MergeOutcome;
    await this.apply(result.merged, { stats, touched, ours, mine, outcome, localPaths: local.map((f) => f.path), staged });
    outcome.conflicts = result.conflicts;

    // Republish the resolved state on top of theirs.
    const after = (await host.list()).filter((f) => this.inScope(f.path));
    const restaged = await this.stage(after, new Set([...touched, ...outcome.pulled]));
    const republish = this.commit(incoming.generation + 1);
    outcome.pushed = await this.publish(republish, known);
    this.state.base = this.manifestOf(republish);
    this.reindexStaged(this.state.base, restaged);
    await this.save();
    outcome.kind = "merged";
    outcome.generation = republish.generation;
    return outcome;
  }

  /**
   * Stage every in-scope file, reading only what the cache cannot vouch for.
   *
   * A commit rebuilds the manifest from what was staged, so every file has to
   * be staged every time — leaving one out publishes its deletion. What can
   * be avoided is reading it again: a file whose size and mtime match the
   * cached copy, and that the host has not reported changed, is staged from
   * memory.
   */
  private async stage(files: FileStat[], touched: Set<string>): Promise<Map<string, FileStat>> {
    this.ns.clear();
    const staged = new Map<string, FileStat>();
    for (const f of files) {
      const bytes = await this.bytesOf(f, touched);
      this.ns.stage(f.path, bytes);
      staged.set(f.path, f);
    }
    for (const path of [...this.cache.keys()]) {
      if (!staged.has(path)) this.forget(path);
    }
    return staged;
  }

  private async bytesOf(f: FileStat, touched: Set<string>): Promise<Uint8Array> {
    const hit = this.cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtime === f.mtime && !touched.has(f.path)) return hit.bytes;
    const bytes = await this.o.host.read(f.path);
    this.remember(f.path, f.size, f.mtime, bytes);
    return bytes;
  }

  private remember(path: string, size: number, mtime: number, bytes: Uint8Array): void {
    this.forget(path);
    if (bytes.length > MAX_CACHED_FILE || this.cached + bytes.length > this.cacheBytes) return;
    this.cache.set(path, { size, mtime, bytes });
    this.cached += bytes.length;
  }

  private forget(path: string): void {
    const old = this.cache.get(path);
    if (!old) return;
    this.cached -= old.bytes.length;
    this.cache.delete(path);
  }

  private commit(generation: number): Commit {
    return this.ns.commit(
      BigInt(generation),
      BigInt(Math.floor(Date.now() / 1000)),
      this.o.device,
      this.scope,
    ) as Commit;
  }

  private manifestOf(commit: Commit): ManifestJson {
    return this.ns.openManifest(commit.blobs.find((b) => b.id === commit.root)!.bytes) as ManifestJson;
  }

  private async fetchManifest(pointer: Pointer): Promise<ManifestJson> {
    const sealed = await this.relay.getBlob(pointer.root);
    if (!sealed) throw new Error("the relay is advertising a manifest it does not hold");
    return this.ns.openManifest(sealed) as ManifestJson;
  }

  /**
   * Blobs first, then the pointer. The pointer is the commit.
   *
   * `known` is what the relay provably holds already — every blob its own
   * current manifest names. Only the rest are asked about: one `/list` if
   * there are many, otherwise a `HEAD` each, in parallel.
   */
  private async publish(commit: Commit, known: Set<string>): Promise<number> {
    let unknown = commit.blobs.filter((b) => !known.has(b.id) && !this.uploaded.has(b.id));
    if (unknown.length > LIST_THRESHOLD) {
      const listed = await this.relay.listBlobs();
      if (listed) {
        for (const b of unknown) if (listed.has(b.id)) this.uploaded.add(b.id);
        unknown = unknown.filter((b) => !listed.has(b.id));
        // The relay said what it has, so the rest are missing: no HEAD needed.
        let pushed = 0;
        await pool(unknown, this.concurrency, async (b) => {
          await this.relay.putBlob(b.bytes);
          this.uploaded.add(b.id);
          pushed += 1;
        });
        return this.finishPublish(commit, pushed);
      }
    }
    let pushed = 0;
    await pool(unknown, this.concurrency, async (b) => {
      if (!(await this.relay.hasBlob(b.id))) {
        await this.relay.putBlob(b.bytes);
        pushed += 1;
      }
      this.uploaded.add(b.id);
    });
    return this.finishPublish(commit, pushed);
  }

  private async finishPublish(commit: Commit, pushed: number): Promise<number> {
    await this.relay.publishPointer(this.o.namespace, commit.pointer);
    this.lastPointerHex = commit.pointer;
    // Keep what we just published. Discarding it reset the generation counter
    // to 1 on every sync, so two devices sat at the same generation forever
    // and every exchange between them looked like a fork.
    // Saved by the caller together with the base, so the two never disagree on disk.
    this.state.pointer = { root: commit.root, generation: commit.generation, updated_at: Math.floor(Date.now() / 1000) };
    return pushed;
  }

  /**
   * Write a manifest into the vault, fetching only what is genuinely remote.
   *
   * `mine` is what this device just sealed. A *merged* manifest legitimately
   * names chunks that exist nowhere else yet — our own side of the merge has
   * not been published — so they come from there, not the relay.
   */
  private async apply(
    manifest: ManifestJson,
    ctx: {
      stats: Map<string, FileStat>;
      touched: Set<string>;
      ours: ManifestJson | null;
      mine: Map<string, Uint8Array>;
      outcome: SyncOutcome;
      localPaths: string[];
      staged?: Map<string, FileStat>;
    },
  ): Promise<void> {
    const { host } = this.o;
    const base = this.state.base;
    const index = this.state.index ?? {};
    const needed: [string, ManifestEntry][] = [];

    for (const [path, entry] of Object.entries(manifest.entries)) {
      // Exactly what we just staged from this disk.
      if (ctx.ours && sameEntry(ctx.ours.entries[path], entry)) continue;
      // Exactly what we last synced, and untouched since.
      const st = ctx.stats.get(path);
      const known = index[path];
      if (
        st &&
        known &&
        known.size === st.size &&
        known.mtime === st.mtime &&
        !ctx.touched.has(path) &&
        sameEntry(base?.entries[path], entry)
      ) {
        continue;
      }
      needed.push([path, entry]);
    }

    // Fetched in parallel, written one at a time: hosts create parent folders
    // on write, and two writes racing to create the same folder is a host bug
    // nobody should have to find.
    let writes: Promise<unknown> = Promise.resolve();
    const serially = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = writes.then(fn, fn);
      writes = run.catch(() => undefined);
      return run;
    };

    await pool(needed, this.concurrency, async ([path, entry]) => {
      const parts: Uint8Array[] = [];
      for (const chunk of entry.chunks) {
        const sealed = ctx.mine.get(chunk.blob) ?? (await this.relay.getBlob(chunk.blob));
        if (!sealed) throw new Error(`the store is missing a chunk of ${path}`);
        // Verified against what the manifest promised, every time. The AEAD
        // tag proves it was sealed with our key; the hash proves it is the
        // blob we asked for.
        parts.push(this.ns.openChunk(sealed, chunk.content));
      }
      const bytes = concat(parts);
      await serially(() => this.writeOne(path, bytes, ctx.stats.get(path), ctx.outcome));
    });

    for (const path of ctx.localPaths) {
      if (path in manifest.entries) continue;
      // Absent, but only a deletion if the device that wrote this manifest
      // was carrying that kind of file. Without this check, one device
      // turning off attachments trashed the other device's attachments —
      // measured, on two real vaults, before the scope existed.
      if (!covers(manifest, path)) continue;
      await host.beforeReplace?.(path, "remote-delete");
      this.applying.add(path);
      try {
        await host.delete(path);
      } finally {
        this.applying.delete(path);
      }
      this.forget(path);
      ctx.outcome.deleted.push(path);
    }
  }

  private async writeOne(path: string, bytes: Uint8Array, st: FileStat | undefined, outcome: SyncOutcome): Promise<void> {
    const { host } = this.o;
    if (st) {
      const current = this.cache.get(path);
      const same =
        current && current.size === st.size && current.mtime === st.mtime
          ? equal(current.bytes, bytes)
          : st.size === bytes.length && equal(await host.read(path), bytes);
      if (same) return;
      await host.beforeReplace?.(path, "remote-update");
    }
    this.applying.add(path);
    try {
      await host.write(path, bytes);
    } finally {
      this.applying.delete(path);
    }
    const after = await host.stat(path);
    if (after) this.remember(path, after.size, after.mtime, bytes);
    outcome.pulled.push(path);
  }

  /** After a pull: every file that now matches `manifest`, at its current stat. */
  private async reindex(manifest: ManifestJson, before: Map<string, FileStat>, outcome: SyncOutcome): Promise<void> {
    const index: Record<string, { size: number; mtime: number }> = {};
    const written = new Set(outcome.pulled);
    for (const path of Object.keys(manifest.entries)) {
      const st = written.has(path) ? await this.o.host.stat(path) : before.get(path);
      if (st) index[path] = { size: st.size, mtime: st.mtime };
    }
    this.state.index = index;
    await this.save();
  }

  /** After a publish: the stats the staged bytes were read at. */
  private reindexStaged(manifest: ManifestJson, staged: Map<string, FileStat>): void {
    const index: Record<string, { size: number; mtime: number }> = {};
    for (const path of Object.keys(manifest.entries)) {
      const st = staged.get(path) ?? (this.state.index?.[path] ? { path, ...this.state.index[path] } : undefined);
      if (st) index[path] = { size: st.size, mtime: st.mtime };
    }
    this.state.index = index;
  }

  private async save(): Promise<void> {
    await this.o.state.save({ pointer: this.state.pointer, base: this.state.base, index: this.state.index });
  }

  /**
   * Re-seal the whole vault under a fresh key, and hand the key back.
   *
   * The only meaningful delete this protocol has: afterwards every blob left
   * on the relay is ciphertext under a key nobody holds. Publishes without
   * reading — the pointer there is sealed under the key being replaced — and
   * sweeps what the old key addressed afterwards, best effort. Every other
   * device has to be paired again; that is the point, not an oversight.
   *
   * The caller must persist the returned key *before* anything else syncs.
   */
  async rotate(onProgress: (line: string) => void = () => {}): Promise<string> {
    if (this.running) await this.running.catch(() => undefined);
    const stranded = new Set<string>();
    if (this.state.pointer) stranded.add(this.state.pointer.root);
    for (const entry of Object.values(this.state.base?.entries ?? {})) {
      for (const chunk of entry.chunks) stranded.add(chunk.blob);
    }

    const key = Namespace.generateKey();
    onProgress("Re-sealing the vault…");
    this.ns.free();
    this.ns = new Namespace(key);
    this.state = { pointer: null, base: null, index: {} };
    this.uploaded.clear();
    this.lastPointerHex = null;
    await this.save();

    const local = (await this.o.host.list()).filter((f) => this.inScope(f.path));
    const staged = await this.stage(local, new Set());
    const commit = this.commit(1);
    await this.publish(commit, new Set());
    this.state.base = this.manifestOf(commit);
    this.reindexStaged(this.state.base, staged);
    await this.save();
    onProgress(`Published ${local.length} file${local.length === 1 ? "" : "s"} under the new key.`);

    onProgress(`Sweeping ${stranded.size} blob${stranded.size === 1 ? "" : "s"} the old key addressed…`);
    let swept = 0;
    await pool([...stranded], this.concurrency, async (id) => {
      if (await this.relay.deleteBlob(id)) swept += 1;
    });
    onProgress(
      swept === stranded.size
        ? `Swept all ${swept}.`
        : `Swept ${swept} of ${stranded.size} — the rest stay on the relay as ciphertext nothing can read.`,
    );
    return key;
  }
}

function blobsOf(manifest: ManifestJson, pointer: Pointer): Set<string> {
  const out = new Set<string>([pointer.root]);
  for (const entry of Object.values(manifest.entries)) for (const c of entry.chunks) out.add(c.blob);
  return out;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw failure instanceof Error ? failure : new Error(typeof failure === "string" ? failure : "a parallel task failed");
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Today, as this device's clock sees it.
 *
 * `toISOString` is UTC, and this date goes in a filename a person reads. East
 * of Greenwich that stamped yesterday on a conflict copy made this morning.
 */
export function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
