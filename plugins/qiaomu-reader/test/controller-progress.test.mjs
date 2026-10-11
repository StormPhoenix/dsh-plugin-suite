import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/controller.js'], bundle: true, write: false, format: 'cjs', external: ['react'] });
test('throttled saves read latest position and departure cancels stale timers', async () => {
  const timers = new Map(); let next = 0;
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => ({}),
    setTimeout: (fn) => { timers.set(++next, fn); return next; }, clearTimeout: (id) => timers.delete(id), console });
  let state = { states: { book: { locator: { chapterIndex: 0, scroll: 0 }, settings: {}, highlights: [] } } };
  const saved = [];
  const store = { get: () => state, set: (patch) => { state = { ...state, ...patch }; }, subscribe: () => () => {} };
  const ui = module.exports.createController(() => ({ actions: { saveState: (id, value) => { saved.push(value); return { ok: true }; } } }), store);
  ui.reportPosition('book', { chapterIndex: 0, scroll: 0.2 });
  ui.reportPosition('book', { chapterIndex: 0, scroll: 0.7 });
  assert.equal(timers.size, 1);
  const [id, fn] = [...timers][0]; timers.delete(id); fn();
  assert.equal(saved[0].locator.scroll, 0.7);
  ui.reportPosition('book', { chapterIndex: 0, scroll: 0.8 });
  await ui.flushPendingSaves();
  assert.equal(saved[1].locator.scroll, 0.8);
  assert.equal(timers.size, 0);
  await ui.flushPendingSaves();
  assert.equal(saved.length, 2);
});
