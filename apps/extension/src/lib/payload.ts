/**
 * How a refresh result merges with what is already stored.
 *
 * Pulled out of the service worker so it can be tested directly. The rule it
 * encodes caused a real regression: a topic that had been working went
 * permanently blank, because every source started answering `304 Not
 * Modified`, the pool came back as `[]`, and `[]` is not nullish — so `??`
 * cheerfully overwrote good items with none.
 */
import type { Payload } from "./types";

export function isEmptyResult(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  return false;
}

/**
 * `now` is Unix seconds. When the new result is empty and something usable is
 * already stored, the stored value survives *with its original timestamp* —
 * so staleness keeps counting from when the data was actually fetched, and a
 * source that has quietly died still ages out instead of looking fresh
 * forever.
 */
export function mergePayload(
  id: string,
  prev: Payload | undefined,
  data: unknown,
  ttl: number,
  now: number,
  error?: string,
  configHash?: string,
): Payload {
  const empty = isEmptyResult(data);
  // Data produced under different options is not "what we already have" — it
  // is a different question's answer. Removing a source must remove its
  // articles even if every remaining source then fails.
  // A stored payload with no fingerprint predates fingerprinting, so its
  // provenance is unknown — and unknown must not count as "same". Treating it
  // as same is what kept a removed source's articles on screen indefinitely
  // for anyone upgrading, which is everyone.
  const sameConfig = configHash === undefined || prev?.config_hash === configHash;
  const keepPrev = empty && sameConfig && !isEmptyResult(prev?.data);

  const kept = keepPrev ? prev!.data : data;
  const stamped = keepPrev ? (prev!.generated_at ?? 0) : now;
  const usable = !isEmptyResult(kept);

  return {
    instanceId: id,
    data: kept ?? null,
    generated_at: usable ? stamped : 0,
    stale_after: (usable ? stamped : 0) + ttl,
    ...(error ? { error } : {}),
    ...(configHash !== undefined ? { config_hash: configHash } : {}),
  };
}

/**
 * Every payload with its `error` note removed.
 *
 * A note describes the last *attempt*; the data describes the last *success*.
 * Storing them in one record means a note outlives the code that wrote it —
 * which is how a message deleted from the source kept rendering from storage
 * long after the condition it named was fixed. Sweeping them on start makes a
 * note as short-lived as the attempt it describes: anything still true is
 * written again by the refresh that follows.
 *
 * Returns `touched` so a caller can skip a pointless write.
 */
export function withoutErrors<T extends Record<string, Payload>>(
  payloads: T,
): { payloads: T; touched: boolean } {
  let touched = false;
  const out = {} as T;
  for (const [id, p] of Object.entries(payloads) as [keyof T & string, Payload][]) {
    if (p && "error" in p) {
      const { error: _drop, ...rest } = p;
      out[id] = rest as T[keyof T & string];
      touched = true;
    } else {
      out[id] = p as T[keyof T & string];
    }
  }
  return { payloads: out, touched };
}

/**
 * A stable fingerprint of whatever affects a group's output.
 *
 * Order-insensitive over object keys so a settings round-trip that reorders
 * them does not read as a change and needlessly discard good data.
 */
export function configHashOf(opts: unknown): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    const rec = v as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`)
      .join(",")}}`;
  };
  const s = stable(opts);
  // FNV-1a: short, stable, and this is a cache key, not a security boundary.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
