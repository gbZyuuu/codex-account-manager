"use strict";
/**
 * Preload: hosts the renderer half of the payload.
 *
 * The payload is evaluated with `new Function("module","exports","console", src)`,
 * the same contract this panel's previous host used - which is why the SAME
 * `index.js` runs unchanged. Inherited consequence: there is no `require` inside
 * the renderer, so all Node code lives in the main half.
 *
 * The `sourceURL` at the end of the code makes DevTools show a named file instead
 * of "eval", which is the difference between a readable stack trace and a useless
 * one.
 */
const { ipcRenderer } = require("electron");

const TWEAK_ID = "co.gbzyuu.codex-account-manager";
const PREFIX = `cam:${TWEAK_ID}:`;

function log(level, message) {
  try {
    ipcRenderer.send("cam:log", level, message);
  } catch {
    /* main may not be ready yet */
  }
  try {
    // eslint-disable-next-line no-console
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      `[codex-account-manager] ${message}`,
    );
  } catch {
    /* no console available: the file log already has it */
  }
}

async function boot() {
  let source;
  try {
    source = await ipcRenderer.invoke("cam:payload-source");
  } catch (e) {
    log("error", `could not fetch the payload: ${String((e && e.message) || e)}`);
    return;
  }
  const api = {
    manifest: { id: TWEAK_ID },
    process: "renderer",
    log: {
      info: (m) => log("info", m),
      warn: (m) => log("warn", m),
      error: (m) => log("error", m),
    },
    ipc: {
      invoke: (channel, payload) => ipcRenderer.invoke(PREFIX + channel, payload),
    },
  };
  try {
    const module = { exports: {} };
    const fn = new Function(
      "module",
      "exports",
      "console",
      `${source}\n//# sourceURL=codex-account-manager://${TWEAK_ID}/index.js`,
    );
    fn(module, module.exports, console);
    const tweak = module.exports.default || module.exports;
    if (!tweak || typeof tweak.start !== "function") throw new Error("payload has no start()");
    tweak.start(api);
    log("info", "renderer half started");
  } catch (e) {
    log("error", `renderer half failed: ${String((e && e.stack) || e)}`);
  }
}

/**
 * Waits for the DOM to EXIST before handing over the payload.
 *
 * Preload runs at `document-start`, and at that moment `document.documentElement`
 * can be `null`. Measured on the first real run: 12 of 16 frames died with
 * `Cannot read properties of null (reading 'lang')`, and the main window's frame
 * was one of them - the panel did not appear and nothing on screen said why.
 *
 * The comment that used to be here claimed waiting "would delay injection for no
 * gain". That was wrong: without waiting there was no injection at all.
 */
async function waitForDom(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (typeof document !== "undefined" && document && document.documentElement) {
      if (document.readyState === "loading") {
        await new Promise((resolve) => {
          document.addEventListener("DOMContentLoaded", resolve, { once: true });
          // Safety net: if the event already fired, we do not hang here.
          setTimeout(resolve, 3000);
        });
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

void (async () => {
  if (!(await waitForDom())) {
    // A context with no DOM (worker, discarded frame). Not an error, just not ours.
    return;
  }
  await boot();
})();
