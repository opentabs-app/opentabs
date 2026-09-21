// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
import {
  accountLink,
  GrantSession,
  Invitation,
  JoinSession,
  PairingCode,
  pairingStep,
  qrRowsFor,
  readAccountLink,
  readRecoveryKit,
  renderRecoveryKit,
} from "./wasm/opensync_wasm.js";
import { Signer } from "./relay";
import { ready } from "./session";

/**
 * Enrolling a device from a ten-character code, in the browser.
 *
 * The handshake is the compiled core; this file is the four messages put on a
 * relay socket. It deliberately does not go through `Relay`: that class holds
 * one long-lived socket for pointers and blobs, and a pairing is a short
 * conversation on its own connection that ends when the device has an
 * account.
 *
 * Kind 20079 is ephemeral, so the relay forwards and stores nothing. Two
 * consequences, both of which shape the code below:
 *
 * - a message sent before the other side is listening is gone, not queued, so
 *   the joining device repeats its first message until it is answered;
 * - the relay echoes the event back to us as a subscriber of our own channel,
 *   so each side ignores its own pubkey or it will answer itself.
 */

const KIND_PAIRING = 20079;
const KIND_AUTH = 22242;
/** How long to wait for the other device at each step. */
const STEP_TIMEOUT_MS = 120_000;
/** How long the joiner waits before saying its first message again. */
const REPEAT_MS = 2_000;

export interface Enrollment {
  accountSecret: string;
  namespaceKey: string;
  namespace: string;
  relayWs: string;
  relayHttp: string;
  grantedBy: string;
  /** Eight characters naming the account, shown on both devices. */
  accountId: string;
}

export {
  Invitation,
  PairingCode,
  renderRecoveryKit,
  readRecoveryKit,
  accountLink,
  readAccountLink,
  qrRowsFor,
};

/**
 * What `readAccountLink` gives back.
 *
 * The same two keys the printed page carries, plus the relay it named — which
 * the page deliberately omits, because paper outlives a hostname and a link
 * pasted into a fresh device is the one moment there is nowhere else to get it
 * from.
 */
export interface AccountLinkContents extends RecoveryKitContents {
  relayWs: string;
}

/** What `readRecoveryKit` gives back: the two keys, and the account they name. */
export interface RecoveryKitContents {
  accountSecret: string;
  namespaceKey: string;
  namespace: string;
  fingerprint: string;
}

/** One pairing conversation on one channel of one relay. */
class Channel {
  private constructor(
    private readonly socket: WebSocket,
    private readonly signer: Signer,
    private readonly channel: string,
    private readonly inbox: Uint8Array[],
    private readonly waiters: (() => void)[],
  ) {}

