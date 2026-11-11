'use strict';

import type { StatusResult, TabDescriptor } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function normalizeOrigin(input: string): string | null {
  let value = String(input || '').trim();
  if (!value) return null;
  if (value === 'localhost' || /^localhost:/.test(value) || /^127\.0\.0\.1(:\d+)?$/.test(value)) {
    value = `http://${value}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function send(msg: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r: Record<string, any>) => resolve(r || {})));
}

async function refresh(): Promise<void> {
  const state = (await send({ type: 'state' })) as unknown as StatusResult;
  render(state);
}

function render(state: StatusResult): void {
  const connected = !!state.connected;
  const pill = $('status');
  pill.textContent = connected ? 'connected' : 'offline';
  pill.className = `pill ${connected ? 'on' : 'off'}`;
  $('subtitle').textContent = connected ? `v${state.version} · daemon 127.0.0.1:8737` : 'daemon not running · chromectl daemon start';

  const pending = state.pendingOrigin;
  const pendingCard = $('pending');
  pendingCard.hidden = !pending;
  if (pending) {
    $('pendingOrigin').textContent = pending.origin;
    $('pendingUrl').textContent = pending.url || '';
  }

  const tabs: TabDescriptor[] = state.tabs || [];
  $('tabsLine').textContent = tabs.length
    ? `${tabs.length} tab${tabs.length === 1 ? '' : 's'} in the agent group`
    : 'no tabs - the agent opens its own';
  const tabList = $('tabList');
  tabList.replaceChildren(
    ...tabs.slice(0, 6).map((t) =>
      el('li', { title: t.url }, el('span', { className: 't' }, t.title || '(untitled)'), el('span', { className: 'u' }, t.url)),
    ),
  );

  const allowed = state.allowedOrigins || [];
  $('allowedCount').textContent = allowed.length ? `${allowed.length}` : '';
  const list = $('allowedList');
  if (!allowed.length) {
    list.replaceChildren(el('li', {}, el('span', { className: 'empty' }, 'No sites allowed yet')));
  } else {
    list.replaceChildren(
      ...allowed.map((origin) => {
        const remove = el('button', { className: 'x', title: `Block ${origin}`, textContent: '×' });
        remove.addEventListener('click', async () => {
          await send({ type: 'revoke', origin });
          await refresh();
        });
        return el('li', {}, el('span', { title: origin }, origin), remove);
      }),
    );
  }

  ($('autoAllow') as HTMLInputElement).checked = !!state.autoAllow;
}

$('allowBtn').addEventListener('click', async () => {
  const origin = $('pendingOrigin').textContent;
  await send({ type: 'allow', origin });
  await refresh();
});

$('denyBtn').addEventListener('click', async () => {
  await send({ type: 'dismiss-pending' });
  await refresh();
});

($('addForm') as HTMLFormElement).addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('addInput') as HTMLInputElement;
  const origin = normalizeOrigin(input.value);
  if (!origin) {
    input.setCustomValidity('Enter a site like example.com');
    input.reportValidity();
    return;
  }
  await send({ type: 'allow', origin });
  input.value = '';
  await refresh();
});

($('autoAllow') as HTMLInputElement).addEventListener('change', async (e) => {
  await send({ type: 'auto', value: (e.target as HTMLInputElement).checked });
  await refresh();
});

$('resetBtn').addEventListener('click', async () => {
  $('resetBtn').textContent = 'closing…';
  await send({ type: 'reset-group' });
  $('resetBtn').textContent = 'Close all';
  await refresh();
});

$('helpBtn').addEventListener('click', () => {
  const panel = $('help');
  panel.hidden = !panel.hidden;
  $('helpBtn').textContent = panel.hidden ? 'How it works' : 'Hide';
});

($('addInput') as HTMLInputElement).addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity(''));

void refresh();
setInterval(() => void refresh(), 2000);
