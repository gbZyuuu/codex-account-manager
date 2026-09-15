#!/usr/bin/env node
/**
 * Generates `assets/icon.ico` with no external dependency at all.
 *
 * WHY PNG AND ICO ARE WRITTEN BY HAND: adding `sharp`/`png-to-ico` to the
 * project would drag in a native binary and an `npm install` step just to
 * produce a file that almost never changes. The project installer only requires
 * Node; keeping that promise is worth more than the convenience of a library.
 * `zlib` already ships with Node and is all the PNG needs.
 *
 * ARTWORK: a dark rounded square with three quota bars - long/green,
 * medium/amber, short/red. Chosen because it stays readable at 16 pixels and
 * says exactly what the program does: quota across several accounts, one bar per
 * account. A circular gauge with a needle was discarded: at 16px the needle
 * becomes a one-pixel smudge and the shape is indistinguishable from any other
 * circle.
 *
 * ANTIALIASING: renders at 4x and averages 4x4 samples per output pixel. Without
 * this the rounded edges look jagged at the small sizes.
 *
 * Usage: node tools/make-icon.js
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor

// ---------------------------------------------------------------- artwork

const BG = [0x17, 0x18, 0x1a];
const BORDER = [0x35, 0x37, 0x3b];
const TRACK = [0xff, 0xff, 0xff];
const TRACK_A = 0.13;
const BARS = [
  { y: 0.305, width: 0.88, color: [0x3f, 0xb9, 0x50] }, // green: plenty of quota
  { y: 0.5, width: 0.54, color: [0xd2, 0x99, 0x22] }, // amber: about half
  { y: 0.695, width: 0.22, color: [0xf8, 0x51, 0x49] }, // red: running out
];
const BAR_X0 = 0.17;
const BAR_X1 = 0.83;
const BAR_H = 0.084;
const BG_RADIUS = 0.225;

/** Inside a rounded-corner rectangle? Coordinates in 0..1. */
function insideRRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.max(Math.abs(px - cx) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(py - cy) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Horizontal capsule: rounded rectangle whose radius equals half its height. */
function insideBar(px, py, x0, x1, yCenter, height) {
  const r = height / 2;
  return insideRRect(px, py, x0, yCenter - r, Math.max(x1 - x0, height), height, r);
}

/** Blends `color` over `dst` with alpha 0..1. */
function over(dst, i, color, alpha) {
  dst[i] = Math.round(dst[i] * (1 - alpha) + color[0] * alpha);
  dst[i + 1] = Math.round(dst[i + 1] * (1 - alpha) + color[1] * alpha);
  dst[i + 2] = Math.round(dst[i + 2] * (1 - alpha) + color[2] * alpha);
  dst[i + 3] = Math.round(dst[i + 3] * (1 - alpha) + 255 * alpha);
}

/**
 * Rasterizes RGBA at the requested size.
 *
 * The coverage of each output pixel comes from the average of SSxSS binary
 * samples. Every layer accumulates into its own coverage and is composited
 * afterwards, so the edges do not pick up a halo from the layer underneath.
 */
function rasterize(size) {
  const out = Buffer.alloc(size * size * 4, 0); // transparent
  const n = SS * SS;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let cBg = 0;
      let cBorder = 0;
      const cTrack = [0, 0, 0];
      const cFill = [0, 0, 0];

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const ux = (px + (sx + 0.5) / SS) / size;
          const uy = (py + (sy + 0.5) / SS) / size;

          const onBg = insideRRect(ux, uy, 0, 0, 1, 1, BG_RADIUS);
          if (!onBg) continue;
          cBg += 1;
          // Border ring: inside the background but outside the shrunk background.
          const margin = 0.028;
          if (
            !insideRRect(ux, uy, margin, margin, 1 - 2 * margin, 1 - 2 * margin, BG_RADIUS - margin)
          ) {
            cBorder += 1;
            continue;
          }
          for (let b = 0; b < BARS.length; b += 1) {
            const bar = BARS[b];
            if (insideBar(ux, uy, BAR_X0, BAR_X1, bar.y, BAR_H)) {
              cTrack[b] += 1;
              const end = BAR_X0 + (BAR_X1 - BAR_X0) * bar.width;
              if (insideBar(ux, uy, BAR_X0, end, bar.y, BAR_H)) cFill[b] += 1;
            }
          }
        }
      }

      if (!cBg) continue;
      const i = (py * size + px) * 4;
      over(out, i, BG, cBg / n);
      if (cBorder) over(out, i, BORDER, cBorder / n);
      for (let b = 0; b < BARS.length; b += 1) {
        if (cTrack[b]) over(out, i, TRACK, (cTrack[b] / n) * TRACK_A);
        if (cFill[b]) over(out, i, BARS[b].color, cFill[b] / n);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA PNG, non-interlaced, filter 0 on every row. */
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlacing

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // row filter type
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO

/**
 * ICO container with an embedded PNG (accepted by Windows since Vista).
 *
 * In the directory table, width/height 256 are stored as 0: the field is a
 * single byte, so 256 does not fit and 0 is the agreed-upon value.
 */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette colors: 0 = no palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---------------------------------------------------------------- main

const projectRoot = path.join(__dirname, "..");
const assetsDir = path.join(projectRoot, "assets");
fs.mkdirSync(assetsDir, { recursive: true });

const entries = SIZES.map((size) => {
  const data = png(rasterize(size), size);
  process.stdout.write(`  ${size}x${size}: ${data.length} bytes\n`);
  return { size, data };
});

const icoTarget = path.join(assetsDir, "icon.ico");
fs.writeFileSync(icoTarget, ico(entries));
process.stdout.write(`icon written: ${icoTarget} (${fs.statSync(icoTarget).size} bytes)\n`);

// A standalone 256 PNG as well, useful for the README and for a store listing
// if one ever exists.
const pngTarget = path.join(assetsDir, "icon-256.png");
fs.writeFileSync(pngTarget, entries[entries.length - 1].data);
process.stdout.write(`png written: ${pngTarget} (${fs.statSync(pngTarget).size} bytes)\n`);
