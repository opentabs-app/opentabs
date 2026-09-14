/**
 * The charset rules, against the shapes real publishers actually serve.
 */
import { describe, expect, it } from "vitest";
import { decodeBody, declaredCharset, headerCharset } from "./decode";

/** Latin-1 bytes for a string, the way an ISO-8859-1 feed is on the wire. */
function latin1(s: string): ArrayBuffer {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b.buffer;
}
const utf8 = (s: string) => new TextEncoder().encode(s).buffer;

describe("decodeBody", () => {
  it("believes the XML declaration when the header says nothing", () => {
    // Folha de S.Paulo, verbatim: `content-type: text/xml` with no charset,
    // ISO-8859-1 declared inside. Decoded as UTF-8 this reads
    // "t�m sintomas" — visible garbage in the card, and no error.
    const doc =
      '<?xml version="1.0" encoding="ISO-8859-1" ?>' +
      "<rss><channel><item><title>estudantes de medicina têm sintomas</title>" +
      "</item></channel></rss>";
    const out = decodeBody(latin1(doc), "text/xml");
    expect(out).toContain("têm sintomas");
    expect(out).not.toContain("�");
  });

  it("prefers the HTTP header over the document, because the server is closer to the truth", () => {
    const doc = '<?xml version="1.0" encoding="ISO-8859-1"?><t>café</t>';
    expect(decodeBody(utf8(doc), "text/xml; charset=utf-8")).toContain("café");
  });

  it("defaults to UTF-8 when nobody says", () => {
    expect(decodeBody(utf8("<t>café</t>"), null)).toContain("café");
    expect(decodeBody(utf8("<t>café</t>"), "application/rss+xml")).toContain("café");
  });

  it("falls back rather than throwing on a charset nobody implements", () => {
    // A feed naming something unusable must not take its whole group down.
    const doc = '<?xml version="1.0" encoding="x-mac-klingon"?><t>hello</t>';
    expect(decodeBody(utf8(doc), null)).toContain("hello");
  });

  it("reads a declaration that is not on the first byte", () => {
    const doc = "﻿" + '<?xml version="1.0" encoding="windows-1252"?><t>x</t>';
    expect(decodeBody(utf8(doc), null)).toContain("<t>x</t>");
  });
});

describe("charset sniffing", () => {
  it("finds the encoding in an XML declaration", () => {
    expect(declaredCharset('<?xml version="1.0" encoding="ISO-8859-1" ?>')).toBe("iso-8859-1");
    expect(declaredCharset("<?xml version='1.0' encoding='windows-1251'?>")).toBe("windows-1251");
  });

  it("finds one in an HTML meta tag, for a page served as a feed", () => {
    expect(declaredCharset('<html><meta charset="Shift_JIS">')).toBe("shift_jis");
  });

  it("returns null when the document claims nothing", () => {
    expect(declaredCharset('<?xml version="1.0"?><rss/>')).toBeNull();
    expect(declaredCharset("<rss><channel/></rss>")).toBeNull();
  });

  it("reads the header's charset in the forms servers send it", () => {
    expect(headerCharset("text/xml; charset=UTF-8")).toBe("utf-8");
    expect(headerCharset('text/xml;charset="ISO-8859-1"')).toBe("iso-8859-1");
    expect(headerCharset("text/xml")).toBeNull();
    expect(headerCharset(null)).toBeNull();
  });
});
