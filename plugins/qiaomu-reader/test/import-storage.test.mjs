import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataLayer } from '../src/client/bridge.js';
import { addHighlight, createBookState } from '../src/core/state.js';
import { loadLocalLibrary } from '../src/client/storage.js';
const file = (name, text) => ({ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const memory = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; };

test('offline import requires durable bytes and index; same content keeps one entry', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory();
    const data = createDataLayer();
    await data.refreshLibrary();
    const first = await data.importBook(file('a.txt', 'same content'));
    const second = await data.importBook(file('b.txt', 'same content'));
    assert.equal(first.storage, 'browser'); assert.equal(second.existing, true);
    assert.equal(data.getLibrary().books.filter((book) => book.id === first.book.id).length, 1);
    const different = await data.importBook(file('a.txt', 'different content'));
    assert.notEqual(first.book.id, different.book.id);
    globalThis.localStorage = { setItem() { throw new Error('quota'); }, getItem() { return null; } };
    const failed = await data.importBook(file('fail.txt', 'cannot save'));
    assert.equal(failed.ok, false);
    assert.ok(!data.getLibrary().books.some((book) => book.title === 'fail'));
  } finally { globalThis.localStorage = previous; }
});

test('host success remains success when cache fails, and invalid files fail', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { setItem() { throw new Error('quota'); }, getItem() { return null; } };
    const data = createDataLayer({ host: { library: async () => ({ books: [] }), import: async () => ({ book: { id: 'host-book', title: 'Saved', format: 'txt' }, existing: true }) } });
    await data.refreshLibrary();
    const result = await data.importBook(file('saved.txt', 'content'));
    assert.equal(result.ok, true); assert.equal(result.storage, 'host'); assert.equal(result.existing, true); assert.ok(result.warning);
    assert.equal((await data.importBook(file('empty.txt', ''))).ok, false);
    assert.equal((await data.importBook(file('bad.doc', 'content'))).ok, false);
    assert.equal((await data.importBook(file('bad.epub', 'invalid archive'))).ok, false);
  } finally { globalThis.localStorage = previous; }
});

test('browser index failure is not reported as an offline success', async () => {
  const previous = globalThis.localStorage;
  try {
    const values = new Map();
    globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem(key, value) { if (key === 'qmr:library') throw new Error('index full'); values.set(key, value); } };
    const data = createDataLayer(); await data.refreshLibrary();
    const result = await data.importBook(file('index.txt', 'readable bytes'));
    assert.equal(result.ok, false);
    assert.ok(!data.getLibrary().books.some((book) => book.title === 'index'));
  } finally { globalThis.localStorage = previous; }
});

test('retry promotes browser book to host and transfers highlights without duplicate records', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory(); let online = false; const books = []; let saved;
    const host = { library: async () => ({ books }), import: async () => { if (!online) throw new Error('offline'); const book = { id: 'sha-host', title: 'offline', format: 'txt', source: 'upload' }; books.splice(0, books.length, book); return { book }; },
      loadState: async () => null, saveState: async (_id, value) => { saved = value; } };
    const data = createDataLayer({ host }); await data.refreshLibrary();
    const original = await data.importBook(file('offline.txt', 'paragraph'));
    data.persistState(original.book.id, addHighlight(createBookState(original.book.id), { text: 'paragraph', chapterHref: 'part-1' }).state);
    online = true;
    const promoted = await data.importBook(file('offline.txt', 'paragraph'));
    assert.equal(promoted.storage, 'host'); assert.equal(promoted.migratedFrom, original.book.id);
    assert.equal(saved.highlights.length, 1); assert.equal(saved.bookId, 'sha-host');
    const reloaded = createDataLayer({ host }); await reloaded.refreshLibrary();
    assert.equal(reloaded.getLibrary().books.filter((book) => ['sha-host', original.book.id].includes(book.id)).length, 1);
  } finally { globalThis.localStorage = previous; }
});

test('refresh and import serialize so a held stale response cannot replace new catalog', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory(); let release; let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; }); let imported = false;
    const data = createDataLayer({ host: { library: async () => { entered(); await held; return { books: [] }; }, import: async () => { imported = true; return { book: { id: 'new-host', title: 'new', format: 'txt' } }; } } });
    const refresh = data.refreshLibrary(); await started;
    const importing = data.importBook(file('new.txt', 'new content'));
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(imported, false);
    release(); await refresh; await importing;
    assert.ok(data.getLibrary().books.some((book) => book.id === 'new-host'));
    assert.ok((await loadLocalLibrary()).books.some((book) => book.id === 'new-host'));
  } finally { globalThis.localStorage = previous; }
});

test('partial IndexedDB index failure selects newest localStorage fallback after reload', async () => {
  const previousDb = globalThis.indexedDB; const previousLs = globalThis.localStorage;
  const indexes = new Map([['index', { books: [{ id: 'old' }] }]]); let abort = true;
  try {
    globalThis.localStorage = memory();
    globalThis.indexedDB = { open() { const open = {}; queueMicrotask(() => { open.result = { transaction() {
      const tx = {}; const store = { get(key) { const request = {}; queueMicrotask(() => { request.result = indexes.get(key); request.onsuccess(); tx.oncomplete(); }); return request; },
        put(value, key) { const request = {}; queueMicrotask(() => { request.result = key; request.onsuccess(); if (abort) tx.onabort(); else { indexes.set(key, value); tx.oncomplete(); } }); return request; } };
      tx.objectStore = () => store; return tx;
    } }; open.onsuccess(); }); return open; } };
    const storage = await import(`../src/client/storage.js?fallback=${Date.now()}`);
    assert.equal(await storage.saveLocalLibrary({ books: [{ id: 'new' }] }), true);
    const reloaded = await import(`../src/client/storage.js?reload=${Date.now()}`);
    assert.equal((await reloaded.loadLocalLibrary()).books[0].id, 'new');
    abort = false; assert.equal(await reloaded.saveLocalLibrary({ books: [{ id: 'latest' }] }), true);
    assert.equal((await reloaded.loadLocalLibrary()).books[0].id, 'latest');
  } finally { globalThis.indexedDB = previousDb; globalThis.localStorage = previousLs; }
});

test('IndexedDB request success waits for transaction commit and abort falls back', async () => {
  const previousDb = globalThis.indexedDB; const previousLs = globalThis.localStorage;
  let transaction; let request; let committed = false;
  try {
    globalThis.localStorage = undefined;
    globalThis.indexedDB = { open() { const open = {}; queueMicrotask(() => { open.result = { transaction() { request = {}; transaction = { objectStore: () => ({ put: () => request }) }; queueMicrotask(() => { request.result = 'key'; request.onsuccess(); }); return transaction; } }; open.onsuccess(); }); return open; } };
    const storage = await import(`../src/client/storage.js?commit=${Date.now()}`);
    const pending = storage.saveBookBytes('x', new Uint8Array([1])).then((value) => { committed = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(committed, false);
    transaction.oncomplete(); assert.equal(await pending, true);
    const aborted = storage.saveBookBytes('y', new Uint8Array([2]));
    await new Promise((resolve) => setImmediate(resolve));
    transaction.onabort(); assert.equal(await aborted, false);
  } finally { globalThis.indexedDB = previousDb; globalThis.localStorage = previousLs; }
});
