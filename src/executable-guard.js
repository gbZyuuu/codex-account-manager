"use strict";
const fs = require("node:fs");
const path = require("node:path");

// An open writable handle prevents Windows from creating an executable image.
// Unlike a one-time process check, it protects the entire copy/patch interval,
// including launches from an old taskbar shortcut that bypasses our CLI lock.
// Robocopy overwrites the existing file in place and can share this handle.
function withExecutableGuard(exe, action) {
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  let fd;
  try {
    try { fd = fs.openSync(exe, "r+"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      fd = fs.openSync(exe, "wx+");
    }
  } catch (error) {
    if (["EBUSY", "EPERM", "EACCES"].includes(error.code)) {
      const blocked = new Error(`Codex is open or its executable is locked: ${exe}`);
      blocked.code = "APP_RUNNING";
      throw blocked;
    }
    throw error;
  }
  try { return action(); }
  finally { fs.closeSync(fd); }
}

module.exports = { withExecutableGuard };
