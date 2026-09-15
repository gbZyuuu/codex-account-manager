"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { startApp } = require("../src/launch");

const compiler = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
test("Windows GUI is visible on first show, without a console or a second activation", {
  skip: process.platform !== "win32" || !fs.existsSync(compiler), timeout: 20000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-window-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const exe = path.join(root, "window-probe.exe");
  const build = spawnSync(compiler, ["/nologo", "/target:winexe", `/out:${exe}`,
    path.join(__dirname, "fixtures", "window-startup.cs")], { encoding: "utf8", windowsHide: true });
  assert.equal(build.status, 0, build.error?.message || build.stdout + build.stderr);

  async function observe(name, start) {
    const report = path.join(root, `${name}.txt`);
    let watcher, timer;
    const ready = new Promise((resolve, reject) => {
      watcher = fs.watch(root, (_event, file) => {
        if (String(file) === path.basename(report) && fs.existsSync(report)) resolve();
      });
      timer = setTimeout(() => reject(Error(`No native report for ${name}`)), 5000);
    });
    try {
      await Promise.all([ready, start(report)]);
      const [flags, show, first, second, consoleWindow] = fs.readFileSync(report, "utf8").split(",");
      return { flags: Number(flags), show: Number(show), first, second, consoleWindow };
    } finally { watcher.close(); clearTimeout(timer); }
  }

  const hidden = await observe("old-hidden-launch", report => new Promise((resolve, reject) => {
    const child = spawn(exe, [report], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(Error(`Probe exited ${code}`)));
  }));
  assert.equal(hidden.flags & 1, 1, "STARTF_USESHOWWINDOW was set");
  assert.equal(hidden.show, 0, "old launcher sends SW_HIDE to the GUI");
  assert.equal(hidden.first, "False", "reproduce the suppressed first show");
  assert.equal(hidden.second, "True", "second show recovers visibility");

  const current = await observe("manager-launch", async report => {
    const child = await startApp(exe, [report]);
    child.ref();
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(Error(`Probe exited ${code}`)));
    });
  });
  t.diagnostic(JSON.stringify({ hidden, current }));
  assert.equal(current.first, "True", "the real startApp must show the GUI on its first request");
  assert.equal(current.consoleWindow, "False", "a GUI executable needs no console-hiding flag");

  // The actual shortcut hides its Node helper via WScript.Shell.Run(..., 0).
  // Check the fixed launch also works when its parent received SW_HIDE.
  const fromHiddenHelper = await observe("hidden-node-helper", report => new Promise((resolve, reject) => {
    const helper = spawn(process.execPath, ["-e",
      "require(process.argv[1]).startApp(process.argv[2],[process.argv[3]]).then(child=>{child.ref();child.once('exit',code=>process.exit(code??1))}).catch(()=>process.exit(1))",
      require.resolve("../src/launch"), exe, report],
    { detached: true, stdio: "ignore", windowsHide: true });
    helper.once("error", reject);
    helper.once("exit", code => code === 0 ? resolve() : reject(Error(`Helper exited ${code}`)));
  }));
  t.diagnostic(JSON.stringify({ fromHiddenHelper }));
  assert.equal(fromHiddenHelper.first, "True", "hidden helper must not hide the GUI child");
  assert.equal(fromHiddenHelper.consoleWindow, "False");
});
