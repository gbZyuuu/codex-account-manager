"use strict";
/**
 * Codex update watcher.
 *
 * THE REAL PROBLEM, measured on this machine: the MSIX updated itself to
 * 26.908.4834.0 while an older copy stayed on 26.903.9818.0. The user believed
 * they were on the new Codex and were not - and nothing said so. A copy is a
 * snapshot, and snapshots age.
 *
 * HOW WE DETECT IT: we compare the `Version` from `Get-AppxPackage` against the
 * one recorded in our `state.json`. We do not use mtime or file size, which change
 * for reasons that are not updates.
 *
 * HOW WE ACT: `check --apply` re-copies and re-patches. `robocopy /MIR` is
 * incremental, so the usual cost is small; only the first copy pays the 1.8 GB.
 *
 * SCHEDULING: a logon trigger plus a periodic one, both running under `wscript`
 * so no console window flashes.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { paths, ensureDirs } = require("./paths");
const { doctor, install, readState } = require("./install");
const { t } = require("./i18n");

const TASK_NAME = "CodexAccountManager-UpdateWatch";

/**
 * Task names from earlier versions of this project.
 *
 * Without this list, a task created under an old name would stay registered
 * forever: `removeTask` would look only for the current name, not find it, and the
 * old one would keep firing `check --apply` for an installation that may no longer
 * exist. Every future rename goes in here.
 */
const LEGACY_TASK_NAMES = ["CodexLiveSubs-UpdateWatch", "CodexLiveSubs-UpdateWatch-Periodic"];

/** One verification pass. With `apply` it fixes; without, it only reports. */
function check(opts = {}) {
  const log = opts.log || (() => {});
  const report = doctor({ log });

  /**
   * A deliberate uninstall outweighs a detected update.
   *
   * This function used to compare ONLY versions. After an `uninstall` the state
   * holds `active: false`, but the recorded version stays the old one - so the
   * first Codex update made `stale` true and, on the logon trigger, `check --apply`
   * called `install()` and re-patched an app the user had deliberately left. The
   * uninstall undid itself.
   *
   * `install` writes fresh state with no `active`/`uninstalledAt`, so reinstalling
   * clears this condition naturally.
   */
  if (report.state && report.state.active === false) {
    log(t("watch.uninstalled"));
    log(t("watch.uninstalled.hint"));
    return { changed: false, uninstalled: true };
  }

  if (!report.stale) {
    log(t("watch.nothing"));
    return { changed: false };
  }
  log(t("watch.update.detected", report.state.sourceVersion, report.source.version));
  if (!opts.apply) {
    log(t("watch.need.apply"));
    return { changed: false, stale: true };
  }
  try {
    install({ log });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // An open app is not a watcher failure: it only means "not now". It runs at
    // logon and every 6h, so the next window with Codex closed resolves it.
    // Forcing here would risk leaving a half-written copy while the app is in use.
    //
    // Detection is by `code`, not by text: with the message translated, a text test
    // would stop matching and the deferral would turn into a fatal error. The text
    // patterns stay only as a net for an error thrown by an older module version.
    if ((e && e.code === "APP_RUNNING") || /esta ABERTO|is OPEN/.test(msg)) {
      log(t("watch.deferred"));
      return { changed: false, stale: true, deferred: true };
    }
    throw e;
  }
  log(t("watch.reapplied"));
  return { changed: true };
}

/**
 * Writes the .vbs that runs the check without a console, then registers the
 * triggers.
 */
