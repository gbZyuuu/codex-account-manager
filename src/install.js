"use strict";
/**
 * install / uninstall / doctor.
 *
 * SAFETY GUARANTEES, in this order:
 *  1. The ORIGINAL app is never written to. MSIX lives in
 *     `C:\Program Files\WindowsApps`, owned by TrustedInstaller; we measured EPERM
 *     even for listing it. So we mirror.
 *  2. Before any write, we save the original bytes of the asar's `package.json`
 *     TOGETHER with the app version and the sha256 of the whole asar. A backup
 *     without version and hash is a backup you cannot trust at restore time - a
 *     metadata-less backup found on this machine was 212 MB against the 295 MB of
 *     the live asar, and without metadata there is no way to tell which version it
 *     came from.
 *  3. The write is in place and the same size, so no asar offset moves
 *     (see src/asar.js).
 *  4. After writing, we READ BACK and validate. If it does not match, we restore
 *     immediately.
 *  5. Chats live in `~/.codex` (measured: 3.4 GB outside the app directory).
 *     Nothing here reaches them.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { paths, ensureDirs, findMsix, findLocalInstalls, asarOf, exeOf } = require("./paths");
const { readFileFromAsar, writeFileInPlace, readHeader } = require("./asar");
const { canPatch, inspectAsar, OUR_META_KEY } = require("./conflict");
const { mirrorDir, dirStats } = require("./mirror");
const { t, ownerLabel } = require("./i18n");

const LOADER_REL = "../app.asar.unpacked/codex-account-manager-loader.cjs";

function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  ensureDirs();
  const tmp = `${paths.state}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, paths.state);
}

/**
 * Is the app in this directory running?
 *
 * The trick: on Windows a running executable is locked for writing. Opening it
 * with `r+` fails with EBUSY/EPERM/EACCES in exactly that case. It is instant and
 * depends on neither PowerShell nor WMI.
 */
function isAppRunning(appDir) {
  const exe = exeOf(appDir);
  if (!fs.existsSync(exe)) return false;
  try {
    fs.closeSync(fs.openSync(exe, "r+"));
    return false;
  } catch (e) {
    return e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
  }
}

/** Picks the target install: MSIX (mirrored) takes priority, otherwise the local one. */
function pickSource() {
  const msix = findMsix();
  if (msix) return msix;
  const locals = findLocalInstalls();
  if (locals.length) return locals[0];
  throw new Error(
    "could not find Codex. Looked for the MSIX package via Get-AppxPackage, " +
      "%LOCALAPPDATA%\\codex\\app-*, and %LOCALAPPDATA%\\Programs\\Codex.",
  );
}

function copyRuntime(log) {
  const srcRuntime = path.join(__dirname, "..", "runtime");
  const dstRuntime = path.join(paths.runtime);
  fs.mkdirSync(path.join(dstRuntime, "payload"), { recursive: true });
  for (const name of ["codex-account-manager-loader.cjs", "preload.js"]) {
    fs.copyFileSync(path.join(srcRuntime, name), path.join(dstRuntime, name));
  }
  const payloadSrc = path.join(__dirname, "..", "payload", "index.js");
  if (!fs.existsSync(payloadSrc)) throw new Error(`payload missing at ${payloadSrc}`);
  fs.copyFileSync(payloadSrc, path.join(dstRuntime, "payload", "index.js"));
  log(t("install.runtime.copied", dstRuntime));
}

