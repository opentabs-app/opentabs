/**
 * The OpenTabs mark, as pixels. One definition, used by everything.
 *
 * Icons from pixel math — no image library, no design tool, no binary
 * checked in that nobody can regenerate.
 *
 * A grid of tabs on the OpenApps blue: three bars, the first highlighted,
 * which reads as "tabs" at 16px where anything more detailed turns to mud.
 *
 * This module exists because the mark was previously written out inside the
 * extension's icon script, and the website then grew a *second*, different
 * mark of its own — so the tab icon and the site favicon were two unrelated
 * drawings of the same product. Both now come from here.
 */
import { deflateSync } from "node:zlib";

/** OpenApps blue. The same ground OpenCapture and the rest of the suite use. */
export const BLUE = [0x15, 0xb9, 0xeb];

/**
 * The three bars, in fractions of the canvas.
 *
 * Fractions rather than pixels so the same geometry holds from a 16px
 * favicon to a 512px app icon to the SVG.
 */
export const BARS = [
  { y0: 0.24, y1: 0.4, x0: 0.18, x1: 0.82, on: true },
  { y0: 0.46, y1: 0.6, x0: 0.18, x1: 0.68, on: false },
  { y0: 0.66, y1: 0.8, x0: 0.18, x1: 0.56, on: false },
];

/** Corner radius, as a fraction of the canvas. */
export const RADIUS = 0.18;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** The mark at `size`×`size`, as a PNG buffer. */
export function png(size) {
  const px = (x, y) => {
    const u = x / size;
    const v = y / size;
    const r = size * RADIUS;
    // Rounded-square mask.
    const inCorner = (cx, cy) =>
      (x - cx) ** 2 + (y - cy) ** 2 > r ** 2 &&
      (x < r ? cx === r : x > size - r ? cx === size - r : false) &&
      (y < r ? cy === r : y > size - r ? cy === size - r : false);
    if (
      inCorner(r, r) ||
      inCorner(size - r, r) ||
      inCorner(r, size - r) ||
      inCorner(size - r, size - r)
    ) {
      return [0, 0, 0, 0];
    }
    for (const b of BARS) {
      if (v >= b.y0 && v <= b.y1 && u >= b.x0 && u <= b.x1) {
        return b.on ? [255, 255, 255, 255] : [255, 255, 255, 150];
      }
    }
    return [...BLUE, 255];
  };

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x + 0.5, y + 0.5);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The same mark as SVG, for the one place a vector is better: a browser tab
 * on a high-DPI screen, and a dark-mode tab strip where a PNG's baked-in
 * background is the only thing that keeps the glyph legible.
 */
export function svg(px = 32) {
  const rect = (b) => {
    const x = (b.x0 * px).toFixed(2);
    const y = (b.y0 * px).toFixed(2);
    const w = ((b.x1 - b.x0) * px).toFixed(2);
    const h = ((b.y1 - b.y0) * px).toFixed(2);
    const fill = b.on ? "#ffffff" : "rgba(255,255,255,0.59)";
    return `  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${(px * 0.02).toFixed(2)}" fill="${fill}"/>`;
  };
  const blue = `#${BLUE.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" role="img" aria-label="OpenTabs">`,
    `  <rect width="${px}" height="${px}" rx="${(px * RADIUS).toFixed(2)}" fill="${blue}"/>`,
    ...BARS.map(rect),
    `</svg>`,
    ``,
  ].join("\n");
}

/**
 * An ICO wrapping PNGs, which every browser since Vista accepts.
 *
 * `favicon.ico` at the site root is still worth shipping in 2026: it is what
 * a browser requests when it cannot use the `<link>` tags — and, more to the
 * point here, what several link-preview crawlers fetch without looking at
 * the HTML at all.
 */
export function ico(sizes = [16, 32, 48]) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    // 256 is encoded as 0 in this byte, which is the one ICO gotcha.
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}
