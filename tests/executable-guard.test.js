"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withExecutableGuard } = require("../src/executable-guard");
const { mirrorDir } = require("../src/mirror");

test("new installation has a guarded placeholder and failures release the handle", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, "nested", "ChatGPT.exe");
  assert.throws(() => withExecutableGuard(exe, () => {
    assert.equal(fs.statSync(exe).size, 0);
    throw new Error("simulated copy failure");
  }), /copy failure/);
  fs.renameSync(exe, exe + ".released");
  assert.equal(fs.existsSync(exe + ".released"), true);
});

test("Windows denies a direct taskbar-style launch throughout a real robocopy update", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-native-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), dest = path.join(root, "dest");
  fs.mkdirSync(source); fs.mkdirSync(dest);
  const original = path.join(source, "where.exe"), target = path.join(dest, "where.exe");
  fs.copyFileSync(path.join(process.env.WINDIR, "System32", "where.exe"), original);
  fs.copyFileSync(original, target);
  fs.utimesSync(original, new Date(), new Date(Date.now() + 5000));
  const run = () => spawnSync(target, ["node.exe"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const before = fs.statSync(target).ino;
  withExecutableGuard(target, () => {
    assert.equal(run().error?.code, "EBUSY");
    assert.equal(mirrorDir(source, dest).copiedSomething, true);
    assert.equal(fs.statSync(target).ino, before, "copy preserves the guarded file");
    assert.equal(run().error?.code, "EBUSY");
    // The integrity writer can still obtain its second writable handle.
    const writer = fs.openSync(target, "r+"); fs.closeSync(writer);
  });
  assert.equal(run().status, 0);
});
