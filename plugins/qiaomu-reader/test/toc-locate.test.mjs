import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

async function bundle(path, globals = {}) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, format: 'cjs', external: ['react'] });
  const module = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, ...globals });
  return module.exports;
}

const { splitHref, chapterIndexForHref, flattenToc, locateTocEntry, detectSectionAnchor } = await bundle('../src/ui/toc-locate.js');
const format = await bundle('../src/ui/format.js');
const engine = { book: { chapters: [{ href: 'OPS/book.xhtml' }, { href: 'OPS/next.xhtml' }] } };
const entries = [{ href: 'OPS/book.xhtml', label: 'Book', children: [
  { href: 'OPS/book.xhtml#first', label: 'First' },
  { href: 'OPS/book.xhtml#second', label: 'Second', children: [{ href: 'OPS/book.xhtml#third', label: 'Third' }] },
] }, { href: 'OPS/next.xhtml', label: 'Next' }];

function dom(positions, height = 200) {
  return {
    viewport: { clientHeight: height, getBoundingClientRect: () => ({ top: 100, left: 100, right: 500 }) },
    flow: { querySelector: (selector) => {
      const fragment = selector.match(/^\[id="(.*?)"\]/)[1];
      const rect = positions[fragment];
      return rect ? { getBoundingClientRect: () => rect } : null;
    } },
  };
}

test('href fragments are decoded safely and ignored for chapter lookup and labels', () => {
  assert.equal(splitHref('OPS/book.xhtml#%E5%B0%8F%E8%8A%82').fragment, '小节');
  assert.equal(splitHref('book.xhtml#bad%XX').fragment, 'bad%XX');
  assert.equal(splitHref(null).path, '');
  assert.equal(chapterIndexForHref(engine, 'OPS/book.xhtml#second'), 0);
  assert.equal(format.chapterIndexForHref(engine, '../book.xhtml#second'), 0);
  assert.equal(chapterIndexForHref(engine, '#second'), -1);
  assert.equal(chapterIndexForHref(null, 'book.xhtml'), -1);
  assert.equal(chapterIndexForHref({ book: { chapters: {} } }, 'book.xhtml'), -1);
  assert.equal(format.chapterLabelMap({ book: { ...engine.book, toc: [{ href: 'OPS/book.xhtml#first', label: 'Chapter title' }] } }).get(0), 'Chapter title');
});

test('one section is selected within the chapter, with its complete ancestor chain', () => {
  const flat = flattenToc(entries, engine);
  const selected = locateTocEntry({ flat, chapterIndex: 0, anchor: { fragment: 'third' } });
  assert.equal(selected.key, flat[3].key);
  assert.deepEqual(Array.from(selected.ancestors), [flat[0].key, flat[2].key]);
  assert.equal(flat.filter((item) => item.key === selected.key).length, 1);
  assert.equal(locateTocEntry({ flat, chapterIndex: 0, anchor: { fragment: 'unknown' } }).key, flat[0].key);
  assert.equal(locateTocEntry({ flat, chapterIndex: 1, anchor: { fragment: 'third' } }).key, flat[4].key);
  assert.equal(locateTocEntry({ flat, chapterIndex: 99 }), null);
  assert.equal(locateTocEntry({ flat, chapterIndex: -1 }), null);
  assert.equal(locateTocEntry({ flat: [], chapterIndex: 0 }), null);
});

test('all-anchor single-file books fall back to their first section and advance on detected anchors', () => {
  const flat = flattenToc(entries[0].children, engine);
  assert.equal(locateTocEntry({ flat, chapterIndex: 0 }).key, flat[0].key);
  for (const fragment of ['first', 'second', 'third']) {
    const current = locateTocEntry({ flat, chapterIndex: 0, anchor: { fragment } });
    assert.equal(flat.find((item) => item.key === current.key).fragment, fragment);
  }
});

test('duplicate hrefs in siblings and separate branches have distinct keys', () => {
  const branch = { href: 'OPS/book.xhtml', children: [{ href: 'OPS/book.xhtml#first' }] };
  const flat = flattenToc([branch, branch, { href: branch.href }], engine);
  assert.equal(new Set(flat.map((item) => item.key)).size, flat.length);
});

test('link fallback supports numeric and PDF object results; fragment-only children inherit chapter context', () => {
  const links = { book: engine.book, resolveLink: (index, href) => href.startsWith('#') ? index : href === 'page:2' ? { chapterIndex: 1, fragment: '' } : href === 'numeric' ? 0 : null };
  const flat = flattenToc([{ href: 'OPS/next.xhtml', children: [{ href: '#detail' }] }, { href: 'page:2' }, { href: 'numeric' }, { href: 'missing' }, { href: '' }], links);
  assert.deepEqual(Array.from(flat, (item) => item.chapterIndex), [1, 1, 1, 0, -1, -1]);
  assert.equal(flat[1].fragment, 'detail');
  assert.equal(flattenToc([{ href: 'bad' }], { resolveLink: () => { throw new Error('bad'); } })[0].chapterIndex, -1);
});

