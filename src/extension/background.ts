/**
 * Browser Bridge - MV3 service worker.
 *
 * Opens a WebSocket to the local bridge daemon (127.0.0.1:8737), receives
 * commands from the CLI on behalf of an AI agent, executes them via the
 * chrome.* APIs + an injected content script, and returns results.
 *
 * The agent may only touch tabs inside its own tab group, and only on origins
 * the user has approved in the extension popup.
 */

import type {
  Envelope,
  NavigationResult,
  PageAction,
  PageParams,
  Settings,
  SnapshotResult,
  StatusResult,
  TabDescriptor,
} from '../shared/types';

const VERSION = '1.4.2';
const PORT = 8737;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const GROUP_TITLE = 'Agent';
const GROUP_COLOR = 'purple' as chrome.tabGroups.ColorEnum & string;

let socket: WebSocket | null = null;
let connected = false;
let backoffMs = 700;
let inflight = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class BridgeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const fail = (code: string, message: string): BridgeError => new BridgeError(code, message);

type ActionParams = PageParams & {
  tabId?: number;
  active?: boolean;
  hard?: boolean;
  all?: boolean;
  expression?: string;
  origin?: string;
  url?: string;
  timeout?: number;
  delayMs?: number;
};

type Method = (params: ActionParams) => Promise<unknown>;

/* ------------------------------------------------------------------ */
/* settings + policy                                                   */
/* ------------------------------------------------------------------ */

async function getSettings(): Promise<Settings> {
  // Auto-approve defaults on: the per-site gate still records every origin and
  // still prompts when the user turns it off, but a fresh install (or a reload
  // that lost storage) is usable immediately instead of blocking the first call.
  return (await chrome.storage.local.get({
    allowedOrigins: [],
    autoAllow: true,
    pendingOrigin: null,
  })) as Settings;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.origin || u.origin === 'null') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function originAllowed(origin: string | null, list: string[]): boolean {
  if (!origin) return false;
  return list.some((entry) => {
    if (entry === origin) return true;
    if (entry.startsWith('*.')) {
      try {
        return new URL(origin).hostname.endsWith(entry.slice(1));
      } catch {
        return false;
      }
    }
    return false;
  });
}

const INTERNAL_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

/**
 * The single permission gate. Called before the agent touches a page and
 * before it navigates somewhere new, so an unapproved site is never loaded.
 */
async function requireOrigin(url: string | undefined, { tabId = null }: { tabId?: number | null } = {}): Promise<void> {
  if (!url || url === 'about:blank' || INTERNAL_URL.test(url)) return;
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw fail(
      'unsupported_url',
      `The agent can only script http(s) pages; this one is ${protocol}. Serve the file over http, or paste its content into the chat instead.`,
    );
  }
  const origin = originOf(url);
  const { allowedOrigins, autoAllow } = await getSettings();
  if (autoAllow || originAllowed(origin, allowedOrigins)) return;

  await chrome.storage.local.set({ pendingOrigin: { origin, url, tabId, at: Date.now() } });
  await paintBadge();
  throw fail(
    'origin_not_allowed',
    `Permission required for ${origin}. Ask the user to open the Browser Bridge extension icon and press "Allow" for this site, then retry.`,
  );
}

async function assertAllowed(tab: chrome.tabs.Tab): Promise<void> {
  return requireOrigin(tab?.url || tab?.pendingUrl, { tabId: tab?.id ?? null });
}

/* ------------------------------------------------------------------ */
/* tab group workspace                                                 */
/* ------------------------------------------------------------------ */

type GroupMap = Record<number, number>;

// Group ids live in local storage so the workspace survives an extension
// reload or a browser restart (Chrome restores tab groups with the session).
async function loadGroups(): Promise<GroupMap> {
  const { agentGroups = {} } = await chrome.storage.local.get('agentGroups');
  return agentGroups as GroupMap;
}

async function saveGroups(groups: GroupMap): Promise<void> {
  await chrome.storage.local.set({ agentGroups: groups });
}

/**
 * Last-resort recovery: if we lost our ids (fresh install, cleared storage)
 * but a purple group named "Agent" still exists, adopt it again instead of
 * leaving the user with an orphaned group.
 */
async function recoverGroups(): Promise<GroupMap> {
  try {
    const found = await chrome.tabGroups.query({ title: GROUP_TITLE });
    const matches = found.filter((g) => g.color === GROUP_COLOR);
    if (!matches.length) return {};
    const groups: GroupMap = {};
    for (const g of matches) groups[g.windowId] = g.id;
    await saveGroups(groups);
    return groups;
  } catch {
    return {};
  }
}

/** Returns the live group id for a window, pruning dead ids. */
async function groupForWindow(windowId: number): Promise<number | null> {
  const groups = await loadGroups();
  const resolved = Object.keys(groups).length ? groups : await recoverGroups();
  const gid = resolved[windowId];
  if (gid == null) return null;
  try {
    const g = await chrome.tabGroups.get(gid);
    if (g.windowId === windowId) return gid;
  } catch {
    /* group closed */
  }
  delete resolved[windowId];
  await saveGroups(resolved);
  return null;
}

