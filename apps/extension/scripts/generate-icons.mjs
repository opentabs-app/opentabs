// Icons from pixel math — no image library, no design tool.
//
// A grid of tabs on the OpenApps blue: three bars, the first highlighted,
// which reads as "tabs" at 16px where anything more detailed turns to mud.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

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

function png(size) {
  const px = (x, y) => {
    const u = x / size, v = y / size;
    const r = size * 0.18;
    // Rounded-square mask.
    const inCorner = (cx, cy) =>
      (x - cx) ** 2 + (y - cy) ** 2 > r ** 2 &&
      (x < r ? cx === r : x > size - r ? cx === size - r : false) &&
      (y < r ? cy === r : y > size - r ? cy === size - r : false);
    if (
      inCorner(r, r) || inCorner(size - r, r) ||
      inCorner(r, size - r) || inCorner(size - r, size - r)
    ) return [0, 0, 0, 0];

    // Three tab bars; the top one is the "active" tab, drawn brighter.
    const bars = [
      { y0: 0.24, y1: 0.40, x0: 0.18, x1: 0.82, on: true },
      { y0: 0.46, y1: 0.60, x0: 0.18, x1: 0.68, on: false },
      { y0: 0.66, y1: 0.80, x0: 0.18, x1: 0.56, on: false },
    ];
    for (const b of bars) {
      if (v >= b.y0 && v <= b.y1 && u >= b.x0 && u <= b.x1) {
        return b.on ? [255, 255, 255, 255] : [255, 255, 255, 150];
      }
    }
    return [0x15, 0xb9, 0xeb, 255]; // OpenApps blue
  };

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x + 0.5, y + 0.5);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(resolve(out, `icon${size}.png`), png(size));
}
console.log("icons written:", out);
