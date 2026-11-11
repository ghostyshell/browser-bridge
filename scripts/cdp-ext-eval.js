#!/usr/bin/env node
// Evaluate an expression inside the Browser Bridge service worker over CDP.
// Used by smoke-test.sh to simulate the user pressing "Allow" in the popup.
//
//   node scripts/cdp-ext-eval.js <extension-dir> <cdp-port> "<expression>"

const path = require('path');
const crypto = require('crypto');

const WS = (() => {
  try {
    return require(path.join(__dirname, '..', 'daemon', 'node_modules', 'ws'));
  } catch {
    return null;
  }
})();

/** Chrome derives an unpacked extension id from the sha256 of its path. */
function extensionIdFor(dir) {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function main() {
  const extDir = process.argv[2];
  const port = process.argv[3] || 9333;
  const expression = process.argv[4];
  if (!extDir || !expression) {
    console.error('usage: cdp-ext-eval.js <extension-dir> <cdp-port> <expression>');
    process.exit(1);
  }
  if (!WS) {
    console.error('ws module missing: run `npm install` in daemon/');
    process.exit(1);
  }

  const id = extensionIdFor(extDir);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const worker = targets.find((t) => t.type === 'service_worker' && t.url.includes(id));
  if (!worker) {
    console.error(`no service worker for ${id} (is the extension loaded?)`);
    process.exit(1);
  }

  const socket = new WS(worker.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let seq = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const done = pending.get(msg.id);
    if (done) {
      pending.delete(msg.id);
      done(msg);
    }
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const callId = ++seq;
      pending.set(callId, resolve);
      socket.send(JSON.stringify({ id: callId, method, params }));
    });

  const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (res.result?.exceptionDetails) {
    console.error(res.result.exceptionDetails.text || 'evaluation failed');
    process.exit(1);
  }
  const value = res.result?.result?.value;
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
