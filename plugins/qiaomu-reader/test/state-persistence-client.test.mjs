import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as state from '../src/core/state.js';
import { createUiStore } from '../src/ui/store.js';
import { createImportQueue } from '../src/client/import-queue.js';

const bridgeSource = await readFile(new URL('../src/client/bridge.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8');
const withoutImports = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nextState = revision => ({ ...state.createBookState('book'), revision });

function dataLayer({ host = null, saveLocalState = async () => true, loadLocalState = async () => null } = {}) {
  const context = {
    ...state, STARTER_BOOKS: [], starterCatalog: () => [],
    saveLocalState, loadLocalState, loadLocalLibrary: async () => null,
    saveLocalLibrary: async () => true, clearLocalData() {}, console,
  };
  vm.runInNewContext(`${withoutImports(bridgeSource)}\nthis.createDataLayer = createDataLayer;`, context);
  return context.createDataLayer({ host });
}

function actionsFor(data) {
  const entries = new Map();
  const disposers = [];
  const context = {
    createDataLayer: () => data, createUiStore, createImportQueue,
    React: { createElement() {} }, ShellModule: { ReaderOverlay() {} },
    LIBRARY_MESSAGES: { zh: {}, en: {} }, flattenMessages: () => ({}),
    nativeChatBridge: () => ({}), NativeConversation() {},
    console: { warn() {}, error() {} },
  };
  vm.runInNewContext(`${withoutImports(indexSource)}\nthis.apply = apply;`, context);
  context.apply({
    layout: { selectPanel() {} }, remote: {}, inject() {},
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') disposers.push(cleanup); },
    slots: { inject(_name, callback) { return callback(); }, register(options) { entries.set(options.name, options); } },
  });
  return { actions: entries.get('main').inject().actions, dispose: () => disposers.reverse().forEach(cleanup => cleanup()) };
}

test('concurrent saves retain synchronous memory and commit both stores in latest order', async () => {
  const firstLocal = deferred(), firstHost = deferred(), started = deferred(), secondStarted = deferred();
  const calls = [], stored = {};
  const save = store => async (_id, value) => {
    calls.push(`${store}:${value.revision}`);
    if (calls.length === 2) started.resolve();
    if (value.revision === 1) await (store === 'local' ? firstLocal : firstHost).promise;
    stored[store] = value.revision;
    if (value.revision === 2) secondStarted.resolve();
    return true;
  };
  const data = dataLayer({ host: { saveState: save('host') }, saveLocalState: save('local') });
  const first = data.persistState('book', nextState(1));
  assert.equal(first, data.getState('book'));
  const firstSaved = data.awaitPendingStateSaves('book');
  await started.promise;
  const latest = data.persistState('book', nextState(2));
  assert.equal(latest, data.getState('book'));
  let loaded = false;
  const ensure = data.ensureState('book').then(value => { loaded = true; return value; });
  firstLocal.resolve();
  await firstLocal.promise;
  assert.equal(loaded, false);
  assert.deepEqual(calls, ['local:1', 'host:1']);
  firstHost.resolve();
  assert.equal((await firstSaved).ok, true);
  await secondStarted.promise;
  assert.equal((await data.awaitPendingStateSaves('book')).ok, true);
  assert.equal(await ensure, latest);
  assert.deepEqual(calls, ['local:1', 'host:1', 'local:2', 'host:2']);
  assert.deepEqual(stored, { local: 2, host: 2 });
  data.dispose();
});

test('a state fetch started before a save cannot replace its newer memory state', async () => {
  const fetched = deferred(), entered = deferred();
  const data = dataLayer({ host: {
    loadState() { entered.resolve(); return fetched.promise; },
    async saveState() {},
  } });
  const loading = data.ensureState('book');
  await entered.promise;
  const latest = data.persistState('book', nextState(2));
  await data.awaitPendingStateSaves('book');
  fetched.resolve(nextState(1));
  assert.equal(await loading, latest);
  assert.equal(data.getState('book'), latest);
  data.dispose();
});

test('a subscriber save joins the queue after the save that emitted it', async () => {
  const committed = [];
  const data = dataLayer({ saveLocalState: async (_id, value) => { committed.push(value.revision); return true; } });
  const unsubscribe = data.subscribe(() => {
    if (data.getState('book').revision === 1) data.persistState('book', nextState(2));
  });
  data.persistState('book', nextState(1));
  await data.awaitPendingStateSaves('book');
  assert.deepEqual(committed, [1, 2]);
  assert.equal(data.getState('book').revision, 2);
  unsubscribe();
  data.dispose();
});

test('one book does not block saves or state loads for another book', async () => {
  const held = deferred(), entered = deferred();
  let fetched = 0;
  const data = dataLayer({ host: {
    async saveState(id) { if (id === 'book') { entered.resolve(); await held.promise; } },
    async loadState(id) { fetched++; return state.createBookState(id); },
  } });
  data.persistState('book', nextState(1));
  await entered.promise;
  data.persistState('another', nextState(2));
  assert.equal((await data.awaitPendingStateSaves('another')).ok, true);
  assert.equal((await data.ensureState('unloaded')).bookId, 'unloaded');
  assert.equal(fetched, 1);
  held.resolve();
  await data.awaitPendingStateSaves('book');
  data.dispose();
});

test('a failed save reports failure and a queued explicit save recovers without retries', async () => {
  const held = deferred(), entered = deferred();
  const attempts = [];
  const data = dataLayer({
    saveLocalState: async (_id, value) => { attempts.push(`local:${value.revision}`); return value.revision === 2; },
    host: { async saveState(_id, value) {
      attempts.push(`host:${value.revision}`);
      if (value.revision === 1) { entered.resolve(); await held.promise; throw new Error('offline'); }
    } },
  });
  data.persistState('book', nextState(1));
  const failed = data.awaitPendingStateSaves('book');
  await entered.promise;
  data.persistState('book', nextState(2));
  const recovered = data.awaitPendingStateSaves('book');
  held.resolve();
  assert.equal((await failed).ok, false);
  assert.equal((await recovered).ok, true);
  assert.equal(data.getState('book').revision, 2);
  assert.deepEqual(attempts, ['local:1', 'host:1', 'local:2', 'host:2']);
  assert.equal((await data.awaitPendingStateSaves('book')).ok, true);
  data.dispose();
});

for (const scenario of [
  { name: 'offline browser success', local: true, host: null, ok: true },
  { name: 'browser success with host rejection', local: true, host: () => Promise.reject(new Error('offline')), ok: true },
  { name: 'host success with browser failure', local: false, host: async () => undefined, ok: true },
  { name: 'both stores fail', local: false, host: () => { throw new Error('offline'); }, ok: false },
  { name: 'offline browser failure', local: false, host: null, ok: false },
]) {
  test(`saveState action awaits settlement: ${scenario.name}`, async () => {
    const held = deferred(), entered = deferred();
    const data = dataLayer({
      saveLocalState: async () => { entered.resolve(); await held.promise; return scenario.local; },
      host: scenario.host ? { saveState: scenario.host } : null,
    });
    const app = actionsFor(data);
    try {
      let settled = false;
      const saving = app.actions.saveState('book', nextState(1)).then(result => { settled = true; return result; });
      assert.equal(data.getState('book').revision, 1);
      await entered.promise;
      assert.equal(settled, false);
      held.resolve();
      const result = await saving;
      assert.equal(result.ok, scenario.ok);
      if (!scenario.ok) assert.match(result.error, /保存失败/);
      assert.equal((await data.awaitPendingStateSaves('book')).ok, scenario.ok);
    } finally { held.resolve(); await data.awaitPendingStateSaves('book'); app.dispose(); }
  });
}

test('synchronous local storage exception does not prevent a host save', async () => {
  let hostCalls = 0;
  const data = dataLayer({ saveLocalState() { throw new Error('quota'); }, host: { saveState() { hostCalls++; } } });
  assert.doesNotThrow(() => data.persistState('book', nextState(1)));
  assert.equal((await data.awaitPendingStateSaves('book')).ok, true);
  assert.equal(hostCalls, 1);
  data.dispose();
});

// Verify the real storage adapter separately from the controlled queue fixture.
test('browser storage save reports both unavailable stores as false and localStorage fallback as true', async () => {
  const source = await readFile(new URL('../src/client/storage.js', import.meta.url), 'utf8');
  const context = {};
  vm.runInNewContext(`${withoutImports(source)}\nthis.save = saveLocalState;`, context);
  assert.equal(await context.save('book', nextState(1)), false);
  const values = new Map();
  context.localStorage = { setItem: (key, value) => values.set(key, value) };
  assert.equal(await context.save('book', nextState(2)), true);
  assert.equal(JSON.parse(values.get('qmr:state:book')).revision, 2);
});
