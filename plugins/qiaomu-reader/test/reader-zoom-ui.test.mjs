import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/ui/reader.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react', 'react-dom'],
});
const walk = (node) => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
const hasClass = (node, name) => node.props.className?.split(' ').includes(name);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

class Target {
  listeners = [];
  additions = [];
  removals = [];
  addEventListener(type, listener, options) {
    const record = { type, listener, options };
    this.additions.push(record);
    if (!this.listeners.some((item) => item.type === type && item.listener === listener)) this.listeners.push(record);
  }
  removeEventListener(type, listener) {
    this.removals.push({ type, listener });
    this.listeners = this.listeners.filter((item) => item.type !== type || item.listener !== listener);
  }
  dispatch(type, event) {
    for (const item of [...this.listeners]) if (item.type === type) item.listener(event);
    this.parentElement?.dispatch(type, event);
  }
}

// Only geometry used by the reader effects is modeled; this is not a browser layout engine.
class Element extends Target {
  style = {};
  children = [];
  clientWidth = 800;
  clientHeight = 600;
  scrollWidth = 800;
  scrollHeight = 1800;
  scrollLeft = 0;
  scrollTop = 0;
  htmlWrites = [];
  _html = '';
  constructor(className = '') { super(); this.className = className; }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = value;
    this.htmlWrites.push(value);
    this.children = [];
    if (value.includes('qmr-pdf-sheet')) {
      const sheet = new Element('qmr-pdf-sheet');
      sheet.parentElement = this;
      this.children.push(sheet);
    }
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)])
      .filter((child) => selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1)));
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() {
    const width = parseFloat(this.style.width) || this.clientWidth;
    const viewport = this.parentElement?.parentElement;
    const left = this.className === 'qmr-pdf-sheet' ? Math.max(0, ((viewport?.clientWidth || width) - width) / 2) - (viewport?.scrollLeft || 0) : 0;
    const top = this.className === 'qmr-pdf-sheet' ? -(viewport?.scrollTop || 0) : 0;
    return { left, top, right: left + width, bottom: top + this.clientHeight, width, height: this.clientHeight };
  }
  get textContent() { return this._html; }
}