async function agentTabs(): Promise<chrome.tabs.Tab[]> {
  let groups = await loadGroups();
  if (!Object.keys(groups).length) groups = await recoverGroups();
  const out: chrome.tabs.Tab[] = [];
  let dirty = false;
  for (const [winId, gid] of Object.entries(groups)) {
    try {
      const tabs = await chrome.tabs.query({ groupId: gid });
      out.push(...tabs);
      if (!tabs.length) {
        // An empty group is auto-dissolved by Chrome.
        try {
          await chrome.tabGroups.get(gid);
        } catch {
          delete groups[Number(winId)];
          dirty = true;
        }
      }
    } catch {
      delete groups[Number(winId)];
      dirty = true;
    }
  }
  if (dirty) await saveGroups(groups);
  out.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return out;
}

async function isAgentTab(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab || tab.groupId == null || tab.groupId < 0) return false;
  const groups = await loadGroups();
  return Object.values(groups).includes(tab.groupId);
}

function describeTab(t: chrome.tabs.Tab): TabDescriptor {
  return {
    tabId: t.id ?? -1,
    windowId: t.windowId,
    groupId: t.groupId,
    url: t.url || t.pendingUrl || '',
    title: t.title || '',
    active: !!t.active,
    status: t.status || '',
    loading: t.status === 'loading',
  };
}

async function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<chrome.tabs.Tab | null> {
  const start = Date.now();
  // Give the navigation a moment to start before trusting status=complete.
  await sleep(120);
  while (Date.now() - start < timeoutMs) {
    let t: chrome.tabs.Tab;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    if (t.status === 'complete') return t;
    await sleep(120);
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function resolveTab(
  params: ActionParams = {},
  { page = true, requireAgent = true } = {},
): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  if (params.tabId != null && (params.tabId as unknown) !== '') {
    try {
      tab = await chrome.tabs.get(Number(params.tabId));
    } catch {
      throw fail('no_such_tab', `No tab with id ${params.tabId}. Run "chromectl tabs".`);
    }
    if (requireAgent && !(await isAgentTab(tab))) {
      throw fail(
        'not_agent_tab',
        `Tab ${tab.id} is not inside the agent tab group, so the agent will not touch it. ` +
          `Run "chromectl adopt --tab ${tab.id}" if the user asked you to work on that tab.`,
      );
    }
  } else {
    const tabs = await agentTabs();
    if (!tabs.length) throw fail('no_agent_tab', 'No agent tab is open yet. Run "chromectl open <url>" first.');
    tab = tabs.find((t) => t.active) || tabs[0]!;
  }
  if (page) await assertAllowed(tab);
  return tab;
}

/* ------------------------------------------------------------------ */
/* content script plumbing                                             */
/* ------------------------------------------------------------------ */

async function ensureInjected(tabId: number): Promise<void> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { __bb: 1, action: 'ping' })) as { ok?: boolean } | undefined;
    if (res && res.ok) return;
  } catch {
    /* not injected yet, or no listener */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    throw fail(
      'restricted_page',
      `Chrome does not let extensions script this page (${(e as Error).message}). Open a normal http(s) page instead.`,
    );
  }
}

/** Reads the live URL from the page itself (chrome.tabs.get can report a
 *  stale snapshot right after a navigation starts). */
async function liveUrl(tabId: number): Promise<string | null> {
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href });
    return (frames?.[0]?.result as string | undefined) || null;
  } catch {
    return null;
  }
}

/** Detects a mid-flight navigation so a lost response is not reported as an error. */
async function navigationResult(tab: chrome.tabs.Tab): Promise<NavigationResult | null> {
  await sleep(250);
  for (let i = 0; i < 4; i++) {
    const live = await liveUrl(tab.id!);
    const now = await chrome.tabs.get(tab.id!).catch(() => null);
    const url = live || now?.url || '';
    const moved = !!url && !!tab.url && url !== tab.url;
    if (moved || now?.status === 'loading') {
      if (now?.status === 'loading') await waitForLoad(tab.id!, 10_000);
      const final = await chrome.tabs.get(tab.id!).catch(() => now);
      return {
        navigated: true,
        url: (await liveUrl(tab.id!)) || final?.url || url,
        title: final?.title || tab.title || '',
        note: 'The page navigated while the action ran; the action result was not readable. Take a fresh snapshot.',
      };
    }
    await sleep(250);
  }
  return null;
}

/**
 * Where the agent group belongs: the window that already holds it, otherwise the
 * window with the most tabs (the one the user actually works in). A freshly
 * opened window with a single tab, or the last-focused popup window, must not
 * capture the group.
 */
