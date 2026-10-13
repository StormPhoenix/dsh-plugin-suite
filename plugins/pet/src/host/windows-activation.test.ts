import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { desktopActivationPid, WindowActivationError, windowActivation } from './window-activation.ts';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { desktopPid, windowsActivation } = require('../../runtime/electron-helper/windows-activation.js');

test('process-boundary PID validation excludes wildcard and malformed targets', () => {
  for (const value of [undefined, '', '0', '-1', '4294967295', '4294967296', '1.5', ' 1', '01', 'NaN']) {
    assert.equal(desktopPid(value), null);
    assert.equal(desktopActivationPid(value), undefined);
  }
  for (const value of ['1', '30248', '4294967294']) {
    assert.equal(desktopPid(value), Number(value));
    assert.equal(desktopActivationPid(value), value);
  }
});

test('foreground grant precedes forwarding and loads once', async () => {
  const calls: string[] = [];
  const activation = windowsActivation('30248', () => {
    calls.push('load');
    return (pid: number) => { assert.equal(pid, 30248); calls.push('grant'); return true; };
  });
  const forward = async () => { calls.push('forward'); return { ok: true }; };
  assert.deepEqual(await activation.activate(forward), { ok: true });
  await activation.activate(forward);
  assert.deepEqual(calls, ['load', 'grant', 'forward', 'grant', 'forward']);
});

test('unavailable PID, native binding and denied grant never forward', async () => {
  const forward = async () => { assert.fail('failure must not forward'); };
  await assert.rejects(windowsActivation(undefined, () => { assert.fail('must not load'); }).activate(forward), { code: 'unavailable' });
  await assert.rejects(windowsActivation('30248', () => { throw new Error('missing native'); }).activate(forward), { code: 'native-unavailable' });
  await assert.rejects(windowsActivation('30248', () => () => false).activate(forward), { code: 'foreground-denied' });
});

test('Desktop failure code survives private IPC without parsing display text', async () => {
  const transport = Object.assign(new EventEmitter(), { connected: true, send(message: {requestId: number}, callback: (error: Error | null) => void) {
    callback(null);
    this.emit('message', { type: 'window-activated', requestId: message.requestId, errorCode: 'focus-denied', error: 'any localized text' });
  } });
  const caller = windowActivation(transport);
  try {
    await assert.rejects(caller.activate(), (error: unknown) => error instanceof WindowActivationError && error.code === 'focus-denied');
  } finally { caller.dispose(); }
});

test('bridge rejection propagates without another foreground grant', async () => {
  let grants = 0;
  const activation = windowsActivation('30248', () => () => { grants++; return true; });
  await assert.rejects(activation.activate(async () => { throw new Error('disconnected'); }), /disconnected/);
  assert.equal(grants, 1);
});
