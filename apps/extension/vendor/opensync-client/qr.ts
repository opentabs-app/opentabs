// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
import { Invitation } from "./wasm/opensync_wasm.js";

/**
 * Drawing a pairing invitation where a camera can see it.
 *
 * A canvas rather than an `<img>` of a data URI: the grid comes out of wasm as
 * booleans, and rasterising it here means the QR is drawn at exactly the pixel
 * size the layout gives it, with no resampling. A QR that has been scaled by
 * the browser is a QR with grey edges, and grey edges are how a phone at arm's
 * length fails to find one.
 */
export function drawInvitation(
  canvas: HTMLCanvasElement,
  invitation: Invitation,
  options: QrOptions = {},
): void {
  const size = invitation.qrSize();
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) rows.push(Array.from(invitation.qrRow(y), (m) => !!m));
  drawModules(canvas, rows, options);
}

export interface QrOptions {
  moduleSize?: number;
  dark?: string;
  light?: string;
}

/**
 * The same drawing, for a grid that came from somewhere other than an
 * invitation — an account link, say. Everything the invitation path was
 * careful about applies unchanged, so it is the one implementation and
 * `drawInvitation` feeds it.
 */
export function drawModules(
  canvas: HTMLCanvasElement,
  rows: boolean[][],
  options: QrOptions = {},
): void {
  const size = rows.length;
  if (!size) throw new Error("nothing to draw");
  // Whole pixels per module, never a fraction. A module boundary that lands
  // mid-pixel is the same grey edge, arrived at a different way.
  const scale = Math.max(1, Math.floor(options.moduleSize ?? 6));
  const px = size * scale;

  // A device-pixel-ratio backing store, so the QR is sharp on the screens most
  // likely to be photographed off — which are the retina ones.
  const dpr = typeof devicePixelRatio === "number" ? Math.max(1, Math.floor(devicePixelRatio)) : 1;
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas context");

  // Light first, over the whole square: the quiet zone is part of the QR, and
  // a transparent background would let a dark page bleed through it and turn
  // the code into a photographic negative. Some scanners cope with that. The
  // ones that do not, fail silently.
  ctx.fillStyle = options.light ?? "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = options.dark ?? "#000000";
  for (let y = 0; y < size; y++) {
    const row = rows[y];
    for (let x = 0; x < size; x++) {
      if (row[x]) ctx.fillRect(x * scale * dpr, y * scale * dpr, scale * dpr, scale * dpr);
    }
  }
}
