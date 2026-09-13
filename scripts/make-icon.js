'use strict';

// Generates assets/icon.png with zero dependencies (zlib + CRC32 only).
//
//   • dark rounded-square tile with a soft radial glow (#111214 -> #000000)
//   • a geometric "K" mark in a light grey gradient (#9ca3af -> #e5e7eb)
//
// The K is a vector shape (three filled quads), not a font glyph, so the icon
// renders identically on Windows, macOS and Linux and needs no tooling.
// Run: node scripts/make-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512; // output edge in px (electron-builder wants >=256; 512 covers macOS)
const VIEW = 200; // design grid — mirrors assets/icon.svg's viewBox
const S = SIZE / VIEW;
const INV_S = VIEW / SIZE;
const SS = 4; // supersampling per axis when rasterising the K

// ---- CRC32 ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- design geometry (200x200 design grid) --------------------------------
const TILE_RADIUS = 42;
const GLOW = { cx: 60, cy: 30, r: 180 }; // radial tile gradient, % of the design box
const K_GRAD_A = [0x9c, 0xa3, 0xaf]; // #9ca3af
const K_GRAD_B = [0xe5, 0xe7, 0xeb]; // #e5e7eb
const BG_A = [0x11, 0x12, 0x14]; // #111214
const BG_B = [0x00, 0x00, 0x00]; // #000000

// The K is the union of three quads: stem, upper arm, lower leg.
const K_QUADS = [
  [[52, 48], [82, 48], [82, 152], [52, 152]], // stem
  [[87.72, 110.86], [147.72, 72.86], [132.28, 47.14], [72.28, 85.14]], // upper arm
  [[71.97, 114.67], [131.97, 152.67], [148.03, 127.33], [88.03, 89.33]], // lower leg
];

// ---- helpers --------------------------------------------------------------
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function mix(a, b, t) { return a + (b - a) * t; }

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- render ---------------------------------------------------------------
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const X = (x + 0.5) * INV_S;
    const Y = (y + 0.5) * INV_S;

    // Rounded-square tile: signed distance, 1-device-px antialiased edge.
    const cx = Math.max(TILE_RADIUS, Math.min(VIEW - TILE_RADIUS, X));
    const cy = Math.max(TILE_RADIUS, Math.min(VIEW - TILE_RADIUS, Y));
    const d = Math.sqrt((X - cx) ** 2 + (Y - cy) ** 2) - TILE_RADIUS;
    const tileA = clamp01(0.5 - d * S);

    // Soft radial glow behind the K.
    const gd = Math.sqrt((X - GLOW.cx) ** 2 + (Y - GLOW.cy) ** 2);
    const gt = clamp01(gd / GLOW.r);
    let r = mix(BG_A[0], BG_B[0], gt);
    let g = mix(BG_A[1], BG_B[1], gt);
    let b = mix(BG_A[2], BG_B[2], gt);

    // K coverage via supersampling.
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const Xs = (x + (sx + 0.5) / SS) * INV_S;
        const Ys = (y + (sy + 0.5) / SS) * INV_S;
        for (let q = 0; q < K_QUADS.length; q++) {
          if (inPoly(Xs, Ys, K_QUADS[q])) { hits++; break; }
        }
      }
    }
    const kCov = hits / (SS * SS);

    if (kCov > 0) {
      const kt = clamp01(((X - 52) + (Y - 47)) / 202);
      r = mix(r, mix(K_GRAD_A[0], K_GRAD_B[0], kt), kCov);
      g = mix(g, mix(K_GRAD_A[1], K_GRAD_B[1], kt), kCov);
      b = mix(b, mix(K_GRAD_A[2], K_GRAD_B[2], kt), kCov);
    }

    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(r);
    px[i + 1] = Math.round(g);
    px[i + 2] = Math.round(b);
    px[i + 3] = Math.round(clamp01(tileA) * 255);
  }
}

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(SIZE, SIZE, px));
console.log('wrote', out, `${SIZE}x${SIZE}`, `(${fs.statSync(out).size} bytes)`);
