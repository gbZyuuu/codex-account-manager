"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { pruneMirrors } = require("../src/mirror");

// A small DOM fixture for the real detection functions, evaluated directly from
// the shipped payload. It implements selectors, not the detection logic.
class Element {
  constructor(text = "", attrs = {}, children = [], tag = "div") {
    Object.assign(this, { text, attrs, children, tag, nodeType: 1, isConnected: true });
    for (const child of children) child.parentElement = this;
  }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  matches(selector) {
    return selector.split(",").some(s => {
      s = s.trim();
      if (!s.startsWith("[")) return this.tag === s;
      const [, key, value] = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s);
      return key in this.attrs && (value === undefined || this.attrs[key] === value);
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  getBoundingClientRect() { return { width: 300, height: this.isConnected ? 200 : 0 }; }
}
const source = fs.readFileSync(path.join(__dirname, "../payload/index.js"), "utf8");
function detector(root) {
  const ctx = vm.createContext({ document: root, HTMLElement: Element });
  const start = source.indexOf("  const compact =");
  const end = source.indexOf("  function dumpMenuShape", start);
  const mutationStart = source.indexOf("  function touchesMenu(");
  const mutationEnd = source.indexOf("\n  /**", mutationStart);
  vm.runInContext('const MARK = "data-cam-panel";\n' + source.slice(start, end) +
    source.slice(mutationStart, mutationEnd) + "\nglobalThis.detect = {findMenu, findAnchor, touchesMenu};", ctx);
  return ctx.detect;
}
const row = text => new Element(text, { role: "menuitem" });
function menu(labels) {
  const rows = labels.map(row);
  const container = new Element("", { role: "menu" }, rows);
  return { rows, container, root: new Element("", {}, [container]) };
}

test("current Owl profile menu recognizes Usage and hides only its row", () => {
  const f = menu(["Personal account", "Usage98% left", "Settings", "Log out"]);
  const d = detector(f.root);
  assert.equal(d.findMenu(), f.container);
  const anchor = d.findAnchor(f.container);
  assert.equal(anchor.el, f.rows[1]);
  assert.equal(anchor.isNativeUsage, true);
});
test("previous Sign out menu remains supported", () => {
  const f = menu(["Plus", "Usage remaining", "SettingsCtrl+,", "Sign out"]);
  assert.equal(detector(f.root).findMenu(), f.container);
});
test("Portuguese Usage menu remains supported without shortcut text", () => {
  const f = menu(["Conta pessoal", "Uso82% restante", "Configurações", "Sair"]);
  const d = detector(f.root);
  assert.equal(d.findMenu(), f.container);
  assert.equal(d.findAnchor(f.container).el, f.rows[1]);
});
test("Settings fallback is never hidden as native usage", () => {
  const f = menu(["Personal account", "Profile", "Settings", "Log out"]);
  const anchor = detector(f.root).findAnchor(f.container);
  assert.equal(anchor.el, f.rows[2]);
  assert.equal(anchor.isNativeUsage, false);
});
test("unrelated menus and disconnected account menus are rejected", () => {
  const f = menu(["Copy", "Settings", "Delete"]);
  assert.equal(detector(f.root).findMenu(), null);
  const account = menu(["Personal account", "Usage", "Settings", "Log out"]);
  account.container.isConnected = false;
  assert.equal(detector(account.root).findMenu(), null);
});
test("lazy rows trigger detection, own panel paints and chat updates do not", () => {
  const f = menu(["Usage", "Settings", "Log out"]);
  const d = detector(f.root);
  assert.equal(d.touchesMenu([{ target: f.container, addedNodes: [f.rows[0]] }]), true);
  const panel = new Element("", { "data-cam-panel": "panel" });
  panel.parentElement = f.container;
  assert.equal(d.touchesMenu([{ target: panel, addedNodes: [new Element("Updated quota")] }]), false);
  assert.equal(d.touchesMenu([{ target: f.root, addedNodes: [new Element("New chat text")] }]), false);
});

test("cleanup retains active/running/unknown folders and previews before removal", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function copy(name) {
    const app = path.join(root, name, "app");
    fs.mkdirSync(path.join(app, "resources"), { recursive: true });
    fs.writeFileSync(path.join(app, "resources", "app.asar"), "fixture");
    return app;
  }
  const active = copy("current");
  const old = copy("OpenAI.Codex_26.1002.7124.0_x64__publisher");
  const running = copy("OpenAI.Codex_26.1001.1234.0_x64__publisher");
  const unknown = copy("personal-files");
  const opts = { isRunning: dir => dir === running };
  const preview = pruneMirrors(root, active, opts);
  assert.equal(preview.find(r => r.dir === path.dirname(old)).removed, false);
  assert.ok(fs.existsSync(old));
  const result = pruneMirrors(root, active, { ...opts, apply: true });
  assert.equal(result.find(r => r.dir === path.dirname(old)).removed, true);
  assert.equal(fs.existsSync(old), false);
  for (const kept of [active, running, unknown]) assert.ok(fs.existsSync(kept));
  assert.throws(() => pruneMirrors(root, path.join(root, "..", "outside")), /outside/);
  assert.deepEqual(pruneMirrors(root, ""), []);
});
