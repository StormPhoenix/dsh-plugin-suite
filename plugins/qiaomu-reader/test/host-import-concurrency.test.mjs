import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hostURL = new URL('../src/host/index.js', import.meta.url).href;
const moduleURL = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
// Only the unavailable Remote peer is replaced; apply and all persistence code are real.
const protocolURL = moduleURL(`
  export class TypertRemoteService {}
  export const Remote = () => () => {};
`);
// Gate one real index read after taking its snapshot, without replacing filesystem results.
const filesystemURL = moduleURL(`
  import * as fs from 'node:fs/promises';
  export const { mkdir, readdir, rename, rm, stat, writeFile, copyFile } = fs;
  let pending;
  export function gateRead(file) {
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const resumed = new Promise(resolve => { release = resolve; });
    pending = { file, entered, resumed };
    return { reached, release };
  }
  export async function readFile(file, ...args) {
    const gate = pending?.file === file ? pending : null;
    if (gate) pending = null;
    const result = await fs.readFile(file, ...args);
    if (gate) { gate.entered(); await gate.resumed; }
    return result;
  }
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hostURL) {
      if (specifier === '@deepseek-ai/dsh-typert-protocol') return { url: protocolURL, shortCircuit: true };
      if (specifier === 'node:fs/promises') return { url: filesystemURL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let apply, inject, gateRead;
try {
  ({ apply, inject } = await import(hostURL));
  ({ gateRead } = await import(filesystemURL));
} finally {
  hooks.deregister();
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'qiaomu-host-'));
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  const disposers = [];
  const tools = new Map();
  const commands = new Map();
  const registry = (entries) => ({ register(definition) {
    assert.equal(entries.has(definition.name), false);
    entries.set(definition.name, definition);
    return () => entries.delete(definition.name);
  } });
  const services = new Map([['tools', registry(tools)], ['commands', registry(commands)], ['sessions', {}]]);
  const api = apply({
    get(name) { assert.ok(inject.includes(name)); return services.get(name); },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); },
    logger: { info() {} },
  }, { workspaceRoot: root });
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    assert.equal(tools.size, 0);
    assert.equal(commands.size, 0);
    // root is the exact private directory returned by mkdtemp above.
    await rm(root, { recursive: true, force: true });
  });
  await api.library();
  const base = api.info().root;
  return { api, root, base, tools, commands,
    index: () => readFile(path.join(base, 'library.json'), 'utf8').then(JSON.parse),
  };
}

const upload = (text, title = text) => ({ filename: `${title}.txt`, title, base64: Buffer.from(text).toString('base64') });
const state = (text) => ({ highlights: [{ id: text, text, chapterHref: 'part-1', color: 'yellow', percent: 0.2 }], bookmarks: [], settings: {} });

test('concurrent different and identical imports retain all books and report duplicates', async (t) => {
  const app = await harness(t);
  const results = await Promise.all([
    app.api.import(upload('alpha')),
    app.api.import(upload('beta')),
    app.api.import(upload('alpha', 'alpha updated')),
  ]);
  assert.deepEqual(results.map(result => result.existing), [false, false, true]);
  assert.equal(results[0].book.id, results[2].book.id);
  assert.equal(results[2].book.addedAt, results[0].book.addedAt);
  const library = await app.index();
  assert.equal(library.version, 1);
  assert.deepEqual(library.books.map(book => book.title), ['alpha updated', 'beta']);
  for (const book of library.books) {
    assert.equal(await readFile(path.join(app.base, book.file), 'utf8'), book.id === results[0].book.id ? 'alpha' : 'beta');
  }
  assert.equal((await readdir(path.join(app.base, 'books'))).length, 2);
});

test('queued index snapshot includes prior imports across API, tool and command entry points', async (t) => {
  const app = await harness(t);
  await app.api.import(upload('seed'));
  await writeFile(path.join(app.root, 'tool.txt'), 'tool');
  await writeFile(path.join(app.root, 'command.txt'), 'command');
  const gate = gateRead(path.join(app.base, 'library.json'));
  const first = app.api.import(upload('first'));
  await gate.reached;
  const queued = [
    app.api.import(upload('second')),
    app.tools.get('reader_library').execute({ action: 'import', path: 'tool.txt' }),
    app.commands.get('reader').handler({ rawInput: 'import command.txt' }),
  ];
  try {
    gate.release();
    const [firstResult, secondResult, toolResult, commandResult] = await Promise.all([first, ...queued]);
    assert.equal(firstResult.existing, false);
    assert.equal(secondResult.existing, false);
    assert.equal(toolResult.imported.source, 'workspace');
    assert.equal(toolResult.from, path.join(app.root, 'tool.txt'));
    assert.equal(commandResult.kind, 'success');
    assert.deepEqual((await app.index()).books.map(book => book.title), ['seed', 'first', 'second', 'tool', 'command']);
  } finally {
    gate.release();
    await Promise.allSettled([first, ...queued]);
  }
});

test('saveState holds the mutation queue through unlocked automatic note export', async (t) => {
  const app = await harness(t);
  const { book } = await app.api.import(upload('seed'));
  const originalExport = app.api.exportNotes;
  const entered = deferred();
  const release = deferred();
  app.api.exportNotes = async (...args) => {
    entered.resolve();
    await release.promise;
    return originalExport(...args);
  };
  const saving = app.api.saveState(book.id, state('first quote'));
  await entered.promise;
  let importStarted = false;
  const request = upload('next');
  Object.defineProperty(request, 'base64', { get() { importStarted = true; return Buffer.from('next').toString('base64'); } });
  const importing = app.api.import(request);
  const removing = app.api.remove(book.id);
  try {
    // An unlocked read completes while export is held; queued mutations must not start.
    assert.equal((await app.api.library()).books.length, 1);
    assert.equal(importStarted, false);
    assert.equal(await readFile(path.join(app.base, book.file), 'utf8'), 'seed');
    release.resolve();
    await Promise.all([saving, importing, removing]);
    assert.deepEqual((await app.index()).books.map(entry => entry.title), ['next']);
    await assert.rejects(stat(path.join(app.base, book.file)), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(app.base, 'state', `${book.id}.json`)), { code: 'ENOENT' });
    assert.match(await readFile(path.join(app.base, 'notes', `${book.id}.md`), 'utf8'), /first quote/);
  } finally {
    release.resolve();
    await Promise.allSettled([saving, importing, removing]);
    app.api.exportNotes = originalExport;
  }
});

test('saveState, remove and importPath share ordered complete mutations', async (t) => {
  const app = await harness(t);
  const { book } = await app.api.import(upload('seed'));
  await writeFile(path.join(app.root, 'restored.txt'), 'seed');
  const results = await Promise.all([
    app.api.saveState(book.id, state('one')),
    app.api.saveState(book.id, state('two')),
    app.api.remove(book.id),
    app.api.importPath('restored.txt'),
  ]);
  assert.deepEqual(Object.keys(results[3]).sort(), ['book', 'from']);
  assert.equal(results[3].book.id, book.id);
  assert.equal(results[3].book.openedAt, null);
  const library = await app.index();
  assert.equal(library.books.length, 1);
  assert.equal(library.books[0].title, 'restored');
  await assert.rejects(stat(path.join(app.base, 'state', `${book.id}.json`)), { code: 'ENOENT' });
  const notes = await readFile(path.join(app.base, 'notes', `${book.id}.md`), 'utf8');
  assert.match(notes, /> two/);
  assert.doesNotMatch(notes, /> one/);
});

test('failed validation and unsafe state paths reject their call without poisoning the queue', async (t) => {
  const app = await harness(t);
  const initial = await Promise.allSettled([
    app.api.import({ base64: '' }),
    app.api.importPath('missing.txt'),
    app.api.remove('missing'),
    app.api.import(upload('valid')),
  ]);
  assert.deepEqual(initial.map(result => result.status), ['rejected', 'rejected', 'rejected', 'fulfilled']);
  const { book } = initial[3].value;
  const failure = await Promise.allSettled([
    app.api.saveState('../invalid', state('rejected')),
    app.api.saveState(book.id, state('saved')),
    app.api.import(upload('later')),
  ]);
  assert.deepEqual(failure.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  const saved = JSON.parse(await readFile(path.join(app.base, 'state', `${book.id}.json`), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.bookId, book.id);
  assert.equal(saved.highlights[0].text, 'saved');
  assert.equal((await app.index()).books.length, 2);
});

test('automatic export failure does not prevent later saves and imports', async (t) => {
  const app = await harness(t);
  const { book } = await app.api.import(upload('seed'));
  const originalExport = app.api.exportNotes;
  let exports = 0;
  app.api.exportNotes = async (...args) => {
    if (++exports === 1) throw new Error('note export failed');
    return originalExport(...args);
  };
  try {
    const results = await Promise.allSettled([
      app.api.saveState(book.id, state('first')),
      app.api.saveState(book.id, state('second')),
      app.api.import(upload('later')),
    ]);
    assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
    assert.match(results[0].reason.message, /note export failed/);
    assert.equal(exports, 2);
    assert.equal((await app.index()).books.length, 2);
    assert.equal((await app.api.loadState(book.id)).highlights[0].text, 'second');
    assert.match(await readFile(path.join(app.base, 'notes', `${book.id}.md`), 'utf8'), /> second/);
  } finally {
    app.api.exportNotes = originalExport;
  }
});

test('tag mutations share import and reading-state serialization and survive reopening', async (t) => {
  const app = await harness(t);
  const { book } = await app.api.import(upload('tagged'));
  const created = await app.api.createTag({ name: 'Topic' });
  const tagId = created.tags[0].id;
  const gate = gateRead(path.join(app.base, 'library.json'));
  const adding = app.api.updateBookTags({ bookIds: [book.id, 'starter-book'], tagIds: [tagId], operation: 'add' });
  await gate.reached;
  const importing = app.api.import(upload('second'));
  const saving = app.api.saveState(book.id, state('retained'));
  gate.release();
  await Promise.all([adding, importing, saving]);
  const reopened = await app.api.library();
  assert.equal(reopened.books.length, 2);
  assert.deepEqual(reopened.bookTags[book.id], [tagId]);
  assert.deepEqual(reopened.bookTags['starter-book'], [tagId]);
  await app.api.renameTag({ tagId, name: 'Renamed' });
  const before = await app.index();
  await assert.rejects(app.api.updateBookTags({ bookIds: [book.id], tagIds: ['missing'], newTagNames: ['not committed'], operation: 'add' }));
  assert.deepEqual(await app.index(), before);
  await app.api.updateBookTags({ bookIds: ['browser-book'], tagIds: [tagId], operation: 'add' });
  await app.api.migrateBookTags({ fromId: 'browser-book', toId: book.id });
  assert.equal((await app.index()).bookTags['browser-book'], undefined);
  await app.api.deleteTag({ tagId });
  const deleted = await app.index();
  assert.deepEqual(deleted.tags, []); assert.deepEqual(deleted.bookTags, {});
  assert.equal(deleted.books.length, 2);
  assert.equal((await app.api.loadState(book.id)).highlights[0].text, 'retained');
});

test('independent apply instances do not share their mutation queue', async (t) => {
  const first = await harness(t);
  const second = await harness(t);
  const { book } = await first.api.import(upload('first'));
  const entered = deferred();
  const release = deferred();
  const originalExport = first.api.exportNotes;
  first.api.exportNotes = async (...args) => { entered.resolve(); await release.promise; return originalExport(...args); };
  const saving = first.api.saveState(book.id, state('blocked'));
  await entered.promise;
  try {
    assert.equal((await second.api.import(upload('independent'))).existing, false);
    assert.equal((await second.index()).books.length, 1);
  } finally {
    release.resolve();
    await saving;
    first.api.exportNotes = originalExport;
  }
});
