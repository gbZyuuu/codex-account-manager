"use strict";
/**
 * Reading an `app.asar` header and patching its `package.json` IN PLACE.
 *
 * WHY NOT REPACK
 * The Codex archive is 309,523,971 bytes. Rebuilding it means recomputing the
 * offset of all 8,868 entries, and one mistake there produces an app that will
 * not start. The patch we need is tiny: change the `main` field. So we write only
 * the bytes of `package.json`, KEEPING THE EXACT SAME LENGTH, padding the
 * remainder with spaces - JSON ignores whitespace. No offset moves. Only
 * fixed-length integrity hashes in the header change; reverting regenerates
 * those hashes from the restored bytes.
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
const crypto = require("node:crypto");

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
      headerBytes: json,
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
  const { buf: before, entry, baseOffset } = readFileFromAsar(asarPath, relPath);
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
  // Owl now verifies individual ASAR entries. Updating the content alone causes
  // "ASAR Integrity Violation" at startup. Keep hashes in the same header space;
  // no entry sizes, offsets, or the archive's total length may change.
  const parsed = readHeader(asarPath);
  const target = findEntry(parsed.header, relPath);
  let nextHeader = parsed.headerBytes;
  if (target.integrity) {
    const integrity = target.integrity;
    if (integrity.algorithm !== "SHA256" || !Number.isSafeInteger(integrity.blockSize) ||
        integrity.blockSize <= 0 || !Array.isArray(integrity.blocks)) {
      throw new Error("unsupported ASAR integrity metadata; no bytes written");
    }
    const digest = b => crypto.createHash("sha256").update(b).digest("hex");
    const blocks = [];
    for (let i = 0; i < padded.length; i += integrity.blockSize) {
      blocks.push(digest(padded.subarray(i, Math.min(padded.length, i + integrity.blockSize))));
    }
    if (blocks.length !== integrity.blocks.length) throw new Error("ASAR block count changed; no bytes written");
    integrity.hash = digest(padded);
    integrity.blocks = blocks;
    nextHeader = Buffer.from(JSON.stringify(parsed.header), "utf8");
    if (nextHeader.length !== parsed.jsonLen) throw new Error("ASAR header size changed; no bytes written");
  }
  const fd = fs.openSync(asarPath, "r+");
  try {
    fs.writeSync(fd, padded, 0, padded.length, baseOffset + Number(entry.offset));
    if (target.integrity) fs.writeSync(fd, nextHeader, 0, nextHeader.length, 16);
    fs.fsyncSync(fd);
  } catch (error) {
    // A partial write must not leave the content and its hashes disagreeing.
    fs.writeSync(fd, before, 0, before.length, baseOffset + Number(entry.offset));
    fs.writeSync(fd, parsed.headerBytes, 0, parsed.headerBytes.length, 16);
    fs.fsyncSync(fd);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return { wrote: payload.length, capacity: entry.size, integrityUpdated: Boolean(target.integrity) };
}

function verifyFileIntegrity(asarPath, relPath) {
  const { buf, entry } = readFileFromAsar(asarPath, relPath);
  if (!entry.integrity) return true;
  const integrity = entry.integrity;
  const digest = b => crypto.createHash("sha256").update(b).digest("hex");
  if (integrity.algorithm !== "SHA256" || integrity.hash !== digest(buf) ||
      !Number.isSafeInteger(integrity.blockSize) || integrity.blockSize <= 0 ||
      !Array.isArray(integrity.blocks) || integrity.blocks.length !== Math.ceil(buf.length / integrity.blockSize)) {
    throw new Error(`invalid integrity for ${relPath}`);
  }
  for (let i = 0; i < integrity.blocks.length; i++) {
    if (integrity.blocks[i] !== digest(buf.subarray(i * integrity.blockSize, (i + 1) * integrity.blockSize))) {
      throw new Error(`invalid block integrity for ${relPath}`);
    }
  }
  return true;
}

module.exports = { readHeader, findEntry, readFileFromAsar, writeFileInPlace, verifyFileIntegrity };
