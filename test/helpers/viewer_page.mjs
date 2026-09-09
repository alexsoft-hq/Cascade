// viewer_page.mjs — ONE loader for the viewer page, and the DOM stub it runs in.
//
// The page is a set of classic scripts sharing one global scope: `<script
// src="/viewer/lib/*.js">` for the two modules src/viewer/ owns, then
// `viewer/js/NN_name.js` in the numbered order the file names make explicit.
// A test that wants to run the page has to load it the way the browser does, in
// that order, in ONE context — so exactly one place here knows how, and every
// viewer test calls it. A stack trace then names the FILE the line is in, which
// is the whole point of the numbering.
//
// The DOM stub below is enough of a browser for this page and nothing more: no
// canvas, no layout, no WebGL. What it buys is everything a browser is not
// needed for — which project the page asks about, what it draws into the
// document, what it puts in the URL — and it says so plainly rather than
// pretending to be a browser.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { classicSource } from '../../src/mcp/http.mjs';

export const ENGINE_ROOT = fileURLToPath(new URL('../../', import.meta.url));


// ---------------------------------------------------------------------------
// A DOM stub: enough of one for this page, and nothing more
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['meta', 'link', 'br', 'input', 'img', 'hr', 'source', 'col']);

export class Style {
  constructor() { this._s = {}; }
  setProperty(k, v) { this._s[k] = v; }
  getPropertyValue(k) { return this._s[k] ?? ''; }
}

export class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.dataset = {};
    this.kids = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.value = '';
    this.placeholder = '';
    this.title = '';
    this.text = '';
    this.clientWidth = 900;
    this.clientHeight = 620;
    this._style = new Style();
    this._listeners = new Map();
    const self = this;
    this.classList = {
      add: (c) => { const s = self._classes(); s.add(c); self.className = [...s].join(' '); },
      remove: (c) => { const s = self._classes(); s.delete(c); self.className = [...s].join(' '); },
      contains: (c) => self._classes().has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes().has(c) : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      },
    };
  }

  _classes() { return new Set(String(this.className || '').split(/\s+/).filter(Boolean)); }

  get style() { return this._style; }
  set style(v) {
    if (typeof v === 'string') {
      this._style = new Style();
      for (const part of v.split(';')) {
        const i = part.indexOf(':');
        if (i > 0) this._style.setProperty(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
    } else if (v && typeof v === 'object') this._style = v;
  }

  get textContent() {
    return this.kids.map((k) => (k instanceof El ? k.textContent : k.text)).join('') || this.text;
  }

  set textContent(v) { this.kids = []; this.text = v == null ? '' : String(v); }

  get children() { return this.kids.filter((k) => k instanceof El); }
  get childNodes() { return this.kids; }
  hasChildNodes() { return this.kids.length > 0; }

  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      if (k instanceof El) { k.parentNode = this; this.kids.push(k); }
      else this.kids.push({ text: String(k) });
    }
    if (this.text && this.kids.length) this.text = '';
  }

  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.kids = []; this.text = ''; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.kids = this.parentNode.kids.filter((k) => k !== this); }

  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'id') this.id = String(v);
    else if (k === 'class') this.className = String(v);
    else if (k === 'value') this.value = String(v);
    else if (k === 'placeholder') this.placeholder = String(v);
    else if (k === 'title') this.title = String(v);
    else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
  }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) {
    this.attrs.delete(k);
    if (k === 'disabled') this.disabled = false;
  }
  addEventListener(ev, fn) { if (!this._listeners.has(ev)) this._listeners.set(ev, []); this._listeners.get(ev).push(fn); }
  removeEventListener() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 900, height: 620, right: 900, bottom: 620 }; }
  focus() {}
  blur() {}
  /** What a real element does: run whatever the page bound to onclick. */
  click() { if (typeof this.onclick === 'function') this.onclick(); }
  scrollIntoView() {}

  /** Every element under this one, this one included. */
  all() {
    const out = [this];
    for (const k of this.kids) if (k instanceof El) out.push(...k.all());
    return out;
  }

  matches(sel) { return matchSimple(this, sel); }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }

  querySelectorAll(sel) { return query(this, sel); }
  querySelector(sel) { return query(this, sel)[0] || null; }
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** `tag`, `.cls`, `#id`, `[attr]`, `[attr="v"]` and any combination of them. */
function matchSimple(node, sel) {
  const s = sel.trim();
  const parts = s.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!parts) return false;
  if (parts[1] && node.tagName !== parts[1].toUpperCase()) return false;
  for (const bit of (parts[2] || '').match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
    if (bit[0] === '.') { if (!node._classes().has(bit.slice(1))) return false; }
    else if (bit[0] === '#') { if (node.id !== bit.slice(1)) return false; }
    else {
      const m = bit.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
      if (!m) return false;
      const have = node.attrs.has(m[1]);
      if (!have) return false;
      if (m[2] !== undefined && node.attrs.get(m[1]) !== m[2]) return false;
    }
  }
  return true;
}

