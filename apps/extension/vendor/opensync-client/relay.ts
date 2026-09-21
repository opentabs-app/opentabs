// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/** Kind 30078: addressable, so the relay keeps exactly one per (pubkey, kind, d). */
const KIND_POINTER = 30078;
const KIND_CONNECTION_AUTH = 22242;
const KIND_BLOSSOM_AUTH = 24242;

/** How long a socket exchange waits for its answer. */
const EXCHANGE_TIMEOUT_MS = 20_000;
/** How long one HTTP request may take before it is abandoned and retried. */
const FETCH_TIMEOUT_MS = 20_000;
/** Retries after the first attempt, for failures a retry can fix. */
const FETCH_RETRIES = 2;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class Signer {
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

  sign(kind: number, tags: string[][], content: string, createdAt: number): NostrEvent {
    const event = { pubkey: this.pubkey, created_at: createdAt, kind, tags, content };
    // NIP-01's canonical form, byte for byte, or the id will not match.
    const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const id = bytesToHex(sha256(utf8ToBytes(canonical)));
    return { ...event, id, sig: bytesToHex(schnorr.sign(id, this.secret)) };
  }
}

export interface RelayOptions {
  /** Per-request HTTP timeout. Uploads get more in proportion to their size. */
  fetchTimeoutMs?: number;
  /** Retries after the first attempt for network failures, timeouts, 429 and 5xx. */
  retries?: number;
}

/** One open subscription: who hears its events, and what it asked for. */
interface Subscription {
  filter: Record<string, unknown>;
  onEvent: (event: NostrEvent) => void;
  /** Standing subscriptions are re-sent after a reconnect; one-shot queries are not. */
  standing: boolean;
  onEose?: () => void;
  onClosed?: (reason: string) => void;
}

/**
 * The relay connection and the blob endpoint beside it.
 *
 * Pointers go over the socket, bytes go over HTTP. The relay is the
 * rendezvous, never the pipe.
 *
 * # One listener, many conversations
 *
 * The socket used to be shared by swapping `onmessage` for the length of each
 * request. That made a standing subscription impossible — the next request
 * would take the listener away from it — and it is why a device that edited
 * nothing never heard that anybody else had. Messages now go through one
 * router: `EVENT`/`EOSE`/`CLOSED` by subscription id, `OK` by event id. A
 * query, a publish and a live feed can share the connection at once.
 */
export class Relay {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  /**
   * The highest created_at published or seen.
   *
   * A relay resolves two replaceable events with the same created_at by
   * keeping the lexically smaller id, so a second write inside the same second
   * has a coin-flip chance of being silently discarded — with an OK in reply.
   * A vault saves more than once a second routinely.
   */
  private watermark = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly awaitingOk = new Map<string, (msg: any[]) => void>();
  private nextSub = 0;
  /** Bumped by `close()`, so a socket from before it cannot become current after it. */
  private epoch = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  /** Aborts every in-flight request when the relay is closed. */
  private lifetime = new AbortController();
  private readonly fetchTimeoutMs: number;
  private readonly retries: number;

