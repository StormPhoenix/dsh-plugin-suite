import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { LIBRARY_MESSAGES } from '../src/ui/library-locale.js';

// Observe component output and event handlers without a second React installation.
async function load(entry) {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'] });
  const module = { exports: {} };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => [initial, () => {}], useRef: () => ({ current: null }),
    useMemo: (fn) => fn(), useEffect() {}, Fragment: 'fragment',
  };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: () => react });
  return module.exports;
}
const { LibraryView } = await load('../src/ui/library.js');
const { ImportQueueView } = await load('../src/ui/import-queue.js');
const walk = (node) => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function harness(snapshot, language = 'zh') {
  const events = [];
  const ui = { useSel: (select) => select({ importQueue: snapshot }), status: () => ({}), books: () => [], readingStateOf: () => 'new', store: { set() {} },
    t(key, fallback) { return key.split('.').reduce((value, segment) => value?.[segment], LIBRARY_MESSAGES[language]) ?? fallback; },
    enqueueImports: (files) => events.push(['enqueue', ...files]), stopImports: () => events.push(['stop']), resumeImports: () => events.push(['resume']),
    retryImport: (id) => events.push(['retry', id]), retryFailedImports: () => events.push(['retryAll']), cancelImport: (id) => events.push(['cancel', id]), clearImports: () => events.push(['clear']), backToLibrary: () => events.push(['library']),
  };
  return { ui, events };
}

test('file picker enables multiple and snapshots all files before resetting input', () => {
  const app = harness({ mode: 'running', items: [] });
  const nodes = walk(LibraryView({ ui: app.ui }));
  const input = nodes.find((node) => node.type === 'input' && node.props.type === 'file');
  assert.equal(input.props.multiple, true);
  const files = [{ name: 'a.txt' }, { name: 'b.epub' }];
  const target = { files, value: 'selection' };
  input.props.onChange({ target });
  assert.equal(target.value, ''); assert.deepEqual(Array.from(app.events[0]), ['enqueue', ...files]);
  input.props.onChange({ target: { files: [], value: '' } });
  assert.equal(app.events.length, 1);
  const add = nodes.find((node) => node.type === 'button' && node.children.includes('追加文件'));
  assert.ok(add); assert.notEqual(add.props.disabled, true);
});

test('queue renders localized outcomes and routes all controls to their own task', () => {
  const app = harness({ mode: 'running', items: [
    { id: 'a', filename: 'a.txt', status: 'waiting', attempts: 0 },
    { id: 'b', filename: 'b.txt', status: 'failed', attempts: 1, error: 'bad file' },
    { id: 'c', filename: 'c.txt', status: 'browser', attempts: 1, warning: 'offline' },
  ] });
  const nodes = walk(ImportQueueView({ ui: app.ui }));
  const click = (label) => nodes.find((node) => node.type === 'button' && node.children.includes(label)).props.onClick();
  click('停止后续导入'); click('重试全部失败'); click('取消此项'); click('重试'); click('重试保存到书库'); click('清除已处理记录');
  assert.deepEqual(app.events, [['stop'], ['retryAll'], ['cancel', 'a'], ['retry', 'b'], ['retry', 'c'], ['clear']]);
  assert.ok(nodes.some((node) => node.children.includes('bad file')));
  assert.ok(nodes.some((node) => node.children.includes('offline')));
  const english = harness({ mode: 'paused', items: [{ id: 'a', filename: 'a.txt', status: 'waiting' }] }, 'en');
  const paused = walk(ImportQueueView({ ui: english.ui }));
  paused.find((node) => node.type === 'button' && node.children.includes('Continue')).props.onClick();
  assert.deepEqual(english.events, [['resume']]);
  const compact = walk(ImportQueueView({ ui: english.ui, compact: true }));
  compact.find((node) => node.type === 'button').props.onClick();
  assert.deepEqual(english.events.at(-1), ['library']);
});
