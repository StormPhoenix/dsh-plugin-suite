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
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name);

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
  style = {
    getPropertyValue(name) { return this[name] || ''; },
    getPropertyPriority() { return ''; },
    setProperty(name, value) { this[name] = value; },
    removeProperty(name) { delete this[name]; },
  };
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
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)])
      .filter((child) => selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1)));
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() {
    const width = parseFloat(this.style.width) || this.clientWidth;
    return { left: 0, top: 0, right: width, bottom: this.clientHeight, width, height: this.clientHeight };
  }
  get textContent() { return this._html; }
}

function harness() {
  let cursor = 0, dirty = true, tree, now = 0, nextTimer = 1;
  const slots = [], timers = new Map(), frames = new Map(), elements = new Map();
  const window = new Target();
  window.matchMedia = () => Object.assign(new Target(), { matches: false });
  const computed = (node) => ({ paddingLeft: '0', paddingRight: '0', overflowY: node.style.overflowY || 'visible' });
  window.getComputedStyle = computed;
  const document = { createTreeWalker: () => ({ nextNode: () => null }) };
  const state = { bookId: 'book', chapterIndex: 0, chapterCount: 3, panel: null, states: {}, visible: true, view: 'reader', searchResults: [], chapterBusy: false };
  const settings = { fontSize: 18, pdfZoom: 1, flow: 'scroll', margin: 48, lineHeight: 1.6, theme: 'paper', fontFamily: 'serif', spread: false };
  const storeWrites = [];
  state.states.book ||= { locator: { chapterIndex: 0, scroll: 0 } };
  const engine = { book: { chapters: [{ href: '0' }, { href: '1' }, { href: '2' }] } };
  engine.render = () => Promise.resolve('<p>chapter</p>'); engine.renderPage = engine.render;
  const ui = {
    useSel: (select) => select(state), bookOf: () => ({ title: 'Test book', format: 'epub' }), engineOf: () => engine, settingsOf: () => settings,
    t: (key, fallback) => fallback,
    store: { get: () => state, set: (patch) => { storeWrites.push(patch); Object.assign(state, patch); dirty = true; } },
    updateSettings() {}, loadState: () => state.states.book, resourceResolver: () => undefined, reportError: (error) => error.message, reportPosition() {}, flushPendingSaves() {},
    registerPager() {}, turnPage() {}, goChapter() {}, goPercent() {}, toast() {},
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
        node.props.ref.current = elements.get(name);
      }
      for (const kind of ['layout', 'passive']) {
        const pending = slots.filter((slot) => slot.kind === kind && slot.pending);
        for (const slot of pending) { slot.cleanup?.(); slot.pending = false; slot.cleanup = slot.fn(); }
      }
    }
  }
  async function advance(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    commit();
  }
  function dispose() {
    for (const slot of slots) { slot.cleanup?.(); slot.cleanup = undefined; }
    timers.clear(); frames.clear();
  }
  commit();
  return {
    state, storeWrites, window, elements, commit, advance, dispose,
    nodes: () => walk(tree), element: (name) => elements.get(name),
    contentNode: () => walk(tree).find((node) => hasClass(node, 'qmr-reader-content')),
    topBar: () => walk(tree).find((node) => hasClass(node, 'qmr-topbar')),
    bottomBar: () => walk(tree).find((node) => hasClass(node, 'qmr-bottombar')),
    setBarHeights() {
      for (const [name, height] of [['qmr-topbar', 52], ['qmr-bottombar', 44], ['qmr-topbar qmr-chrome-hidden', 52], ['qmr-bottombar qmr-chrome-hidden', 44]]) {
        const element = elements.get(name);
        if (element) element.offsetHeight = height;
      }
    },
  };
}

const contentRect = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 };
const pointerMove = (app, clientY) => app.contentNode().props.onPointerMoveCapture({ type: 'pointermove', clientY, currentTarget: { getBoundingClientRect: () => contentRect } });

test('chrome starts visible and hides itself after idle without any input', async (t) => {
  const app = harness(); t.after(app.dispose);
  try {
    await app.advance(0);
    assert.equal(app.topBar().props.className, 'qmr-topbar');
    await app.advance(2800);
    assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
    assert.equal(app.bottomBar().props.className, 'qmr-bottombar qmr-chrome-hidden');
  } finally { app.dispose(); }
});

test('pointer movement over the middle of the content neither summons nor postpones hiding', async (t) => {
  const app = harness(); t.after(app.dispose);
  await app.advance(0); app.setBarHeights();
  pointerMove(app, 300); pointerMove(app, 350);
  await app.advance(2800);
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden', 'idle after mid-content moves still hides on schedule');
});

test('wheel scrolling neither summons nor postpones hiding', async (t) => {
  const app = harness(); t.after(app.dispose);
  await app.advance(0);
  app.element('qmr-page-viewport').dispatch('wheel', { type: 'wheel', deltaY: 120, clientX: 400, clientY: 300, prevented: false, preventDefault() {} });
  app.commit();
  await app.advance(2800);
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
});

test('pointer movement into the top or bottom bar strip summons the chrome and restarts the timer', async (t) => {
  const app = harness(); t.after(app.dispose);
  await app.advance(0); app.setBarHeights();
  await app.advance(2800); app.setBarHeights();
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
  pointerMove(app, 580);
  app.commit();
  assert.equal(app.topBar().props.className, 'qmr-topbar', 'bottom strip summons');
  await app.advance(2800); app.setBarHeights();
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
  pointerMove(app, 20);
  app.commit();
  assert.equal(app.topBar().props.className, 'qmr-topbar', 'top strip summons');
  await app.advance(2800);
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
});

test('repeated moves inside a bar strip keep the chrome visible past one timeout span', async (t) => {
  const app = harness(); t.after(app.dispose);
  await app.advance(0); app.setBarHeights();
  pointerMove(app, 560);
  await app.advance(2000);
  app.setBarHeights();
  pointerMove(app, 570);
  await app.advance(2000);
  assert.equal(app.bottomBar().props.className, 'qmr-bottombar', 'second strip move restarted the timer');
  await app.advance(1000);
  assert.equal(app.bottomBar().props.className, 'qmr-bottombar qmr-chrome-hidden');
});

test('pointer down, key down and focus still summon the chrome from anywhere on the content', async (t) => {
  const app = harness(); t.after(app.dispose);
  const content = () => app.contentNode().props;
  await app.advance(2800);
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
  content().onPointerDownCapture({ type: 'pointerdown' }); app.commit();
  assert.equal(app.topBar().props.className, 'qmr-topbar');
  await app.advance(2800);
  content().onKeyDownCapture({ type: 'keydown' }); app.commit();
  assert.equal(app.topBar().props.className, 'qmr-topbar');
  await app.advance(2800);
  content().onFocusCapture({ type: 'focus' }); app.commit();
  assert.equal(app.topBar().props.className, 'qmr-topbar');
  await app.advance(2800);
  assert.equal(app.topBar().props.className, 'qmr-topbar qmr-chrome-hidden');
});
