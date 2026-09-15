"use strict";
const { readState, pickSource, isAppRunning } = require("./install");
const { check } = require("./watcher");
const { withUpdateLock, startApp } = require("./launch");

function versionParts(value) {
  return typeof value === "string" && /^\d+(?:\.\d+){1,3}$/.test(value)
    ? value.split(".").map(Number) : null;
}

// Unlike a simple inequality, this never advertises an error or a downgrade.
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function updateStatus(deps = {}) {
  const state = (deps.readState || readState)();
  if (state.active === false || !state.exe || !state.appDir) return { available: false };
  const source = (deps.pickSource || pickSource)();
  return {
    available: source.kind !== "error" && newer(source.version, state.sourceVersion),
    current: state.sourceVersion || null,
    version: source.kind === "error" ? null : source.version || null,
  };
}

function parentAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function restartUpdatedApp({ parentPid, thread, ready, log, timeoutMs = 120000, deps = {} }) {
  if (!Number.isInteger(parentPid) || parentPid < 1) throw new Error("Invalid parent process");
  const d = { updateStatus, readState, parentAlive, isAppRunning, withUpdateLock, check, startApp,
    now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...deps };
  if (!d.updateStatus().available) throw new Error("No newer installed Codex version available");
  const initial = d.readState();
  await ready(); // The UI may request normal quit only after this acknowledgement.
  const deadline = d.now() + timeoutMs;
  while (d.parentAlive(parentPid) || d.isAppRunning(initial.appDir)) {
    if (d.now() >= deadline) throw new Error("Codex did not close; update cancelled without changing the app");
    await d.sleep(500);
  }
  await d.withUpdateLock(async () => {
    // Recheck after taking the shared lock: another shortcut may have opened it.
    if (d.isAppRunning(initial.appDir)) throw new Error("Codex opened again; update cancelled");
    const state = d.readState();
    if (state.active === false) throw new Error("Manager was uninstalled; update cancelled");
    const status = d.updateStatus();
    if (status.available) {
      const result = await d.check({ apply: true, log });
      if (result.deferred || !result.changed) throw new Error("Update could not be applied");
    } else if (state.sourceVersion !== initial.sourceVersion && !newer(state.sourceVersion, initial.sourceVersion)) {
      throw new Error("Installed version changed unexpectedly");
    } else if (state.sourceVersion === initial.sourceVersion) {
      throw new Error("Update source no longer available");
    }
    if (d.updateStatus().available) throw new Error("Copy still outdated after update");
    const next = d.readState();
    if (next.active === false || !next.exe || !newer(next.sourceVersion, initial.sourceVersion)) {
      throw new Error("Updated installation could not be verified");
    }
    const args = typeof thread === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread)
      ? [`codex://threads/${thread}`] : [];
    await d.startApp(next.exe, args);
  });
}

module.exports = { newer, updateStatus, restartUpdatedApp };
