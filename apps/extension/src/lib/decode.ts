/**
 * Turning fetched bytes into text, with the right character set.
 *
 * `Response.text()` decodes as UTF-8 unless the HTTP `Content-Type` names a
 * charset. That is correct for most of the web and wrong for a specific,
 * still-populous class of feed: one served as `text/xml` with no charset at
 * all, declaring its encoding *inside* the document.
 *
 * Folha de S.Paulo is the case that found this. It sends
 *
 *     content-type: text/xml
 *     <?xml version="1.0" encoding="ISO-8859-1" ?>
 *
 * so every accented character arrived as U+FFFD and the card showed
 * "estudantes de medicina t<?>m sintomas". Not a crash, not an error — just
 * a topic that looks broken, in every language that needs an accent.
 *
 * So: take the bytes, and believe, in order, the HTTP charset, then the
 * document's own declaration, then UTF-8.
 */

/** `<?xml … encoding="…"?>`, and HTML's `<meta charset>` for good measure. */
const XML_DECL = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i;

/**
 * Read the charset a document claims for itself.
 *
 * Sniffed from the first bytes decoded as Latin-1 — every encoding worth
 * detecting here is ASCII-compatible in its declaration, so this cannot be
 * wrong about the *name* even when it is wrong about the body.
 */
export function declaredCharset(head: string): string | null {
  const xml = XML_DECL.exec(head);
  if (xml?.[1]) return xml[1].toLowerCase();
  const meta = META_CHARSET.exec(head);
  if (meta?.[1]) return meta[1].toLowerCase();
  return null;
}

/** The charset from a `Content-Type` header, if it names one. */
export function headerCharset(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Decode a response body.
 *
 * `TextDecoder` refuses a label it does not know, and a feed naming a charset
 * nobody implements must not take the whole group down — so an unusable label
 * falls back to UTF-8, which is what the platform would have done anyway.
 */
export function decodeBody(bytes: ArrayBuffer, contentType: string | null): string {
  const bin = new Uint8Array(bytes);
  const fromHeader = headerCharset(contentType);

  // The declaration lives in the first line or two. Latin-1 over the head is
  // enough to read it, and cannot throw.
  const head = new TextDecoder("iso-8859-1").decode(bin.subarray(0, 1024));
  const label = fromHeader ?? declaredCharset(head) ?? "utf-8";

  try {
    return new TextDecoder(label).decode(bin);
  } catch {
    return new TextDecoder("utf-8").decode(bin);
  }
}
