#!/usr/bin/env node
// Evaluate an expression inside the Browser Bridge service worker over CDP.
// Used by smoke-test.sh to simulate the user pressing "Allow" in the popup.
//
//   node dist/scripts/cdp-ext-eval.js <extension-dir> <cdp-port> "<expression>"

import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { WebSocket as WSWebSocket } from 'ws';

const require = createRequire(__filename);

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpMessage {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
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

/** Chrome derives an unpacked extension id from the sha256 of its path. */
export function extensionIdFor(dir: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function main(): Promise<void> {
  const extDir = process.argv[2];
  const port = process.argv[3] || '9333';
  const expression = process.argv[4];
  if (!extDir || !expression) {
    console.error('usage: cdp-ext-eval.js <extension-dir> <cdp-port> <expression>');
    process.exit(1);
  }
  const ws = loadWs();
  if (!ws) {
    console.error('ws module missing: run `npm install`');
    process.exit(1);
  }

  const id = extensionIdFor(extDir);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CdpTarget[];
  const worker = targets.find((t) => t.type === 'service_worker' && t.url.includes(id));
  if (!worker) {
    console.error(`no service worker for ${id} (is the extension loaded?)`);
    process.exit(1);
  }

  const socket: WSWebSocket = new ws.WebSocket(worker.webSocketDebuggerUrl);
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

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
