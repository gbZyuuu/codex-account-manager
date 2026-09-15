"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { integrityResources, syncExecutableIntegrity } = require("../src/integrity");

function executable(text) {
  const b = Buffer.alloc(0x1200);
  const pe = 0x80, optional = pe + 24, section = optional + 0xf0;
  b.writeUInt32LE(pe, 0x3c);
  b.write("PE\0\0", pe);
  b.writeUInt16LE(1, pe + 6);
  b.writeUInt16LE(0xf0, pe + 20);
  b.writeUInt16LE(0x20b, optional);
  b.writeUInt32LE(0x1000, optional + 112 + 16);
  b.writeUInt32LE(0x1000, section + 12);
  b.writeUInt32LE(0x1000, section + 16);
  b.writeUInt32LE(0x200, section + 20);
  const base = 0x200;
  function named(dir, label, nameOffset, target) {
    b.writeUInt16LE(1, base + dir + 12);
    b.writeUInt32LE((0x80000000 + nameOffset) >>> 0, base + dir + 16);
    b.writeUInt32LE((0x80000000 + target) >>> 0, base + dir + 20);
    b.writeUInt16LE(label.length, base + nameOffset);
    b.write(label, base + nameOffset + 2, "utf16le");
  }
  named(0, "INTEGRITY", 0x100, 0x20);
  named(0x20, "ELECTRONASAR", 0x130, 0x40);
  b.writeUInt16LE(1, base + 0x40 + 14);
  b.writeUInt32LE(1033, base + 0x40 + 16);
  b.writeUInt32LE(0x80, base + 0x40 + 20);
  b.writeUInt32LE(0x1200, base + 0x80);
  b.writeUInt32LE(Buffer.byteLength(text), base + 0x80 + 4);
  b.write(text, 0x400, "utf8");
  return b;
}
test("Windows executable header hash updates only its named resource; validation stays enabled", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-pe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, "ChatGPT.exe"), asar = path.join(dir, "app.asar");
  const json = Buffer.from('{"files":{}}');
  const head = Buffer.alloc(8 + Math.ceil((8 + json.length) / 4) * 4);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(head.length - 8, 4);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  fs.writeFileSync(asar, head);
  const original = executable(JSON.stringify([{ file: "resources\\app.asar", alg: "SHA256", value: "a".repeat(64) }]));
  fs.writeFileSync(exe, original);
  const result = syncExecutableIntegrity(exe, asar);
  const patched = fs.readFileSync(exe);
  const resource = integrityResources(patched)[0];
  assert.equal(result.resourceCount, 1);
  assert.equal(JSON.parse(resource.text)[0].value, crypto.createHash("sha256").update(json).digest("hex"));
  assert.equal(patched.length, original.length);
  assert.deepEqual(patched.subarray(0, resource.offset), original.subarray(0, resource.offset));
  assert.deepEqual(patched.subarray(resource.offset + resource.size), original.subarray(resource.offset + resource.size));
});
test("legacy executables without embedded ASAR integrity return no resource", () => {
  const b = executable("[]");
  b.writeUInt32LE(0, 0x80 + 24 + 112 + 16);
  assert.deepEqual(integrityResources(b), []);
});
