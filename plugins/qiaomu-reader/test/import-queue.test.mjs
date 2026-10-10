import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImportQueue } from '../src/client/import-queue.js';

const file = (name) => ({ name, size: 1 });
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const success = { ok: true, storage: 'host', book: { id: 'book' } };

test('one worker preserves FIFO across append, stop and resume', async () => {
  const started = defer(); const release = defer(); const order = [];
  const queue = createImportQueue({ publish() {}, async importBook(value) {
    order.push(value.name);
    if (value.name === 'a') { started.resolve(); await release.promise; }
    return success;
  } });
  queue.enqueue([file('a'), file('b')]);
  await started.promise;
  queue.enqueue([file('c')]); queue.stop(); release.resolve();
  await queue.settled();
  assert.equal(queue.snapshot().mode, 'paused');
  assert.deepEqual(order, ['a']);
  queue.enqueue([file('d')]);
  assert.equal(queue.snapshot().mode, 'paused');
  queue.resume(); await queue.settled();
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.equal(queue.snapshot().mode, 'idle');
});

test('failure continues, duplicate retry commands reuse rows and browser-only can retry', async () => {
  const attempts = new Map(); const order = [];
  const queue = createImportQueue({ publish() {}, async importBook(value) {
    order.push(value.name); const count = (attempts.get(value.name) || 0) + 1; attempts.set(value.name, count);
    if (value.name === 'bad' && count === 1) throw new Error('bad file');
    if (value.name === 'offline' && count === 1) return { ...success, storage: 'browser', hostError: 'offline' };
    return success;
  } });
  queue.enqueue([file('bad'), file('good'), file('offline')]); await queue.settled();
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['failed', 'host', 'browser']);
  queue.retryFailed(); queue.retryFailed();
  queue.retry([queue.snapshot().items.find((item) => item.filename === 'offline').id]);
  await queue.settled();
  assert.equal(queue.snapshot().items.length, 3);
  assert.deepEqual(order, ['bad', 'good', 'offline', 'bad', 'offline']);
  assert.ok(queue.snapshot().items.every((item) => item.status === 'host'));
});

test('cancel waiting and clear terminal records do not remove in-flight work', async () => {
  const started = defer(); const release = defer();
  const queue = createImportQueue({ publish() {}, async importBook() { started.resolve(); await release.promise; return success; } });
  queue.enqueue([file('a'), file('b')]); await started.promise;
  const [a, b] = queue.snapshot().items;
  queue.cancel(a.id); queue.cancel(b.id); queue.clear();
  assert.equal(queue.snapshot().items.length, 1);
  assert.equal(queue.snapshot().items[0].status, 'processing');
  release.resolve(); await queue.settled(); queue.clear();
  assert.equal(queue.hasPending(), false);
  assert.deepEqual(queue.snapshot().items, []);
});

test('dispose suppresses late publications and releases waiting work', async () => {
  const started = defer(); const release = defer(); let calls = 0; let publications = 0;
  const queue = createImportQueue({ publish() { publications++; }, async importBook() { calls++; started.resolve(); await release.promise; return success; } });
  queue.enqueue([file('a'), file('b')]); await started.promise;
  queue.dispose(); const previous = publications;
  queue.enqueue([file('c')]); release.resolve(); await queue.settled();
  assert.equal(calls, 1); assert.equal(publications, previous); assert.equal(queue.hasPending(), false);
});

test('append at completion boundary schedules the added file exactly once', async () => {
  const calls = []; let queue; let added = false;
  queue = createImportQueue({ publish(snapshot) {
    if (!added && snapshot.items[0]?.status === 'host') { added = true; queue.enqueue([file('b')]); }
  }, async importBook(value) { calls.push(value.name); return success; } });
  queue.enqueue([file('a')]); await queue.settled();
  assert.deepEqual(calls, ['a', 'b']);
});
