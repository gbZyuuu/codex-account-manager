"use strict";
const { execFile, fork } = require("node:child_process");
const path = require("node:path");

// The Electron main process only uses asynchronous child APIs. Version discovery
// invokes PowerShell in the worker, and one result is shared by all windows.
function createUpdateClient(config, opts = {}) {
  const worker = path.join(config.sourceRoot, "src", "update-worker.js");
  const env = { ...process.env, CAM_ROOT: config.root };
  delete env.ELECTRON_RUN_AS_NODE;
  let cached = null, at = 0, pending = null, restarting = null, lastError = null;
  function status() {
    if (cached && Date.now() - at < 300000) return Promise.resolve({ ...cached, restarting: !!restarting, lastError: lastError || cached.lastError });
    if (!pending) pending = new Promise((resolve, reject) => {
      execFile(config.node, [worker, "status"], { env, windowsHide: true, timeout: 45000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { cached = JSON.parse(stdout); at = Date.now(); resolve(cached); }
        catch (parseError) { reject(parseError); }
      });
    }).finally(() => { pending = null; });
    return pending.then(value => ({ ...value, restarting: !!restarting, lastError: lastError || value.lastError }));
  }
  function restart(thread) {
    if (restarting) return restarting;
    lastError = null;
    restarting = new Promise((resolve, reject) => {
      const child = fork(worker, ["restart", String(process.pid), thread || ""], {
        execPath: config.node, execArgv: [], env, detached: true, windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let armed = false, failed = false;
      const timer = setTimeout(() => { child.kill(); fail(new Error("Update worker did not become ready")); }, 45000);
      function fail(error) {
        if (failed) return;
        failed = true;
        clearTimeout(timer); lastError = error.message; at = 0;
        if (!armed) reject(error);
        opts.onError?.(error);
      }
      child.on("error", fail);
      child.on("message", message => {
        if (message.type === "error") { fail(new Error(message.error)); return; }
        if (message.type !== "ready" || armed) return;
        clearTimeout(timer);
        child.send({ type: "proceed" }, error => {
          if (error) { fail(error); return; }
          armed = true; child.unref(); child.channel?.unref();
          resolve({ ok: true });
        });
      });
      child.on("exit", code => {
        clearTimeout(timer);
        if (!armed || code !== 0) fail(new Error(`Update worker exited (${code})`));
        restarting = null; at = 0;
      });
    }).catch(error => { restarting = null; throw error; });
    return restarting;
  }
  return { status, restart };
}
module.exports = { createUpdateClient };