function install(opts = {}) {
  const log = opts.log || (() => {});
  ensureDirs();

  const source = pickSource();
  log(t("install.source", source.kind, source.version || "?"));
  log(`  ${source.appDir}`);

  // Mirror when the source is not writable (MSIX). A local install is patched in
  // place, because there the original app is ALREADY writable and a 1.8 GB mirror
  // is not justified.
  let appDir = source.appDir;
  let mirrored = false;
  if (!source.writable) {
    const name = source.packageFullName || `codex-${source.version || "unknown"}`;
    appDir = path.join(paths.mirrors, name, "app");

    /**
     * Do NOT re-mirror while the app is open.
     *
     * Found in practice while reinstalling with Codex running: `robocopy /MIR`
     * DELETES from the destination whatever does not exist in the source, and our
     * `codex-account-manager-loader.cjs` only exists in the destination. It gets
     * removed and `app.asar` goes back to the original. The order mirror -> copy
     * loader -> patch is self-correcting, which is why that time it worked out;
     * but if robocopy trips over a file locked by the running process, it aborts
     * halfway and leaves a partial mirror whose entry point points at a loader
     * that does not exist. That is an app that will not open.
     */
    if (isAppRunning(appDir) && !opts.force) {
      /**
       * The error carries a `code`, not just text.
       *
       * The watcher has to tell "not now, the app is open" apart from a real
       * failure, and it used to do that by testing `/esta ABERTO/` on the message.
       * With the message translated into English that test would never match: the
       * watcher would treat an open app as a fatal error instead of deferring.
       * Stable code does not depend on language.
       */
      const e = new Error(t("err.app.open", exeOf(appDir)));
      e.code = "APP_RUNNING";
      throw e;
    }
    log(t("install.mirroring", appDir));
    mirrorDir(source.appDir, appDir, (l) => log(`  robocopy: ${l}`));
    const s = dirStats(appDir);
    log(t("install.mirror.stats", s.files, (s.bytes / 1024 / 1024).toFixed(0)));
    mirrored = true;
  } else {
    log(t("install.inplace"));
  }

  const asar = asarOf(appDir);
  if (!fs.existsSync(asar)) throw new Error(t("err.no.asar", asar));

  const conflict = canPatch(asar);
  if (!conflict.ok) throw new Error(conflict.reason);
  const info = conflict.info;
  log(t("install.entry.current", info.main, ownerLabel(info.owner)));

  // Backup WITH metadata. Without version and hash, restoring is guesswork.
  const { buf: originalPkgBytes } = readFileFromAsar(asar, "package.json");
  const asarHashBefore = sha256File(asar);
  const backupDir = path.join(paths.backup, source.packageFullName || source.version || "app");
  fs.mkdirSync(backupDir, { recursive: true });
  const pkgBackup = path.join(backupDir, "package.json.orig");
  const metaBackup = path.join(backupDir, "backup.json");
  if (info.owner === "original") {
    fs.writeFileSync(pkgBackup, originalPkgBytes);
    fs.writeFileSync(
      metaBackup,
      `${JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          sourceKind: source.kind,
          appVersion: source.version || null,
          packageFullName: source.packageFullName || null,
          appDir,
          asarBytes: fs.statSync(asar).size,
          asarSha256: asarHashBefore,
          packageJsonBytes: originalPkgBytes.length,
          packageJsonSha256: crypto.createHash("sha256").update(originalPkgBytes).digest("hex"),
          originalMain: info.main,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    log(t("install.backup.made", pkgBackup, originalPkgBytes.length));
  } else {
    log(t("install.backup.kept"));
    if (!fs.existsSync(pkgBackup)) {
      throw new Error(
        `the asar carries our patch but the backup ${pkgBackup} does not exist. ` +
          "I will not continue without being able to revert.",
      );
    }
  }

  copyRuntime(log);

  // The loader has to live OUTSIDE the asar, in the sibling folder that already exists.
  const unpacked = path.join(appDir, "resources", "app.asar.unpacked");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.copyFileSync(
    path.join(paths.runtime, "codex-account-manager-loader.cjs"),
    path.join(unpacked, "codex-account-manager-loader.cjs"),
  );
  log(t("install.loader.installed", path.join(unpacked, "codex-account-manager-loader.cjs")));

  // Builds the patched package.json. Minified, so it fits in the original bytes.
  const originalMain = info.owner === "original" ? info.main : info.originalMain || info.main;
  const patched = { ...info.meta, main: LOADER_REL };

  /**
   * The key comes from `OUR_META_KEY`, NOT written by hand.
   *
   * There used to be a literal `patched.__codexlive = ...` here, while
   * `inspectAsar` read `meta["__codexAccountManager"]`. The project rename updated
   * the reader and forgot the writer, so validation looked for a key the write
   * never produced: `originalMain` always came back null, validation always
   * failed, and the patch was always reverted. The install had no way to work.
   *
   * Using the shared constant is what stops the next rename from reintroducing the
   * divergence: writer and reader can no longer disagree.
   */
  patched[OUR_META_KEY] = { originalMain, root: paths.root, patchedAt: new Date().toISOString() };
  const text = JSON.stringify(patched);
  log(t("install.patch.size", Buffer.byteLength(text, "utf8"), info.capacity));

  const res = writeFileInPlace(asar, "package.json", text);
  log(t("install.patch.written", res.wrote, res.capacity));

  // VALIDATION: read it back and check. If it fails, revert immediately.
  try {
    const after = inspectAsar(asar);
    if (after.main !== LOADER_REL) throw new Error(`main read back as ${after.main}`);
    if (!after.originalMain) throw new Error("originalMain was not recorded");
    readHeader(asar); // header still parseable
    const sizeAfter = fs.statSync(asar).size;
    if (sizeAfter !== fs.statSync(asar).size) throw new Error("archive size changed");
    log(t("install.validated", after.main, after.originalMain));
  } catch (e) {
    log(t("install.validation.failed", String(e && e.message)));
    writeFileInPlace(asar, "package.json", originalPkgBytes.toString("utf8").trimEnd());
    throw new Error(t("err.validate.reverted", String(e && e.message)));
  }

  writeState({
    version: 1,
    installedAt: new Date().toISOString(),
    sourceKind: source.kind,
    sourceAppDir: source.appDir,
    sourceVersion: source.version || null,
    packageFullName: source.packageFullName || null,
    appDir,
    mirrored,
    asar,
    exe: exeOf(appDir),
    backupDir,
    originalMain,
    entryOwnerAtInstall: "nosso",
  });

  const launchers = createLaunchers(exeOf(appDir), log);

  log("");
  log(t("install.done"));
  for (const l of launchers) log(`  ${l}`);
  return { appDir, exe: exeOf(appDir), mirrored, launchers };
}

/**
 * Shortcuts that open the patched COPY.
 *
 * Without them, "one command installs everything" would be a lie: the regular
 * Store shortcut keeps opening the original app, with no panel. We create a `.lnk`
 * in the Start Menu (so it can be pinned to the taskbar) and a `.cmd` for whoever
 * prefers a terminal.
 *
 * The `.lnk` is produced through `WScript.Shell` in PowerShell because Node has no
 * shortcut API, and `wscript` cannot be used here: we need the exit code.
 */
/**
 * Puts our own icon in a stable place and returns the path.
 *
 * It has to leave the project folder: the shortcut stores an ABSOLUTE path to the
 * icon, and if it pointed at the development folder, moving or deleting the
 * project would leave the shortcut with a broken icon. Copied to the install root,
 * the icon lives and dies with the installation.
 *
 * Without our own icon the shortcut would inherit the one from the original app
 * executable, and both shortcuts would look identical on the taskbar - exactly
 * what makes it confusing to pick which one to open.
 */
function ensureIcon(log) {
  const source = path.join(__dirname, "..", "assets", "icon.ico");
  if (!fs.existsSync(source)) {
    log(t("install.icon.missing", source));
    return null;
  }
  const target = path.join(paths.root, "icon.ico");
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    fs.copyFileSync(source, target);
    return target;
  } catch (e) {
    log(t("install.icon.failed", String(e && e.message)));
    return null;
  }
}

/** Writes a `.lnk`. One implementation, used by every destination. */
function writeShortcut(target, exe, icon) {
  const ps =
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" +
    `'${target.replace(/'/g, "''")}');` +
    `$s.TargetPath='${exe.replace(/'/g, "''")}';` +
    `$s.WorkingDirectory='${path.dirname(exe).replace(/'/g, "''")}';` +
    (icon ? `$s.IconLocation='${icon.replace(/'/g, "''")},0';` : "") +
    "$s.Description='Codex with the live subscription panel';$s.Save()";
  const r = require("node:child_process").spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true, timeout: 60000 },
  );
  if (r.status !== 0) throw new Error(`${r.stdout || ""}${r.stderr || ""}`.trim());
}