  static async open(wsUrl: string, signer: Signer, channel: string): Promise<Channel> {
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    const inbox: Uint8Array[] = [];
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((w) => w());

    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error(`cannot reach the relay at ${wsUrl}`));
      socket.onerror = fail;
      socket.onclose = fail;
      socket.onopen = () => {
        socket.send(JSON.stringify(["REQ", "pair", { kinds: [KIND_PAIRING], "#d": [channel] }]));
        resolve();
      };
    });
    socket.onerror = null;
    socket.onclose = () => wake();

    socket.onmessage = (event) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg[0] === "AUTH" && typeof msg[1] === "string") {
        // NIP-42, answered as it arrives: a closed relay refuses writes from
        // anyone who has not, and pairing is a write.
        const auth = signer.sign(
          KIND_AUTH,
          [
            ["relay", wsUrl],
            ["challenge", msg[1]],
          ],
          "",
          Math.floor(Date.now() / 1000),
        );
        socket.send(JSON.stringify(["AUTH", auth]));
        return;
      }
      if (msg[0] !== "EVENT") return;
      const relayed = msg[2] as { pubkey?: string; content?: string } | undefined;
      // Our own event, echoed back to us on the channel we are talking on.
      if (!relayed || relayed.pubkey === signer.pubkey) return;
      if (typeof relayed.content !== "string") return;
      inbox.push(hexToBytes(relayed.content));
      wake();
    };

    return new Channel(socket, signer, channel, inbox, waiters);
  }

  send(message: Uint8Array): void {
    const event = this.signer.sign(
      KIND_PAIRING,
      [["d", this.channel]],
      bytesToHex(message),
      Math.floor(Date.now() / 1000),
    );
    this.socket.send(JSON.stringify(["EVENT", event]));
  }

  /** The next message from anybody but us, or null if the wait ran out. */
  async recv(withinMs: number): Promise<Uint8Array | null> {
    const deadline = Date.now() + withinMs;
    for (;;) {
      const next = this.inbox.shift();
      if (next) return next;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.waiters.push(done);
        setTimeout(done, Math.min(left, 250));
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * Join an account from a code shown on a device that already has one.
 *
 * `wsUrl` comes from the same screen as the code — a device with no account
 * has no way to know which relay to ask. A scanned invitation carries its own
 * relay and overrides `wsUrl`, which is the point of scanning: the address is
 * the half people mistype, and a phone that just read one is a phone that was
 * never told where the relay is.
 */
export async function joinAccount(
  wsUrl: string,
  code: string,
  options: { timeoutMs?: number } = {},
): Promise<Enrollment> {
  await ready();
  let parsed: PairingCode;
  try {
    const invitation = Invitation.parse(code);
    wsUrl = invitation.relayWs;
    parsed = invitation.code;
  } catch {
    parsed = PairingCode.parse(code);
  }
  const session = new JoinSession(parsed);
  // A key for this conversation only: this device is nobody until the grant
  // arrives, and NIP-42 only ever proves possession of a key.
  const channel = await Channel.open(wsUrl, Signer.generate(), parsed.channel);
  const deadline = Date.now() + (options.timeoutMs ?? STEP_TIMEOUT_MS);

  try {
    let offer: Uint8Array | null = null;
    while (!offer) {
      if (Date.now() > deadline) throw new Error("nothing answered that code");
      channel.send(session.joinMessage());
      const reply = await channel.recv(Math.min(REPEAT_MS, deadline - Date.now()));
      if (reply && pairingStep(reply) === "offer") offer = reply;
      else if (reply && pairingStep(reply) === "abandon") {
        throw new Error("the other device stopped");
      }
    }

    let accept: Uint8Array;
    try {
      accept = session.accept(offer);
    } catch (e) {
      // Whoever answered did not hold the code. Say so on the channel so the
      // other device stops waiting, then fail — the code is spent either way.
      channel.send(JoinSession.abandonMessage("the code did not match"));
      await new Promise((r) => setTimeout(r, 200));
      throw e;
    }
    channel.send(accept);

    for (;;) {
      const grant = await channel.recv(deadline - Date.now());
      if (!grant) throw new Error("the other device never sent the account");
      if (pairingStep(grant) === "abandon") throw new Error("the other device stopped");
      if (pairingStep(grant) !== "grant") continue;
      return session.open(grant) as Enrollment;
    }
  } finally {
    channel.close();
  }
}

/**
 * Show a code and hand this account to whoever answers it correctly.
 *
 * One call is one code and one attempt: it returns after a single grant, or a
 * single failure, which from an attacker's side is the same thing.
 */
export async function grantAccount(
  wsUrl: string,
  code: PairingCode,
  account: Omit<Enrollment, "accountId">,
  signerSecretHex: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await ready();
  const session = new GrantSession(code, account);
  const channel = await Channel.open(wsUrl, Signer.fromHex(signerSecretHex), code.channel);
  const deadline = Date.now() + (options.timeoutMs ?? STEP_TIMEOUT_MS);

  try {
    for (;;) {
      const join = await channel.recv(deadline - Date.now());
      if (!join) throw new Error("no device answered the code");
      if (pairingStep(join) !== "join") continue;
      channel.send(session.offer(join));
      break;
    }

    for (;;) {
      const accept = await channel.recv(deadline - Date.now());
      if (!accept) throw new Error("the other device stopped halfway");
      const step = pairingStep(accept);
      if (step === "abandon") throw new Error("the other device could not verify the code");
      if (step !== "accept") continue;
      channel.send(session.grant(accept));
      // Let the socket flush: the grant is ephemeral, and closing too eagerly
      // takes it with the connection.
      await new Promise((r) => setTimeout(r, 200));
      return;
    }
  } finally {
    channel.close();
  }
}

/**
 * Keep the address that actually worked.
 *
 * A granting device sends the relay address *it* uses, which on a household
 * setup is very often `127.0.0.1` — correct there, meaningless on the phone
 * that just joined. So the joiner keeps the address it reached, and accepts
 * the granted blob endpoint only when it names the same host, which is the
 * case where the other device knows something this one does not.
 */
export function endpointsFor(usedWs: string, granted: Enrollment): { ws: string; http: string } {
  const host = (url: string) => url.split("//")[1]?.split("/")[0] ?? "";
  if (host(granted.relayWs) === host(usedWs)) return { ws: usedWs, http: granted.relayHttp };
  if (usedWs.startsWith("wss://")) {
    return { ws: usedWs, http: `https://${usedWs.slice(6).replace(/\/+$/, "")}` };
  }
  if (usedWs.startsWith("ws://")) {
    return { ws: usedWs, http: `http://${usedWs.slice(5).replace(/\/+$/, "")}` };
  }
  return { ws: usedWs, http: granted.relayHttp };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
