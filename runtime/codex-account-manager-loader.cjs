"use strict";
/**
 * Injected entry point. It lives in `resources/app.asar.unpacked/`, OUTSIDE the
 * archive.
 *
 * WHY OUTSIDE THE ASAR
 * Adding a file INSIDE the asar would change the size of the entries and force a
 * rewrite of every offset in a 295 MB archive. By putting the loader in a real
 * folder next to it, the only byte that changes inside the asar is the `main`
 * field of `package.json`, written in place and with the same length. `main`
 * becomes `"../app.asar.unpacked/codex-account-manager-loader.cjs"`: Electron
 * resolves `main` relative to the app root (`resources/app.asar`), and the `..`
 * steps out of the archive into the sibling folder, which the normal fs serves.
 *
 * ORDER MATTERS: we install the preload and the main half BEFORE loading the
 * original entry, otherwise the app would already have created windows without
 * our preload.
 *
 * A FAILURE MUST NEVER TAKE THE APP DOWN. Any error of ours is logged and
 * swallowed, and the original entry is loaded regardless. A broken tweak cannot
 * stop the person from using Codex.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const ROOT = path.join(LOCAL, "codex-account-manager");
const LOG_DIR = path.join(ROOT, "log");
const LOG_FILE = path.join(LOG_DIR, "main.log");
const PAYLOAD = path.join(ROOT, "runtime", "payload", "index.js");
const PRELOAD = path.join(ROOT, "runtime", "preload.js");
const TWEAK_ID = "co.gbzyuu.codex-account-manager";

/**
 * Logging that does NOT block the main process.
 *
 * The previous version called `fs.appendFileSync` and `process.stdout.write` for
 * every message, inside the main process. Two consequences, and both took part in
 * the Settings freeze:
 *
 * - SYNCHRONOUS disk I/O per line. The renderer logs through this very channel
 *   (`cam:log`), so one log point on the hot path queued disk writes on the
 *   thread that paints the window. Blocked main = frozen window, and the key you
 *   typed does not even show up.
 * - `process.stdout.write` in a packaged GUI app writes to a pipe nobody reads.
 *   When the pipe buffer fills up, `write` BLOCKS - and a blocked write DOES NOT
 *   THROW, so the `try/catch` that used to wrap it protected nothing.
 *
 * Now: lines go into a buffer and are written in batches, asynchronously; stdout
 * is only used when there is a real terminal; and the buffer has a ceiling, so a
 * logging loop cannot turn into unbounded memory use.
 */
const LOG_HAS_TTY = Boolean(process.stdout && process.stdout.isTTY);
const LOG_BUFFER_MAX = 500;
const LOG_FLUSH_MS = 250;
let logBuffer = [];
let logFlushTimer = null;
let logDirReady = false;
let logDropped = 0;

function ensureLogDir() {
  if (logDirReady) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logDirReady = true;
}

function flushLog(sync) {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (!logBuffer.length) return;
  if (logDropped > 0) {
    logBuffer.push(`[${new Date().toISOString()}] [warn] ${logDropped} log line(s) dropped due to overflow\n`);
    logDropped = 0;
  }
  const chunk = logBuffer.join("");
  logBuffer = [];
  try {
    ensureLogDir();
    // On shutdown there is no next event loop tick, so the write has to be
    // synchronous there, otherwise the last batch is lost.
    if (sync) fs.appendFileSync(LOG_FILE, chunk, "utf8");
    else fs.appendFile(LOG_FILE, chunk, "utf8", () => {});
  } catch {
    /* no log is better than breaking */
  }
}

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  if (logBuffer.length < LOG_BUFFER_MAX) logBuffer.push(line);
  else logDropped += 1;
  if (!logFlushTimer) logFlushTimer = setTimeout(() => flushLog(false), LOG_FLUSH_MS);
  if (LOG_HAS_TTY) {
    try {
      process.stdout.write(line);
    } catch {
      /* the terminal may go away */
    }
  }
}

process.on("exit", () => flushLog(true));

function originalMain() {
  // The patched package.json itself keeps the original entry.
  try {
    const pkg = require(path.join(__dirname, "..", "app.asar", "package.json"));
    // The current key is `__codexAccountManager`. The old one (`__codexlive`) is
    // still accepted because a mirror written before the rename still carries it,
    // and refusing there would bring the app up with no entry point - breaking
    // Codex over a field name would be far worse than accepting both.
    const meta = pkg.__codexAccountManager || pkg.__codexlive;
    const recorded = meta && meta.originalMain;
    if (recorded) return recorded;
  } catch (e) {
    log("warn", `could not read the package.json inside the asar: ${String(e && e.message)}`);
  }
  return ".vite/build/early-bootstrap.js";
}

