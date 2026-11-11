/**
 * chromectl - drive the user's real Chrome from a shell, through the
 * Browser Bridge extension.
 *
 * Every page command runs inside the agent's own tab group, and only on
 * origins the user has approved in the extension popup.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { HealthResult, SnapshotResult, StatusResult, TabDescriptor } from '../shared/types';

const ROOT = process.env.BB_ROOT || path.resolve(__dirname, '..', '..');
const DAEMON = path.join(ROOT, 'dist', 'daemon', 'server.js');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'browser-bridge');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token');
const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');

const BASE = `http://127.0.0.1:${process.env.BRIDGE_PORT || 8737}`;

// Agents pipe our output into head/grep, which closes the pipe early. That is
// not an error worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e?.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue | undefined>;

interface CommandContext {
  args: string[];
  flags: Flags;
  name: string;
}

type Target = { ref?: string; selector?: string; text?: string; index?: number };

/* ------------------------------------------------------------------ */
/* daemon plumbing                                                     */
/* ------------------------------------------------------------------ */

function token(): string {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

async function health(timeout = 600): Promise<HealthResult | null> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return (await res.json()) as HealthResult;
  } catch {
    return null;
  }
}

async function ensureDaemon(): Promise<HealthResult> {
  const h = await health();
  if (h) return h;
  if (!fs.existsSync(DAEMON)) die(`daemon not found at ${DAEMON} - run: npm run build`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(CONFIG_DIR, 'shots'), { recursive: true, mode: 0o700 });
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    const hh = await health(400);
    if (hh) return hh;
    await new Promise((r) => setTimeout(r, 100));
  }
  die(`daemon did not start; see ${LOG_PATH}`);
}