function installTask(opts = {}) {
  const log = opts.log || (() => {});
  ensureDirs();
  const vbs = path.join(paths.runtime, "update-watch.vbs");
  const cli = path.resolve(__dirname, "..", "bin", "cam.js");
  const nodeExe = process.execPath;
  const script = [
    "' Codex update watcher - codex-account-manager.",
    "' wscript creates no console; cscript or node directly would.",
    "Option Explicit",
    "Dim sh, cmd",
    "Set sh = CreateObject(\"WScript.Shell\")",
    `cmd = """${nodeExe}"" ""${cli}"" check --apply"`,
    "sh.Run cmd, 0, True",
    "",
  ].join("\r\n");
  fs.writeFileSync(vbs, script, "latin1");
  log(t("watch.script", vbs));

  const run = (args) => {
    const r = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (r.status !== 0) throw new Error(`schtasks failed (${r.status}): ${out}`);
    return out;
  };

  const action = `wscript.exe //nologo "${vbs}"`;
  const coverage = [];

  /**
   * The logon trigger goes through the Startup folder, NOT `schtasks /SC ONLOGON`.
   *
   * MEASURED on this machine: `schtasks /Create /SC ONLOGON` answers "ERROR: Access
   * denied" without elevation - that specific trigger requires administrator. And
   * because the call threw, it aborted the function before creating the periodic
   * task as well, so the result was ZERO coverage.
   *
   * The user's own Startup folder requires no elevation at all and runs at logon,
   * which is exactly the trigger we want. Changing mechanism fixes the cause
   * instead of asking the user for UAC over a maintenance task.
   */
  const startupDir = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const lnkLogon = path.join(startupDir, "Codex Account Manager Update Watch.lnk");
  try {
    fs.mkdirSync(startupDir, { recursive: true });
    const ps =
      "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" +
      `'${lnkLogon.replace(/'/g, "''")}');` +
      "$s.TargetPath='wscript.exe';" +
      `$s.Arguments='//nologo \"${vbs.replace(/'/g, "''")}\"';` +
      "$s.WindowStyle=7;" +
      "$s.Description='Reapplies the panel after a Codex update';$s.Save()";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`${r.stdout || ""}${r.stderr || ""}`.trim());
    log(t("watch.logon.trigger", lnkLogon));
    coverage.push(t("watch.coverage.logon"));
  } catch (e) {
    log(t("watch.logon.failed", String(e && e.message).slice(0, 200)));
  }

  // Earlier tasks: the logon one under the current name (logon now comes from the
  // Startup folder) and the ones from the project's old names. Absence is not an
  // error.
  for (const oldName of [TASK_NAME, ...LEGACY_TASK_NAMES]) {
    try {
      run(["/Delete", "/TN", oldName, "/F"]);
      log(t("watch.task.removed", oldName));
    } catch {
      /* did not exist, or no permission - neither matters here */
    }
  }

  /**
   * The periodic task is OPTIONAL. If the environment refuses it, the logon
   * trigger alone already covers the real case: the app updates in the background
   * and the copy is rebuilt at the next logon. Failing here must not bring down
   * what already works.
   */
  const second = `${TASK_NAME}-Periodic`;
  try {
    try {
      run(["/Delete", "/TN", second, "/F"]);
    } catch {
      /* did not exist */
    }
    log(run(["/Create", "/TN", second, "/TR", action, "/SC", "HOURLY", "/MO", "6", "/F"]));
    coverage.push(t("watch.coverage.periodic"));
  } catch (e) {
    log(t("watch.task.periodic.failed", String(e && e.message).slice(0, 200)));
  }

  if (!coverage.length) throw new Error(t("err.no.trigger"));
  log(t("watch.active", coverage.join(t("watch.coverage.and"))));
}

/** Where the logon trigger lives. One definition, used by install/remove/status. */
function logonShortcutPath() {
  return path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "Codex Account Manager Update Watch.lnk",
  );
}

function removeTask(opts = {}) {
  const log = opts.log || (() => {});
  for (const name of [TASK_NAME, `${TASK_NAME}-Periodic`, ...LEGACY_TASK_NAMES]) {
    const r = spawnSync("schtasks.exe", ["/Delete", "/TN", name, "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    log(r.status === 0 ? t("watch.removed", name) : t("watch.absent", name));
  }
  // The logon trigger is not a scheduled task; without this part it would survive
  // the uninstall and try to reapply a patch for an installation that is gone.
  const lnk = logonShortcutPath();
  if (fs.existsSync(lnk)) {
    try {
      fs.rmSync(lnk, { force: true });
      log(t("watch.removed", lnk));
    } catch (e) {
      log(t("watch.logon.failed", String(e && e.message).slice(0, 150)));
    }
  } else {
    log(t("watch.logon.absent"));
  }
}

function taskStatus(opts = {}) {
  const log = opts.log || (() => {});
  for (const name of [TASK_NAME, `${TASK_NAME}-Periodic`]) {
    const r = spawnSync("schtasks.exe", ["/Query", "/TN", name, "/FO", "LIST"], {
      encoding: "utf8",
      windowsHide: true,
    });
    log(r.status === 0 ? t("watch.status.registered", name) : t("watch.status.missing", name));
  }
  const lnk = logonShortcutPath();
  log(
    t("watch.status.logon", fs.existsSync(lnk) ? t("watch.status.present") : t("watch.status.notpresent")),
  );
  const st = readState();
  log(t("watch.last.install", st.installedAt || "-", st.sourceVersion || "?"));
}

module.exports = { check, installTask, removeTask, taskStatus, TASK_NAME };
