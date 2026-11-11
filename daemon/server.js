#!/usr/bin/env node
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

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const VERSION = '1.0.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8737);
const PING_MS = 20000;
const DEFAULT_TIMEOUT = 60000;
const CONNECT_GRACE_MS = 8000;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'browser-bridge');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token');
const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
const SHOT_DIR = path.join(CONFIG_DIR, 'shots');
const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  for (const dir of [CONFIG_DIR, SHOT_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadToken() {
  ensureDirs();
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
  return token;
}

const TOKEN = loadToken();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
  if (process.stdout.isTTY) console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pngSize(buf) {
  // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function saveScreenshot(dataUrl) {
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

/** @type {Set<any>} */
const clients = new Set();
let activeClient = null;
let everConnected = false;
const pending = new Map();
let seq = 0;

function clientInfo(ws) {
  return ws.__info || {};
}

function pickClient() {
  if (activeClient && activeClient.readyState === 1) return activeClient;
  for (const c of clients) if (c.readyState === 1) return (activeClient = c);
  return null;
}

async function awaitClient(timeoutMs = CONNECT_GRACE_MS) {
  const start = Date.now();
  let c = pickClient();
  while (!c && Date.now() - start < timeoutMs) {
    await sleep(100);
    c = pickClient();
  }
  return c;
}

function sendCmd(client, method, params, timeoutMs) {
  const id = `${process.pid}-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`Command "${method}" timed out after ${timeoutMs}ms`), { code: 'timeout' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method, client });
    try {
      client.send(JSON.stringify({ type: 'cmd', id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(Object.assign(new Error(`Could not send to extension: ${e.message}`), { code: 'send_failed' }));
    }
  });
}

/* ------------------------------------------------------------------ */
/* http api                                                            */
/* ------------------------------------------------------------------ */

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function authorized(req, url) {
  const header = req.headers['x-bridge-token'] || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const query = url.searchParams.get('token') || '';
  const candidate = header || bearer || query;
  if (!candidate || candidate.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(TOKEN));
}

async function handleRpc(req, res, body) {
  if (req.headers.origin) {
    // A browser page tried to call us. Never allow that.
    return json(res, 403, { ok: false, error: { code: 'forbidden', message: 'Origin header not allowed' } });
  }
  if (!authorized(req, new URL(req.url, `http://${HOST}:${PORT}`))) {
    return json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Bad or missing token' } });
  }

  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return json(res, 400, { ok: false, error: { code: 'bad_json', message: 'Body is not JSON' } });
  }

  const { method, params = {}, timeout } = payload;
  if (!method) return json(res, 400, { ok: false, error: { code: 'bad_request', message: 'Missing method' } });

  const client = await awaitClient(payload.waitMs ?? CONNECT_GRACE_MS);
  if (!client) {
    return json(res, 503, {
      ok: false,
      error: {
        code: 'extension_not_connected',
        message: everConnected
          ? 'The Browser Bridge extension is not connected. Open Chrome and check chrome://extensions, then open the extension popup for its status.'
          : 'No Browser Bridge extension has connected yet. Load it once: chrome://extensions -> Developer mode -> Load unpacked -> select the extension/ folder in this project.',
      },
    });
  }

  const started = Date.now();
  try {
    let result = await sendCmd(client, method, params, Math.max(1000, Number(timeout) || DEFAULT_TIMEOUT));
    if (result && result.dataUrl) {
      const shot = saveScreenshot(result.dataUrl);
      const { dataUrl, ...rest } = result;
      result = { ...rest, ...shot };
    }
    log(`rpc ${method} ok ${Date.now() - started}ms`);
    return json(res, 200, { ok: true, result, ms: Date.now() - started });
  } catch (e) {
    log(`rpc ${method} ERR ${e.code || 'error'} ${e.message}`);
    return json(res, 200, {
      ok: false,
      error: { code: e.code || 'error', message: e.message || String(e) },
      ms: Date.now() - started,
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      extensionConnected: !!pickClient(),
      extensionClients: [...clients].filter((c) => c.readyState === 1).length,
      extension: activeClient ? clientInfo(activeClient) : null,
      port: PORT,
    });
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return json(res, 413, { ok: false, error: { code: 'too_large', message: 'Body too large' } });
      handleRpc(req, res, body).catch((e) => json(res, 500, { ok: false, error: { code: 'daemon_error', message: e.message } }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/token') {
    if (!authorized(req, url)) return json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Bad or missing token' } });
    return json(res, 200, { ok: true, token: TOKEN });
  }

  json(res, 404, { ok: false, error: { code: 'not_found', message: `${req.method} ${url.pathname}` } });
});

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const origin = req.headers.origin || '';
  const extensionOrigin = origin.startsWith('chrome-extension://');
  if (!extensionOrigin && !authorized(req, url)) {
    log(`reject ws from origin=${JSON.stringify(origin)}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.__origin = origin;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  log(`ws connected (origin=${ws.__origin || 'none'})`);

  ws.on('message', (raw) => {
    let msg;
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
      activeClient = ws;
      everConnected = true;
      log(`extension hello v${msg.version} id=${msg.extensionId}`);
      return;
    }
    if (msg.type === 'pong') {
      ws.__lastPong = Date.now();
      return;
    }
    if (msg.type === 'result' && msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
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
            new Error('The browser connection dropped while the command was running (tab closed, Chrome quit, or extension reloaded).'),
            { code: 'extension_disconnected' },
          ),
        );
      }
    }
    log('ws closed');
  });

  ws.on('error', (e) => log(`ws error: ${e.message}`));

  // Keep the MV3 service worker alive: Chrome resets its idle timer on
  // WebSocket activity, so a 20s ping makes the socket effectively permanent.
  const ping = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {}
    }
  }, PING_MS);
  ws.on('close', () => clearInterval(ping));
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

server.on('error', (e) => {
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

function shutdown(sig) {
  log(`shutting down (${sig})`);
  try {
    fs.unlinkSync(PID_PATH);
  } catch {}
  for (const c of clients) {
    try {
      c.close();
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
