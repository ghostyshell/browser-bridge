#!/usr/bin/env node
// Install/reload an unpacked extension in a running Chrome over CDP.
// (Chrome 137+ ignores the --load-extension command line switch.)

import path from 'node:path';
import { createRequire } from 'node:module';
import type { WebSocket as WSWebSocket } from 'ws';

const require = createRequire(__filename);

interface CdpMessage {
  id?: number;
  result?: { id: string };
  error?: { message: string };
}

function loadWs(): typeof import('ws') | null {
  for (const candidate of ['ws', path.join(__dirname, '..', '..', 'node_modules', 'ws')]) {
    try {
      return require(candidate) as typeof import('ws');
    } catch {
      /* try next */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const extPath = process.argv[2] || path.join(__dirname, '..', '..', 'extension');
  const port = process.argv[3] || '9333';
  const ws = loadWs();
  if (!ws) {
    console.error('ws module missing: run `npm install`');
    process.exit(1);
  }
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const socket: WSWebSocket = new ws.WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  let seq = 0;
  const pending = new Map<number, (msg: CdpMessage) => void>();
  socket.on('message', (raw: unknown) => {
    const msg = JSON.parse(String(raw)) as CdpMessage;
    const done = msg.id != null ? pending.get(msg.id) : undefined;
    if (done) {
      pending.delete(msg.id!);
      done(msg);
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<CdpMessage>((resolve) => {
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
  console.log(`extension loaded: ${res.result?.id}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
