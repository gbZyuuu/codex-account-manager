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

const { install, uninstall, doctor } = require("../src/install");
const { check, installTask, removeTask, taskStatus } = require("../src/watcher");
const { t } = require("../src/i18n");

const log = (m) => process.stdout.write(`${m}\n`);

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
  log(t("help.check"));
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
    switch (cmd) {
      case "preflight":
        // Loaded on demand: the probe prints by itself when it is required, and
        // forcing it to export a module just for this would be more fragile.
        require(path.join(__dirname, "preflight.js"));
        break;
      case "install":
        install({ log, force: rest.includes("--force") });
        break;
      case "uninstall":
        uninstall({ log });
        break;
      case "doctor":
        doctor({ log });
        break;
      case "check":
        check({ log, apply: rest.includes("--apply") });
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
    log(t("err.prefix", String((e && e.message) || e)));
    process.exitCode = 1;
  }
}

void main();
