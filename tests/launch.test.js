"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launch, withUpdateLock } = require("../src/launch");

test("closed app updates first and launches the resulting executable with intact arguments", async () => {
  let state = { appDir: "old", exe: "old.exe" };
  const events = [];
  await launch(["codex://threads/example", "argument with spaces"], { deps: {
    readState: () => state,
    isAppRunning: () => false,
    check: opts => { assert.equal(opts.apply, true); events.push("update"); state = { appDir: "new", exe: "new.exe" }; },
    startApp: (exe, args) => { events.push("launch"); assert.equal(exe, "new.exe"); assert.deepEqual(args, ["codex://threads/example", "argument with spaces"]); },
  } });
  assert.deepEqual(events, ["update", "launch"]);
});

test("running app and deliberately uninstalled tweak are opened without reapplying", async () => {
  for (const active of [true, false]) {
    let opened = false;
    await launch([], { deps: {
      readState: () => ({ appDir: "app", exe: "app.exe", active }),
      isAppRunning: () => active,
      check: () => assert.fail("must not update"),
      startApp: () => { opened = true; },
    } });
    assert.equal(opened, true);
  }
});

test("failed update never starts a partially copied app", async () => {
  await assert.rejects(launch([], { deps: {
    readState: () => ({ appDir: "app", exe: "app.exe" }),
    isAppRunning: () => false,
    check: () => { throw new Error("copy failed"); },
    startApp: () => assert.fail("must not launch"),
  } }), /copy failed/);
});

test("update lock rejects concurrent writers and releases after success or failure", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-launch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withUpdateLock(async () => {
    await assert.rejects(withUpdateLock(() => assert.fail("second writer"), root), /Update in progress/);
  }, root);
  await assert.rejects(withUpdateLock(() => { throw new Error("expected failure"); }, root), /expected failure/);
  assert.equal(fs.existsSync(path.join(root, "update.lock")), false);
  assert.equal(await withUpdateLock(() => "recovered", root), "recovered");
});

test("a second shortcut waits for the live updater instead of reporting a launch failure", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-launch-wait-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let release, waiting;
  const ready = new Promise(resolve => { waiting = resolve; });
  const first = withUpdateLock(() => new Promise(resolve => { release = resolve; }), root);
  const second = withUpdateLock(() => "opened", root, { waitMs: 2000, log: waiting });
  await ready;
  release(); await first;
  assert.equal(await second, "opened");
});

test("shortcut waiting never removes an invalid lock", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-launch-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "update.lock");
  fs.writeFileSync(file, '{"pid":0}');
  await assert.rejects(withUpdateLock(() => assert.fail("must not start"), root, { waitMs: 2000 }), /interrupted/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"pid":0}');
});