function harness({ format = 'epub', fontSize = 18, pdfZoom = 1, flow = 'scroll', panel = null, render } = {}) {
  let cursor = 0, dirty = true, tree, now = 0, nextTimer = 1;
  const slots = [], timers = new Map(), frames = new Map(), elements = new Map();
  const window = new Target();
  window.matchMedia = () => Object.assign(new Target(), { matches: false });
  const computed = (node) => ({ paddingLeft: '0', paddingRight: '0', overflowY: node.style.overflowY || 'visible' });
  window.getComputedStyle = computed;
  const document = { createTreeWalker: () => ({ nextNode: () => null }) };
  const state = { bookId: 'book', chapterIndex: 0, chapterCount: 3, panel, states: {}, visible: true, view: 'reader', searchResults: [], chapterBusy: false };
  let settings = { fontSize, pdfZoom, flow, margin: 48, lineHeight: 1.6, theme: 'paper', fontFamily: 'serif', spread: false };
  const requests = [], updates = [], turns = [], errors = [], storeWrites = [];
  const engine = { book: { chapters: [{ href: '0' }, { href: '1' }, { href: '2' }] } };
  const request = (index, options) => {
    requests.push({ index, options });
    return render ? render(index, options) : Promise.resolve(format === 'pdf' ? `<div class="qmr-pdf-sheet">page ${index}</div>` : `<p>chapter ${index}</p>`);
  };
  engine.render = request; engine.renderPage = request;
  const ui = {
    useSel: (select) => select(state), bookOf: () => ({ title: 'Test book', format }), engineOf: () => engine, settingsOf: () => settings,
    t: (key, fallback) => ({ 'reader.zoomIn': 'Zoom in', 'reader.zoomOut': 'Zoom out', 'reader.zoom': 'Zoom' }[key] || fallback),
    store: { get: () => state, set: (patch) => { storeWrites.push(patch); Object.assign(state, patch); dirty = true; } },
    updateSettings: (id, patch) => { updates.push([id, { ...patch }]); settings = { ...settings, ...patch }; dirty = true; },
    loadState() {}, resourceResolver: () => undefined, reportError: (error) => { errors.push(error); return error.message; }, reportPosition() {},
    registerPager(pager) { ui.pager = pager; }, turnPage: (direction) => turns.push(direction),
    goChapter: (index) => { state.chapterIndex = index; dirty = true; }, goPercent() {}, toast() {},
  };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (fn, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) slots[index] = { value: fn(), deps };
    return slots[index].value;
  };
  const effect = (kind, fn, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) slots[index] = { kind, fn, deps, cleanup: previous?.cleanup, pending: true };
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), Fragment: 'fragment',
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useLayoutEffect: (fn, deps) => effect('layout', fn, deps), useEffect: (fn, deps) => effect('passive', fn, deps),
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: (name) => {
      if (name === 'react') return react;
      if (name === 'react-dom') return { createPortal() { throw new Error('Portal rendering is outside this reader fixture'); } };
      throw new Error(`Unexpected external module: ${name}`);
    }, window, document, HTMLElement: Element,
    Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4 }, AbortController, getComputedStyle: computed,
    localStorage: { getItem: () => null, setItem() {} }, performance: { now: () => now },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, delay = 0) => { const id = nextTimer++; timers.set(id, { fn, due: now + delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => { const id = nextTimer++; frames.set(id, fn); return id; }, cancelAnimationFrame: (id) => frames.delete(id),
  });
  function commit() {
    let commits = 0;
    while (dirty) {
      assert.ok(++commits < 30, 'hook commits must settle');
      dirty = false; cursor = 0;
      tree = module.exports.ReaderView({ ui });
      for (const node of walk(tree)) {
        if (!node.props.ref) continue;
        const name = node.props.className;
        if (!elements.has(name)) elements.set(name, new Element(name));
        const element = elements.get(name);
        Object.assign(element.style, node.props.style);
        node.props.ref.current = element;
      }
      const viewport = elements.get('qmr-page-viewport'), content = elements.get('qmr-page-flow qmr-paper-body');
      if (viewport && content) { viewport.children = [content]; content.parentElement = viewport; viewport.parentElement = window; }
      for (const kind of ['layout', 'passive']) {
        const pending = slots.filter((slot) => slot.kind === kind && slot.pending);
        for (const slot of pending) { slot.cleanup?.(); slot.pending = false; slot.cleanup = slot.fn(); }
      }
    }
  }
  async function advance(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    // Drain the reader's bounded render promise chain, including assimilated engine promises.
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    commit();
  }
  function frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); commit(); }
  function dispose() {
    for (const slot of slots) { slot.cleanup?.(); slot.cleanup = undefined; }
    timers.clear(); frames.clear();
  }
  commit();
  return { ui, state, requests, updates, turns, errors, storeWrites, window, elements, commit, advance, frame, dispose,
    nodes: () => walk(tree), element: (name) => elements.get(name),
    setSettings: (patch) => { settings = { ...settings, ...patch }; dirty = true; commit(); },
  };
}

const zoomButtons = (app) => app.nodes().filter((node) => node.type === 'button' && hasClass(node, 'qmr-zoom-btn'));
function wheel(target, patch = {}) {
  const event = { target, deltaX: 0, deltaY: 100, deltaMode: 0, clientX: 400, clientY: 300, prevented: false,
    preventDefault() { this.prevented = true; }, ...patch };
  target.dispatch('wheel', event);
  return event;
}

