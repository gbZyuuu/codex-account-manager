"use strict";
// Run against a dedicated headless Chrome with layout-preview.html already open.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${process.argv[2]}/json`)).json();
  const tab = tabs.find(t => t.url.endsWith("/tests/layout-preview.html"));
  assert.ok(tab, "preview tab");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const waiting = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), task = waiting.get(message.id);
    if (!task) return;
    waiting.delete(message.id); clearTimeout(task.timer);
    message.error ? task.reject(message.error) : task.resolve(message.result);
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => reject(new Error(`${method} timeout`)), 7000);
      waiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function run(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  try {
    if (process.argv[4] === "quota") {
      await run(`(async () => {
        window.previewUpdate = {available:false};
        document.querySelector('[role="menu"]').hidden = true;
        document.querySelector('textarea').value = 'rascunho preservado';
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r => setTimeout(r,180));
      })()`);
      for (const width of [900, 320, 240]) {
        await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        const layout = await run(`(() => {
          const b=document.querySelector('[data-cam-quota]'), r=b.getBoundingClientRect(), c=b.parentElement.getBoundingClientRect();
          return {text:b.textContent,tag:b.tagName,left:r.left-c.left,overflow:b.scrollWidth>b.clientWidth,x:r.x+r.width/2,y:r.y+r.height/2};
        })()`);
        assert.equal(layout.text, "Semanal 40%"); assert.equal(layout.tag, "BUTTON");
        assert.ok(layout.left < 20); assert.equal(layout.overflow, false);
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: layout.x, y: layout.y });
        await run('new Promise(r=>setTimeout(r,150))');
        assert.notEqual(await run("getComputedStyle(document.querySelector('[data-cam-quota]')).backgroundColor"), "rgba(0, 0, 0, 0)");
        const shot = await call("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(process.argv[3], `quota-hover-${width}.png`), Buffer.from(shot.data, "base64"));
      }
      const point = await run("(()=>{const r=document.querySelector('[data-cam-quota]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
      assert.equal(await run('window.previewProfileOpens'), 1);
      assert.equal(await run('document.querySelectorAll("[data-cam-panel]").length'), 1);
      await run('document.querySelector("[role=menu]").hidden=true; document.querySelector("[data-cam-quota]").focus()');
      assert.equal(await run('document.activeElement.hasAttribute("data-cam-quota")'), true, "quota must have keyboard focus");
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      assert.equal(await run('window.previewProfileOpens'), 2);
      const result = await run(`(async()=>{
        const refresh=async()=>{document.dispatchEvent(new Event('visibilitychange'));await new Promise(r=>setTimeout(r,180))};
        const text=()=>document.querySelector('[data-cam-quota]').textContent;
        exampleRows[0].fiveHour={remaining:0}; await refresh();
        if(!text().includes('5 h 0%')) throw Error('real zero quota must remain visible');
        exampleRows[0].fiveHour=null; exampleRows[0].weekly={remaining:0}; await refresh();
        if(text()!=='Semanal 0%') throw Error('missing window or zero weekly');
        exampleRows[0].weekly=null; await refresh();
        if(text()!=='Cota indisponível') throw Error('no windows');
        const invoke=window.previewApi.ipc.invoke;
        window.previewApi.ipc.invoke=async channel=>{if(channel.startsWith('usage:'))throw Error('offline');return invoke(channel)};
        await refresh(); if(text()!=='Cota indisponível') throw Error('offline');
        window.previewApi.ipc.invoke=invoke;
        exampleRows[0].weekly={remaining:40}; await refresh();
        document.documentElement.lang='en-US'; await new Promise(r=>setTimeout(r,180));
        if(text()!=='Weekly 40%') throw Error('language');
        if(document.querySelector('textarea').value!=='rascunho preservado') throw Error('draft changed');
        module.exports.stop();
        if(document.querySelector('[data-cam-quota]')) throw Error('disposal');
        return 'quota: left alignment, hover, absent windows, zero, offline, mouse, keyboard, same panel, language and draft OK';
      })()`);
      console.log(result);
      return;
    }
    assert.equal(await run('document.querySelectorAll("[data-cam-update]").length'), 1);
    await run('document.querySelector("textarea").value = "rascunho preservado"');
    for (const width of [900, 320, 240]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const layout = await run(`(() => {
        const n = document.querySelector('[data-cam-update]'), b = n.querySelector('button');
        const r = n.getBoundingClientRect(), br = b.getBoundingClientRect();
        return { overflow: n.scrollWidth > n.clientWidth, fits: br.right <= r.right && br.left >= r.left, label: b.textContent };
      })()`);
      assert.equal(layout.overflow, false); assert.equal(layout.fits, true);
      assert.equal(layout.label, "Atualizar e reiniciar");
      const shot = await call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.argv[3], `update-${width}.png`), Buffer.from(shot.data, "base64"));
    }
    const checks = await run(`(async () => {
      const wait = () => new Promise(r => setTimeout(r, 180));
      const refresh = async () => { document.dispatchEvent(new Event('visibilitychange')); await wait(); };
      const count = () => document.querySelectorAll('[data-cam-update]').length;
      document.querySelector('[role="menu"]').remove(); await wait();
      if (count() !== 1) throw Error('notice depends on account menu');
      document.querySelector('[data-cam-update] button').click();
      document.querySelector('[data-cam-update] button').click(); await wait();
      if (window.previewRestarts !== 1 || !document.querySelector('[data-cam-update] button').disabled) throw Error('double restart');
      window.previewUpdate = {available:true, current:'1.2',version:'1.3',restarting:false}; await refresh();
      window.previewUpdateError = true;
      document.querySelector('[data-cam-update] button').click(); await wait();
      if (!document.querySelector('[data-cam-update]').textContent.includes('Não foi possível') || document.querySelector('[data-cam-update] button').disabled) throw Error('failure recovery');
      window.previewUpdateError = false;
      window.previewUpdate = {available:false}; await refresh();
      if (count() !== 0) throw Error('up-to-date notice');
      window.previewUpdate = {available:true, current:'1.2',version:'1.3'}; await refresh();
      const composer = document.querySelector('#composer-preview');
      composer.remove(); await wait(); document.body.append(composer); await wait();
      if (count() !== 1) throw Error('remount duplication');
      document.documentElement.lang = 'en-US'; await wait();
      if (document.querySelector('[data-cam-update] button').textContent !== 'Update and restart') throw Error('language');
      if (document.querySelector('textarea').value !== 'rascunho preservado') throw Error('draft changed');
      module.exports.stop(); await wait();
      if (count() !== 0 || document.querySelector('[data-cam-quota]')) throw Error('disposal');
      return 'widths, menu independence, single click, error, up-to-date, remount, language, draft and disposal OK';
    })()`);
    console.log(checks);
  } finally {
    await call("Browser.close"); socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
