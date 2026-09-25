// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
/**
 * NIP-44 v2, for the one thing the browser client needs it for: sealing the
 * vault key to the account's own npub, and opening it again.
 *
 * The same construction as `crates/opensync-nostr/src/nip44.rs`, and it has
 * to stay byte-compatible with it and with every NIP-07 extension and NIP-46
 * signer: a laptop that pasted an nsec, a phone signed in through Amber and
 * the desktop app all read one record. Only the pasted-key signer uses this
 * file — an extension or a bunker does the same arithmetic on its side, with
 * a key this page never sees.
 *
 * - conversation key = HKDF-extract(salt "nip44-v2", ECDH x-coordinate)
 * - per message, a random 32-byte nonce; HKDF-expand(conversation key,
 *   nonce, 76) gives a ChaCha20 key, a ChaCha20 nonce and an HMAC key
 * - the plaintext is length-prefixed and padded to a bucket
 * - payload = base64(0x02 ‖ nonce ‖ ciphertext ‖ HMAC-SHA256(nonce ‖ ciphertext))
 */
import { chacha20 } from "@noble/ciphers/chacha";
import { equalBytes } from "@noble/ciphers/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { expand, extract } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

const VERSION = 2;
const SALT = utf8ToBytes("nip44-v2");

/** The shared secret for a secret key and an x-only pubkey (hex). Symmetric. */
export function conversationKey(secret: Uint8Array, peerPubkeyHex: string): Uint8Array {
  // x-only keys are even-y by definition (BIP-340), hence the 02 prefix.
  const shared = secp256k1.getSharedSecret(secret, hexToBytes("02" + peerPubkeyHex));
  return extract(sha256, shared.subarray(1, 33), SALT);
}

function messageKeys(conversation: Uint8Array, nonce: Uint8Array) {
  const okm = expand(sha256, conversation, nonce, 76);
  return { key: okm.subarray(0, 32), iv: okm.subarray(32, 44), mac: okm.subarray(44, 76) };
}

export function paddedLength(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

/** Seal with a fresh random nonce. */
export function encrypt(conversation: Uint8Array, plaintext: string): string {
  return encryptWithNonce(conversation, plaintext, randomBytes(32));
}

/** The same with the nonce given — for the spec's vectors, never for real use. */
export function encryptWithNonce(conversation: Uint8Array, plaintext: string, nonce: Uint8Array): string {
  const bytes = utf8ToBytes(plaintext);
  if (bytes.length < 1 || bytes.length > 65535) throw new Error("a NIP-44 message must be 1 to 65535 bytes");
  const padded = new Uint8Array(2 + paddedLength(bytes.length));
  padded[0] = bytes.length >> 8;
  padded[1] = bytes.length & 0xff;
  padded.set(bytes, 2);
  const { key, iv, mac } = messageKeys(conversation, nonce);
  const ciphertext = chacha20(key, iv, padded);
  const tag = hmac(sha256, mac, concatBytes(nonce, ciphertext));
  return toBase64(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, tag));
}

export function decrypt(conversation: Uint8Array, payload: string): string {
  if (payload.startsWith("#")) throw new Error("not a NIP-44 v2 payload: unknown version");
  if (payload.length < 132 || payload.length > 87472) throw new Error("not a NIP-44 v2 payload: wrong length");
  let data: Uint8Array;
  try {
    data = fromBase64(payload);
  } catch {
    throw new Error("not a NIP-44 v2 payload: not base64");
  }
  if (data.length < 99 || data[0] !== VERSION) throw new Error("not a NIP-44 v2 payload: unknown version");
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const tag = data.subarray(data.length - 32);
  const { key, iv, mac } = messageKeys(conversation, nonce);
  if (!equalBytes(hmac(sha256, mac, concatBytes(nonce, ciphertext)), tag)) {
    throw new Error("the payload was not sealed for this key, or has been altered");
  }
  const padded = chacha20(key, iv, ciphertext);
  const len = (padded[0] << 8) | padded[1];
  if (len === 0 || padded.length !== 2 + paddedLength(len)) throw new Error("not a NIP-44 v2 payload: bad padding");
  return new TextDecoder("utf-8", { fatal: true }).decode(padded.subarray(2, 2 + len));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