for (const format of ['epub', 'pdf']) {
  test(`${format} title toolbar shows circular accessible zoom controls, current value and bounds`, (t) => {
    const app = harness({ format, fontSize: 23, pdfZoom: 1.37 }); t.after(app.dispose);
    const [out, into] = zoomButtons(app);
    assert.ok(app.nodes().find((node) => hasClass(node, 'qmr-topbar')).children.some((node) => walk(node).includes(out)));
    for (const [button, label] of [[out, 'Zoom out'], [into, 'Zoom in']]) {
      assert.equal(button.props.title, label); assert.equal(button.props['aria-label'], label);
      assert.equal(button.props.disabled, false);
      const svg = walk(button).find((node) => node.type === 'svg');
      assert.equal(svg.props['aria-hidden'], true);
      assert.ok(walk(svg).some((node) => node.type === 'circle' && node.props.r > 0));
    }
    const value = () => app.nodes().find((node) => hasClass(node, 'qmr-zoom-value'));
    assert.equal(value().children[0], format === 'pdf' ? '137%' : '23px');
    assert.equal(value().props['aria-label'], 'Zoom');
    const content = app.nodes().find((node) => hasClass(node, 'qmr-page-frame'));
    assert.equal(content.props.style.width, '100%'); assert.equal(content.props.style.maxWidth, 'none');
    app.setSettings(format === 'pdf' ? { pdfZoom: 3 } : { fontSize: 48 });
    assert.equal(zoomButtons(app)[1].props.disabled, true); assert.equal(zoomButtons(app)[0].props.disabled, false);
    app.setSettings(format === 'pdf' ? { pdfZoom: 0.5 } : { fontSize: 12 });
    assert.equal(zoomButtons(app)[0].props.disabled, true); assert.equal(zoomButtons(app)[1].props.disabled, false);
    zoomButtons(app)[1].props.onClick(); app.commit();
    assert.deepEqual(app.updates.at(-1), ['book', format === 'pdf' ? { pdfZoom: 0.6 } : { fontSize: 13 }]);
    assert.equal(value().children[0], format === 'pdf' ? '60%' : '13px');
  });
}

test('wheel zoom is non-passive, viewport-scoped, reads current settings and cleans up on rerender/unmount', async (t) => {
  const app = harness({ panel: 'companion' }); t.after(app.dispose);
  const viewport = app.element('qmr-page-viewport');
  const first = viewport.listeners.find((item) => item.type === 'wheel');
  assert.ok(first); assert.equal(first.options.passive, false);
  assert.equal(app.window.listeners.filter((item) => item.type === 'wheel').length, 0);
  const companion = new Element('companion'); companion.parentElement = app.window;
  assert.equal(wheel(companion, { ctrlKey: true, deltaY: -100 }).prevented, false);
  assert.equal(app.updates.length, 0);
  assert.equal(wheel(viewport, { ctrlKey: true, deltaY: -100 }).prevented, true); app.commit();
  assert.deepEqual(app.updates.at(-1), ['book', { fontSize: 19 }]);
  app.setSettings({ fontSize: 30 });
  wheel(viewport, { ctrlKey: true, deltaY: -100 }); app.commit();
  assert.deepEqual(app.updates.at(-1), ['book', { fontSize: 31 }]);
  app.ui.goChapter(1); app.commit();
  assert.ok(viewport.removals.some((item) => item.type === 'wheel' && item.listener === first.listener));
  assert.equal(viewport.listeners.filter((item) => item.type === 'wheel').length, 1);
  await app.advance(0);
  app.dispose();
  assert.equal(viewport.listeners.filter((item) => item.type === 'wheel').length, 0);
  const count = app.updates.length;
  wheel(viewport, { ctrlKey: true, deltaY: -100 });
  assert.equal(app.updates.length, count);
});

test('ordinary wheel preserves native and nested scrolling before turning at the content edge', async (t) => {
  const app = harness(); t.after(app.dispose); await app.advance(0); app.frame();
  const viewport = app.element('qmr-page-viewport');
  assert.equal(wheel(viewport).prevented, false); assert.deepEqual(app.turns, []);
  const nested = new Element('nested'); nested.style.overflowY = 'auto'; nested.parentElement = viewport;
  viewport.scrollTop = 1200;
  assert.equal(wheel(nested).prevented, false); assert.deepEqual(app.turns, []);
  await app.advance(400);
  assert.equal(wheel(viewport).prevented, true); assert.deepEqual(app.turns, [1]);
});

