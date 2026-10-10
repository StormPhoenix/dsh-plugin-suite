import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { LIBRARY_MESSAGES, flattenMessages } from '../src/ui/library-locale.js';

// Bundle the actual modules and retain hook state across user actions.
async function renderer(entry) {
  let active; let cursor; let effects = [];
  const instances = new Map();
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), Fragment: 'fragment',
    useState(initial) { const index = cursor++; if (!(index in active)) active[index] = typeof initial === 'function' ? initial() : initial; const owner = active; return [owner[index], value => { owner[index] = typeof value === 'function' ? value(owner[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return active[index] ||= { current: initial }; },
    useMemo(fn, deps) { const index = cursor++; if (!active[index] || deps.some((value, i) => !Object.is(value, active[index].deps[i]))) active[index] = { deps, value: fn() }; return active[index].value; },
    useEffect(fn, deps) { const index = cursor++; if (!active[index] || !deps || deps.some((value, i) => !Object.is(value, active[index].deps[i]))) { const owner = active; effects.push(() => { owner[index]?.cleanup?.(); owner[index] = { deps: deps || [], cleanup: fn() }; }); } },
  };
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react', 'react-dom'] });
  const module = { exports: {} };
  const listeners = new Map(); let focused = 0;
  const document = { body: {}, activeElement: { focus() { focused++; } }, addEventListener(key, fn) { listeners.set(key, fn); }, removeEventListener(key, fn) { if (listeners.get(key) === fn) listeners.delete(key); } };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, document, require: name => name === 'react-dom' ? { createPortal: node => node } : react });
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      active = instances.get(path) || []; instances.set(path, active); cursor = 0;
      return expand(node.type({ ...node.props, children: node.children }), `${path}/component`);
    }
    if (node.props.ref) node.props.ref.current = { querySelectorAll: () => [], focus() { focused++; } };
    return { ...node, children: node.children.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`)) };
  }
  return { exports: module.exports, render(Component, props) { effects = []; const root = expand(react.createElement(Component, props)); const pending = effects; effects = []; pending.forEach(fn => fn()); return root; }, unmount() { for (const instance of instances.values()) for (const slot of instance) slot?.cleanup?.(); instances.clear(); }, listeners, focused: () => focused };
}
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
const text = node => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? '');
const button = (root, label) => { const node = walk(root).find(node => node.type === 'button' && text(node) === label); assert.ok(node, `Missing button: ${label}`); return node; };
const input = (root, type) => walk(root).find(node => node.type === 'input' && node.props.type === type);
function harness(state = {}, language = 'en') {
  let books = [{ id: 'a', title: 'Alpha', author: 'Author', format: 'epub' }, { id: 'b', title: 'Beta', format: 'pdf' }, { id: 'c', title: 'Gamma', format: 'epub' }];
  let catalog = { tags: [{ id: 'x', name: 'History' }, { id: 'y', name: 'Science' }, { id: 'z', name: 'Favourite' }], bookTags: { a: ['x', 'y', 'z'], b: ['y'] } };
  const calls = [];
  const snapshot = { dataRevision: 1, ...state };
  const ui = {
    useSel: select => select(snapshot), store: { set: patch => Object.assign(snapshot, patch) }, books: () => books, tagCatalog: () => catalog,
    status: () => ({}), canEditTags: () => true, readingStateOf: () => 'new', highlightCountOf: () => 0, progressOfBook: () => 0, loadState: async () => {},
    t: (key, fallback) => flattenMessages(LIBRARY_MESSAGES[language])[key] ?? fallback,
    updateBookTags: async request => { calls.push(['update', JSON.parse(JSON.stringify(request))]); return { ok: true }; },
    createTag: async request => { calls.push(['create', JSON.parse(JSON.stringify(request))]); return { ok: true }; },
    renameTag: async request => { calls.push(['rename', JSON.parse(JSON.stringify(request))]); return { ok: true }; },
    deleteTag: async request => { calls.push(['delete', JSON.parse(JSON.stringify(request))]); return { ok: true }; },
  };
  return { ui, calls, snapshot, books: value => { books = value; snapshot.dataRevision++; }, catalog: value => { catalog = value; snapshot.dataRevision++; } };
}

test('tag filter searches existing choices, supports any/all and exclusive no-tags', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness();
  const props = () => ({ ui: app.ui, ids: app.snapshot.libraryTagIds || [], mode: app.snapshot.libraryTagMode || 'any', untagged: !!app.snapshot.libraryUntagged, onClose() {} });
  const render = () => r.render(r.exports.TagFilter, props()); let root = render();
  input(root, 'search').props.onChange({ target: { value: 'hist' } }); root = render();
  assert.equal(walk(root).filter(node => node.props['aria-pressed'] !== undefined).length, 1);
  walk(root).find(node => node.props['aria-pressed'] !== undefined).props.onClick(); root = render(); assert.deepEqual(Array.from(app.snapshot.libraryTagIds), ['x']);
  walk(root).find(node => node.type === 'select').props.onChange({ target: { value: 'all' } });
  walk(root).filter(node => node.type === 'input' && node.props.type === 'checkbox').at(-1).props.onChange({ target: { checked: true } });
  assert.equal(app.snapshot.libraryUntagged, true); assert.deepEqual(Array.from(app.snapshot.libraryTagIds), []);
  root = render(); input(root, 'checkbox').props.onChange({ target: { checked: false } }); assert.equal(app.snapshot.libraryUntagged, false);
  assert.equal(app.calls.length, 0);
});

test('whole-list tag intersection preserves title, format and reading filters', async () => {
  const r = await renderer('../src/ui/library.js'); const app = harness({ libraryTagIds: ['x', 'y'], libraryTagMode: 'all', libraryFormat: 'epub', libraryQuery: 'alpha' });
  let root = r.render(r.exports.LibraryView, { ui: app.ui });
  assert.deepEqual(walk(root).filter(node => node.props.role === 'listitem').map(node => text(node).includes('Alpha')), [true]);
  assert.ok(button(root, 'Tag filter')); assert.ok(button(root, 'Clear all filters'));
  const chips = walk(root).filter(node => node.props.className === 'qmr-tag-badge' && node.type === 'span');
  assert.ok(chips.some(node => text(node) === '+1')); assert.ok(chips.every(node => node.type === 'span' && !node.props.onClick));
  button(root, 'Clear all filters').props.onClick(); assert.equal(app.snapshot.libraryTagMode, 'any');
  app.ui.store.set({ libraryUntagged: true }); root = r.render(r.exports.LibraryView, { ui: app.ui });
  assert.equal(walk(root).filter(node => node.props.role === 'listitem').length, 1); assert.ok(text(root).includes('Gamma'));
  app.ui.store.set({ libraryUntagged: false, libraryFilter: 'reading' }); root = r.render(r.exports.LibraryView, { ui: app.ui }); assert.equal(walk(root).filter(node => node.props.role === 'listitem').length, 0);
});

const typeTag = (root, value) => input(root, 'text').props.onChange({ target: { value } });
const enterTag = root => input(root, 'text').props.onKeyDown({ key: 'Enter', preventDefault() {} });

test('Enter stages new names and reuses existing tags without writing until confirmation', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness(); let closed = 0;
  const props = { ui: app.ui, bookIds: ['a', 'b'], mode: 'add', onClose: () => closed++ };
  const render = () => r.render(r.exports.BookTagEditor, props); let root = render();
  assert.equal(walk(root).filter(node => node.type === 'input').length, 1);
  typeTag(root, ' history '); root = render(); enterTag(root); root = render();
  typeTag(root, ' New tag '); root = render(); enterTag(root); root = render();
  assert.equal(app.calls.length, 0); assert.equal(input(root, 'text').props.value, '');
  button(root, 'Cancel').props.onClick(); assert.equal(closed, 1); assert.equal(app.calls.length, 0);
  await button(root, 'Confirm add').props.onClick();
  assert.deepEqual(app.calls, [['update', { bookIds: ['a', 'b'], tagIds: ['x'], operation: 'add', newTagNames: ['New tag'] }]]);
});

test('single replacement supports removing chips and creates names atomically', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness();
  const props = { ui: app.ui, bookIds: ['a'], mode: 'replace', onClose() {} };
  const render = () => r.render(r.exports.BookTagEditor, props); let root = render();
  walk(root).find(node => node.props['aria-label'] === 'Deselect tag History').props.onClick(); root = render();
  typeTag(root, 'New'); root = render(); enterTag(root); root = render(); await button(root, 'Save').props.onClick();
  assert.deepEqual(app.calls, [['update', { bookIds: ['a'], tagIds: ['y', 'z'], operation: 'replace', newTagNames: ['New'] }]]);
});

test('composition, duplicate input and validation do not create extra tags; failures retain edits', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness();
  app.ui.updateBookTags = async () => ({ ok: false });
  const props = { ui: app.ui, bookIds: ['a'], mode: 'add', onClose() { assert.fail('failure must not close'); } };
  const render = () => r.render(r.exports.BookTagEditor, props); let root = render();
  typeTag(root, 'New'); root = render(); input(root, 'text').props.onCompositionStart(); enterTag(root); root = render();
  assert.equal(input(root, 'text').props.value, 'New'); input(root, 'text').props.onCompositionEnd(); enterTag(root); root = render();
  typeTag(root, ' new '); root = render(); enterTag(root); root = render();
  assert.equal(walk(root).filter(node => node.props['aria-label'] === 'Deselect tag New').length, 1);
  typeTag(root, 'x'.repeat(41)); root = render(); enterTag(root); root = render(); assert.ok(text(root).includes('up to 40'));
  typeTag(root, ''); root = render(); await button(root, 'Confirm add').props.onClick(); root = render();
  assert.ok(text(root).includes('Please retry')); assert.ok(text(root).includes('New'));
});

test('removal candidates belong to selected books and cannot create new tags', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness();
  const props = { ui: app.ui, bookIds: ['b'], mode: 'remove', onClose() {} };
  const render = () => r.render(r.exports.BookTagEditor, props); let root = render();
  assert.ok(!text(root).includes('History')); typeTag(root, 'Unknown'); root = render(); enterTag(root); root = render();
  assert.ok(text(root).includes('No matching tags')); assert.equal(app.calls.length, 0);
  typeTag(root, 'Science'); root = render(); enterTag(root); root = render(); await button(root, 'Confirm remove').props.onClick();
  assert.deepEqual(app.calls, [['update', { bookIds: ['b'], tagIds: ['y'], operation: 'remove' }]]);
});

test('selection survives sorting, exits after successful bulk add and clears on filter changes', async () => {
  const r = await renderer('../src/ui/library.js'); const app = harness({ libraryTagIds: ['y'] });
  const render = () => r.render(r.exports.LibraryView, { ui: app.ui }); let root = render();
  const toolbar = walk(root).find(node => node.props.className === 'qmr-library-toolbar');
  assert.equal(text(toolbar.children[0]), 'Select books');
  assert.ok(!walk(toolbar).some(node => node.props.className === 'qmr-library-section-title'));
  assert.ok(!text(root).includes('Manage tags')); button(root, 'Select books').props.onClick(); root = render();
  button(root, 'Select all 2 matching books').props.onClick(); root = render();
  walk(root).find(node => node.props.className === 'qmr-library-sort').props.onChange({ target: { value: 'title' } }); root = render();
  assert.ok(text(root).includes('2 selected')); button(root, 'Add tags in bulk').props.onClick(); root = render();
  typeTag(root, 'History'); root = render(); enterTag(root); root = render(); await button(root, 'Confirm add').props.onClick(); root = render();
  assert.ok(button(root, 'Select books')); assert.ok(!text(root).includes('2 selected'));
  assert.ok(!walk(root).some(node => node.type === 'input' && node.props.type === 'checkbox'));
  button(root, 'Select books').props.onClick(); root = render();
  button(root, 'Select all 2 matching books').props.onClick(); root = render();
  input(root, 'search').props.onChange({ target: { value: 'Alpha' } }); render(); root = render();
  assert.ok(text(root).includes('0 selected')); assert.ok(button(root, 'Clear selection'));
});

test('Chinese fallback and stable theme palette work without a locale provider', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness(); app.ui.t = (_, fallback) => fallback;
  const root = r.render(r.exports.BookTagEditor, { ui: app.ui, bookIds: ['a', 'b'], mode: 'add', onClose() {} });
  assert.ok(text(root).includes('给 2 本书添加标签')); assert.ok(button(root, '确认添加'));
  assert.equal(r.exports.ManageTags, undefined);
  assert.equal(r.exports.tagColor('x'), r.exports.tagColor('x')); assert.notEqual(r.exports.tagColor('x'), r.exports.tagColor('y'));
  assert.equal(flattenMessages(LIBRARY_MESSAGES.zh)['catalog.tags.select'], '选择书籍');
  assert.ok(Object.values(flattenMessages(LIBRARY_MESSAGES.zh)).every(value => typeof value === 'string'));
});

test('dialogs use portals, dismiss on outside and Escape and restore invoking focus', async () => {
  const r = await renderer('../src/ui/library-tags.js'); const app = harness(); let closed = 0;
  const props = { ui: app.ui, title: 'Tags', onClose: () => closed++, children: [] };
  const root = r.render(r.exports.TagOverlay, props); assert.ok(walk(root).some(node => node.props['aria-modal'] === true));
  const backdrop = walk(root).find(node => node.props.className?.includes('qmr-tag-backdrop'));
  backdrop.props.onPointerDown({ target: 1, currentTarget: 2 }); assert.equal(closed, 0);
  backdrop.props.onPointerDown({ target: 1, currentTarget: 1 }); assert.equal(closed, 1);
  r.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(closed, 2);
  r.render(r.exports.TagOverlay, { ...props, busy: true }); assert.equal(r.focused(), 0);
  r.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(closed, 2);
  r.unmount(); assert.equal(r.focused(), 1); assert.equal(r.listeners.size, 0);
});

test('tag dictionaries expose matching English and Chinese keys', () => {
  assert.deepEqual(Object.keys(LIBRARY_MESSAGES.en.catalog.tags).sort(), Object.keys(LIBRARY_MESSAGES.zh.catalog.tags).sort());
});