async function rpc<T>(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<T> {
  await ensureDaemon();
  const t = token();
  if (!t) die(`no token at ${TOKEN_PATH} - run: chromectl daemon restart`);
  let res: Response;
  try {
    res = await fetch(`${BASE}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': t },
      body: JSON.stringify({ method, params, timeout }),
      signal: AbortSignal.timeout((timeout || 60_000) + 15_000),
    });
  } catch (e) {
    die(`cannot reach daemon at ${BASE}: ${(e as Error).message}`);
  }
  let body: { ok: boolean; result?: unknown; error?: { code?: string; message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    die(`bad response from daemon (HTTP ${res.status})`);
  }
  if (!body.ok) {
    const err = body.error || {};
    die(err.message ? `${err.code || 'error'}: ${err.message}` : `HTTP ${res.status}`);
  }
  return body.result as T;
}

function die(msg: string): never {
  process.stderr.write(`chromectl: ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* arg parsing                                                         */
/* ------------------------------------------------------------------ */

const BOOLEAN_FLAGS = new Set([
  'json',
  'submit',
  'no-clear',
  'slow',
  'hard',
  'all',
  'gone',
  'no-text',
  'help',
  'quiet',
  'background',
  'active',
  'index',
  'click-only',
  'cdp',
]);

function parse(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { args, flags };
}

/** bare number -> ref, css=/#./[/> -> selector, text= -> text, else text */
function target(spec: string | undefined, flags: Flags = {}): Target {
  const idx = flags.index != null ? { index: Number(flags.index) } : {};
  if (flags.ref != null) return { ref: String(flags.ref) };
  if (flags.selector) return { selector: String(flags.selector), ...idx };
  if (flags.text) return { text: String(flags.text), ...idx };
  if (spec == null) return {};
  const s = String(spec);
  if (/^\[?\d+\]?$/.test(s.trim())) return { ref: s.replace(/[[\]]/g, '') };
  if (s.startsWith('ref=')) return { ref: s.slice(4) };
  if (s.startsWith('css=')) return { selector: s.slice(4), ...idx };
  if (s.startsWith('selector=')) return { selector: s.slice(9), ...idx };
  if (s.startsWith('text=')) return { text: s.slice(5), ...idx };
  if (/^[#.[*>]/.test(s) || /^[a-z]+\[/.test(s)) return { selector: s, ...idx };
  return { text: s, ...idx };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const out = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};

function renderSnapshot(s: SnapshotResult): void {
  const v = s.viewport;
  out(s.title || '(untitled)');
  out(s.url);
  out(
    `viewport ${v.width}x${v.height} @ ${v.scrollPct ?? 0}% (scrollY ${v.scrollY}/${v.scrollHeight})` +
      `  ·  ${s.elements.length} elements` +
      `  ·  ${s.summary?.forms ?? 0} forms, ${s.summary?.iframes ?? 0} iframes${s.summary?.truncated ? '  ·  TRUNCATED' : ''}`,
  );
  out('');
  if (!s.elements.length) out('(no interactive elements found - try: chromectl text)');
  for (const line of s.lines) out(line);
  if (s.text) {
    out('');
    out('── VISIBLE TEXT ──');
    out(s.text);
  }
}

function renderTab(t: TabDescriptor): void {
  out(`tab ${t.tabId}  ${t.active ? '*' : ' '} ${t.title || '(untitled)'}`);
  out(`        ${t.url}`);
}

function renderStatus(s: StatusResult): void {
  out(`extension   ${s.connected ? 'connected' : 'NOT connected'}   v${s.version}`);
  const tabs = s.agentTabs || [];
  out(
    `agent tabs  ${tabs.length}${
      s.groups?.length
        ? ` (group ${s.groups.map((g) => g.groupId).join(', ')} in window ${s.groups.map((g) => g.windowId).join(', ')})`
        : ''
    }`,
  );
  for (const t of tabs) out(`  ${t.active ? '*' : ' '} ${t.tabId}  ${t.title || '(untitled)'}  -  ${t.url}`);
  const allowed = s.allowedOrigins || [];
  out(`allowed     ${allowed.length ? allowed.join(', ') : '(none - approve sites in the extension popup)'}`);
  if (s.autoAllow) out('WARNING     auto-approve is ON: every site is allowed');
  if (s.pendingOrigin) out(`pending     ${s.pendingOrigin.origin}  (waiting for the user to Allow)`);
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

function tabParam(flags: Flags): Record<string, number> {
  return flags.tab ? { tabId: Number(flags.tab) } : {};
}

function normalizeUrl(u: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (u.includes('.') && !u.includes(' ')) return `https://${u}`;
  return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
}

const commands: Record<string, (ctx: CommandContext) => Promise<void>> = {
  async status({ flags }) {
    const h = await health();
    if (!h) {
      out('daemon      not running');
      out('extension   unknown');
      return;
    }
    out(`daemon      ${BASE}  pid ${h.pid}  up ${h.uptime}s`);
    if (!h.extensionConnected) {
      out('extension   NOT connected - is Chrome running with Browser Bridge enabled? see: chromectl daemon logs');
      return;
    }
    const s = await rpc<StatusResult>('status');
    if (flags.json) return out(JSON.stringify(s, null, 2));
    renderStatus(s);
  },

  async tabs({ flags }) {
    const r = await rpc<{ tabs: TabDescriptor[] }>('tab.list', { all: !!flags.all });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    if (!r.tabs.length) return out('(no agent tabs - run: chromectl open <url>)');
    for (const t of r.tabs) renderTab(t);
  },

  async open({ args, flags }) {
    const url = args[0];
    if (!url) die('usage: chromectl open <url>');
    const r = await rpc<TabDescriptor>('tab.open', { url: normalizeUrl(url), active: flags.active === true && !flags.background }, 45_000);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`opened tab ${r.tabId} in the agent group: ${r.title || '(untitled)'}`);
    out(r.url);
  },

  async adopt({ flags }) {
    const params: Record<string, unknown> = {};
    if (flags.tab) params.tabId = Number(flags.tab);
    if (flags.url) params.url = flags.url;
    const r = await rpc<TabDescriptor>('tab.adopt', params);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`adopted tab ${r.tabId} into the agent group: ${r.title || ''}`);
    out(r.url);
  },

  async goto({ args, flags }) {
    const url = args[0];
    if (!url) die('usage: chromectl goto <url>');
    const r = await rpc<TabDescriptor>('tab.goto', { ...tabParam(flags), url: normalizeUrl(url) }, 45_000);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(r.title);
    out(r.url);
  },

  async activate({ flags }) {
    const r = await rpc<TabDescriptor>('tab.activate', tabParam(flags));
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`brought tab ${r.tabId} to the front: ${r.title || '(untitled)'}`);
    out(r.url);
  },

  async back({ flags }) {
    const r = await rpc<TabDescriptor>('tab.back', tabParam(flags));
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(r.url);
  },

  async forward({ flags }) {
    const r = await rpc<TabDescriptor>('tab.forward', tabParam(flags));
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(r.url);
  },

  async reload({ flags }) {
    const r = await rpc<TabDescriptor>('tab.reload', { ...tabParam(flags), hard: !!flags.hard }, 45_000);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(r.title);
    out(r.url);
  },

  async close({ flags }) {
    const r = await rpc<{ closed: number | null; blanked?: number }>('tab.close', tabParam(flags));
    if (flags.json) return out(JSON.stringify(r, null, 2));
    if (r.closed == null) out(`blanked tab ${r.blanked} (it was the last tab in the window, so Chrome kept the window open)`);
    else out(`closed tab ${r.closed}`);
  },

  async snapshot({ flags }) {
    const params: Record<string, unknown> = { ...tabParam(flags) };
    if (flags.max) params.maxElements = Number(flags.max);
    if (flags['no-text']) params.text = false;
    if (flags.text && /^\d+$/.test(String(flags.text))) params.textLength = Number(flags.text);
    const r = await rpc<SnapshotResult>('page.snapshot', params);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    renderSnapshot(r);
  },

  async text({ flags }) {
    const r = await rpc<{ text: string }>('page.text', {
      ...tabParam(flags),
      limit: flags.limit ? Number(flags.limit) : 8000,
    });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(r.text);
  },

  async links({ flags }) {
    const r = await rpc<{ links: Array<{ url: string; text: string }> }>('page.links', {
      ...tabParam(flags),
      limit: flags.limit ? Number(flags.limit) : 150,
    });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    for (const l of r.links) out(`${l.text || '(no text)'}\n  ${l.url}`);
  },

  async query({ args, flags }) {
    if (!args[0]) die('usage: chromectl query <css selector> [--limit N] [--attrs a,b]');
    const params: Record<string, unknown> = {
      ...tabParam(flags),
      selector: args[0],
      limit: flags.limit ? Number(flags.limit) : 40,
    };
    if (flags.attrs) params.attrs = String(flags.attrs).split(',').map((s) => s.trim());
    const r = await rpc<{
      count: number;
      returned: number;
      selector: string;
      items: Array<{ tag: string; text?: string; href?: string; value?: string; visible: boolean; attrs?: Record<string, string> }>;
    }>('page.query', params);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`${r.count} match(es) for ${r.selector}${r.returned < r.count ? `, showing ${r.returned}` : ''}`);
    for (const it of r.items) {
      const bits = [it.tag];
      if (it.text) bits.push(JSON.stringify(it.text));
      if (it.href) bits.push(`href=${it.href}`);
      if (it.value) bits.push(`value=${JSON.stringify(it.value)}`);
      if (it.attrs?.class) bits.push(`class="${it.attrs.class}"`);
      if (!it.visible) bits.push('(hidden)');
      out(`  ${bits.join(' ')}`);
    }
  },

  async click({ args, flags }) {
    const t = target(args[0], flags);
    if (!Object.keys(t).length) die('usage: chromectl click <ref|css=...|text=...>');
    const r = await rpc<{ clicked?: { role: string; name: string }; navigated?: boolean; url: string }>('page.click', {
      ...tabParam(flags),
      ...t,
      clickOnly: !!flags['click-only'],
      viaCdp: !!flags.cdp,
    });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    if (r.clicked) out(`clicked ${r.clicked.role} "${r.clicked.name}"${r.navigated ? '  -> navigated' : ''}`);
    else if (r.navigated) out('clicked -> navigated (result not readable, take a fresh snapshot)');
    else out('clicked, but the page reloaded while it ran - take a fresh snapshot to see the result');
    out(r.url);
  },

  async hover({ args, flags }) {
    const t = target(args[0], flags);
    const r = await rpc<{ hovered: { role: string; name: string } }>('page.hover', { ...tabParam(flags), ...t });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`hovered ${r.hovered.role} "${r.hovered.name}"`);
  },

  async type({ args, flags }) {
    const t = target(args[0], flags);
    const text = args.slice(1).join(' ');
    if (!Object.keys(t).length || !text) die('usage: chromectl type <ref|css=...|text=...> <text>');
    const r = await rpc<{ typed?: { role: string; name: string }; value?: string; submitted?: boolean; url?: string }>(
      'page.type',
      {
        ...tabParam(flags),
        ...t,
        text,
        clear: !flags['no-clear'],
        submit: !!flags.submit,
        slow: flags.slow ? Number(flags.slow) || 60 : 0,
      },
    );
    if (flags.json) return out(JSON.stringify(r, null, 2));
    if (r.typed) out(`typed into ${r.typed.role} "${r.typed.name}"  value="${r.value}"${r.submitted ? '  (submitted)' : ''}`);
    else out('typed, but the page reloaded while it ran - take a fresh snapshot to see the result');
    if (r.url) out(r.url);
  },

  async key({ args, flags }) {
    const keys = args[0];
    if (!keys) die('usage: chromectl key <combo>   e.g. "Enter", "Escape", "Meta+a", "Shift+Tab"');
    const r = await rpc<{ handled?: string; submitted?: boolean }>('page.key', {
      ...tabParam(flags),
      keys,
      ...(flags.ref ? { ref: String(flags.ref) } : {}),
    });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`sent ${keys}${r.handled ? ` (${r.handled})` : ''}${r.submitted ? '  (submitted)' : ''}`);
  },

  async scroll({ args, flags }) {
    const params: Record<string, unknown> = { ...tabParam(flags) };
    if (flags.ref) params.ref = String(flags.ref);
    else params.direction = args[0] || 'down';
    if (flags.amount) params.amount = Number(flags.amount);
    const r = await rpc<{ scrollY: number; scrollHeight: number; pct: number; atBottom?: boolean; atTop?: boolean }>(
      'page.scroll',
      params,
    );
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`scrollY ${r.scrollY} / ${r.scrollHeight}  (${r.pct}%)${r.atBottom ? '  at bottom' : ''}${r.atTop ? '  at top' : ''}`);
  },

  async select({ args, flags }) {
    const t = target(args[0], flags);
    const values = args.slice(1);
    if (!Object.keys(t).length || !values.length) die('usage: chromectl select <ref> <option text|value>...');
    const r = await rpc<{ selected: string[] }>('page.select', { ...tabParam(flags), ...t, values });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`selected: ${r.selected.join(' | ')}`);
  },

  async wait({ args, flags }) {
    const spec = args[0];
    if (!spec) die('usage: chromectl wait <css=...|text=...|url=...|idle> [--timeout ms] [--gone]');
    const params: Record<string, unknown> = {
      ...tabParam(flags),
      timeout: flags.timeout ? Number(flags.timeout) : 10_000,
      gone: !!flags.gone,
    };
    if (spec === 'idle') params.idle = true;
    else if (spec.startsWith('css=')) params.selector = spec.slice(4);
    else if (spec.startsWith('text=')) params.text = spec.slice(5);
    else if (spec.startsWith('url=')) params.url = spec.slice(4);
    else params.text = spec;
    const r = await rpc<{ found: boolean; ms: number }>('page.wait', params, Number(params.timeout) + 20_000);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(r.found ? `found after ${r.ms}ms` : `not found after ${r.ms}ms`);
    if (!r.found) process.exitCode = 2;
  },

  async find({ args, flags }) {
    const query = args.join(' ');
    if (!query) die('usage: chromectl find <text>');
    const r = await rpc<{ count: number; matches: Array<{ ref: number | null; context: string }> }>('page.find', {
      ...tabParam(flags),
      query,
      limit: flags.limit ? Number(flags.limit) : 10,
    });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`${r.count} match(es) for "${query}"`);
    for (const m of r.matches) out(`  ${m.ref != null ? `[${m.ref}] ` : ''}${m.context}`);
  },

  async eval({ args, flags }) {
    const expression = args.join(' ');
    if (!expression) die('usage: chromectl eval "<javascript expression>"');
    const r = await rpc<{ value: unknown }>('page.eval', { ...tabParam(flags), expression });
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
  },

  async screenshot({ flags }) {
    const r = await rpc<{ path: string; width?: number; height?: number; url: string }>('page.screenshot', tabParam(flags), 90_000);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    if (flags.out) {
      fs.copyFileSync(r.path, String(flags.out));
      out(`saved ${flags.out} (${r.width}x${r.height})`);
    } else {
      out(r.path);
      if (r.width) out(`${r.width}x${r.height}  ·  ${r.url}`);
    }
  },

  async policy({ flags }) {
    const r = await rpc<StatusResult>('policy.get');
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`auto-approve  ${r.autoAllow ? 'ON' : 'off'}`);
    out(`allowed       ${r.allowedOrigins.length ? r.allowedOrigins.join(', ') : '(none)'}`);
    if (r.pendingOrigin) out(`pending       ${r.pendingOrigin.origin}`);
  },

  async request({ args }) {
    const origin = args[0];
    if (!origin) die('usage: chromectl request <url|origin>');
    const r = await rpc<{ pending: string }>('policy.request', { url: normalizeUrl(origin) });
    out(`permission requested for ${r.pending} - open the Browser Bridge icon in Chrome and press Allow`);
  },

  async reset() {
    const r = await rpc<{ closed: number }>('group.reset');
    out(`closed ${r.closed} agent tab(s) and cleared the group`);
  },

  async daemon({ args }) {
    const sub = args[0] || 'status';
    if (sub === 'start') {
      const h = await ensureDaemon();
      out(`daemon running on ${BASE} (pid ${h.pid})`);
      return;
    }
    if (sub === 'stop') {
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
      } catch {
        /* not running */
      }
      if (!pid) return out('daemon not running');
      try {
        process.kill(pid, 'SIGTERM');
        out(`stopped daemon pid ${pid}`);
      } catch (e) {
        out(`could not stop pid ${pid}: ${(e as Error).message}`);
      }
      return;
    }
    if (sub === 'restart') {
      try {
        const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
        if (pid) process.kill(pid, 'SIGTERM');
      } catch {
        /* not running */
      }
      await new Promise((r) => setTimeout(r, 600));
      const h = await ensureDaemon();
      out(`daemon running on ${BASE} (pid ${h.pid})`);
      return;
    }
    if (sub === 'logs') {
      if (!fs.existsSync(LOG_PATH)) return out('(no log yet)');
      const text = fs.readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n');
      out(text.slice(-(Number(args[1]) || 40)).join('\n'));
      return;
    }
    const h = await health();
    if (!h) return out('daemon      not running');
    out(`daemon      ${BASE}  pid ${h.pid}  up ${h.uptime}s`);
    out(`extension   ${h.extensionConnected ? 'connected' : 'NOT connected'}${h.extension ? `  (v${h.extension.version}, id ${h.extension.extensionId})` : ''}`);
    out(`log         ${LOG_PATH}`);
    out(`token       ${TOKEN_PATH}`);
  },

  async help() {
    out(`chromectl - control Chrome from the shell (Browser Bridge)

  chromectl status                  daemon + extension + agent tabs + permissions
  chromectl open <url> [--active]   open a tab in the agent group (background unless --active)
  chromectl adopt [--tab N]         pull one of the user's tabs into the group
  chromectl snapshot                accessibility snapshot with [refs]
  chromectl text                    visible text of the page
  chromectl links                   every visible link
  chromectl query <css>             structured rows: text, href, value, class
  chromectl click <ref|css=|text=>   click something  [--cdp] [--click-only]
  chromectl type <ref> <text>       type into a field  [--submit] [--slow] [--no-clear]
  chromectl key <combo>             key press: Enter, Escape, Meta+a, Shift+Tab
  chromectl scroll <up|down|top|bottom>   or --ref N
  chromectl hover <ref>             hover
  chromectl select <ref> <value>    choose a <select> option
  chromectl wait <css=|text=|url=|idle>  [--timeout ms] [--gone]
  chromectl find <text>             where does this text appear
  chromectl eval "<js>"             run JS in the page (blocked by strict CSP sites)
  chromectl screenshot [--out f]    capture the visible tab, returns a PNG path
  chromectl tabs [--all]            agent tabs (or every tab)
  chromectl activate                bring the agent tab to the front
  chromectl goto <url> | back | forward | reload | close
  chromectl policy | request <url>  see / ask for site permission
  chromectl reset                   close all agent tabs
  chromectl daemon start|stop|restart|logs

Global flags: --tab N, --json

Refs come from "chromectl snapshot" and expire on navigation or a new snapshot.`);
  },
};

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { args, flags } = parse(argv);
  const name = args.shift() || 'status';
  if (name === '--help' || flags.help || name === 'help') return commands.help!({ args, flags, name });
  const cmd = commands[name] || commands[name.replace(/-/g, '')];
  if (!cmd) {
    out(`unknown command "${name}"\n`);
    return commands.help!({ args, flags, name });
  }
  await cmd({ args, flags, name });
}

main().catch((e: Error) => {
  process.stderr.write(`chromectl: ${e.message}\n`);
  process.exit(1);
});
