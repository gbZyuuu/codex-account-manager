"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdateClient } = require("../src/update-client");

test("real child-process protocol coalesces status and double clicks, and reports a cancelled restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-update-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "update-worker.js"), `
    const fs = require('fs'), path = require('path');
    fs.appendFileSync(path.join(process.env.CAM_ROOT, 'calls'), process.argv[2] + '\\n');
    if (process.argv[2] === 'status') process.stdout.write(JSON.stringify({available:true,version:'1.3'}));
    else {
      process.on('message', message => {
        if (message.type !== 'proceed') process.exit(3);
        setTimeout(() => process.send({type:'error',error:'Simulated quit cancelled'}, () => process.disconnect()), 50);
      });
      process.send({type:'ready'});
    }
  `);
  let report;
  const failure = new Promise(resolve => { report = resolve; });
  const client = createUpdateClient({ sourceRoot: root, root, node: process.execPath }, { onError: report });
  const statuses = await Promise.all([client.status(), client.status(), client.status()]);
  assert.equal(statuses.every(s => s.available), true);
  await client.status();
  const first = client.restart("example"), second = client.restart("example");
  assert.equal(first, second);
  assert.deepEqual(await first, { ok: true });
  assert.match((await failure).message, /quit cancelled/);
  assert.deepEqual(fs.readFileSync(path.join(root, "calls"), "utf8").trim().split('\n'), ["status", "restart"]);
});
