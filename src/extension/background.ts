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

const VERSION = '1.1.0';
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
  return (await chrome.storage.local.get({
    allowedOrigins: [],
    autoAllow: false,
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
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
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
    const tab = await resolveTab(p);
    return callPage(tab, 'click', p);
  },

  async 'page.type'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'type', p);
  },

  async 'page.key'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'key', p);
  },

  async 'page.scroll'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'scroll', p);
  },

  async 'page.hover'(p: ActionParams = {}) {
    const tab = await resolveTab(p);
    return callPage(tab, 'hover', p);
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

    let out: EvalResult | undefined;
    let world: 'MAIN' | 'ISOLATED' = 'MAIN';
    try {
      out = await inject('MAIN');
      if (out && !out.ok && /Content Security Policy|unsafe-eval/i.test(out.error || '')) {
        world = 'ISOLATED';
        out = await inject('ISOLATED');
      }
    } catch (e) {
      throw fail('restricted_page', (e as Error).message);
    }
    if (!out) throw fail('eval_failed', 'No result from page');
    if (!out.ok) {
      if (/Content Security Policy|unsafe-eval/i.test(out.error || '')) {
        throw fail(
          'eval_blocked',
          "This site's Content-Security-Policy blocks eval, so page.eval cannot run here. Use snapshot, text, find, links or query instead.",
        );
      }
      throw fail('eval_failed', out.error || 'evaluation failed');
    }
    return { value: out.value, world: world === 'MAIN' ? 'page' : 'isolated' };
  },

  async 'page.screenshot'(p: ActionParams = {}) {
    const tab = await resolveTab(p, { page: false });
    await assertAllowed(tab);
    // captureVisibleTab only sees the *active* tab of a window, so the tab is
    // borrowed for the length of the capture and then handed back to whatever
    // the user was reading. Window focus is left alone unless it was lost.
    const [previous] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    const borrowed = previous?.id !== tab.id;
    if (borrowed) await chrome.tabs.update(tab.id!, { active: true });
    if (borrowed && !(await chrome.windows.get(tab.windowId)).focused) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* window may be gone */
      }
    }
    await sleep(p.delayMs ?? 250);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      let meta: unknown = {};
      try {
        meta = await callPage(tab, 'viewport', {});
      } catch {
        /* viewport is nice to have */
      }
      return { dataUrl, url: tab.url, title: tab.title, ...(meta as object) };
    } finally {
      if (borrowed && previous?.id != null) {
        await chrome.tabs.update(previous.id, { active: true }).catch(() => undefined);
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
