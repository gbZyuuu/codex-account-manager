"use strict";
// Start a dedicated headless Chrome with --remote-debugging-port=<port>, then:
// node tests/render-readme.cjs <port>
// No real credentials, account API or application session are used.
const fs = require("node:fs"), path = require("node:path"), { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${process.argv[2]}/json`)).json();
  const tab = tabs.find(t => t.type === "page" && t.url.includes("/tests/readme-preview.html"));
  assert.ok(tab, "Open tests/readme-preview.html in the dedicated browser first");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(m.error) : p.resolve(m.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(Error(`${method} timed out`)); }, 10000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const run = async expression => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async (selector, name) => {
    const clip = await run(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x-8,y:r.y-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16,scale:1}})()`);
    const r = await call("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(path.resolve(__dirname, "../assets", name), Buffer.from(r.data, "base64"));
    console.log(`${name}: ${clip.width} × ${clip.height} CSS pixels, 2× density`);
  };
  try {
    await call("Emulation.setDeviceMetricsOverride", { width: 800, height: 1100, deviceScaleFactor: 2, mobile: false });
    await call("Emulation.setTimezoneOverride", { timezoneId: "America/Sao_Paulo" });
    const url = pathToFileURL(path.join(__dirname, "readme-preview.html")).href;
    await call("Page.enable");
    for (const variant of ["both", "weekly"]) {
      await call("Page.navigate", { url: `${url}?windows=${variant}` });
      // Navigation must finish before evaluating in the new document.
      await new Promise(resolve => {
        const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { clearTimeout(timer); socket.removeEventListener("message", listener); resolve(); } };
        const timer = setTimeout(() => { socket.removeEventListener("message", listener); resolve(); }, 2000);
        socket.addEventListener("message", listener);
      });
      await run(`new Promise((resolve,reject)=>{
        const ready=()=>document.querySelector('[data-cam-panel]')?.textContent.includes('Subscription 2') && document.querySelector('[data-cam-quota]')?.textContent.includes('40%');
        if(ready()) return resolve();
        const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve()}});
        const timer=setTimeout(()=>{observer.disconnect();reject(Error('Panel did not render'))},4000);
        observer.observe(document.body,{subtree:true,childList:true,characterData:true});
      })`);
      const text = await run("document.querySelector('[data-cam-quota]').textContent");
      assert.equal(text.includes("5 h"), variant === "both");
      assert.equal(await run("document.querySelector('[data-cam-panel]').textContent.includes('5 h')"), variant === "both");
      await shot('[role="menu"]', variant === "both" ? "panel.png" : "panel-weekly.png");
      if (variant === "both") {
        await run(`document.querySelector('[aria-label="Manage subscriptions"]').click()`);
        assert.ok(await run("document.querySelector('[data-cam-panel]').textContent.includes('Forget')"));
        await shot('[role="menu"]', "manage.png");
      }
      await run(`document.querySelector('[role="menu"]').hidden=true`);
      const point = await run("(()=>{const r=document.querySelector('[data-cam-quota]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await run("new Promise(r=>setTimeout(r,160))");
      assert.equal(await run("document.querySelector('[role=menu]').hidden"), true);
      assert.notEqual(await run("getComputedStyle(document.querySelector('[data-cam-quota]')).backgroundColor"), "rgba(0, 0, 0, 0)");
      await shot('#composer-preview', variant === "both" ? "composer.png" : "composer-weekly.png");
    }
  } finally { await call("Browser.close"); socket.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