async function chooseWindow(): Promise<chrome.windows.Window> {
  const groups = await loadGroups();
  const withGroup: number[] = [];
  for (const gid of Object.values(groups)) {
    try {
      const g = await chrome.tabGroups.get(gid);
      withGroup.push(g.windowId);
    } catch {
      /* group gone */
    }
  }
  const windows = (await chrome.windows.getAll({ windowTypes: ['normal'], populate: true })).filter(
    (w) => w.id != null,
  );
  const existing = windows.filter((w) => withGroup.includes(w.id!));
  if (existing.length) return existing[0]!;
  const busiest = [...windows].sort((a, b) => (b.tabs?.length ?? 0) - (a.tabs?.length ?? 0))[0];
  return busiest ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }));
}

const NAV_ACTIONS = new Set<PageAction>(['click', 'key', 'type', 'select', 'hover']);

async function callPage<T>(tab: chrome.tabs.Tab, action: PageAction, params: ActionParams = {}): Promise<T | NavigationResult> {
  const unwrap = (res: Envelope<unknown> | undefined): T => {
    if (!res) throw fail('no_response', 'The page did not respond (it may be navigating). Retry.');
    if (!res.ok) throw fail(res.code || 'page_error', res.error || 'Page action failed');
    return res.result as T;
  };

  await ensureInjected(tab.id!);
  try {
    return unwrap((await chrome.tabs.sendMessage(tab.id!, { __bb: 1, action, params })) as Envelope<unknown>);
  } catch (e) {
    // The page navigated (or reloaded) out from under the message.
    const nav = await navigationResult(tab);
    if (nav) return nav;
    await ensureInjected(tab.id!);
    try {
      return unwrap((await chrome.tabs.sendMessage(tab.id!, { __bb: 1, action, params })) as Envelope<unknown>);
    } catch (e2) {
      const nav2 = await navigationResult(tab);
      if (nav2) return nav2;
      // A click can reload the same URL, which looks identical to a dead
      // context. Report that softly so the agent re-reads the page instead of
      // chasing a phantom error.
      if (NAV_ACTIONS.has(action)) {
        const now = await chrome.tabs.get(tab.id!).catch(() => null);
        return {
          navigated: !!(now && tab.url && now.url !== tab.url),
          uncertain: true,
          url: now?.url || tab.url || '',
          title: now?.title || tab.title || '',
          note: 'The page reloaded or navigated while the action ran and the result was lost. Take a fresh snapshot to confirm what happened.',
        };
      }
      throw fail('no_response', `The page did not respond to ${action} (${(e2 as Error).message || e2}). Take a fresh snapshot and retry.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* debugger sessions                                                   */
/* ------------------------------------------------------------------ */

const cdpAttached = new Map<number, ReturnType<typeof setTimeout>>();
const CDP_IDLE_MS = 20_000;

async function cdpDetach(tabId: number): Promise<void> {
  const timer = cdpAttached.get(tabId);
  if (timer) clearTimeout(timer);
  cdpAttached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

function cdpTouch(tabId: number): void {
  const timer = cdpAttached.get(tabId);
  if (timer) clearTimeout(timer);
  cdpAttached.set(tabId, setTimeout(() => void cdpDetach(tabId), CDP_IDLE_MS));
}

/**
 * Attach (once per tab) and make a background tab behave like a focused one.
 *
 * A tab that is not active in its window gets no animation frames and no
 * trusted input, and reports visibilityState "hidden", so pages that gate work
 * on visibility stall. Playwright solves this the same way: focus emulation on
 * attach. It changes nothing the user sees and never raises the window.
 */
async function cdpSession(tabId: number): Promise<void> {
  if (cdpAttached.has(tabId)) {
    cdpTouch(tabId);
    return;
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => undefined);
  await chrome.debugger
    .sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true })
    .catch(() => undefined);
  await chrome.debugger
    .sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' })
    .catch(() => undefined);
  cdpTouch(tabId);
}

/**
 * Send a CDP command. Input commands only answer once the renderer has handled
 * the event, and a throttled renderer can hold that answer for ~5s, so the ack
 * is raced against a short sleep instead of being awaited outright.
 */
async function cdp(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
  { raceAck = true }: { raceAck?: boolean } = {},
): Promise<unknown> {
  await cdpSession(tabId);
  cdpTouch(tabId);
  const call = chrome.debugger.sendCommand({ tabId }, method, params);
  if (method.startsWith('Input.') && raceAck) {
    return Promise.race([call, sleep(400).then(() => undefined)]);
  }
  return call;
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    const timer = cdpAttached.get(source.tabId);
    if (timer) clearTimeout(timer);
    cdpAttached.delete(source.tabId);
  }
});

/** Resolve a target to viewport coordinates through the page, via CDP. */
async function cdpPoint(tabId: number, p: ActionParams): Promise<{ x: number; y: number; name: string } | null> {
  const res = (await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const el = ${elementExpression(p)};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 80) };
    })()`,
    returnByValue: true,
  })) as { result?: { value?: { x: number; y: number; name: string } | null } };
  return res.result?.value ?? null;
}

