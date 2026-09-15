#!/usr/bin/env node
"use strict";
/**
 * codex-account-manager CLI. A single command installs everything, with no
 * dependency on any other program.
 *
 *   node bin/cam.js preflight       read-only: writes nothing
 *   node bin/cam.js install         mirrors, patches, installs the runtime
 *   node bin/cam.js uninstall       restores the original package.json inside the asar
 *   node bin/cam.js doctor          diagnostics: state, versions, entry point owner
 *   node bin/cam.js check [--apply] detects a Codex update and (with --apply) redoes the patch
 *   node bin/cam.js watch install|remove|status   update-watcher triggers
 */
const process = require("node:process");
const path = require("node:path");
const fs = require("node:fs");

const { install, uninstall, doctor, readState, isAppRunning } = require("../src/install");
const { pruneMirrors } = require("../src/mirror");
const { paths } = require("../src/paths");
const { check, installTask, removeTask, taskStatus } = require("../src/watcher");
const { t } = require("../src/i18n");
const { launch, withUpdateLock } = require("../src/launch");

let operationLog = null, operationStarted = 0;
const log = (m) => {
  if (operationLog) fs.appendFileSync(operationLog, `[${new Date().toISOString()} pid=${process.pid}] ${m}\n`);
  process.stdout.write(`${m}\n`);
};

/**
 * The help text is a contract with the person using this: if it lies, they type
 * the wrong command and conclude the program is broken.
 *
 * Three fixes came out of an install test performed from the point of view of a
 * brand-new user:
 *
 * 1. The first line read `usage: cls <...>`, the project name from BEFORE the
 *    rename. Anyone reading the help would type a command that does not exist.
 * 2. `preflight` was documented in the README as a command but was missing from
 *    the dispatcher: running `preflight` fell through to `default` and printed
 *    the help, which looks like a user typo rather than a gap in the program. It
 *    now exists for real.
 * 3. `watch install` promised "scheduled tasks (logon + 6h)". The logon trigger
 *    is not a scheduled task, it is a shortcut in the Startup folder, because
 *    `schtasks /SC ONLOGON` requires an administrator. The help now says what
 *    actually happens.
 */
function usage() {
  log(t("help.usage"));
  log("");
  log(t("help.preflight1"));
  log(t("help.preflight2"));
  log(t("help.install1"));
  log(t("help.install2"));
  log(t("help.uninstall"));
  log(t("help.doctor"));
  log(t("help.cleanup"));
  log(t("help.check"));
  log(t("help.launch"));
  log(t("help.watch.install"));
  log(t("help.watch.remove"));
  log(t("help.watch.status"));
  log("");
  log(t("help.lang"));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (process.platform !== "win32") {
    log(t("err.windows.only"));
    process.exitCode = 1;
    return;
  }
  try {
    if (["launch", "install", "uninstall"].includes(cmd) || (cmd === "check" && rest.includes("--apply"))) {
      fs.mkdirSync(paths.log, { recursive: true });
      operationLog = path.join(paths.log, `${cmd}-last.log`);
      // Keep recent attempts, including overlapping shortcut clicks. Previously
      // a second click erased the only evidence of the slow installation.
      if (fs.existsSync(operationLog) && fs.statSync(operationLog).size > 262144) {
        fs.copyFileSync(operationLog, `${operationLog}.previous`);
        fs.writeFileSync(operationLog, "");
      }
      operationStarted = Date.now();
      log(`${cmd} started`);
    }
    switch (cmd) {
      case "preflight":
        // Loaded on demand: the probe prints by itself when it is required, and
        // forcing it to export a module just for this would be more fragile.
        require(path.join(__dirname, "preflight.js"));
        break;
      case "install":
        await withUpdateLock(() => install({ log, force: rest.includes("--force") }));
        break;
      case "uninstall":
        await withUpdateLock(() => uninstall({ log }));
        break;
      case "doctor":
        doctor({ log });
        break;
      case "cleanup": {
        const st = readState();
        if (!st.appDir) throw new Error(t("err.no.state"));
        for (const entry of pruneMirrors(paths.mirrors, st.appDir, {
          apply: rest.includes("--apply"), isRunning: isAppRunning,
        })) {
          log(entry.reason ? t("cleanup.kept", entry.dir, entry.reason) :
            entry.removed ? t("cleanup.removed", entry.dir) :
            t("cleanup.preview", entry.dir, (entry.bytes / 1048576).toFixed(0)));
        }
        break;
      }
      case "check":
        if (rest.includes("--apply")) await withUpdateLock(() => check({ log, apply: true }));
        else check({ log });
        break;
      case "launch":
        await withUpdateLock(() => launch(rest, { log }), paths.root, { waitMs: 120000, log });
        break;
      case "watch": {
        const sub = rest[0];
        if (sub === "install") installTask({ log });
        else if (sub === "remove") removeTask({ log });
        else if (sub === "status") taskStatus({ log });
        else usage();
        break;
      }
      case "--help":
      case "-h":
      case "help":
      case undefined:
        usage();
        break;
      default:
        // An unknown command is not the same as a missing command: naming the
        // rejected command saves the person from hunting for a typo.
        log(t("err.unknown.command", cmd));
        log("");
        usage();
        process.exitCode = 1;
    }
  } catch (e) {
    const message = t("err.prefix", String((e && e.stack) || e));
    try { log(message); } catch { process.stderr.write(`${message}\n`); }
    process.exitCode = 1;
  } finally {
    if (operationStarted) {
      try { log(`${cmd} finished in ${Date.now() - operationStarted} ms; exit=${process.exitCode || 0}`); } catch { /* Preserve the original error. */ }
    }
  }
}

void main();
