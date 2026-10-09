import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { windowActivation } from './window-activation.ts';

class Transport extends EventEmitter {
  connected = true;
  sent: { type: string; requestId: number }[] = [];
  send(message: { type: string; requestId: number }, callback: (error: Error | null) => void) {
    this.sent.push(message);
    callback(null);
  }
}

test('activation correlates Desktop replies and propagates failures', async () => {
  const transport = new Transport();
  const caller = windowActivation(transport);
  try {
    const first = caller.activate();
    const second = caller.activate();
    transport.emit('message', { type: 'window-activated', requestId: transport.sent[1].requestId });
    await second;
    transport.emit('message', { type: 'window-activated', requestId: transport.sent[0].requestId, error: 'quitting' });
    await assert.rejects(first, /quitting/);
  } finally { caller.dispose(); }
  assert.equal(transport.listenerCount('message'), 0);
  assert.equal(transport.listenerCount('disconnect'), 0);
});

test('activation rejects unavailable, timed out and disposed requests', async () => {
  const transport = new Transport();
  const caller = windowActivation(transport, 10);
  try {
    await assert.rejects(caller.activate(), /timed out/);
    const pending = caller.activate();
    transport.emit('disconnect');
    await assert.rejects(pending, /unavailable/);
    transport.connected = false;
    await assert.rejects(caller.activate(), /unavailable/);
    transport.connected = true;
    const disposed = caller.activate();
    caller.dispose();
    await assert.rejects(disposed, /unavailable/);
    await assert.rejects(caller.activate(), /unavailable/);
  } finally { caller.dispose(); }
});