test('flat TXT and PDF outlines retain chapter-based selection without anchors', () => {
  for (const prefix of ['txt', 'pdf']) {
    const book = { chapters: [0, 1, 2].map((index) => ({ href: `${prefix}:${index}` })) };
    const flat = flattenToc(book.chapters, { book });
    assert.equal(locateTocEntry({ flat, chapterIndex: 2 }).key, flat[2].key);
  }
});

test('scroll selects the last section above the reading threshold, skips missing anchors and changes with position', () => {
  const positions = { first: { top: -100 }, second: { top: 160 }, third: { top: 161 } };
  const nodes = dom(positions);
  const options = { ...nodes, fragments: ['first', 'missing', 'second', 'third'], mode: 'scroll' };
  assert.equal(detectSectionAnchor(options), 'second');
  positions.third.top = 120;
  assert.equal(detectSectionAnchor(options), 'third');
  assert.equal(detectSectionAnchor({ ...options, fragments: ['missing'] }), null);
  assert.equal(detectSectionAnchor({ ...options, flow: null }), null);
});

test('pagination selects the last anchor before the visible right edge, including prior-page headings', () => {
  const options = { ...dom({ first: { left: -400 }, second: { left: 499 }, third: { left: 500 } }), fragments: ['first', 'second', 'third'], mode: 'paginated' };
  assert.equal(detectSectionAnchor(options), 'second');
  options.flow = dom({ first: { left: -400 }, second: { left: -1 }, third: { left: 100 } }).flow;
  assert.equal(detectSectionAnchor(options), 'third');
});

test('multi-column elements use their first client rectangle and CSS special characters are escaped', () => {
  let selector;
  const node = { getClientRects: () => [{ left: 600 }], getBoundingClientRect: () => ({ left: 10 }) };
  const viewport = dom({}).viewport;
  assert.equal(detectSectionAnchor({ flow: { querySelector: () => node }, viewport, fragments: ['wrapper'], mode: 'paginated' }), null);
  assert.equal(detectSectionAnchor({ flow: { querySelector: (value) => { selector = value; return { getBoundingClientRect: () => ({ top: 100 }) }; } }, viewport, fragments: ['quote"\\\n'], mode: 'scroll' }), 'quote"\\\n');
  assert.ok(selector.includes('\\22 '));
  assert.ok(selector.includes('\\5c '));
  assert.ok(selector.includes('\\a '));
});

test('hidden anchors without layout rectangles never replace a visible section', () => {
  const visible = { getClientRects: () => [{ top: 100, left: 100 }] };
  const hidden = { getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, left: 0 }) };
  const flow = { querySelector: (selector) => selector.includes('visible') ? visible : hidden };
  for (const mode of ['scroll', 'paginated']) {
    assert.equal(detectSectionAnchor({ flow, viewport: dom({}).viewport, fragments: ['visible', 'hidden'], mode }), 'visible');
  }
});

test('delayed restore explicitly samples on the next frame and discards superseded restores', async () => {
  const source = await readFile(new URL('../src/ui/reader.js', import.meta.url), 'utf8');
  const callback = source.match(/positionReadyRef\.current = true;\s*(requestAnimationFrame\(\(\) => \{\s*if \(restoreEpochRef\.current === epoch && positionIdentityRef\.current === identity\) reportTocAnchor\(\);\s*\}\);)/)?.[1];
  assert.ok(callback, 'completion must schedule sampling even if page state does not change');
  const frames = [];
  let samples = 0;
  const restoreEpochRef = { current: 1 }, positionIdentityRef = { current: 'book:0' };
  const context = { restoreEpochRef, positionIdentityRef, epoch: 1, identity: 'book:0', requestAnimationFrame: (fn) => frames.push(fn), reportTocAnchor: () => { samples += 1; } };
  vm.runInNewContext(callback, context);
  assert.equal(samples, 0);
  frames.shift()();
  assert.equal(samples, 1);
  vm.runInNewContext(callback, context);
  restoreEpochRef.current = 2;
  frames.shift()();
  assert.equal(samples, 1);
  restoreEpochRef.current = 1;
  vm.runInNewContext(callback, context);
  positionIdentityRef.current = 'other:0';
  frames.shift()();
  assert.equal(samples, 1);
});

