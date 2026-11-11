/**
 * Browser Bridge daemon.
 *
 *   extension  --ws://127.0.0.1:8737/ws-->  daemon  <--http /rpc-->  chromectl / agents
 *
 * The daemon is a dumb relay: it keeps the extension socket alive, forwards
 * commands from local CLI clients, and writes screenshots to disk.
 *
 * Security posture:
 *   - binds to 127.0.0.1 only
 *   - /rpc requires a bearer token from ~/.config/browser-bridge/token (0600)
 *   - /rpc rejects any request carrying an Origin header (i.e. a web page)
 *   - /ws only accepts chrome-extension:// origins (or the bearer token)
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BridgeFailure, ExtensionInfo, HealthResult } from '../shared/types';

const VERSION = '1.2.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8737);
const PING_MS = 20_000;
const DEFAULT_TIMEOUT = 60_000;
const CONNECT_GRACE_MS = 8_000;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'browser-bridge');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token');
const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
const SHOT_DIR = path.join(CONFIG_DIR, 'shots');
const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');

interface ClientSocket extends WebSocket {
  __info?: ExtensionInfo;
  __origin?: string;
  __lastPong?: number;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error & { code?: string }) => void;
  timer: NodeJS.Timeout;
  method: string;
  client: ClientSocket;
}

interface RpcPayload {
  method?: string;
  params?: Record<string, unknown>;
  timeout?: number;
  waitMs?: number;
}

interface ShotResult {
  dataUrl?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function ensureDirs(): void {
  for (const dir of [CONFIG_DIR, SHOT_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadToken(): string {
  ensureDirs();
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

const TOKEN = loadToken();

function log(...args: Array<string | number | boolean | undefined>): void {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* disk full, unwritable */
  }
  if (process.stdout.isTTY) console.log(line);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pngSize(buf: Buffer): { width: number; height: number } | null {
  // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function saveScreenshot(dataUrl: string): { path: string; bytes: number; width?: number; height?: number } {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const buf = Buffer.from(b64, 'base64');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SHOT_DIR, `shot-${stamp}.png`);
  fs.writeFileSync(file, buf);
  return { path: file, bytes: buf.length, ...(pngSize(buf) || {}) };
}

/* ------------------------------------------------------------------ */
/* extension clients                                                   */
/* ------------------------------------------------------------------ */

const clients = new Set<ClientSocket>();
let activeClient: ClientSocket | null = null;
let everConnected = false;
const pending = new Map<string, PendingEntry>();
let seq = 0;

function pickClient(): ClientSocket | null {
  if (activeClient && activeClient.readyState === 1) return activeClient;
  for (const c of clients) {
    if (c.readyState === 1) {
      activeClient = c;
      return c;
    }
  }
  return null;
}

async function awaitClient(timeoutMs = CONNECT_GRACE_MS): Promise<ClientSocket | null> {
  const start = Date.now();
  let c = pickClient();
  while (!c && Date.now() - start < timeoutMs) {
    await sleep(100);
    c = pickClient();
  }
  return c;
}

