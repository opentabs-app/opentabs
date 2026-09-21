// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
/**
 * Where the apps point when nobody has told them otherwise.
 *
 * The same constant as `crates/opensync-core/src/relay_url.rs`, and the same
 * inference. It is a four-language value — that file, this one, openkeyboard's
 * `Store.kt` and its `Store.swift` — and `scripts/check-hosted-relay.sh` fails
 * if they disagree. A relay address that differs between two surfaces of one
 * product does not present as a mismatch; it presents as one device that syncs
 * and one that does not.
 */

/** A bare host: every surface needs a different shape, so none is stored. */
export const HOSTED_RELAY_HOST = "relay.opensync.network";

export const HOSTED_RELAY_WS = `wss://${HOSTED_RELAY_HOST}/`;
export const HOSTED_RELAY_HTTP = `https://${HOSTED_RELAY_HOST}`;

/**
 * Should an address typed without a scheme be treated as TLS?
 *
 * The field takes `host:port` because that is what people read off another
 * screen, and a bare address always used to become `ws://`. That was right
 * while every relay was on somebody's LAN and wrong the moment one has a
 * name: `relay.opensync.network` produced a plaintext connection to a
 * TLS-only endpoint, which fails as a closed socket rather than as anything
 * about schemes.
 *
 * So the shape of the host decides. An IP literal or a loopback/`.local` name
 * is on your own network; a name with a dot in it is on the internet. Both
 * answers are wrong for somebody, which is why a typed scheme still wins.
 */
export function assumeTls(address: string): boolean {
  const bare = stripScheme(address);
  // An IPv6 literal is full of colons; only a trailing :digits is a port.
  const host = bare.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost" || host.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(":")) return false; // bare IPv6
  // Anything left with no dot is a short name on a local network —
  // `raspberrypi`, a Tailscale MagicDNS name — with no public certificate.
  return host.includes(".");
}

function stripScheme(address: string): string {
  const a = address.trim();
  for (const p of ["wss://", "ws://", "https://", "http://"]) {
    if (a.startsWith(p)) return a.slice(p.length).replace(/\/+$/, "");
  }
  return a.replace(/\/+$/, "");
}