/** Descendant combinators only ("#cpaxis button") — all this page ever uses. */
function query(root, sel) {
  const steps = sel.trim().split(/\s+/);
  let pool = root.all().filter((n) => matchSimple(n, steps[0]));
  for (const step of steps.slice(1)) {
    const next = [];
    for (const p of pool) for (const d of p.all()) if (d !== p && matchSimple(d, step)) next.push(d);
    pool = [...new Set(next)];
  }
  return pool;
}

/**
 * A flat-enough parse of the page's static markup: tags, attributes, nesting —
 * AND THE TEXT BETWEEN THEM.
 *
 * The text nodes used to be dropped, and it cost more than it looked like it
 * would: `<option selected>6</option>` (both depth pickers) read back as the
 * empty string, so `select.value` was empty, so `Number(byId('fdepth').value)`
 * was 0, so every chain this stub could have drawn came back as a bad-input.
 * No test in this file had ever rendered one. Text is kept here, and
 * `bootPage` below takes an option's TEXT as its value when it has no `value`
 * attribute, which is what a browser does.
 */
export function parseBody(html) {
  const bodyStart = html.indexOf('<body>');
  const bodyEnd = html.indexOf('</body>');
  const src = html.slice(bodyStart + '<body>'.length, bodyEnd);
  const body = new El('body');
  const stack = [body];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let m;
  let at = 0;
  /** The run of text that ends where the next tag begins. */
  const text = (upTo) => {
    const run = src.slice(at, upTo);
    at = upTo;
    if (run !== '') stack[stack.length - 1].append(run);
  };
  while ((m = re.exec(src)) !== null) {
    text(m.index);
    at = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const [, close, tag, attrText] = m;
    const lower = tag.toLowerCase();
    if (lower === 'script' || lower === 'style') {
      if (!close) {
        const end = src.indexOf(`</${lower}>`, re.lastIndex);
        re.lastIndex = end < 0 ? src.length : end + lower.length + 3;
        at = re.lastIndex;
      }
      continue;
    }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const node = new El(lower);
    for (const a of (attrText || '').matchAll(/([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = a[1];
      if (name === '/') continue;
      node.setAttribute(name, a[2] ?? a[3] ?? a[4] ?? '');
    }
    stack[stack.length - 1].append(node);
    const selfClosing = (attrText || '').trim().endsWith('/');
    if (!VOID_TAGS.has(lower) && !selfClosing) stack.push(node);
  }
  return body;
}

/** Every custom property one `[data-theme="…"]` block declares, as a map. */
export function themeTokens(html, theme) {
  const m = html.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  assert.ok(m, `viewer/index.html declares no [data-theme="${theme}"] block`);
  const out = {};
  for (const decl of m[1].split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    if (!name.startsWith('--')) continue;
    out[name] = decl.slice(i + 1).trim();
  }
  return out;
}

/** What a browser's computed value would be: `var()` references substituted. */
export function resolveVars(tok, value) {
  let v = String(value);
  for (let i = 0; i < 5 && v.includes('var(--'); i++) {
    v = v.replace(/var\((--[\w-]+)\)/g, (_, n) => tok[n] ?? '');
  }
  return v;
}


// ---------------------------------------------------------------------------
// The page's scripts, in the order the browser runs them
// ---------------------------------------------------------------------------

/**
 * Every script the page loads, in document order, as `{filename, code}`.
 *
 *   /vendor/…       SKIPPED. Those are the two vendored map renderers; the stub
 *                   has no canvas, and `bootPage({renderer:true})` puts a
 *                   chainable nothing in their place instead.
 *   /viewer/lib/…   src/viewer/<name>.mjs minus its `export ` keywords — the
 *                   same transform the server applies at request time, taken
 *                   from the server so the two cannot drift.
 *   /viewer/js/…    read from disk as it is.
 *   inline          the script's own text (there is one, in <head>, which runs
 *                   before first paint; it is in the head and this reads the
 *                   BODY, so it is not here).
 */
export function pageScripts(html, root = ENGINE_ROOT) {
  const body = html.slice(html.indexOf('<body>'));
  const out = [];
  for (const m of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    if (!src) { out.push({ filename: 'viewer/index.html', code: m[2] }); continue; }
    const url = src[1];
    if (url.startsWith('/vendor/')) continue;
    if (url.startsWith('/viewer/lib/')) {
      const name = url.slice('/viewer/lib/'.length).replace(/\.js$/, '');
      out.push({ filename: `src/viewer/${name}.mjs`, code: classicSource(fs.readFileSync(path.join(root, 'src', 'viewer', `${name}.mjs`), 'utf8')) });
      continue;
    }
    if (url.startsWith('/viewer/js/')) {
      const rel = path.join('viewer', 'js', url.slice('/viewer/js/'.length));
      out.push({ filename: rel, code: fs.readFileSync(path.join(root, rel), 'utf8') });
      continue;
    }
    throw new Error(`viewer/index.html loads a script this loader does not know: ${url}`);
  }
  assert.ok(out.length > 0, 'no scripts found in viewer/index.html');
  return out;
}

/** Run them all in one context, each with its own filename. */
export function runPage(ctx, html, root = ENGINE_ROOT) {
  for (const s of pageScripts(html, root)) vm.runInContext(s.code, ctx, { filename: s.filename });
}


/**
 * A CHAINABLE NOTHING, standing in for the vendored force-graph bundle.
 *
 * The picture itself is still not checked here (no canvas, no layout, no
 * WebGL): what this buys is the code path BEFORE the canvas — the model the
 * page builds out of a `map` answer, the chips beside it and the counts under
 * it, which without a renderer never run at all because `drawMap` stops at
 * `mapHas2D()`. Every method returns the same object, so the whole builder
 * chain in mountMap2D works and every callback it is handed is simply kept.
 */
export function fakeForceGraph() {
  const api = new Proxy(function self() { return api; }, {
    get: (_t, k) => (k === 'then' ? undefined : () => api),
    apply: () => api,
  });
  return function ForceGraph() { return api; };
}

/**
 * Boot the page in a fresh context and let its `init()` settle.
 *
 * `answer` is how the page's own `fetch` is answered: the whole page talks to
 * the server through it, so a caller hands over a real server (`(url, opts) =>
 * fetch(base + url, opts)`) or a recording, and nothing else in here knows the
 * difference.
 *
 * @param {{html:string, answer:Function, hash?:string, search?:string,
 *          storage?:object, renderer?:boolean, origin?:string}} cfg
 */
export async function bootPage({ html, answer, hash = '', search = '', storage = {}, renderer = false, origin = '' } = {}) {
  const body = parseBody(html);
  // What a browser does with `<option value="x" selected>`: the select reports
  // that option's value — and where the option has no `value` attribute, its
  // own TEXT (`<option selected>6</option>`, both depth pickers).
  for (const sel of body.querySelectorAll('select')) {
    const chosen = sel.children.find((o) => o.attrs.has('selected')) || sel.children[0];
    if (!chosen) continue;
    const v = chosen.getAttribute('value');
    const value = v != null && v !== '' ? v : chosen.textContent.trim();
    if (value) sel.value = value;
  }
  const documentElement = new El('html');
  const byId = new Map();
  for (const n of body.all()) if (n.id) byId.set(n.id, n);

  const calls = [];
  const store = new Map(Object.entries(storage));

  const location = { search, hash, href: origin + '/', pathname: '/' };
  const docListeners = new Map();
  const sandbox = {
    console,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    cancelAnimationFrame: (h) => clearTimeout(h),
    performance,
    location,
    history: { replaceState: (a, b, h) => { location.hash = h; }, pushState: (a, b, h) => { location.hash = h; }, back() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    fetch: (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
      return answer(String(url), opts);
    },
    // The page reads EVERY colour it draws with — CSS, inline SVG and each of
    // the three canvas renderers — out of a custom property on <html>. So the
    // stub answers out of the page's own [data-theme] blocks, for whichever
    // theme is set: that is what makes the accessor testable here at all.
    getComputedStyle: () => {
      const tok = themeTokens(html, documentElement.getAttribute('data-theme') || 'signal');
      return { getPropertyValue: (k) => resolveVars(tok, tok[k] ?? '') };
    },
    document: {
      documentElement,
      body,
      createElement: (tag) => new El(tag),
      createElementNS: (ns, tag) => new El(tag),
      getElementById: (id) => byId.get(id) || null,
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      // KEPT, not swallowed: the page has ONE Escape rule and it lives on the
      // document, so a test that cannot fire one cannot see it.
      addEventListener: (evName, fn) => {
        if (typeof fn !== 'function') return;
        if (!docListeners.has(evName)) docListeners.set(evName, []);
        docListeners.get(evName).push(fn);
      },
      removeEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // Window listeners are KEPT, not swallowed: the Graph pane's height is
  // re-measured on `resize`, and a test that cannot fire one cannot see it.
  const winListeners = new Map();
  sandbox.window.addEventListener = (evName, fn) => {
    if (typeof fn !== 'function') return;
    if (!winListeners.has(evName)) winListeners.set(evName, []);
    winListeners.get(evName).push(fn);
  };
  sandbox.window.removeEventListener = () => {};
  sandbox.window.innerWidth = 1400;
  sandbox.window.innerHeight = 900;
  if (renderer) sandbox.window.ForceGraph = fakeForceGraph();

  const ctx = vm.createContext(sandbox);
  runPage(ctx, html);
  // The page's init() is async (it fetches its catalogues, the project list,
  // the meta and the Overview): let those settle.
  await settle(ctx);
  /** Fire one window event at every listener the page registered for it. */
  const fireWindow = (evName) => {
    for (const fn of winListeners.get(evName) || []) fn({ type: evName });
  };
  /** Fire one document event at every listener the page registered for it. */
  const fireDoc = (evName, extra = {}) => {
    for (const fn of [...(docListeners.get(evName) || [])]) {
      fn({ type: evName, target: body, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  };
  return { ctx, sandbox, body, byId, calls, store, html, fireWindow, fireDoc };
}

/** Let every pending microtask + timer round the page started actually run. */
export async function settle(ctx, rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
  void ctx;
}

/** Read one expression out of the page's own context. */
export const ev = (ctx, expr) => vm.runInContext(expr, ctx);