/**
 * Where the Desktop is, asked to Windows itself.
 *
 * `~/Desktop` is wrong on any machine with the folder redirected to OneDrive, and
 * in that case the shortcut would land in a folder the user never sees.
 */
function desktopDir() {
  const r = require("node:child_process").spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Desktop')"],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  const out = String((r.stdout || "")).trim();
  return out && r.status === 0 ? out : path.join(os.homedir(), "Desktop");
}

function createLaunchers(exe, log) {
  const made = [];
  const startMenu = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const lnk = path.join(startMenu, "Codex Account Manager.lnk");
  const icon = ensureIcon(log);
  try {
    fs.mkdirSync(startMenu, { recursive: true });
    writeShortcut(lnk, exe, icon);
    log(t("install.shortcut.made", lnk));
    made.push(lnk);
  } catch (e) {
    log(t("install.shortcut.startmenu.failed", String(e && e.message)));
  }

  /**
   * A Desktop shortcut TOO, and not out of fondness for desktop icons.
   *
   * MEASURED: after one uninstall/install cycle, the Start Menu `.lnk` was correct
   * on disk (target and icon verified) and Windows STOPPED listing it.
   * `Get-StartApps` showed the entry before the cycle and did not show it after;
   * restarting `StartMenuExperienceHost` did not fix it in three attempts. The
   * Start Menu index dropped the entry when we deleted the file and never noticed
   * it being recreated under the same name.
   *
   * In other words: the Start Menu depends on an index that is not under our
   * control and may simply not refresh. The Desktop uses no index - the shortcut
   * shows up because the file is there. Having both is the difference between "I
   * installed it and cannot find the program" and "I installed it and opened it".
   */
  try {
    const desk = desktopDir();
    const lnkDesk = path.join(desk, "Codex Account Manager.lnk");
    fs.mkdirSync(desk, { recursive: true });
    writeShortcut(lnkDesk, exe, icon);
    log(t("install.shortcut.made", lnkDesk));
    made.push(lnkDesk);
  } catch (e) {
    log(t("install.shortcut.desktop.failed", String(e && e.message)));
  }

  const cmd = path.join(paths.root, "codex-account-manager.cmd");
  try {
    fs.writeFileSync(cmd, `@echo off\r\nstart "" "${exe}" %*\r\n`, "latin1");
    log(t("install.launcher.made", cmd));
    made.push(cmd);
  } catch (e) {
    log(t("install.launcher.failed", String(e && e.message)));
  }

  /**
   * Tells the Windows shell that the shortcuts changed.
   *
   * MEASURED: a correct `.lnk` created in the Start Menu folder may simply not be
   * listed. `Get-StartApps` showed the entry, the file was deleted and recreated
   * under the same name, and Windows stopped listing it; restarting
   * `StartMenuExperienceHost` did not fix it in three attempts.
   *
   * `SHChangeNotify` with `SHCNE_ASSOCCHANGED` is the documented way to tell the
   * shell "review what you have cached". It needs no elevation and restarts nothing
   * of the user's. If it fails, the Desktop shortcut already guarantees access, so
   * this is an improvement and not a dependency.
   */
  try {
    const ps =
      "Add-Type -Namespace Shell32 -Name Api -MemberDefinition '" +
      "[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);" +
      "' ; [Shell32.Api]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)";
    const r = require("node:child_process").spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", windowsHide: true, timeout: 60000 },
    );
    log(r.status === 0 ? t("install.shell.notified") : t("install.shell.notify.failed"));
  } catch (e) {
    log(t("install.shell.notify.failed", String(e && e.message)));
  }

  if (!made.length) made.push(exe);
  return made;
}