function makeMainApi(ipcMain) {
  const prefix = `cam:${TWEAK_ID}:`;
  const registered = [];
  return {
    api: {
      manifest: { id: TWEAK_ID },
      process: "main",
      log: {
        info: (m) => log("info", `[payload] ${m}`),
        warn: (m) => log("warn", `[payload] ${m}`),
        error: (m) => log("error", `[payload] ${m}`),
      },
      ipc: {
        handle(channel, fn) {
          const full = prefix + channel;
          // Idempotent on purpose: a reload in the same process would blow up
          // with "Attempted to register a second handler". That is exactly how
          // the payload died once under the previous host of this panel.
          try {
            ipcMain.removeHandler(full);
          } catch {
            /* it did not exist */
          }
          ipcMain.handle(full, (_e, ...args) => fn(...args));
          registered.push(full);
        },
      },
    },
    dispose(ipc) {
      for (const full of registered) {
        try {
          ipc.removeHandler(full);
        } catch {
          /* ok */
        }
      }
      registered.length = 0;
    },
  };
}

function boot() {
  let electron;
  try {
    electron = require("electron");
  } catch (e) {
    log("error", `no electron module, nothing to do: ${String(e && e.message)}`);
    return;
  }
  const { app, session, ipcMain } = electron;

  // 1. Preload on EVERY session, including the ones created later.
  try {
    if (!fs.existsSync(PRELOAD)) throw new Error(`preload missing at ${PRELOAD}`);
    const register = (s) => {
      try {
        if (typeof s.registerPreloadScript === "function") {
          s.registerPreloadScript({ id: "codex-account-manager", type: "frame", filePath: PRELOAD });
        } else {
          s.setPreloads([...(s.getPreloads ? s.getPreloads() : []), PRELOAD]);
        }
      } catch (e) {
        log("warn", `preload registration failed on one session: ${String(e && e.message)}`);
      }
    };
    app.on("session-created", register);
    if (session && session.defaultSession) register(session.defaultSession);
    log("info", `preload registered: ${PRELOAD}`);
  } catch (e) {
    log("error", `preload not registered: ${String(e && e.message)}`);
  }

  // 2. Main half of the payload.
  try {
    if (!fs.existsSync(PAYLOAD)) throw new Error(`payload missing at ${PAYLOAD}`);
    const mod = require(PAYLOAD);
    const tweak = mod && (mod.default || mod);
    if (!tweak || typeof tweak.start !== "function") throw new Error("payload without start()");
    const { api } = makeMainApi(ipcMain);
    tweak.start(api);
    log("info", "main half of the payload started");
  } catch (e) {
    log("error", `main half failed: ${String((e && e.stack) || e)}`);
  }

  // 3. The channel that hands the renderer code to the preload, plus the log one.
  //
  // The log channel is NOT decoration: `ipcRenderer.send` to a channel with no
  // listener is silent, so without this every log from the renderer half would
  // vanish. And the first `install` is exactly when those logs matter.
  try {
    ipcMain.removeHandler("cam:payload-source");
  } catch {
    /* it did not exist */
  }
  try {
    ipcMain.handle("cam:payload-source", () => fs.readFileSync(PAYLOAD, "utf8"));
    /**
     * A rate ceiling on this channel, no matter who calls it.
     *
     * The renderer already deduplicates the log points on the hot path, but this
     * is a guarantee on THIS side: a logging loop in the renderer must not turn
     * into load on the main process, because a stalled main freezes the window.
     * If the ceiling is exceeded, we count the drops instead of going quiet
     * without leaving a trace.
     */
    const LOG_RATE_PER_SEC = 40;
    let logWindowStart = 0;
    let logWindowCount = 0;
    let logSuppressed = 0;
    ipcMain.on("cam:log", (_e, level, message) => {
      const now = Date.now();
      if (now - logWindowStart >= 1000) {
        if (logSuppressed > 0) {
          log("warn", `[renderer] ${logSuppressed} message(s) suppressed by the rate ceiling`);
          logSuppressed = 0;
        }
        logWindowStart = now;
        logWindowCount = 0;
      }
      logWindowCount += 1;
      if (logWindowCount > LOG_RATE_PER_SEC) {
        logSuppressed += 1;
        return;
      }
      const lv = level === "error" || level === "warn" ? level : "info";
      log(lv, `[renderer] ${message}`);
    });
  } catch (e) {
    log("warn", `payload channels not registered: ${String(e && e.message)}`);
  }
}

boot();

// 4. Finally the real app. Outside the try/catch of our own steps: if THIS
// fails, it is a problem in Codex itself and the error has to bubble up intact.
const entry = originalMain();
log("info", `loading the original entry: ${entry}`);
require(path.join(__dirname, "..", "app.asar", entry));
