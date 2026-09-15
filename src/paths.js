"use strict";
/**
 * Where things live. No version pinned into any path.
 *
 * The Codex app on Windows shows up in three shapes, and the Store MSIX is the
 * only one that is not writable: `C:\Program Files\WindowsApps` belongs to
 * TrustedInstaller and returns EPERM even for READING without elevation
 * (measured). That is why the patch never happens on the original: we copy the
 * app and patch the copy.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const ROAMING = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

/** Our own root, deliberately named: nothing here shares a folder with another program. */
const ROOT = path.join(LOCAL, "codex-account-manager");
const paths = {
  root: ROOT,
  mirrors: path.join(ROOT, "apps"),
  backup: path.join(ROOT, "backup"),
  runtime: path.join(ROOT, "runtime"),
  log: path.join(ROOT, "log"),
  state: path.join(ROOT, "state.json"),
  codexHome: process.env.CODEX_HOME || path.join(HOME, ".codex"),
};

function ensureDirs() {
  for (const key of ["root", "mirrors", "backup", "runtime", "log"]) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Locates the MSIX installation through `Get-AppxPackage`. Returns InstallLocation
 * and Version, which is the source of truth the watcher uses to tell that the app
 * was updated.
 */
function findMsix() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 " +
          "InstallLocation,Version,PackageFullName | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    ).trim();
    if (!out) return null;
    const p = JSON.parse(out);
    if (!p || !p.InstallLocation) return null;
    return {
      kind: "msix",
      version: String(p.Version || ""),
      packageFullName: String(p.PackageFullName || ""),
      appDir: path.join(p.InstallLocation, "app"),
      writable: false,
    };
  } catch {
    return null;
  }
}

/** Writable installations (Squirrel / Programs), which need no copy. */
function findLocalInstalls() {
  const found = [];
  for (const d of listDirs(path.join(LOCAL, "codex")).filter((d) => /[\\/]app-/i.test(d))) {
    if (fs.existsSync(path.join(d, "ChatGPT.exe"))) {
      found.push({ kind: "squirrel", version: path.basename(d).replace(/^app-/i, ""), appDir: d, writable: true });
    }
  }
  const programs = path.join(LOCAL, "Programs", "Codex");
  if (fs.existsSync(path.join(programs, "ChatGPT.exe"))) {
    found.push({ kind: "programs", version: "", appDir: programs, writable: true });
  }
  return found;
}

function asarOf(appDir) {
  return path.join(appDir, "resources", "app.asar");
}

function exeOf(appDir) {
  return path.join(appDir, "ChatGPT.exe");
}

module.exports = { paths, ensureDirs, listDirs, findMsix, findLocalInstalls, asarOf, exeOf, HOME, LOCAL, ROAMING };