function sendCmd<T>(client: ClientSocket, method: string, params: unknown, timeoutMs: number): Promise<T> {
  const id = `${process.pid}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`Command "${method}" timed out after ${timeoutMs}ms`), { code: 'timeout' }));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method, client });
    try {
      client.send(JSON.stringify({ type: 'cmd', id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(Object.assign(new Error(`Could not send to extension: ${(e as Error).message}`), { code: 'send_failed' }));
    }
  });
}

/* ------------------------------------------------------------------ */
/* http api                                                            */
/* ------------------------------------------------------------------ */

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function fail(res: http.ServerResponse, code: string, status: number, message: string): void {
  json(res, status, { ok: false, error: { code, message } });
}

function headerValue(req: http.IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  const header = headerValue(req, 'x-bridge-token');
  const auth = headerValue(req, 'authorization');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const query = url.searchParams.get('token') ?? '';
  const candidate = header || bearer || query;
  if (!candidate || candidate.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(TOKEN));
}

async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
  if (req.headers.origin) {
    // A browser page tried to call us. Never allow that.
    return fail(res, 'forbidden', 403, 'Origin header not allowed');
  }
  if (!authorized(req, new URL(req.url ?? '/', `http://${HOST}:${PORT}`))) {
    return fail(res, 'unauthorized', 401, 'Bad or missing token');
  }

  let payload: RpcPayload;
  try {
    payload = JSON.parse(body || '{}') as RpcPayload;
  } catch {
    return fail(res, 'bad_json', 400, 'Body is not JSON');
  }

  const { method, params = {}, timeout } = payload;
  if (!method) return fail(res, 'bad_request', 400, 'Missing method');

  const client = await awaitClient(payload.waitMs ?? CONNECT_GRACE_MS);
  if (!client) {
    return fail(
      res,
      'extension_not_connected',
      503,
      everConnected
        ? 'The Browser Bridge extension is not connected. Open Chrome and check chrome://extensions, then open the extension popup for its status.'
        : 'No Browser Bridge extension has connected yet. Load it once: chrome://extensions -> Developer mode -> Load unpacked -> select the extension/ folder in this project.',
    );
  }

  const started = Date.now();
  try {
    let result = await sendCmd<ShotResult>(client, method, params, Math.max(1000, Number(timeout) || DEFAULT_TIMEOUT));
    if (result && typeof result === 'object' && 'dataUrl' in result && result.dataUrl) {
      const shot = saveScreenshot(String(result.dataUrl));
      const { dataUrl, ...rest } = result;
      void dataUrl;
      result = { ...rest, ...shot };
    }
    log(`rpc ${method} ok ${Date.now() - started}ms`);
    return json(res, 200, { ok: true, result, ms: Date.now() - started });
  } catch (e) {
    const err = e as Error & { code?: string };
    log(`rpc ${method} ERR ${err.code || 'error'} ${err.message}`);
    const failure: BridgeFailure = { code: err.code || 'error', message: err.message || String(e) };
    return json(res, 200, { ok: false, error: failure, ms: Date.now() - started });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    const health: HealthResult = {
      ok: true,
      version: VERSION,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      extensionConnected: !!pickClient(),
      extensionClients: [...clients].filter((c) => c.readyState === 1).length,
      extension: activeClient?.__info ?? null,
      port: PORT,
    };
    return json(res, 200, health);
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 4 * 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return fail(res, 'too_large', 413, 'Body too large');
      handleRpc(req, res, body).catch((e: Error) => fail(res, 'daemon_error', 500, e.message));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pin') {
    // Test harness: route commands to a specific connected browser (the
    // throwaway profile) instead of whichever one said hello first.
    if (!authorized(req, url)) return fail(res, 'unauthorized', 401, 'Bad or missing token');
    const want = url.searchParams.get('extensionId');
    // Unpacked extensions get their id from their folder, so every browser that
    // loaded this checkout reports the same id: take the most recent hello.
    const match = [...clients]
      .filter((c) => c.readyState === 1 && c.__info?.extensionId === want)
      .sort((a, b) => (b.__info?.since ?? 0) - (a.__info?.since ?? 0))[0];
    if (!match) return fail(res, 'no_such_client', 404, `No connected extension with id ${want}`);
    activeClient = match;
    log(`pinned client id=${want}`);
    return json(res, 200, { ok: true, extension: match.__info });
  }

  if (req.method === 'GET' && url.pathname === '/token') {
    if (!authorized(req, url)) return fail(res, 'unauthorized', 401, 'Bad or missing token');
    return json(res, 200, { ok: true, token: TOKEN });
  }

  fail(res, 'not_found', 404, `${req.method} ${url.pathname}`);
});

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const origin = headerValue(req, 'origin');
  const extensionOrigin = origin.startsWith('chrome-extension://');
  if (!extensionOrigin && !authorized(req, url)) {
    log(`reject ws from origin=${JSON.stringify(origin)}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = ws as ClientSocket;
    client.__origin = origin;
    wss.emit('connection', client, req);
  });
});

wss.on('connection', (ws: ClientSocket) => {
  clients.add(ws);
  log(`ws connected (origin=${ws.__origin || 'none'})`);

  ws.on('message', (raw: Buffer) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      ws.__info = {
        version: msg.version,
        ua: msg.ua,
        extensionId: msg.extensionId,
        since: Date.now(),
      };
      // First healthy client wins. Two browsers can be connected (the real
      // one plus a throwaway test profile); a late reconnect must not steal
      // the queue from the client the caller has already been using.
      if (!activeClient || activeClient.readyState !== 1) activeClient = ws;
      everConnected = true;
      log(`extension hello v${msg.version} id=${msg.extensionId}`);
      return;
    }
    if (msg.type === 'pong') {
      ws.__lastPong = Date.now();
      return;
    }
    if (msg.type === 'result' && msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else {
        const err = Object.assign(new Error(msg.error?.message || 'Extension error'), {
          code: msg.error?.code || 'error',
        });
        entry.reject(err);
      }
      return;
    }
    if (msg.type === 'log') log(`ext: ${msg.message}`);
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (activeClient === ws) {
      activeClient = null;
      pickClient();
    }
    // Fail fast: a command whose extension went away should not sit on a
    // 60s timeout (Chrome closing, extension reloaded, machine asleep).
    for (const [id, entry] of pending) {
      if (entry.client === ws) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(
          Object.assign(
            new Error(
              'The browser connection dropped while the command was running (tab closed, Chrome quit, or extension reloaded).',
            ),
            { code: 'extension_disconnected' },
          ),
        );
      }
    }
    log('ws closed');
  });

  ws.on('error', (e: Error) => log(`ws error: ${e.message}`));

  // Keep the MV3 service worker alive: Chrome resets its idle timer on
  // WebSocket activity, so a 20s ping makes the socket effectively permanent.
  const ping = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* socket closing */
      }
    }
  }, PING_MS);
  ws.on('close', () => clearInterval(ping));
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use - another daemon is running`);
    process.exit(0);
  }
  log(`server error: ${e.stack || e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  ensureDirs();
  fs.writeFileSync(PID_PATH, String(process.pid));
  log(`daemon v${VERSION} listening on http://${HOST}:${PORT}`);
});

function shutdown(sig: string): void {
  log(`shutting down (${sig})`);
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    /* already gone */
  }
  for (const c of clients) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
