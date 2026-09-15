"use strict";
/**
 * Mirroring of the app directory.
 *
 * MEASURED: `readdir` on the ROOT of `C:\Program Files\WindowsApps` returns EPERM
 * without elevation, but a SPECIFIC path inside the package is readable (reading
 * `OpenAI.Codex_.../AppxManifest.xml` worked with no UAC prompt). In other words:
 * the ACL blocks listing the root, not reading the app's files. That is why
 * robocopy with an explicit source works without elevation.
 *
 * Measured cost of the copy on this machine: 5,398 files, 1,792 MB.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Copies `srcDir` to `destDir` with robocopy /MIR.
 *
 * Robocopy exit codes are a bitmask: 0..7 means success, >=8 is a real failure.
 * Treating "!= 0" as an error would make every successful copy look broken.
 */
function mirrorDir(srcDir, destDir, onLine) {
  fs.mkdirSync(destDir, { recursive: true });
  const args = [srcDir, destDir, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1", "/MT:8"];
  const res = spawnSync("robocopy.exe", args, { encoding: "utf8", windowsHide: true, timeout: 30 * 60 * 1000 });
  const code = typeof res.status === "number" ? res.status : -1;
  const text = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (text && onLine) for (const l of text.split(/\r?\n/)) if (l.trim()) onLine(l.trim());
  if (code < 0 || code >= 8) {
    throw new Error(`robocopy failed (code ${code}). ${text.slice(0, 500)}`);
  }
  return { code, copiedSomething: code !== 0 };
}

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* unreadable file: skip it rather than abort the whole count */
        }
      }
    }
  }
  return { bytes, files };
}

module.exports = { mirrorDir, dirStats };
