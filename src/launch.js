"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { paths } = require("./paths");
const { check } = require("./watcher");
const { readState, isAppRunning } = require("./install");

// All CLI writers share this lock, including the scheduler and shortcuts.
// Never remove another process's lock automatically: an interrupted update
// must be inspected before another launch can use a possibly incomplete copy.
async function withUpdateLock(action, root = paths.root, opts = {}) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "update.lock");
  let fd;
  const deadline = Date.now() + (opts.waitMs || 0);
  let announced = false;
  while (fd === undefined) {
    try { fd = fs.openSync(file, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let alive = false;
      if (opts.waitMs) {
        try {
          const owner = JSON.parse(fs.readFileSync(file, "utf8"));
          if (Number.isInteger(owner.pid) && owner.pid > 0) { process.kill(owner.pid, 0); alive = true; }
        } catch { /* Never remove a stale or unverifiable lock. */ }
      }
      if (!alive || Date.now() >= deadline) throw new Error(`Update in progress or interrupted; inspect ${file}`);
      if (!announced) { opts.log?.("Another manager operation is running; waiting for it to finish."); announced = true; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const cleanup = () => {
    if (fd === undefined) return;
    fs.closeSync(fd);
    fd = undefined;
    fs.unlinkSync(file);
  };
  process.once("exit", cleanup);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
}

function startApp(exe, args) {
  return new Promise((resolve, reject) => {
    // This child IS the user-facing GUI. On Windows, windowsHide sets SW_HIDE
    // in STARTUPINFO, suppressing its first ShowWindow even when it asks to
    // appear. A second activation can then reveal the already-loaded app.
    // Keep the Node/VBS helpers hidden, but launch ChatGPT.exe normally.
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(child); });
  });
}

async function launch(args = [], opts = {}) {
  const deps = { readState, isAppRunning, check, startApp, ...opts.deps };
  const state = deps.readState();
  if (!state.exe || !state.appDir) throw new Error("Manager installation not found");
  // A second shortcut invocation just focuses the existing app. Updating needs
  // every instance of the copied app to be closed first.
  if (state.active !== false && !deps.isAppRunning(state.appDir)) {
    await deps.check({ apply: true, log: opts.log });
  }
  const next = deps.readState();
  await deps.startApp(next.exe, args);
}

module.exports = { launch, withUpdateLock, startApp };