test('late chapter completion cannot replace committed content or clear the new chapter busy state', async (t) => {
  const pending = [deferred(), deferred()];
  const app = harness({ render: (index) => pending[index].promise }); t.after(app.dispose);
  await app.advance(0); assert.equal(app.requests[0].index, 0);
  app.ui.goChapter(1); app.commit(); await app.advance(0);
  const flow = app.element('qmr-page-flow qmr-paper-body');
  pending[0].resolve('<p>obsolete</p>'); await app.advance(0);
  assert.equal(flow.innerHTML, ''); assert.equal(app.state.chapterBusy, true);
  pending[1].resolve('<p>current</p>'); await app.advance(0);
  assert.equal(flow.innerHTML, '<p>current</p>'); assert.equal(app.state.chapterBusy, false);
  assert.deepEqual(app.errors, []);
});

test('identical text in a new chapter is a new committed generation and resets scroll', async (t) => {
  const app = harness({ render: () => Promise.resolve('<p>same text</p>') }); t.after(app.dispose);
  await app.advance(0); app.frame();
  const viewport = app.element('qmr-page-viewport'), flow = app.element('qmr-page-flow qmr-paper-body');
  viewport.scrollTop = 700;
  const writes = flow.htmlWrites.length;
  app.ui.goChapter(1); app.commit();
  assert.equal(flow.htmlWrites.length, writes);
  await app.advance(0); app.frame();
  assert.equal(flow.htmlWrites.length, writes + 1); assert.equal(viewport.scrollTop, 0);
});

test('zooming an already committed PDF page preserves its center anchor instead of resetting', async (t) => {
  const app = harness({ format: 'pdf' }); t.after(app.dispose);
  await app.advance(120); app.frame();
  const viewport = app.element('qmr-page-viewport');
  viewport.scrollTop = 400;
  zoomButtons(app)[1].props.onClick(); app.commit(); await app.advance(120); app.frame();
  assert.ok(Math.abs(viewport.scrollTop - 470) < 1e-9);
  assert.ok(Math.abs(viewport.scrollLeft - 40) < 1e-9);
  assert.deepEqual(app.errors, []);
});

test('pending PDF chapter does not mark old HTML as the new page before zoomed rendering commits', async (t) => {
  const next = deferred();
  const app = harness({ format: 'pdf', render: (index) => index === 0 ? Promise.resolve('<div class="qmr-pdf-sheet">old page</div>') : next.promise });
  t.after(app.dispose); await app.advance(120); app.frame();
  const viewport = app.element('qmr-page-viewport'), flow = app.element('qmr-page-flow qmr-paper-body');
  assert.ok(flow.innerHTML.includes('old page'));
  viewport.scrollTop = 400;
  const writes = flow.htmlWrites.length;
  app.ui.goChapter(1); app.commit(); await app.advance(120);
  assert.equal(flow.htmlWrites.length, writes, 'pending chapter must not recommit the previous page');
  assert.equal(app.requests[0].options.signal.aborted, true);
  zoomButtons(app)[1].props.onClick(); app.commit(); await app.advance(120);
  assert.equal(app.requests.at(-1).options.width, viewport.clientWidth * 1.1);
  assert.equal(app.requests[1].options.signal.aborted, true);
  next.resolve('<div class="qmr-pdf-sheet">new page</div>'); await app.advance(0); app.frame();
  assert.ok(flow.innerHTML.includes('new page'));
  assert.equal(viewport.scrollTop, 0, 'a newly committed chapter resets rather than applying an old-page zoom anchor');
  assert.equal(app.state.chapterBusy, false); assert.deepEqual(app.errors, []);
});
