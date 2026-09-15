"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { readFileFromAsar, readHeader, writeFileInPlace, verifyFileIntegrity } = require("../src/asar");
const hash = b => crypto.createHash("sha256").update(b).digest("hex");

function archive(t, withIntegrity = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-asar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "app.asar");
  const data = Buffer.from('{"main":"original.js"}' + " ".repeat(64));
  const sibling = Buffer.from("original sibling content");
  const blockSize = 32;
  const blocks = [];
  for (let i = 0; i < data.length; i += blockSize) blocks.push(hash(data.subarray(i, i + blockSize)));
  const entry = { size: data.length, offset: "0" };
  if (withIntegrity) entry.integrity = { algorithm: "SHA256", hash: hash(data), blockSize, blocks };
  const json = Buffer.from(JSON.stringify({ files: { "package.json": entry,
    "sibling.js": { size: sibling.length, offset: String(data.length) } } }));
  const pickleSize = Math.ceil((8 + json.length) / 4) * 4;
  const head = Buffer.alloc(8 + pickleSize);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(pickleSize, 4);
  head.writeUInt32LE(pickleSize - 4, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  fs.writeFileSync(file, Buffer.concat([head, data, sibling]));
  return { file, data, sibling };
}
test("Owl integrity hashes match padded content; size, offsets, sibling bytes remain unchanged", t => {
  const { file, data, sibling } = archive(t);
  const size = fs.statSync(file).size;
  const before = readHeader(file);
  assert.equal(writeFileInPlace(file, "package.json", '{"main":"loader.cjs"}').integrityUpdated, true);
  const { buf, entry } = readFileFromAsar(file, "package.json");
  assert.equal(verifyFileIntegrity(file, "package.json"), true);
  assert.equal(entry.integrity.hash, hash(buf));
  for (let i = 0; i < entry.integrity.blocks.length; i++) {
    assert.equal(entry.integrity.blocks[i], hash(buf.subarray(i * 32, (i + 1) * 32)));
  }
  assert.equal(fs.statSync(file).size, size);
  assert.equal(readHeader(file).baseOffset, before.baseOffset);
  assert.deepEqual(readFileFromAsar(file, "sibling.js").buf, sibling);
  writeFileInPlace(file, "package.json", data.toString());
  assert.deepEqual(readHeader(file).headerBytes, before.headerBytes);
  assert.deepEqual(readFileFromAsar(file, "package.json").buf, data);
});
test("oversized changes leave all archive bytes untouched", t => {
  const { file } = archive(t);
  const original = fs.readFileSync(file);
  assert.throws(() => writeFileInPlace(file, "package.json", "x".repeat(1000)), /does not fit/);
  assert.deepEqual(fs.readFileSync(file), original);
});
test("legacy archives without integrity metadata remain supported", t => {
  const { file } = archive(t, false);
  assert.equal(writeFileInPlace(file, "package.json", '{"main":"loader.cjs"}').integrityUpdated, false);
  assert.equal(JSON.parse(readFileFromAsar(file, "package.json").buf).main, "loader.cjs");
});
test("readback detects stale integrity metadata before an installation is accepted", t => {
  const { file } = archive(t);
  const { entry, baseOffset } = readFileFromAsar(file, "package.json");
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.from("x"), 0, 1, baseOffset + Number(entry.offset));
  fs.closeSync(fd);
  assert.throws(() => verifyFileIntegrity(file, "package.json"), /invalid integrity/);
});