function removeLaunchers(log) {
  const lnk = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Codex Account Manager.lnk",
  );
  for (const f of [
    lnk,
    // The Desktop shortcut goes too; leaving it behind would be an icon pointing
    // at an executable that the uninstall just unpatched.
    path.join(desktopDir(), "Codex Account Manager.lnk"),
    path.join(paths.root, "codex-account-manager.cmd"),
    // The icon is copied by `ensureIcon` on install; it goes out with the uninstall.
    path.join(paths.root, "icon.ico"),
  ]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      log(t("install.removed", f));
    }
  }
}

function uninstall(opts = {}) {
  const log = opts.log || (() => {});
  const st = readState();
  if (!st.asar) throw new Error(t("err.no.state"));
  const pkgBackup = path.join(st.backupDir, "package.json.orig");
  if (!fs.existsSync(pkgBackup)) throw new Error(t("err.backup.missing", pkgBackup));
  const meta = JSON.parse(fs.readFileSync(path.join(st.backupDir, "backup.json"), "utf8"));
  const bytes = fs.readFileSync(pkgBackup);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (meta.packageJsonSha256 && hash !== meta.packageJsonSha256) {
    throw new Error(t("err.backup.hash"));
  }
  log(t("uninstall.restoring", bytes.length, meta.appVersion));
  writeFileInPlace(st.asar, "package.json", bytes.toString("utf8").trimEnd());
  const after = inspectAsar(st.asar);
  log(t("uninstall.entry.now", after.main, ownerLabel(after.owner)));
  const loader = path.join(st.appDir, "resources", "app.asar.unpacked", "codex-account-manager-loader.cjs");
  if (fs.existsSync(loader)) {
    fs.rmSync(loader, { force: true });
    log(t("uninstall.loader.removed"));
  }
  removeLaunchers(log);

  /**
   * Uninstalling has to turn the watcher off as well.
   *
   * Without this the uninstall undid itself: the triggers stayed registered, and on
   * the first Codex update the logon `check --apply` called `install()` again and
   * re-patched an app the user had just walked away from. Nobody asks to uninstall
   * hoping to be reinstalled later.
   *
   * `require` in here rather than at the top of the file, because `watcher.js`
   * imports this module: at the top that would close an import cycle and one of the
   * two sides would see the other only partially loaded. Inside the function, both
   * have finished loading.
   */
  try {
    require("./watcher").removeTask({ log });
  } catch (e) {
    log(t("uninstall.watch.failed", String((e && e.message) || e)));
    log(t("uninstall.watch.hint"));
  }

  writeState({ ...st, uninstalledAt: new Date().toISOString(), active: false });
  log(t("uninstall.done"));
  log(`  ${st.appDir}`);
}

function doctor(opts = {}) {
  const log = opts.log || (() => {});
  const st = readState();
  const source = (() => {
    try {
      return pickSource();
    } catch (e) {
      return { kind: "error", version: String(e.message) };
    }
  })();
  log(t("doctor.source.now", source.kind, source.version || ""));
  log(t("doctor.version.state", st.sourceVersion || t("doctor.no.state")));
  const stale = st.sourceVersion && source.version && st.sourceVersion !== source.version;
  log(t("doctor.stale", stale ? t("doctor.stale.yes") : t("doctor.stale.no")));
  if (st.asar && fs.existsSync(st.asar)) {
    const info = inspectAsar(st.asar);
    log(t("doctor.asar", st.asar));
    log(t("doctor.entry", info.main, ownerLabel(info.owner)));
    log(t("doctor.pkg.space", info.currentBytes, info.capacity));
  } else {
    log(t("doctor.asar", t("doctor.no.state")));
  }

  return { stale: Boolean(stale), source, state: st };
}

module.exports = {
  install,
  uninstall,
  doctor,
  readState,
  writeState,
  pickSource,
  sha256File,
  createLaunchers,
  removeLaunchers,
  LOADER_REL,
};
