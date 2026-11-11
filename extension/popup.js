'use strict';

const $ = (id) => document.getElementById(id);

function normalizeOrigin(input) {
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

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
}

async function refresh() {
  const state = await send({ type: 'state' });
  render(state);
}

function render(state) {
  const connected = !!state.connected;
  const pill = $('status');
  pill.textContent = connected ? 'connected' : 'offline';
  pill.className = `pill ${connected ? 'on' : 'off'}`;
  $('subtitle').textContent = connected
    ? `v${state.version} · daemon 127.0.0.1:8737`
    : 'daemon not running · chromectl daemon start';

  const pending = state.pendingOrigin;
  const pendingCard = $('pending');
  pendingCard.hidden = !pending;
  if (pending) {
    $('pendingOrigin').textContent = pending.origin;
    $('pendingUrl').textContent = pending.url || '';
  }

  const tabs = state.tabs || [];
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
          refresh();
        });
        return el('li', {}, el('span', { title: origin }, origin), remove);
      }),
    );
  }

  $('autoAllow').checked = !!state.autoAllow;
}

$('allowBtn').addEventListener('click', async () => {
  const origin = $('pendingOrigin').textContent;
  await send({ type: 'allow', origin });
  refresh();
});

$('denyBtn').addEventListener('click', async () => {
  await send({ type: 'dismiss-pending' });
  refresh();
});

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const origin = normalizeOrigin($('addInput').value);
  if (!origin) {
    $('addInput').setCustomValidity('Enter a site like example.com');
    $('addInput').reportValidity();
    return;
  }
  await send({ type: 'allow', origin });
  $('addInput').value = '';
  refresh();
});

$('autoAllow').addEventListener('change', async (e) => {
  await send({ type: 'auto', value: e.target.checked });
  refresh();
});

$('resetBtn').addEventListener('click', async () => {
  $('resetBtn').textContent = 'closing…';
  await send({ type: 'reset-group' });
  $('resetBtn').textContent = 'Close all';
  refresh();
});

$('helpBtn').addEventListener('click', () => {
  const panel = $('help');
  panel.hidden = !panel.hidden;
  $('helpBtn').textContent = panel.hidden ? 'How it works' : 'Hide';
});

$('addInput').addEventListener('input', (e) => e.target.setCustomValidity(''));

refresh();
setInterval(refresh, 2000);
