import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataLayer } from '../src/client/bridge.js';
const file = { name: 'tagged.txt', arrayBuffer: async () => new TextEncoder().encode('tagged content').buffer };
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('promotion migrates authoritative tags even when the client snapshot has none', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory(); let online = false, migrations = 0;
    let model = { tags: [{ id: 'topic', name: 'Topic' }], bookTags: {} };
    const host = {
      library: async () => ({ books: [], ...model }), updateBookTags() {},
      import: async () => { if (!online) throw new Error('offline'); return { book: { id: 'host-tagged', title: 'tagged', format: 'txt' } }; },
      migrateBookTags: async ({ fromId, toId }) => { migrations++; const bookTags = { ...model.bookTags, [toId]: model.bookTags[fromId] }; delete bookTags[fromId]; model = { ...model, bookTags }; return { books: [], ...model }; },
    };
    const data = createDataLayer({ host }); await data.refreshLibrary();
    const browser = await data.importBook(file);
    model.bookTags[browser.book.id] = ['topic']; online = true;
    const result = await data.importBook(file);
    assert.equal(result.migratedFrom, browser.book.id); assert.equal(migrations, 1);
    assert.deepEqual(data.getLibrary().bookTags['host-tagged'], ['topic']);
    assert.equal(data.getLibrary().bookTags[browser.book.id], undefined);
    assert.ok(data.getLibrary().books.length > 1);
  } finally { globalThis.localStorage = previous; }
});

test('browser book promotion preserves old tag association on failure and retries into host ID', async () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = memory(); let online = false, migrationFails = true;
    let model = { tags: [{ id: 'topic', name: 'Topic' }], bookTags: {} };
    const host = {
      library: async () => ({ books: [], ...model }),
      import: async () => { if (!online) throw new Error('offline'); return { book: { id: 'host-tagged', title: 'tagged', format: 'txt', source: 'upload' } }; },
      updateBookTags: async request => { model = { ...model, bookTags: { ...model.bookTags, [request.bookIds[0]]: request.tagIds } }; return model; },
      migrateBookTags: async ({ fromId, toId }) => { if (migrationFails) throw new Error('migration offline'); const bookTags = { ...model.bookTags, [toId]: model.bookTags[fromId] }; delete bookTags[fromId]; model = { ...model, bookTags }; return { ...model, books: [{ id: 'host-tagged', title: 'tagged', format: 'txt' }] }; },
    };
    const data = createDataLayer({ host }); await data.refreshLibrary();
    const browser = await data.importBook(file);
    await data.updateBookTags({ bookIds: [browser.book.id], tagIds: ['topic'], operation: 'add' });
    online = true;
    const partial = await data.importBook(file);
    assert.equal(partial.ok, true); assert.ok(partial.warning); assert.equal(partial.migratedFrom, null);
    assert.deepEqual(data.getLibrary().bookTags[browser.book.id], ['topic']);
    assert.ok(data.getLibrary().books.some(book => book.id === browser.book.id));
    migrationFails = false;
    const complete = await data.importBook(file);
    assert.equal(complete.migratedFrom, browser.book.id);
    assert.deepEqual(data.getLibrary().bookTags['host-tagged'], ['topic']);
    assert.equal(data.getLibrary().bookTags[browser.book.id], undefined);
    assert.ok(!data.getLibrary().books.some(book => book.id === browser.book.id));
  } finally { globalThis.localStorage = previous; }
});
