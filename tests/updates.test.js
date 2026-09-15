"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { newer, updateStatus, restartUpdatedApp } = require("../src/updates");

test("version offers are numeric, never errors, same versions or downgrades", () => {
  assert.equal(newer("26.1016.8622.0", "26.1007.2314.0"), true);
  assert.equal(newer("1.10", "1.9.9"), true);
  for (const pair of [["1.2", "1.2.0.0"], ["1.1", "1.2"], ["error", "1.2"], ["1.2", ""], ["", "1.2"]]) {
    assert.equal(newer(...pair), false);
  }
  const deps = { readState: () => ({ active: false }), pickSource: () => assert.fail("uninstalled") };
  assert.equal(updateStatus(deps).available, false);
  deps.readState = () => ({ exe: "app.exe", appDir: "app", sourceVersion: "1.2" });
  deps.pickSource = () => ({ kind: "error", version: "9.0" });
  assert.equal(updateStatus(deps).available, false);
  deps.pickSource = () => ({ kind: "msix", version: "1.3" });
  assert.equal(updateStatus(deps).available, true);
});

function fixture() {
  let state = { exe: "old.exe", appDir: "app", sourceVersion: "1.2" }, now = 0;
  const events = [];
  const deps = {
    updateStatus: () => ({ available: state.sourceVersion === "1.2" }),
    readState: () => state,
    parentAlive: () => now < 500,
    isAppRunning: () => now < 1000,
    now: () => now,
    sleep: async ms => { now += ms; events.push("wait"); },
    withUpdateLock: async fn => { events.push("lock"); await fn(); },
    check: async () => { events.push("apply"); state = { ...state, sourceVersion: "1.3", exe: "new.exe" }; return { changed: true }; },
    startApp: async (exe, args) => { events.push(["start", exe, args]); },
  };
  return { events, deps, run: extra => restartUpdatedApp({ parentPid: 42, ready: async () => events.push("ready"), timeoutMs: 1500, deps, ...extra }) };
}

test("restart waits for parent AND app children before locking, updating and restoring the exact chat", async () => {
  const f = fixture(), thread = "01a12caa-1319-7f50-860e-a2425ade03c9";
  await f.run({ thread });
  assert.deepEqual(f.events, ["ready", "wait", "wait", "lock", "apply", ["start", "new.exe", [`codex://threads/${thread}`]]]);
});

test("cancelled native quit times out without acquiring a lock or changing any files", async () => {
  const f = fixture(); f.deps.parentAlive = () => true;
  await assert.rejects(f.run(), /did not close/);
  assert.equal(f.events.includes("lock"), false);
});

test("another app launched during lock acquisition prevents the write", async () => {
  const f = fixture();
  let reopened = false;
  f.deps.isAppRunning = () => reopened;
  f.deps.withUpdateLock = async fn => { reopened = true; await fn(); };
  await assert.rejects(f.run(), /opened again/);
  assert.equal(f.events.includes("apply"), false);
});

test("source discovery or readiness failure never begins shutdown/update", async () => {
  const f = fixture(); f.deps.updateStatus = () => ({ available: false });
  await assert.rejects(f.run(), /No newer/);
  assert.deepEqual(f.events, []);
  f.deps.updateStatus = () => ({ available: true });
  await assert.rejects(f.run({ ready: () => { throw new Error("no acknowledgement"); } }), /acknowledgement/);
  assert.deepEqual(f.events, []);
});

test("copy failure, deferred install and failed verification never launch the executable", async () => {
  for (const action of [() => { throw new Error("copy failed"); }, () => ({ deferred: true }), () => ({ changed: true })]) {
    const f = fixture(); f.deps.check = action;
    await assert.rejects(f.run(), /copy failed|could not be applied|outdated/);
    assert.equal(f.events.some(e => Array.isArray(e)), false);
  }
});

test("a successful installer result cannot conceal a downgraded installation", async () => {
  const f = fixture();
  let changed = false;
  f.deps.updateStatus = () => ({ available: !changed });
  const read = f.deps.readState;
  f.deps.readState = () => changed ? { ...read(), sourceVersion: "1.1" } : read();
  f.deps.check = () => { changed = true; return { changed: true }; };
  await assert.rejects(f.run(), /could not be verified/);
  assert.equal(f.events.some(e => Array.isArray(e)), false);
});

test("scheduler finishing first is accepted, uninstall and disappeared source are rejected", async () => {
  const f = fixture();
  f.deps.withUpdateLock = async fn => { await f.deps.check(); await fn(); };
  await f.run({ thread: 'bad-argument --something' });
  assert.equal(f.events.filter(e => e === "apply").length, 1);
  assert.deepEqual(f.events.at(-1), ["start", "new.exe", []]);
  const g = fixture();
  let removed = false;
  const originalRead = g.deps.readState;
  g.deps.readState = () => removed ? { active: false } : originalRead();
  g.deps.withUpdateLock = async fn => { removed = true; await fn(); };
  await assert.rejects(g.run(), /uninstalled/);
  const h = fixture();
  let available = true;
  h.deps.updateStatus = () => ({ available });
  h.deps.withUpdateLock = async fn => { available = false; await fn(); };
  await assert.rejects(h.run(), /no longer available/);
});
