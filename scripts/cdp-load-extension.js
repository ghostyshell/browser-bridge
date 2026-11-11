#!/usr/bin/env node
// Install/reload an unpacked extension in a running Chrome over CDP.
// (Chrome 137+ ignores the --load-extension command line switch.)
const path = require('path');

const WS = (() => {
  try {
    return require(path.join(__dirname, '..', 'daemon', 'node_modules', 'ws'));
  } catch {
    return null;
  }
})();

async function main() {
  const extPath = process.argv[2] || path.join(__dirname, '..', 'extension');
  const port = process.argv[3] || 9333;
  if (!WS) {
    console.error('ws module missing: run `npm install` in daemon/');
    process.exit(1);
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WS(version.webSocketDebuggerUrl);
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
      const id = ++seq;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const res = await call('Extensions.loadUnpacked', { path: path.resolve(extPath) });
  socket.close();
  if (res.error) {
    console.error(`load failed: ${res.error.message}`);
    process.exit(1);
  }
  console.log(`extension loaded: ${res.result.id}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
