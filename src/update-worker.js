"use strict";
// Runs in regular Node, never Electron's UI process. Survives normal app quit.
const fs = require("node:fs");
const path = require("node:path");
const { paths } = require("./paths");
const { updateStatus, restartUpdatedApp } = require("./updates");

async function main() {
  if (process.argv[2] === "status") {
    const status = updateStatus();
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(paths.log, "update-result.json"), "utf8"));
      if (!previous.ok) status.lastError = previous.error;
    } catch { /* No previous attempt. */ }
    process.stdout.write(JSON.stringify(status));
    return;
  }
  if (process.argv[2] !== "restart" || !process.send) throw new Error("IPC restart worker required");
  fs.mkdirSync(paths.log, { recursive: true });
  const logfile = path.join(paths.log, "update-last.log");
  fs.writeFileSync(logfile, `${new Date().toISOString()} update requested\n`);
  const log = message => fs.appendFileSync(logfile, `${message}\n`);
  const result = value => fs.writeFileSync(path.join(paths.log, "update-result.json"), JSON.stringify(value));
  try {
    await restartUpdatedApp({
      parentPid: Number(process.argv[3]), thread: process.argv[4], log,
      ready: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Restart acknowledgement timed out")), 10000);
        process.once("message", message => {
          clearTimeout(timer);
          if (message && message.type === "proceed") resolve();
          else reject(new Error("Restart not acknowledged"));
        });
        process.send({ type: "ready" });
      }),
    });
    result({ ok: true, at: new Date().toISOString() });
  } catch (error) {
    log(String(error.stack || error));
    result({ ok: false, at: new Date().toISOString(), error: error.message });
    // If the UI is gone, make a failed update visible instead of silently leaving
    // the person with a closed app. Never open a possibly half-copied executable.
    let closed = false;
    try { process.kill(Number(process.argv[3]), 0); }
    catch (failure) { closed = failure.code === "ESRCH"; }
    if (closed) {
      const message = /^pt/i.test(process.env.CAM_LANG || "")
        ? "Nao foi possivel atualizar o Codex. Detalhes em: " : "Codex update failed. Details: ";
      const child = require("node:child_process").spawn("wscript.exe",
        ["//nologo", path.join(paths.runtime, "update-error.vbs"), message + logfile],
        { detached: true, windowsHide: true, stdio: "ignore" });
      child.on("error", failure => log(failure.message));
      child.once("spawn", () => child.unref());
    }
    throw error;
  }
}

main().catch(error => {
  if (process.connected) process.send({ type: "error", error: error.message });
  else process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}).finally(() => { if (process.connected) process.disconnect(); });