  constructor(
    private readonly wsUrl: string,
    private readonly httpUrl: string,
    private readonly signer: Signer,
    options: RelayOptions = {},
  ) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.retries = options.retries ?? FETCH_RETRIES;
  }

  /** The account's public key on this relay, hex. */
  get pubkey(): string {
    return this.signer.pubkey;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Loopback is the one wrong address that looks right.
   *
   * `127.0.0.1` on a phone is the phone, so a relay running on a laptop is
   * unreachable and the failure reads as "cannot connect" — which sends
   * people to check firewalls and Wi-Fi rather than the one field that is
   * actually wrong.
   */
  private unreachable(): Error {
    const host = this.wsUrl.replace(/^wss?:\/\//, "").split(/[:/]/)[0];
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      // Only a problem off the machine the relay runs on. A page on the same
      // computer reaching its own loopback relay and failing is the relay not
      // running, and saying "use your network address" would be wrong there.
      const local =
        typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname ?? "");
      if (!local) {
        return new RelayUnreachableError(
          `${this.wsUrl} points at this device, not the computer running the relay. ` +
            "Use that computer's address on your network instead, such as ws://192.168.0.10:4848/",
        );
      }
    }
    return new RelayUnreachableError(`cannot reach relay at ${this.wsUrl}`);
  }

  private nextCreatedAt(): number {
    this.watermark = Math.max(this.now(), this.watermark + 1);
    return this.watermark;
  }

  private observe(createdAt: number): void {
    this.watermark = Math.max(this.watermark, createdAt);
  }

  /**
   * Close the socket, stop reconnecting, and abort every request in flight.
   *
   * A `Relay` is not usable afterwards for standing subscriptions, but a
   * later request opens a fresh connection — `close()` is how settings
   * changes drop the old one, and the plugin keeps calling methods after it.
   */
  close(): void {
    this.closed = true;
    this.epoch += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending(new Error("the relay connection was closed"));
    this.subscriptions.clear();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    socket?.close();
    // Later requests reconnect on demand; only standing subscriptions stop.
    this.closed = false;
  }

  private failPending(err: Error): void {
    for (const [id, waiter] of this.awaitingOk) {
      this.awaitingOk.delete(id);
      waiter(["__error", err]);
    }
    for (const [id, sub] of this.subscriptions) {
      if (sub.standing) continue;
      this.subscriptions.delete(id);
      sub.onClosed?.(err.message);
    }
  }

  private route(socket: WebSocket, msg: any[]): boolean {
    switch (msg[0]) {
      case "AUTH":
        if (typeof msg[1] === "string") {
          // A relay may challenge on connect or mid-connection; answer either.
          socket.send(JSON.stringify(["AUTH", this.authEvent(msg[1])]));
        }
        return false;
      case "EVENT": {
        const sub = this.subscriptions.get(String(msg[1]));
        const event = msg[2] as NostrEvent | undefined;
        if (sub && event && typeof event.content === "string") {
          this.observe(event.created_at);
          sub.onEvent(event);
        }
        return false;
      }
      case "EOSE":
        this.subscriptions.get(String(msg[1]))?.onEose?.();
        return false;
      case "CLOSED": {
        const id = String(msg[1]);
        const sub = this.subscriptions.get(id);
        if (sub) {
          this.subscriptions.delete(id);
          sub.onClosed?.(String(msg[2] ?? ""));
        }
        return false;
      }
      case "OK": {
        const waiter = this.awaitingOk.get(String(msg[1]));
        if (waiter) {
          this.awaitingOk.delete(String(msg[1]));
          waiter(msg);
          return false;
        }
        // An OK nobody is waiting for is the answer to our AUTH.
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Whether a relay connection is open right now. Apps show this: "syncing" with
   * no connection and "syncing" while connected look the same otherwise.
   */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Called whenever the connection opens or closes. Returns an unsubscribe. */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private connectionListeners = new Set<(connected: boolean) => void>();

  private announceConnection(connected: boolean) {
    for (const l of this.connectionListeners) {
      try {
        l(connected);
      } catch {
        /* a listener must not take the socket down */
      }
    }
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;

    const epoch = this.epoch;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      let settled = false;
      const current = () => epoch === this.epoch;

      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!err && !current()) {
          // `close()` ran while this was connecting: nobody wants it now.
          socket.close();
          err = new Error("the relay connection was closed");
        }
        if (err) {
          if (current()) this.connecting = null;
          reject(err);
        } else {
          this.socket = socket;
          this.connecting = null;
          this.reconnectDelay = 1000;
          this.announceConnection(true);
          resolve(socket);
        }
      };

      const timer = setTimeout(() => {
        done(this.unreachable());
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }, 15000);

      socket.onerror = () => done(this.unreachable());
      socket.onclose = () => {
        const wasCurrent = this.socket === socket || (!settled && current());
        done(new RelayUnreachableError("relay closed the connection"));
        if (!wasCurrent) return;
        this.socket = null;
        this.connecting = null;
        this.announceConnection(false);
        this.failPending(new RelayUnreachableError("relay closed the connection"));
        this.scheduleReconnect();
      };

      socket.onopen = () => {
        // Do NOT resolve here. A relay with auth enabled sends its challenge
        // immediately after the socket opens, and anything published before
        // that handshake finishes is refused with "auth-required". Resolving
        // on open and letting the caller race the challenge is the bug this
        // shape exists to prevent.
        //
        // A relay that never asks is also fine: the grace timer below gives
        // up waiting and proceeds unauthenticated.
        setTimeout(() => done(), 3000);
      };

      socket.onmessage = (ev) => {
        const msg = safeParse(ev.data);
        if (!msg) return;
        // The OK for our AUTH is the signal that the connection is usable.
        if (this.route(socket, msg)) done();
      };
    });
    return this.connecting;
  }

  /**
   * Reopen the socket for the subscriptions that are still wanted.
   *
   * Backs off from one second to thirty, and resets on the first success. A
   * relay that went away and came back re-sends the stored pointer to each
   * resubscribed filter, so a device that was offline while others wrote
   * hears about it the moment it is back.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    if (![...this.subscriptions.values()].some((s) => s.standing)) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect()
        .then((socket) => {
          for (const [id, sub] of this.subscriptions) {
            if (sub.standing) socket.send(JSON.stringify(["REQ", id, sub.filter]));
          }
        })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  private authEvent(challenge: string) {
    return this.signer.sign(
      KIND_CONNECTION_AUTH,
      [
        ["relay", this.wsUrl],
        ["challenge", challenge],
      ],
      "",
      this.now(),
    );
  }

  /** Send one REQ and collect what it has stored, up to EOSE. */
  private async query(filter: Record<string, unknown>): Promise<NostrEvent[]> {
    const socket = await this.connect();
    const id = `q${this.nextSub++}`;
    const events: NostrEvent[] = [];
    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        clearTimeout(timer);
        this.subscriptions.delete(id);
        try {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(["CLOSE", id]));
        } catch {
          /* the socket going away here changes nothing */
        }
        if (err) reject(err);
        else resolve(events);
      };
      const timer = setTimeout(() => finish(new RelayUnreachableError("relay did not answer")), EXCHANGE_TIMEOUT_MS);
      this.subscriptions.set(id, {
        filter,
        standing: false,
        onEvent: (e) => events.push(e),
        onEose: () => finish(),
        onClosed: (reason) => finish(new RelayUnreachableError(`relay closed the query: ${reason || "no reason given"}`)),
      });
      socket.send(JSON.stringify(["REQ", id, filter]));
    });
  }

  private pointerFilter(namespace: string): Record<string, unknown> {
    return { authors: [this.signer.pubkey], kinds: [KIND_POINTER], "#d": [namespace] };
  }

  async fetchPointer(namespace: string): Promise<string | null> {
    const events = await this.query({ ...this.pointerFilter(namespace), limit: 1 });
    const event = events.sort((a, b) => a.created_at - b.created_at).pop();
    if (!event) return null;
    this.observe(event.created_at);
    return event.content;
  }

  /**
   * Hear every pointer published to `namespace`, including the stored one.
   *
   * A standing REQ with no limit: the relay sends what it holds, then every
   * accepted event that matches, for as long as the socket is open — and
   * this reopens it when it drops. The callback gets the sealed pointer; the
   * caller decides whether it is news. Our own publishes come back too.
   *
   * Returns a function that ends the subscription.
   */
  subscribePointer(namespace: string, onPointer: (hex: string, createdAt: number) => void): () => void {
    const id = `live${this.nextSub++}`;
    const filter = this.pointerFilter(namespace);
    this.subscriptions.set(id, {
      filter,
      standing: true,
      onEvent: (e) => onPointer(e.content, e.created_at),
      // A relay that ends a live subscription is asked again later rather
      // than taken at its word: a restart looks the same from here.
      onClosed: () => {
        this.subscriptions.set(id, { filter, standing: true, onEvent: (e) => onPointer(e.content, e.created_at) });
        this.scheduleReconnect();
      },
    });
    void this.connect()
      .then((socket) => {
        if (this.subscriptions.has(id)) socket.send(JSON.stringify(["REQ", id, filter]));
      })
      .catch(() => this.scheduleReconnect());
    return () => {
      this.subscriptions.delete(id);
      try {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(["CLOSE", id]));
      } catch {
        /* nothing to tidy */
      }
    };
  }

  async publishPointer(namespace: string, hexPayload: string): Promise<void> {
    const event = this.signer.sign(
      KIND_POINTER,
      [["d", namespace]],
      hexPayload,
      this.nextCreatedAt(),
    );
    const socket = await this.connect();
    const ok = await new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaitingOk.delete(event.id);
        reject(new RelayUnreachableError("relay did not answer"));
      }, EXCHANGE_TIMEOUT_MS);
      this.awaitingOk.set(event.id, (msg) => {
        clearTimeout(timer);
        if (msg[0] === "__error") reject(msg[1]);
        else resolve(msg);
      });
      socket.send(JSON.stringify(["EVENT", event]));
    });
    if (ok[2]) return;
    const note = String(ok[3] ?? "");
    // NIP-01's prefix for "your signature is fine and the answer is still no".
    // The same distinction the 403 gets on the blob path — an app that gets
    // past one meets the other on the same first run.
    if (note.startsWith("restricted:")) throw new NotAdmittedError(note);
    throw new Error(`relay refused the pointer: ${note || "no reason given"}`);
  }

  private blossomAuth(verb: string): string {
    const event = this.signer.sign(
      KIND_BLOSSOM_AUTH,
      [["t", verb], ["expiration", String(this.now() + 300)]],
      "",
      this.now(),
    );
    return `Nostr ${btoa(JSON.stringify(event))}`;
  }

  /**
   * `fetch`, with a timeout, bounded retries and an abort on `close()`.
   *
   * Without the timeout a request to a relay that has gone quiet — a laptop
   * lid closed, a captive portal — never settles, and the status reads
   * "syncing…" forever. Retries are for what a retry can fix: the network,
   * a timeout, 429 and 5xx. A 4xx is an answer and is returned as one.
   * `init` is rebuilt per attempt because an Authorization header carries a
   * signed event with an expiry.
   */
  private async request(url: string, init: () => RequestInit, sizeHint = 0): Promise<Response> {
    const timeoutMs = this.fetchTimeoutMs + Math.ceil(sizeHint / 1_000_000) * 10_000;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(8000, 500 * 3 ** (attempt - 1)) * (0.75 + Math.random() / 2));
      const controller = new AbortController();
      const lifetime = this.lifetime.signal;
      if (lifetime.aborted) throw new Error("the relay connection was closed");
      const onClose = () => controller.abort();
      lifetime.addEventListener("abort", onClose);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const res = await fetch(url, { ...init(), signal: controller.signal });
        if ((res.status === 429 || res.status >= 500) && res.status !== 507 && attempt < this.retries) {
          lastError = new Error(`${res.status}`);
          continue;
        }
        return res;
      } catch (e) {
        if (lifetime.aborted && !timedOut) throw new Error("the relay connection was closed");
        lastError = timedOut ? new RelayUnreachableError(`the storage server did not answer within ${Math.round(timeoutMs / 1000)} s`) : e;
      } finally {
        clearTimeout(timer);
        lifetime.removeEventListener("abort", onClose);
      }
    }
    if (lastError instanceof RelayUnreachableError) throw lastError;
    if (lastError instanceof Error && /^\d{3}$/.test(lastError.message)) {
      throw new Error(`the storage server kept failing (${lastError.message})`);
    }
    throw new RelayUnreachableError(`cannot reach the storage server at ${this.httpUrl}`);
  }

  async hasBlob(id: string): Promise<boolean> {
    const res = await this.request(`${this.httpUrl}/${id}`, () => ({ method: "HEAD" }));
    return res.ok;
  }

  /**
   * Every blob this account has stored, or `null` if the relay will not say.
   *
   * One request instead of one `HEAD` per blob, for the case where a device
   * has many blobs and no idea which the relay holds — a first sync, or a
   * sync to a relay it has not used before. Blossom's `/list` is optional,
   * so anything but a JSON array is "ask the slow way".
   */
  async listBlobs(): Promise<Set<string> | null> {
    try {
      const res = await this.request(`${this.httpUrl}/list/${this.signer.pubkey}`, () => ({ method: "GET" }));
      if (!res.ok) return null;
      const body = await res.json();
      if (!Array.isArray(body)) return null;
      return new Set(body.map((row: { sha256?: string }) => String(row?.sha256 ?? "")).filter(Boolean));
    } catch {
      return null;
    }
  }

  async getBlob(id: string): Promise<Uint8Array | null> {
    const res = await this.request(`${this.httpUrl}/${id}`, () => ({ method: "GET" }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fetching a blob failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const res = await this.request(
      `${this.httpUrl}/upload`,
      () => ({
        method: "PUT",
        headers: { Authorization: this.blossomAuth("upload") },
        body: bytes as BodyInit,
      }),
      bytes.length,
    );
    if (res.status === 413) {
      // A 413 has two quite different causes and they need different answers.
      // The relay says "quota exceeded" in a JSON body when you are actually
      // out of space; a plain-text 413 is the server refusing the request
      // size before it ever looked at your account. Reporting the second as
      // "storage is full" sends people off to buy space they do not need.
      const detail = await res.text();
      if (detail.includes("quota exceeded")) throw new QuotaError(detail);
      throw new Error(`the relay refused a ${bytes.length} byte upload: ${detail}`);
    }
    // 403 is the relay saying it does not serve this account at all. Nothing
    // the client retries can change that — it needs a person to admit the
    // account, or the app pointed at a different relay — so it is its own
    // error rather than a status code with a JSON document stapled to it.
    // On a relay with a roster this is the first thing a fresh install meets.
    if (res.status === 403) throw new NotAdmittedError(await res.text());
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Ask the relay to forget a blob, and say whether it agreed.
   *
   * A boolean rather than a `void`, and it never throws. Deletion here is
   * advisory — Blossom's DELETE reaches whichever server you asked, an
   * operator may have it switched off, and a blob that was ever fetched was
   * ever copied. The one caller is a rotation sweeping ciphertext it has
   * already made unreadable: it is tidying, not protecting, and a relay's
   * housekeeping policy must not be able to fail a rotation that has already
   * happened.
   *
   * A 404 counts as success. The blob is not there, which is what was asked.
   */
  async deleteBlob(id: string): Promise<boolean> {
    try {
      const res = await this.request(`${this.httpUrl}/${id}`, () => ({
        method: "DELETE",
        headers: { Authorization: this.blossomAuth("delete") },
      }));
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}

export class QuotaError extends Error {
  constructor(detail: string) {
    super(`storage is full: ${detail}`);
    this.name = "QuotaError";
  }
}

/**
 * The relay could not be reached, or stopped answering.
 *
 * Its own class so an interface can say "offline — will retry" and mean it:
 * unlike `QuotaError` and `NotAdmittedError`, this is the one failure that
 * waiting fixes.
 */
export class RelayUnreachableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RelayUnreachableError";
  }
}

/**
 * The relay does not serve this account.
 *
 * Its own class for the reason `QuotaError` is: the answer is different, and
 * a UI can only offer the right one if it can tell. Retrying never helps —
 * somebody has to admit the account, or the app has to be pointed somewhere
 * else — and a message that reads like a fault invites exactly the retry that
 * cannot work.
 */
export class NotAdmittedError extends Error {
  constructor(detail: string) {
    super(`this relay does not serve your account: ${reason(detail)}`);
    this.name = "NotAdmittedError";
  }
}

/**
 * The `reason` out of the relay's body, or the body as it came.
 *
 * Refusals arrive as `{"error":…,"reason":…}` over HTTP and as
 * `restricted: …` over the socket. Both carry a sentence written for a
 * person; neither should reach one wrapped in its own envelope.
 */
function reason(detail: string): string {
  if (detail.startsWith("restricted:")) return detail.slice("restricted:".length).trim();
  try {
    const body = JSON.parse(detail);
    if (typeof body?.reason === "string") return body.reason;
  } catch {
    // Not JSON. The text is the reason.
  }
  return detail;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeParse(data: unknown): any[] | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
