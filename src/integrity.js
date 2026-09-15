"use strict";
// Windows embeds the ASAR header hash in the executable's Integrity/ElectronAsar
// resource. Update that resource in place, keeping validation enabled. The Store
// executable is never a target; callers use the manager's writable app copy.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { readHeader } = require("./asar");

function integrityResources(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("invalid Windows executable");
  const sections = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error("unsupported PE optional header");
  const directory = optional + (magic === 0x20b ? 112 : 96) + 16;
  const rva = bytes.readUInt32LE(directory);
  if (!rva) return [];
  const sectionTable = optional + optionalSize;
  function offset(address) {
    for (let i = 0; i < sections; i++) {
      const s = sectionTable + i * 40;
      const start = bytes.readUInt32LE(s + 12);
      const size = bytes.readUInt32LE(s + 16);
      if (address >= start && address < start + size) return bytes.readUInt32LE(s + 20) + address - start;
    }
    throw new Error("PE resource address is outside file sections");
  }
  const base = offset(rva);
  function entries(relative) {
    const at = base + relative;
    const count = bytes.readUInt16LE(at + 12) + bytes.readUInt16LE(at + 14);
    if (count > 4096) throw new Error("invalid PE resource directory");
    const result = [];
    for (let i = 0; i < count; i++) {
      const e = at + 16 + i * 8;
      const name = bytes.readUInt32LE(e);
      const target = bytes.readUInt32LE(e + 4);
      const str = base + (name & 0x7fffffff);
      const label = name & 0x80000000 ? bytes.toString("utf16le", str + 2,
        str + 2 + bytes.readUInt16LE(str) * 2) : String(name);
      result.push({ label, directory: Boolean(target & 0x80000000), relative: target & 0x7fffffff });
    }
    return result;
  }
  const type = entries(0).find(e => e.label.toLowerCase() === "integrity");
  if (!type) return [];
  if (!type.directory) throw new Error("invalid Integrity resource type");
  const name = entries(type.relative).find(e => e.label.toLowerCase() === "electronasar");
  if (!name) throw new Error("Integrity resource has no ElectronAsar entry");
  if (!name.directory) throw new Error("invalid ElectronAsar resource directory");
  return entries(name.relative).map(e => {
    if (e.directory) throw new Error("unexpected nested ElectronAsar resource");
    const data = base + e.relative;
    const at = offset(bytes.readUInt32LE(data));
    const size = bytes.readUInt32LE(data + 4);
    if (at + size > bytes.length) throw new Error("truncated ElectronAsar resource");
    return { offset: at, size, text: bytes.toString("utf8", at, at + size) };
  });
}

function syncExecutableIntegrity(exe, asar) {
  const hash = crypto.createHash("sha256").update(readHeader(asar).headerBytes).digest("hex");
  const resources = integrityResources(fs.readFileSync(exe));
  const changes = resources.map(resource => {
    const records = JSON.parse(resource.text.replace(/\0+$/, ""));
    if (!Array.isArray(records)) throw new Error("invalid ElectronAsar resource JSON");
    const record = records.find(r => String(r.file).replace(/\\/g, "/").toLowerCase() === "resources/app.asar");
    if (!record || String(record.alg).toUpperCase() !== "SHA256" || !/^[a-f0-9]{64}$/i.test(record.value)) {
      throw new Error("unsupported ElectronAsar integrity record");
    }
    if (resource.text.split(record.value).length !== 2) throw new Error("ambiguous ElectronAsar header hash");
    const next = Buffer.from(resource.text.replace(record.value, hash), "utf8");
    if (next.length !== resource.size) throw new Error("ElectronAsar resource size changed");
    return { ...resource, next };
  });
  if (changes.length) {
    const fd = fs.openSync(exe, "r+");
    try {
      for (const c of changes) fs.writeSync(fd, c.next, 0, c.next.length, c.offset);
      fs.fsyncSync(fd);
    } catch (error) {
      for (const c of changes) {
        const old = Buffer.from(c.text, "utf8");
        fs.writeSync(fd, old, 0, old.length, c.offset);
      }
      fs.fsyncSync(fd);
      throw error;
    } finally { fs.closeSync(fd); }
    const after = integrityResources(fs.readFileSync(exe));
    for (const c of changes) {
      if (after.find(r => r.offset === c.offset)?.text !== c.next.toString("utf8")) {
        throw new Error("ElectronAsar resource readback failed");
      }
    }
  }
  return { hash, resourceCount: changes.length };
}

module.exports = { integrityResources, syncExecutableIntegrity };
