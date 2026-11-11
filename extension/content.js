/**
 * Browser Bridge - page agent (isolated world content script).
 *
 * Injected on demand by the service worker. Exposes a tiny RPC surface:
 *   snapshot / click / type / key / scroll / hover / select / wait / find /
 *   text / links / viewport
 *
 * Refs ([12]) are written onto elements as data-bb-ref and are only valid
 * until the next snapshot or navigation.
 */
(() => {
  if (window.__bbInstalled) return;
  window.__bbInstalled = true;

  const REF = 'data-bb-ref';
  const MAX_ELEMENTS = 500;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => {
    const t = collapse(s);
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  const CANDIDATES = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'details',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="treeitem"]',
    '[role="row"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'img[alt]',
    'label',
  ].join(',');

  /* ---------------------------------------------------------------- */
  /* element inspection                                               */
  /* ---------------------------------------------------------------- */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return true;
  }

  function labelText(el) {
    const aria = el.getAttribute('aria-labelledby');
    if (aria) {
      const txt = aria
        .split(/\s+/)
        .map((id) => collapse(document.getElementById(id)?.innerText))
        .filter(Boolean)
        .join(' ');
      if (txt) return txt;
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return collapse(lbl.innerText);
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping !== el) return collapse(wrapping.innerText);
    return '';
  }

  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (aria && collapse(aria)) return clip(aria, 120);
    const labelled = labelText(el);
    if (labelled) return clip(labelled, 120);
    if (tag === 'img') return clip(el.getAttribute('alt'), 120);
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type)) return clip(el.value, 120);
      if (type === 'image') return clip(el.alt || el.value, 120);
      return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 120);
    }
    const txt = collapse(el.innerText || el.textContent);
    if (txt) return clip(txt, 120);
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '', 120);
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'button') return 'button';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return `heading${tag[1]}`;
    if (tag === 'img') return 'image';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'label') return 'label';
    if (tag === 'details') return 'disclosure';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      const map = {
        checkbox: 'checkbox',
        radio: 'radio',
        submit: 'button',
        button: 'button',
        reset: 'button',
        image: 'button',
        file: 'file',
        range: 'slider',
        color: 'color',
        hidden: 'hidden',
      };
      return map[type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'button';
    return tag;
  }

  function isInteresting(el, role) {
    if (role === 'hidden') return false;
    if (role === 'label') return false;
    if (role.startsWith('heading') || role === 'image') return !!nameOf(el);
    if (el.matches('input,select,textarea,[contenteditable=""],[contenteditable="true"]')) return true;
    return !!nameOf(el) || role === 'button' || role === 'link';
  }

  function stateOf(el) {
    const bits = [];
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (tag === 'input' || role === 'checkbox' || role === 'switch') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'switch') {
        const on = el.checked ?? el.getAttribute('aria-checked') === 'true';
        bits.push(on ? 'checked' : 'unchecked');
      }
    }
    if (el.required || el.getAttribute('aria-required') === 'true') bits.push('required');
    if (el.expanded !== undefined) bits.push(el.expanded ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-expanded')) bits.push(`aria-expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-pressed')) bits.push(`pressed=${el.getAttribute('aria-pressed')}`);
    if (el.getAttribute('aria-selected') === 'true') bits.push('selected');
    if (el.readOnly) bits.push('readonly');
    return bits;
  }

  function valueOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const opts = [...el.selectedOptions].map((o) => collapse(o.textContent));
      return opts.join(' / ');
    }
    if (tag === 'input' && (el.type || '').toLowerCase() === 'checkbox') return '';
    if (tag === 'input' || tag === 'textarea') return clip(el.value, 160);
    if (el.isContentEditable) return clip(el.innerText, 160);
    return '';
  }

  function hrefOf(el) {
    if (el.tagName.toLowerCase() !== 'a') return '';
    const href = el.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:')) return '';
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  }

  /* ---------------------------------------------------------------- */
  /* snapshot                                                         */
  /* ---------------------------------------------------------------- */

  function snapshot(p = {}) {
    const maxEls = Math.min(Number(p.maxElements) || 300, MAX_ELEMENTS);
    const includeText = p.text !== false;
    const textLimit = Math.min(Number(p.textLength) || 2000, 20000);

    document.querySelectorAll(`[${REF}]`).forEach((el) => el.removeAttribute(REF));

    const seen = new Set();
    const elements = [];
    let ref = 0;

    for (const el of document.querySelectorAll(CANDIDATES)) {
      if (ref >= maxEls) break;
      if (seen.has(el)) continue;
      seen.add(el);
      const role = roleOf(el);
      if (!isInteresting(el, role)) continue;
      if (!isVisible(el)) continue;

      const id = String(ref++);
      el.setAttribute(REF, id);
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;

      elements.push({
        ref: Number(id),
        role,
        name: nameOf(el),
        value: valueOf(el),
        href: hrefOf(el),
        state: stateOf(el),
        inViewport: inView,
        tag: el.tagName.toLowerCase(),
        bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      });
    }

    const lines = elements.map((e) => {
      const parts = [`[${e.ref}]`, e.role, JSON.stringify(e.name || '')];
      if (e.value) parts.push(`value=${JSON.stringify(e.value)}`);
      if (e.href) parts.push(`href=${e.href}`);
      if (e.state.length) parts.push(e.state.join(' '));
      if (!e.inViewport) parts.push('(offscreen)');
      return parts.join(' ');
    });

    const scrollable = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const pct = scrollable ? Math.round((scrollY / scrollable) * 100) : 0;

    const result = {
      url: location.href,
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        scrollY: Math.round(scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        scrollPct: pct,
      },
      summary: {
        links: document.querySelectorAll('a[href]').length,
        inputs: document.querySelectorAll('input,textarea,select,[contenteditable="true"]').length,
        forms: document.forms.length,
        iframes: document.querySelectorAll('iframe').length,
        images: document.images.length,
        truncated: ref >= maxEls,
      },
      elements,
      lines,
      text: includeText ? clip(document.body?.innerText || '', textLimit) : '',
    };
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* element lookup                                                   */
  /* ---------------------------------------------------------------- */

  function find(p = {}) {
    if (p.ref !== undefined && p.ref !== null && p.ref !== '') {
      const el = document.querySelector(`[${REF}="${CSS.escape(String(p.ref))}"]`);
      if (!el) {
        throw new Error(
          `Element [${p.ref}] is gone (page changed since the snapshot). Take a fresh snapshot.`,
        );
      }
      return el;
    }
    if (p.selector) {
      const list = document.querySelectorAll(p.selector);
      if (!list.length) throw new Error(`No element matches selector "${p.selector}"`);
      const el = list[Number(p.index) || 0];
      if (!el) throw new Error(`Selector "${p.selector}" matched ${list.length} elements; index out of range`);
      return el;
    }
    if (p.text) {
      const needle = collapse(p.text).toLowerCase();
      const nodes = document.querySelectorAll('a,button,[role="button"],[role="link"],label,h1,h2,h3,h4');
      let partial = null;
      for (const el of nodes) {
        const text = collapse(el.innerText).toLowerCase();
        if (text === needle) return el;
        if (!partial && text.includes(needle)) partial = el;
      }
      if (partial) return partial;
      throw new Error(`No clickable element whose text contains "${p.text}"`);
    }
    throw new Error('Provide a ref (from a snapshot), a selector, or text.');
  }

  function describeEl(el) {
    return { role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase() };
  }

  /* ---------------------------------------------------------------- */
  /* actions                                                          */
  /* ---------------------------------------------------------------- */

  async function click(p = {}) {
    const el = find(p);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(60);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      detail: 1,
    };
    const beforeUrl = location.href;
    try {
      el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    } catch (e) {
      // Some elements reject synthetic pointer events; fall back to .click().
      if (typeof el.click === 'function') el.click();
      else throw e;
    }
    await sleep(p.waitMs ?? 300);
    return {
      clicked: describeEl(el),
      url: location.href,
      navigated: location.href !== beforeUrl,
      title: document.title,
    };
  }

  async function hover(p = {}) {
    const el = find(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(50);
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      pointerId: 1,
      pointerType: 'mouse',
    };
    el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 }));
    await sleep(200);
    return { hovered: describeEl(el) };
  }

  async function type(p = {}) {
    const el = find(p);
    const text = String(p.text ?? '');
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (typeof el.focus === 'function') el.focus();
    await sleep(30);

    const isField = el.matches('input,textarea');
    if (p.clear !== false) {
      if (isField && typeof el.select === 'function') {
        el.select();
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    if (p.slow) {
      // Per-character input, for autocomplete / typeahead widgets.
      for (const ch of text) {
        if (!document.execCommand('insertText', false, ch)) {
          el.value = (el.value || '') + ch;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        }
        await sleep(Number(p.slow) || 60);
      }
    } else {
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        if (isField) {
          const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
        } else if (el.isContentEditable) {
          el.textContent = text;
        } else {
          el.value = text;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);

    let submitted = false;
    if (p.submit) {
      submitted = await submitEl(el);
    }

    return {
      typed: describeEl(el),
      value: isField ? clip(el.value, 300) : clip(el.innerText, 300),
      submitted,
      url: location.href,
    };
  }

  async function submitEl(el) {
    const form = el.form || el.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        await sleep(200);
        return true;
      }
      form.submit();
      await sleep(200);
      return true;
    }
    const target = el || document.activeElement || document.body;
    const ev = { bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    target.dispatchEvent(new KeyboardEvent('keydown', ev));
    target.dispatchEvent(new KeyboardEvent('keypress', ev));
    target.dispatchEvent(new KeyboardEvent('keyup', ev));
    await sleep(200);
    return false;
  }

  const KEY_CODES = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Esc: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
    Space: 32,
  };

  function focusables() {
    return [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')].filter(
      (el) => !el.disabled && isVisible(el),
    );
  }

  async function key(p = {}) {
    const combo = String(p.keys || p.key || '');
    if (!combo) throw new Error('Provide keys, e.g. "Enter", "Escape", "Meta+a", "Shift+Tab".');
    const parts = combo.split('+').map((s) => s.trim());
    const rawKey = parts.pop();
    const keyName = rawKey === 'Space' ? ' ' : rawKey;
    const mods = new Set(parts.map((s) => s.toLowerCase()));
    const ev = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: keyName,
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      keyCode: KEY_CODES[keyName] || (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0),
      which: KEY_CODES[keyName] || (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0),
      altKey: mods.has('alt'),
      ctrlKey: mods.has('ctrl') || mods.has('control'),
      metaKey: mods.has('meta') || mods.has('cmd') || mods.has('command'),
      shiftKey: mods.has('shift'),
    };
    const mod = ev.ctrlKey || ev.metaKey;

    let el = p.ref !== undefined || p.selector ? find(p) : document.activeElement || document.body;
    if (typeof el.focus === 'function') el.focus();

    // Synthetic events cannot trigger native browser shortcuts, so cover the
    // ones an agent actually needs.
    if (mod && keyName.toLowerCase() === 'a') {
      if (el.matches?.('input,textarea')) el.select();
      else document.execCommand('selectAll', false, null);
      return { key: combo, handled: 'select-all' };
    }
    if (keyName === 'Tab') {
      const list = focusables();
      const i = list.indexOf(document.activeElement);
      const next = list[(i + (ev.shiftKey ? -1 : 1) + list.length) % list.length];
      if (next) next.focus();
      return { key: combo, handled: 'focus', focused: describeEl(document.activeElement) };
    }
    if (keyName === 'Enter') {
      const submitted = await submitEl(el);
      el.dispatchEvent(new KeyboardEvent('keydown', ev));
      el.dispatchEvent(new KeyboardEvent('keypress', ev));
      el.dispatchEvent(new KeyboardEvent('keyup', ev));
      return { key: combo, handled: 'enter', submitted, url: location.href };
    }
    if (keyName === 'Escape') {
      el.dispatchEvent(new KeyboardEvent('keydown', ev));
      el.dispatchEvent(new KeyboardEvent('keyup', ev));
      try {
        el.blur();
      } catch {}
      return { key: combo, handled: 'escape' };
    }

    el.dispatchEvent(new KeyboardEvent('keydown', ev));
    el.dispatchEvent(new KeyboardEvent('keypress', ev));
    el.dispatchEvent(new KeyboardEvent('keyup', ev));
    await sleep(120);
    return { key: combo };
  }

  async function scroll(p = {}) {
    const mode = String(p.direction || p.to || 'down');
    if (p.ref !== undefined && p.ref !== '') {
      const el = find(p);
      el.scrollIntoView({ block: p.block || 'center', behavior: 'instant' });
    } else if (mode === 'top') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else if (mode === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    } else if (mode === 'up') {
      window.scrollBy({ top: -Math.round(innerHeight * (p.amount || 0.85)), behavior: 'instant' });
    } else {
      window.scrollBy({ top: Math.round(innerHeight * (p.amount || 0.85)), behavior: 'instant' });
    }
    await sleep(150);
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return {
      scrollY: Math.round(scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      atBottom: scrollY >= max - 4,
      atTop: scrollY <= 4,
      pct: max ? Math.round((scrollY / max) * 100) : 100,
    };
  }

  async function select(p = {}) {
    const el = find(p);
    if (el.tagName.toLowerCase() !== 'select') throw new Error('Target is not a <select> element');
    const wanted = new Set((Array.isArray(p.values) ? p.values : [p.value]).flat().map((v) => collapse(v).toLowerCase()));
    const picked = [];
    for (const opt of el.options) {
      const matches = wanted.has(collapse(opt.value).toLowerCase()) || wanted.has(collapse(opt.textContent).toLowerCase());
      if (matches) {
        opt.selected = true;
        picked.push(collapse(opt.textContent));
      } else if (!el.multiple) {
        opt.selected = false;
      }
    }
    if (!picked.length) {
      const available = [...el.options].slice(0, 25).map((o) => collapse(o.textContent));
      throw new Error(`No option matched. Options: ${available.join(' | ')}`);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    return { selected: picked };
  }

  async function wait(p = {}) {
    const timeout = Math.min(Number(p.timeout) || 10000, 25000);
    const start = Date.now();
    const interval = 120;
    while (Date.now() - start < timeout) {
      if (p.selector) {
        const el = document.querySelector(p.selector);
        if (p.gone ? !el : el) return { found: !p.gone, selector: p.selector, ms: Date.now() - start };
      }
      if (p.text) {
        const has = collapse(document.body?.innerText || '').toLowerCase().includes(collapse(p.text).toLowerCase());
        if (p.gone ? !has : has) return { found: !p.gone, text: p.text, ms: Date.now() - start };
      }
      if (p.url) {
        const has = location.href.includes(p.url);
        if (p.gone ? !has : has) return { found: !p.gone, url: location.href, ms: Date.now() - start };
      }
      if (p.idle && document.readyState === 'complete') {
        return { found: true, idle: true, ms: Date.now() - start };
      }
      await sleep(interval);
    }
    return { found: false, timedOut: true, ms: Date.now() - start, url: location.href, title: document.title };
  }

  function find_text(p = {}) {
    const q = collapse(p.query || p.text || '').toLowerCase();
    if (!q) throw new Error('Provide query text');
    const limit = Math.min(Number(p.limit) || 10, 50);
    const matches = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && matches.length < limit) {
      const raw = node.nodeValue || '';
      const idx = raw.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) continue;
      const before = collapse(raw.slice(Math.max(0, idx - 60), idx));
      const after = collapse(raw.slice(idx + q.length, idx + q.length + 60));
      const refEl = parent.closest(`[${REF}]`);
      matches.push({
        context: `${before}[${raw.slice(idx, idx + q.length)}]${after}`,
        ref: refEl ? Number(refEl.getAttribute(REF)) : null,
        tag: parent.tagName.toLowerCase(),
      });
    }
    return { query: p.query, count: matches.length, matches };
  }

  function text(p = {}) {
    const limit = Math.min(Number(p.limit) || 8000, 60000);
    return { url: location.href, title: document.title, text: clip(document.body?.innerText || '', limit) };
  }

  function links(p = {}) {
    const limit = Math.min(Number(p.limit) || 150, 1000);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (out.length >= limit) break;
      if (!isVisible(a)) continue;
      const href = hrefOf(a);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ url: href, text: clip(a.innerText || a.getAttribute('aria-label') || '', 100) });
    }
    return { url: location.href, links: out };
  }

  /** Structured alternative to eval on sites whose CSP blocks it. */
  function query(p = {}) {
    if (!p.selector) throw new Error('query needs a selector');
    const limit = Math.min(Number(p.limit) || 40, 500);
    const attrNames = Array.isArray(p.attrs)
      ? p.attrs
      : ['id', 'class', 'name', 'type', 'role', 'aria-label', 'href', 'data-testid'];
    const nodes = [...document.querySelectorAll(p.selector)];
    const items = nodes.slice(0, limit).map((el) => {
      const attrs = {};
      for (const name of attrNames) {
        const v = el.getAttribute(name);
        if (v != null) attrs[name] = clip(v, 120);
      }
      return {
        tag: el.tagName.toLowerCase(),
        text: clip(el.innerText || el.value || el.getAttribute('aria-label') || '', 160),
        href: hrefOf(el),
        value: el.matches('input,textarea,select') ? clip(el.value, 120) : undefined,
        visible: isVisible(el),
        attrs,
      };
    });
    return { selector: p.selector, count: nodes.length, returned: items.length, items };
  }

  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scrollY: Math.round(scrollY),
      scrollHeight: document.documentElement.scrollHeight,
    };
  }

  /* ---------------------------------------------------------------- */
  /* rpc                                                              */
  /* ---------------------------------------------------------------- */

  const ACTIONS = { snapshot, click, hover, type, key, scroll, select, wait, find: find_text, text, links, query, viewport };

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.__bb !== 1) return;
    if (msg.action === 'ping') {
      respond({ ok: true, result: { pong: true, url: location.href } });
      return;
    }
    const fn = ACTIONS[msg.action];
    if (!fn) {
      respond({ ok: false, error: `Unknown page action "${msg.action}"` });
      return;
    }
    (async () => {
      try {
        const result = await fn(msg.params || {});
        respond({ ok: true, result });
      } catch (e) {
        respond({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  });
})();