const MOUSE_MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function keyDescriptor(combo: string): { key: string; code: string; modifiers: number; text?: string } {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  const raw = parts.pop() || '';
  const key = raw === 'Space' ? ' ' : raw;
  let modifiers = 0;
  for (const m of parts) modifiers |= MOUSE_MODIFIERS[m.toLowerCase()] ?? 0;
  const code =
    key.length === 1
      ? /[a-z]/i.test(key)
        ? `Key${key.toUpperCase()}`
        : /[0-9]/.test(key)
          ? `Digit${key}`
          : key
      : key;
  return { key, code, modifiers, text: key.length === 1 ? key : key === 'Enter' ? '\r' : undefined };
}

/** JS expression that resolves a click target from the same params the content
 *  script takes, so refs, selectors and text search behave identically. */
function elementExpression(p: ActionParams): string {
  if (p.ref !== undefined && p.ref !== null && p.ref !== '') {
    return `document.querySelector('[data-bb-ref="${String(p.ref).replace(/"/g, '\\"')}"]')`;
  }
  if (p.selector) {
    const sel = JSON.stringify(p.selector);
    return `document.querySelectorAll(${sel})[${Number(p.index) || 0}]`;
  }
  if (p.text) {
    const needle = JSON.stringify(String(p.text).trim().toLowerCase());
    // Visible elements only (menus keep hidden copies in the DOM), exact match
    // first, then smallest containing match so a wrapper never wins over the
    // item itself.
    return `(() => {
      const needle = ${needle};
      const seen = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=option],label,span,li')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
        })
        .map((el) => ({ el, text: (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase() }))
        .filter((c) => c.text.includes(needle));
      if (!seen.length) return null;
      const exact = seen.find((c) => c.text === needle);
      return (exact || seen.sort((a, b) => a.text.length - b.text.length)[0]).el;
    })()`;
  }
  return 'null';
}

/**
 * Click through the debugger: real Input.dispatchMouseEvent presses, which
 * Material widgets honour where in-page synthetic events are ignored (menus
 * close on mousedown, mat-option needs a trusted press).
 */
async function cdpClick(tabId: number, p: ActionParams): Promise<Record<string, unknown>> {
  const box = await cdpPoint(tabId, p);
  if (!box) throw new Error('element not found');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
  await sleep(p.waitMs ?? 250);
  return { clicked: { role: 'element', name: box.name }, url: '', navigated: false, viaCdp: true };
}

/** One-shot CDP screenshot of a tab, attached and detached per capture. */
async function pressKey(tabId: number, combo: string, repeat = 1): Promise<void> {
  const k = keyDescriptor(combo);
  for (let i = 0; i < repeat; i++) {
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: k.text ? 'keyDown' : 'rawKeyDown',
      key: k.key,
      code: k.code,
      text: k.text,
      modifiers: k.modifiers,
      windowsVirtualKeyCode: k.key.length === 1 ? k.key.toUpperCase().charCodeAt(0) : 0,
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: k.key,
      code: k.code,
      modifiers: k.modifiers,
    });
  }
}

