"use strict";
/**
 * Reading an `app.asar` header and patching its `package.json` IN PLACE.
 *
 * WHY NOT REPACK
 * The Codex archive is 309,523,971 bytes. Rebuilding it means recomputing the
 * offset of all 8,868 entries, and one mistake there produces an app that will
 * not start. The patch we need is tiny: change the `main` field. So we write only
 * the bytes of `package.json`, KEEPING THE EXACT SAME LENGTH, padding the
 * remainder with spaces - JSON ignores whitespace. No offset moves, the header
 * does not change, and reverting is writing the same bytes back.
 *
 * FORMAT (Chromium pickle), measured on this app:
 *   offset 0   uint32  = 4                      (size of the next field)
 *   offset 4   uint32  = headerPickleSize        (2441368)
 *   offset 8   uint32  = headerPickleSize - 4    (2441364)
 *   offset 12  uint32  = jsonLen                 (2441358)
 *   offset 16  jsonLen bytes of JSON
 *   padding    to align on 4 bytes
 *   baseOffset = 8 + headerPickleSize             (2441376)
 * Each entry holds { size, offset }, where offset is relative to baseOffset and
 * arrives as a STRING in the JSON.
 */
const fs = require("node:fs");

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error("archive truncated in the header");
    const w1 = head.readUInt32LE(0);
    const headerPickleSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (w1 !== 4) throw new Error(`unexpected archive header (w1=${w1})`);
    if (jsonLen <= 0 || jsonLen > headerPickleSize) {
      throw new Error(`archive has an invalid jsonLen (${jsonLen})`);
    }
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    return {
      headerPickleSize,
      jsonLen,
      baseOffset: 8 + headerPickleSize,
      header: JSON.parse(json.toString("utf8")),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** A file entry in the header, by a path such as "package.json" or "a/b.js". */
function findEntry(header, relPath) {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  let node = header;
  for (let i = 0; i < parts.length; i += 1) {
    if (!node || !node.files) return null;
    node = node.files[parts[i]];
  }
  return node && typeof node.size === "number" && node.offset !== undefined ? node : null;
}

function readFileFromAsar(asarPath, relPath) {
  const { baseOffset, header } = readHeader(asarPath);
  const entry = findEntry(header, relPath);
  if (!entry) throw new Error(`could not find ${relPath} inside the archive`);
  const fd = fs.openSync(asarPath, "r");
  try {
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset));
    return { buf, entry, baseOffset };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes `content` over an existing entry, REQUIRING that it fits in the original
 * space. Pads the remainder with spaces.
 *
 * Refuses instead of growing the file: growing would force offsets to move, which
 * is exactly the risk this module exists to avoid.
 */
function writeFileInPlace(asarPath, relPath, content) {
  const { entry, baseOffset } = readFileFromAsar(asarPath, relPath);
  const payload = Buffer.from(content, "utf8");
  if (payload.length > entry.size) {
    throw new Error(
      `the new content of ${relPath} is ${payload.length} bytes and does not fit in ` +
        `the original ${entry.size}. Aborted on purpose: growing the entry would ` +
        `require rewriting every offset in the archive.`,
    );
  }
  const padded = Buffer.alloc(entry.size, 0x20); // space
  payload.copy(padded, 0);
  const fd = fs.openSync(asarPath, "r+");
  try {
    fs.writeSync(fd, padded, 0, padded.length, baseOffset + Number(entry.offset));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { wrote: payload.length, capacity: entry.size };
}

module.exports = { readHeader, findEntry, readFileFromAsar, writeFileInPlace };
