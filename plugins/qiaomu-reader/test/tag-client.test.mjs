import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataLayer } from '../src/client/bridge.js';
import { loadLocalLibrary } from '../src/client/storage.js';

const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const catalog = () => ({ books: [], tags: [{ id: 'tag-invest', name: '投资' }], bookTags: { starter: ['tag-invest'] } });

test('host tags remain cached across refresh and offline filtering; offline writes fail', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory();
    const online = createDataLayer({ host: { library: async () => catalog(), updateBookTags() {} } });
    await online.refreshLibrary();
    assert.equal(online.canEditTags(), true);
    const offline = createDataLayer(); await offline.refreshLibrary();
    assert.deepEqual(offline.getLibrary().bookTags.starter, ['tag-invest']);
    assert.equal(offline.canEditTags(), false);
    assert.equal((await offline.createTag({ name: 'new' })).ok, false);
  } finally { globalThis.localStorage = previous; }
});

test('tag edits publish only confirmed snapshots and distinguish cache failure', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory();
    let fail = true;
    const host = { library: async () => catalog(), updateBookTags: async () => { if (fail) throw new Error('rejected'); return { books: [], tags: catalog().tags, bookTags: { starter: ['tag-invest'], another: ['tag-invest'] } }; } };
    const data = createDataLayer({ host }); await data.refreshLibrary();
    const imported = await data.importBook({ name: 'offline.txt', arrayBuffer: async () => new TextEncoder().encode('offline tagged content').buffer });
    const retainedIds = data.getLibrary().books.map(book => book.id);
    assert.ok(retainedIds.includes(imported.book.id));
    let published = 0; data.subscribe(() => published++);
    assert.equal((await data.updateBookTags({ bookIds: ['another'], tagIds: ['tag-invest'], operation: 'add' })).ok, false);
    assert.equal(published, 0); assert.equal(data.getLibrary().bookTags.another, undefined);
    fail = false;
    assert.equal((await data.updateBookTags({})).ok, true);
    assert.deepEqual((await loadLocalLibrary()).bookTags.another, ['tag-invest']);
    assert.deepEqual(data.getLibrary().books.map(book => book.id), retainedIds);
    assert.deepEqual((await loadLocalLibrary()).books.map(book => book.id), retainedIds);
    globalThis.localStorage = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
    assert.equal((await data.updateBookTags({})).warning, 'TAG_CACHE_FAILED');
  } finally { globalThis.localStorage = previous; }
});

test('book renaming requires host ownership and publishes only its confirmed record', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: memory() });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  const book = { id: 'host-book', title: 'Original', format: 'txt', file: 'books/host-book.txt' };
  let fail = true, calls = 0;
  const data = createDataLayer({ host: {
    library: async () => ({ ...catalog(), books: [book] }),
    renameBook: async ({ title }) => { calls++; if (fail) throw new Error('rejected'); return { book: { ...book, title, originalTitle: book.title } }; },
  } });
  t.after(() => data.dispose());
  await data.refreshLibrary();
  assert.equal(data.canRenameBook(book.id), true);
  assert.equal(data.canRenameBook('browser-only'), false);
  const ids = data.getLibrary().books.map(entry => entry.id);
  for (const id of ids.filter(id => id !== book.id)) assert.equal(data.canRenameBook(id), false);
  assert.equal((await data.renameBook({ bookId: 'browser-only', title: 'Blocked' })).ok, false);
  assert.equal(calls, 0);
  let published = 0; const unsubscribe = data.subscribe(() => published++); t.after(unsubscribe);
  assert.equal((await data.renameBook({ bookId: book.id, title: 'New' })).ok, false);
  assert.equal(published, 0);
  assert.equal(data.getLibrary().books.find(entry => entry.id === book.id).title, 'Original');
  fail = false;
  assert.equal((await data.renameBook({ bookId: book.id, title: 'New' })).ok, true);
  assert.deepEqual(data.getLibrary().books.map(entry => entry.id), ids);
  assert.equal((await loadLocalLibrary()).books.find(entry => entry.id === book.id).title, 'New');
  assert.deepEqual(data.getLibrary().bookTags, catalog().bookTags);
  globalThis.localStorage = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
  assert.equal((await data.renameBook({ bookId: book.id, title: 'Latest' })).warning, 'BOOK_CACHE_FAILED');
  assert.equal(data.getLibrary().books.find(entry => entry.id === book.id).title, 'Latest');
  const offline = createDataLayer(); t.after(() => offline.dispose()); await offline.refreshLibrary();
  assert.equal(offline.canRenameBook(book.id), false);
});

test('disposed data layer does not publish a pending rename confirmation', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: memory() });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  const book = { id: 'host-book', title: 'Original', format: 'txt' };
  let resolve, entered;
  const started = new Promise(done => { entered = done; });
  const data = createDataLayer({ host: {
    library: async () => ({ ...catalog(), books: [book] }),
    renameBook: () => { entered(); return new Promise(done => { resolve = done; }); },
  } });
  t.after(() => data.dispose()); await data.refreshLibrary();
  let published = 0; data.subscribe(() => published++);
  const pending = data.renameBook({ bookId: book.id, title: 'New' });
  await started; data.dispose(); resolve({ book: { ...book, title: 'New' } });
  assert.equal((await pending).ok, false);
  assert.equal(published, 0);
  assert.equal(data.getLibrary().books.find(entry => entry.id === book.id).title, 'Original');
});

test('disposed data layer does not publish a pending tag mutation', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory(); let resolve, entered;
    const started = new Promise(done => { entered = done; });
    const data = createDataLayer({ host: { library: async () => catalog(), updateBookTags: () => { entered(); return new Promise(done => { resolve = done; }); } } });
    await data.refreshLibrary(); let published = 0; data.subscribe(() => published++);
    const pending = data.updateBookTags({}); await started; data.dispose(); resolve(catalog());
    assert.equal((await pending).ok, false); assert.equal(published, 0);
  } finally { globalThis.localStorage = previous; }
});