async function cdpType(tabId: number, p: ActionParams): Promise<Record<string, unknown>> {
  const box = await cdpPoint(tabId, p);
  if (!box) throw new Error('field not found');
  // Both presses are acknowledged here: the insert below must not overtake the
  // focus they cause.
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1,
  }, { raceAck: false });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1,
  }, { raceAck: false });
  await sleep(60);

  // A press can land before the page is settled and leave nothing focused. Make
  // focus explicit rather than typing into the document.
  const focused = (await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => { const el = ${elementExpression(p)}; return !!el && document.activeElement === el; })()`,
    returnByValue: true,
  })) as { result?: { value?: boolean } };
  if (!focused.result?.value) {
    await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => { const el = ${elementExpression(p)}; if (el) { el.focus(); } })()`,
    });
    await sleep(40);
  }

  if (p.clear !== false) {
    // Trusted select-all then delete, so app state updates the way real input does.
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      commands: ['selectAll'],
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await pressKey(tabId, 'Backspace');
  }

  const text = String(p.text ?? '');
  if (p.slow) {
    for (const ch of text) {
      await cdp(tabId, 'Input.insertText', { text: ch });
      await sleep(Number(p.slow) || 60);
    }
  } else if (text) {
    await cdp(tabId, 'Input.insertText', { text });
  }

  let submitted = false;
  if (p.submit) {
    await pressKey(tabId, 'Enter');
    submitted = true;
  }
  await sleep(150);
  const value = (await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => { const el = ${elementExpression(p)}; return el ? (el.value ?? el.innerText ?? '') : ''; })()`,
    returnByValue: true,
  })) as { result?: { value?: string } };
  return { typed: { role: 'field', name: box.name }, value: String(value.result?.value ?? '').slice(0, 300), submitted, url: '', viaCdp: true };
}

async function cdpScroll(tabId: number, p: ActionParams): Promise<Record<string, unknown>> {
  const direction = String(p.direction || 'down');
  const amount = Number(p.amount) || 0.85;
  if (p.ref !== undefined && p.ref !== '') {
    const box = await cdpPoint(tabId, p);
    if (box) await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 0 });
  }
  const metrics = (await cdp(tabId, 'Runtime.evaluate', {
    expression: '({ h: innerHeight, y: scrollY, max: document.documentElement.scrollHeight })',
    returnByValue: true,
  })) as { result?: { value?: { h: number; y: number; max: number } } };
  const m = metrics.result?.value ?? { h: 800, y: 0, max: 800 };
  const delta =
    direction === 'top' ? -m.max : direction === 'bottom' ? m.max : Math.round(m.h * amount) * (direction === 'up' ? -1 : 1);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(m.h / 2),
    y: Math.round(m.h / 2),
    deltaX: 0,
    deltaY: delta,
  });
  await sleep(150);
  const after = (await cdp(tabId, 'Runtime.evaluate', {
    expression: `({ y: Math.round(scrollY), max: Math.max(1, document.documentElement.scrollHeight - innerHeight) })`,
    returnByValue: true,
  })) as { result?: { value?: { y: number; max: number } } };
  const a = after.result?.value ?? { y: 0, max: 1 };
  return {
    scrollY: a.y,
    scrollHeight: m.max,
    atBottom: a.y >= a.max - 4,
    atTop: a.y <= 4,
    pct: Math.round((a.y / a.max) * 100),
  };
}

async function cdpHover(tabId: number, p: ActionParams): Promise<Record<string, unknown>> {
  const box = await cdpPoint(tabId, p);
  if (!box) throw new Error('element not found');
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(150);
  return { hovered: { role: 'element', name: box.name }, viaCdp: true };
}

async function cdpScreenshot(tabId: number): Promise<string> {
  const res = (await cdp(tabId, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })) as { data?: string } | undefined;
  if (!res?.data) throw new Error('no screenshot data');
  return `data:image/png;base64,${res.data}`;
}

/* ------------------------------------------------------------------ */
/* methods                                                             */
/* ------------------------------------------------------------------ */

const methods: Record<string, Method> = {
  async status(): Promise<StatusResult> {
    const { allowedOrigins, autoAllow, pendingOrigin } = await getSettings();
    const groups = await loadGroups();
    const tabs = await agentTabs();
    return {
      version: VERSION,
      connected: true,
      autoAllow,
      allowedOrigins,
      pendingOrigin,
      groups: Object.entries(groups).map(([windowId, groupId]) => ({ windowId: Number(windowId), groupId })),
      agentTabs: tabs.map(describeTab),
    };
  },

  async 'group.reset'() {
    const groups = await loadGroups();
    const byWindow = new Map<number, number[]>();
    for (const gid of Object.values(groups)) {
      try {
        const tabs = await chrome.tabs.query({ groupId: gid });
        for (const t of tabs) {
          if (t.id == null) continue;
          if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
          byWindow.get(t.windowId)!.push(t.id);
        }
      } catch {
        /* group gone */
      }
    }

    let closed = 0;
    for (const [windowId, tabIds] of byWindow) {
      if (!tabIds.length) continue;
      const total = (await chrome.tabs.query({ windowId })).length;
      try {
        if (tabIds.length >= total) {
          // Never leave a window empty: Chrome would close it under the user.
          const keep = tabIds[0]!;
          await chrome.tabs.update(keep, { url: 'about:blank' });
          try {
            await chrome.tabs.ungroup(keep);
          } catch {
            /* already ungrouped */
          }
          const rest = tabIds.slice(1);
          if (rest.length) await chrome.tabs.remove(rest);
          closed += rest.length;
        } else {
          await chrome.tabs.remove(tabIds);
          closed += tabIds.length;
        }
      } catch {
        try {
          await chrome.tabs.ungroup(tabIds);
        } catch {
          /* nothing to ungroup */
        }
      }
    }
    await saveGroups({});
    return { closed };
  },

  async 'tab.open'(p: ActionParams = {}) {
    const url = p.url || 'about:blank';
    await requireOrigin(url);
    const win = await chooseWindow();
    // What the user is reading right now. Chrome activates a tab that joins a
    // collapsed group (and on some builds even an inactive create switches the
    // visible tab), so the previous tab is restored explicitly below.
    const [beforeActive] = await chrome.tabs.query({ windowId: win.id, active: true });
    let gid = win.id == null ? null : await groupForWindow(win.id);
    // Background by default: the user keeps the tab they were reading.
    const tab = await chrome.tabs.create({ url, windowId: win.id, active: p.active === true });
    if (gid != null) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id!], groupId: gid });
      } catch {
        gid = null;
      }
    }
    if (gid == null) {
      gid = await chrome.tabs.group({ tabIds: [tab.id!], createProperties: { windowId: win.id } });
      try {
        await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
      } catch {
        /* group may already be gone */
      }
      const groups = await loadGroups();
      groups[win.id!] = gid;
      await saveGroups(groups);
    }
    if (p.active !== true && beforeActive?.id != null && beforeActive.id !== tab.id) {
      await chrome.tabs.update(beforeActive.id, { active: true }).catch(() => undefined);
    }
    const loaded = await waitForLoad(tab.id!, p.timeout ?? 20_000);
    const finalTab = loaded || (await chrome.tabs.get(tab.id!).catch(() => tab));
    if (p.url && p.url !== 'about:blank') {
      // A blocked origin is reported before the agent starts reading the page.
      await assertAllowed(finalTab);
    }
    return { ...describeTab(finalTab), groupId: gid };
  },

  async 'tab.list'(p: ActionParams = {}) {
    const tabs = await agentTabs();
    return { tabs: (p.all ? await chrome.tabs.query({}) : tabs).map(describeTab) };
  },

  async 'tab.activate'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await chrome.tabs.update(tab.id!, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    // Keep the group visible so the user can see what the agent is doing.
    try {
      const gid = await groupForWindow(tab.windowId);
      if (gid != null) await chrome.tabGroups.update(gid, { collapsed: false });
    } catch {
      /* group may be gone */
    }
    return describeTab(await chrome.tabs.get(tab.id!));
  },

  async 'tab.close'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    const total = (await chrome.tabs.query({ windowId: tab.windowId })).length;
    if (total <= 1) {
      // Closing the last tab would close the user's window. Blank it instead.
      await chrome.tabs.update(tab.id!, { url: 'about:blank' });
      try {
        await chrome.tabs.ungroup(tab.id!);
      } catch {
        /* already ungrouped */
      }
      return { closed: null, blanked: tab.id };
    }
    await chrome.tabs.remove(tab.id!);
    return { closed: tab.id };
  },

  /** Pulls a tab the user already has open into the agent group. */
  async 'tab.adopt'(p: ActionParams = {}) {
    let tab: chrome.tabs.Tab | undefined;
    if (p.tabId != null && (p.tabId as unknown) !== '') {
      tab = await chrome.tabs.get(Number(p.tabId));
    } else if (p.url) {
      const [found] = await chrome.tabs.query({ url: p.url });
      if (!found) throw fail('no_such_tab', `No open tab matching ${p.url}`);
      tab = found;
    } else {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) throw fail('no_such_tab', 'No active tab to adopt.');
    }
    if (tab.groupId != null && (await isAgentTab(tab))) return describeTab(tab);

    await requireOrigin(tab.url || tab.pendingUrl, { tabId: tab.id ?? null });

    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== 'normal') throw fail('bad_window', 'Only normal browser windows can host the agent group.');

    let gid = await groupForWindow(tab.windowId);
    if (gid != null) {
      await chrome.tabs.group({ tabIds: [tab.id!], groupId: gid });
    } else {
      gid = await chrome.tabs.group({ tabIds: [tab.id!], createProperties: { windowId: tab.windowId } });
      try {
        await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
      } catch {
        /* group may already be gone */
      }
      const groups = await loadGroups();
      groups[tab.windowId] = gid;
      await saveGroups(groups);
    }
    await assertAllowed(tab);
    return { ...describeTab(await chrome.tabs.get(tab.id!)), groupId: gid };
  },

  async 'tab.goto'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await requireOrigin(p.url, { tabId: tab.id ?? null });
    await chrome.tabs.update(tab.id!, { url: p.url! });
    const loaded = await waitForLoad(tab.id!, p.timeout ?? 20_000);
    const finalTab = loaded || (await chrome.tabs.get(tab.id!));
    await assertAllowed(finalTab);
    return describeTab(finalTab);
  },

  async 'tab.back'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await chrome.tabs.goBack(tab.id!);
    const loaded = await waitForLoad(tab.id!, p.timeout ?? 15_000);
    return describeTab(loaded || (await chrome.tabs.get(tab.id!)));
  },

  async 'tab.forward'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await chrome.tabs.goForward(tab.id!);
    const loaded = await waitForLoad(tab.id!, p.timeout ?? 15_000);
    return describeTab(loaded || (await chrome.tabs.get(tab.id!)));
  },

  async 'tab.reload'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await chrome.tabs.reload(tab.id!, { bypassCache: !!p.hard });
    const loaded = await waitForLoad(tab.id!, p.timeout ?? 20_000);
    return describeTab(loaded || (await chrome.tabs.get(tab.id!)));
  },

  async 'page.snapshot'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage<SnapshotResult>(tab, 'snapshot', p);
  },

  async 'page.click'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    // CDP is the default path: trusted input, no activation. --click-only keeps
    // the in-page synthetic path (when only one event type should fire) and
    // --no-cdp forces it entirely.
    const wantCdp = !p.noCdp && !p.clickOnly;
    if (wantCdp) {
      try {
        return await cdpClick(tab.id!, p);
      } catch {
        // debugger refused (devtools open, restricted page): fall back.
      }
    }
    return callPage(tab, 'click', p);
  },

  async 'page.type'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    if (p.noCdp) return callPage(tab, 'type', p);
    try {
      return await cdpType(tab.id!, p);
    } catch {
      return callPage(tab, 'type', p);
    }
  },

  async 'page.key'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    const combo = String(p.keys || p.key || '');
    if (!combo) throw fail('bad_request', 'Provide keys, e.g. "Enter", "Escape", "Meta+a".');
    try {
      if (p.ref !== undefined || p.selector) {
        const box = await cdpPoint(tab.id!, p);
        if (box) {
          await cdp(tab.id!, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1,
          });
          await cdp(tab.id!, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1,
          });
        }
      }
      await pressKey(tab.id!, combo);
      await sleep(120);
      return { key: combo, handled: 'cdp', submitted: combo === 'Enter' || undefined };
    } catch {
      return callPage(tab, 'key', p);
    }
  },

  async 'page.scroll'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    if (p.noCdp) return callPage(tab, 'scroll', p);
    try {
      return await cdpScroll(tab.id!, p);
    } catch {
      return callPage(tab, 'scroll', p);
    }
  },

  async 'page.hover'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    if (p.noCdp) return callPage(tab, 'hover', p);
    try {
      return await cdpHover(tab.id!, p);
    } catch {
      return callPage(tab, 'hover', p);
    }
  },

  async 'page.select'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'select', p);
  },

  async 'page.wait'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'wait', p);
  },

  async 'page.find'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'find', p);
  },

  async 'page.text'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'text', p);
  },

  async 'page.links'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'links', p);
  },

  async 'page.query'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'query', p);
  },

  /** Escape hatch: run JS in the page. Tries the page's own world first, then
   *  the content-script world (needed on sites with a strict CSP). */
  async 'page.eval'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    if (!p.expression) throw fail('bad_request', 'page.eval needs an expression');
    // The debugger's Runtime.evaluate is not subject to the page's Trusted
    // Types or CSP, so it works on Google properties where injected eval fails.
    if (!p.noCdp) try {
      const res = (await cdp(tab.id!, 'Runtime.evaluate', {
        expression: String(p.expression),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluation failed');
      return { value: res.result?.value, world: 'page' };
    } catch {
      /* fall through to the injected path */
    }
    await ensureInjected(tab.id!);

    type EvalResult = { ok: boolean; value?: unknown; error?: string };

    const inject = async (world: 'MAIN' | 'ISOLATED'): Promise<EvalResult | undefined> => {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        world,
        args: [String(p.expression)],
        func: (expression: string) => {
          try {
            // eslint-disable-next-line no-eval
            const value = eval(expression);
            let json: unknown;
            try {
              json = JSON.parse(
                JSON.stringify(value, (_k, v) => (typeof v === 'function' ? `[Function ${v.name || 'anonymous'}]` : v)),
              );
            } catch {
              json = String(value);
            }
            return { ok: true, value: json === undefined ? String(value) : json };
          } catch (e) {
            return { ok: false, error: String(e && (e as Error).message ? (e as Error).message : e) };
          }
        },
      });
      return frames?.[0]?.result as EvalResult | undefined;
    };

    // Two different walls send us to the isolated world: a CSP without
    // unsafe-eval, and Trusted Types on the document (Google properties set
    // require-trusted-types-for 'script').
    const blocked = (msg: string) =>
      /Content Security Policy|unsafe-eval|Trusted Type/i.test(msg);

    let out: EvalResult | undefined;
    let world: 'MAIN' | 'ISOLATED' = 'MAIN';
    try {
      out = await inject('MAIN');
      if (out && !out.ok && blocked(out.error || '')) {
        world = 'ISOLATED';
        out = await inject('ISOLATED');
      }
    } catch (e) {
      throw fail('restricted_page', (e as Error).message);
    }
    if (!out) throw fail('eval_failed', 'No result from page');
    if (!out.ok) {
      if (blocked(out.error || '')) {
        throw fail(
          'eval_blocked',
          `The page blocks eval (${out.error}). page.eval cannot run here; use snapshot, text, find, links or query instead.`,
        );
      }
      throw fail('eval_failed', out.error || 'evaluation failed');
    }
    return { value: out.value, world: world === 'MAIN' ? 'page' : 'isolated' };
  },

  async 'page.screenshot'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    await sleep(p.delayMs ?? 250);
    let meta: unknown = {};
    try {
      meta = await callPage(tab, 'viewport', {});
    } catch {
      /* viewport is nice to have */
    }

    // Prefer the debugger: CDP screenshots capture a background tab without
    // switching the visible one at all (the technique Playwright and browser-use
    // rely on). captureVisibleTab is the fallback, and it does need the tab
    // active, so there we borrow it and hand it straight back.
    try {
      const dataUrl = await cdpScreenshot(tab.id!);
      return { dataUrl, url: tab.url, title: tab.title, ...(meta as object) };
    } catch {
      const [previous] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      const borrowed = previous?.id !== tab.id;
      if (borrowed) await chrome.tabs.update(tab.id!, { active: true });
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        return { dataUrl, url: tab.url, title: tab.title, ...(meta as object) };
      } finally {
        if (borrowed && previous?.id != null) {
          await chrome.tabs.update(previous.id, { active: true }).catch(() => undefined);
        }
      }
    }
  },

  async 'policy.get'() {
    const { allowedOrigins, autoAllow, pendingOrigin } = await getSettings();
    return { allowedOrigins, autoAllow, pendingOrigin };
  },

  /** Creates a pending request the user answers in the popup. */
  async 'policy.request'(p: ActionParams = {}) {
    const origin = p.origin || originOf(p.url || '');
    if (!origin) throw fail('bad_request', 'policy.request needs an origin');
    await chrome.storage.local.set({ pendingOrigin: { origin, url: p.url || '', at: Date.now() } });
    await paintBadge();
    return { pending: origin };
  },
};

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

function send(obj: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }
}

async function paintBadge(): Promise<void> {
  const { pendingOrigin } = await getSettings().catch(() => ({ pendingOrigin: null }));
  try {
    if (pendingOrigin) {
      await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setTitle({ title: `Browser Bridge - ${pendingOrigin.origin} is waiting for permission` });
    } else if (connected) {
      await chrome.action.setBadgeBackgroundColor({ color: '#6d28d9' });
      await chrome.action.setBadgeText({ text: '•' });
      await chrome.action.setTitle({ title: 'Browser Bridge - connected' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Browser Bridge - daemon not running' });
    }
  } catch {
    /* badge is cosmetic */
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 1.7, 5000);
  reconnectTimer = setTimeout(connect, delay);
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    connected = true;
    backoffMs = 700;
    send({ type: 'hello', version: VERSION, ua: navigator.userAgent, extensionId: chrome.runtime.id });
    void paintBadge();
  };
  socket.onmessage = (ev: MessageEvent<string>) => {
    let msg: { type?: string; id?: string; method?: string; params?: ActionParams };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (msg.type === 'cmd' && msg.id) {
      inflight++;
      void handleCommand({ id: msg.id, method: msg.method || '', params: msg.params }).finally(() => {
        inflight--;
      });
    }
  };
  socket.onclose = () => {
    connected = false;
    socket = null;
    void paintBadge();
    scheduleReconnect();
  };
  socket.onerror = () => {
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  };
}

async function handleCommand({ id, method, params }: { id: string; method: string; params?: ActionParams }): Promise<void> {
  const started = Date.now();
  try {
    const fn = methods[method];
    if (!fn) throw fail('unknown_method', `Unknown method "${method}"`);
    const result = await fn(params || {});
    send({ type: 'result', id, ok: true, result, ms: Date.now() - started });
  } catch (e) {
    const err = e as BridgeError;
    send({
      type: 'result',
      id,
      ok: false,
      error: { code: err.code || 'error', message: err.message || String(e) },
      ms: Date.now() - started,
    });
  }
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('reconnect', { periodInMinutes: 1 });
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('reconnect', { periodInMinutes: 1 });
  connect();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'reconnect') connect();
});
// Any extension event is a chance to make sure the socket is up.
chrome.tabs.onUpdated.addListener(() => {
  if (!connected) connect();
});

interface PopupMessage {
  type?: string;
  origin?: string;
  value?: boolean;
}

chrome.runtime.onMessage.addListener((msg: PopupMessage, _sender, respond: (r: unknown) => void) => {
  void (async () => {
    if (msg?.type === 'state') {
      const { allowedOrigins, autoAllow, pendingOrigin } = await getSettings();
      const tabs = await agentTabs();
      respond({
        connected,
        version: VERSION,
        allowedOrigins,
        autoAllow,
        pendingOrigin,
        tabs: tabs.map(describeTab),
      });
      return;
    }
    if (msg?.type === 'allow' || msg?.type === 'revoke') {
      const { allowedOrigins } = await getSettings();
      const list = new Set(allowedOrigins);
      if (msg.type === 'allow' && msg.origin) list.add(msg.origin);
      else if (msg.origin) list.delete(msg.origin);
      await chrome.storage.local.set({ allowedOrigins: [...list], pendingOrigin: null });
      await paintBadge();
      respond({ ok: true, allowedOrigins: [...list] });
      return;
    }
    if (msg?.type === 'dismiss-pending') {
      await chrome.storage.local.set({ pendingOrigin: null });
      await paintBadge();
      respond({ ok: true });
      return;
    }
    if (msg?.type === 'auto') {
      await chrome.storage.local.set({ autoAllow: !!msg.value });
      await paintBadge();
      respond({ ok: true });
      return;
    }
    if (msg?.type === 'reset-group') {
      try {
        const out = await methods['group.reset']!({});
        respond({ ok: true, ...(out as object) });
      } catch (e) {
        respond({ ok: false, error: (e as Error).message });
      }
      return;
    }
    if (msg?.type === 'open-agent-tab') {
      const out = (await methods['tab.open']!({ url: 'https://example.com' }).catch((e: Error) => ({
        error: e.message,
      }))) as Record<string, unknown>;
      respond({ ok: !out.error, ...out });
      return;
    }
    respond({ ok: false, error: 'unknown message' });
  })();
  return true;
});

connect();
void paintBadge();