function harness() {
  const slots = [], frames = new Map();
  let cursor = 0, effects = [], dirty = false, tree, nextFrame = 0;
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (initial) => {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (update) => {
        const next = typeof update === 'function' ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef: (initial) => {
      const index = cursor++;
      slots[index] ??= { value: { current: initial } };
      return slots[index].value;
    },
    useMemo: (factory, deps) => {
      const index = cursor++;
      if (!depsEqual(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useLayoutEffect: (effect, deps) => {
      const index = cursor++;
      if (depsEqual(slots[index]?.deps, deps)) return;
      slots[index]?.cleanup?.();
      slots[index] = { deps };
      effects.push(() => { slots[index].cleanup = effect(); });
    },
  };
  const walk = (node, predicate, result = []) => {
    if (Array.isArray(node)) node.forEach((child) => walk(child, predicate, result));
    else if (node?.props) {
      if (predicate(node)) result.push(node);
      walk(node.props.children, predicate, result);
    }
    return result;
  };
  const items = () => walk(tree, (node) => node.props.className?.startsWith('qmr-toc-item'));
  const body = { scrollTop: 0, clientTop: 0, clientHeight: 100, getBoundingClientRect: () => ({ top: 100 }), querySelector: () => {
    const rows = items();
    const index = rows.findIndex((row) => row.props.className.includes('is-current'));
    return index < 0 ? null : { getBoundingClientRect: () => ({ top: 100 + index * 20 - body.scrollTop, height: 20 }) };
  } };
  return {
    globals: { require: () => react, requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: (id) => frames.delete(id) },
    body, items,
    toggles: () => walk(tree, (node) => node.props.className?.startsWith('qmr-toc-toggle') && node.props.onClick),
    render: (Panel, ui) => {
      do {
        cursor = 0; effects = []; dirty = false;
        tree = Panel({ ui });
        walk(tree, (node) => node.props.className === 'qmr-panel-body')[0].props.ref.current = body;
        effects.forEach((effect) => effect());
      } while (dirty);
    },
    flushFrames: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); },
  };
}

test('panel highlights one section, ignores stale anchors, and retries centering after layout', async () => {
  const runtime = harness();
  const { TocPanel } = await bundle('../src/ui/toc.js', runtime.globals);
  const state = { bookId: 'book', chapterIndex: 0, chapterCount: 2, engineVersion: 1, tocAnchor: { bookId: 'book', chapterIndex: 0, fragment: 'third' } };
  const ui = { useSel: (select) => select(state), engineOf: () => ({ ...engine, book: { ...engine.book, toc: entries } }) };
  runtime.body.clientHeight = 0;
  runtime.render(TocPanel, ui);
  assert.deepEqual(runtime.items().filter((item) => item.props['aria-current']).map((item) => item.props.children[0]), ['Third']);
  assert.equal(runtime.body.scrollTop, 0);
  runtime.body.clientHeight = 100;
  runtime.flushFrames();
  assert.equal(runtime.body.scrollTop, 20);
  state.tocAnchor = { bookId: 'other', chapterIndex: 0, fragment: 'third' };
  runtime.render(TocPanel, ui);
  assert.equal(runtime.items().find((item) => item.props['aria-current']).props.children[0], 'Book');
});

test('panel expands current ancestors after section changes and keeps unrelated branches collapsed', async () => {
  const runtime = harness();
  const { TocPanel } = await bundle('../src/ui/toc.js', runtime.globals);
  const bookEngine = { book: { ...engine.book, toc: [...entries, { href: 'OPS/next.xhtml', children: [{ href: 'OPS/next.xhtml#other' }] }] } };
  const state = { bookId: 'book', chapterIndex: 0, engineVersion: 1, tocAnchor: null };
  const ui = { useSel: (select) => select(state), engineOf: () => bookEngine };
  runtime.render(TocPanel, ui);
  runtime.toggles()[1].props.onClick();
  runtime.toggles()[2].props.onClick();
  runtime.render(TocPanel, ui);
  state.tocAnchor = { bookId: 'book', chapterIndex: 0, fragment: 'third' };
  runtime.render(TocPanel, ui);
  assert.equal(runtime.items().find((item) => item.props['aria-current']).props.children[0], 'Third');
  assert.equal(runtime.toggles()[1].props['aria-expanded'], true);
  assert.equal(runtime.toggles()[2].props['aria-expanded'], false);
  runtime.toggles()[0].props.onClick();
  runtime.render(TocPanel, ui);
  state.tocAnchor = { bookId: 'book', chapterIndex: 0, fragment: 'first' };
  runtime.render(TocPanel, ui);
  assert.equal(runtime.toggles()[0].props['aria-expanded'], true);
  assert.equal(runtime.items().find((item) => item.props['aria-current']).props.children[0], 'First');
});

test('panel clicks preserve chapter jumps with PDF resolve objects and warn for unresolved items', async () => {
  const runtime = harness();
  const { TocPanel } = await bundle('../src/ui/toc.js', runtime.globals);
  const state = { bookId: 'pdf', chapterIndex: 1 };
  const jumps = [], warnings = [];
  const pdf = { book: { toc: [{ href: 'page:2' }, { href: 'missing' }] }, resolveLink: (_index, href) => href === 'page:2' ? { chapterIndex: 1 } : null };
  const ui = { useSel: (select) => select(state), engineOf: () => pdf, goChapter: (index) => jumps.push(index), toast: (...args) => warnings.push(args) };
  runtime.render(TocPanel, ui);
  runtime.items().forEach((item) => item.props.onClick());
  assert.deepEqual(jumps, [1]);
  assert.deepEqual(warnings, [['无法定位该目录项', 'warn']]);
});
