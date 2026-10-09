import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { desktopAppPath, activateDesktop } = require('../../runtime/electron-helper/desktop-activation.js');
const source = (name: string): string =>
  readFileSync(new URL('../../runtime/electron-helper/' + name, import.meta.url), 'utf8');

test('activation targets the exact Host app with fixed arguments and propagates errors', async () => {
  const exe = '/workspace/Harness Dev.app/Contents/MacOS/Electron';
  assert.equal(desktopAppPath(exe), '/workspace/Harness Dev.app');
  for (const invalid of [
    '/usr/bin/node',
    'relative.app/Contents/MacOS/Electron',
    '/x.app/Contents/MacOS/',
    undefined,
  ]) {
    assert.equal(desktopAppPath(invalid), null);
  }
  let calls = 0;
  await activateDesktop(
    exe,
    'darwin',
    (command: string, args: string[], options: object, callback: (error: Error | null) => void) => {
      calls++;
      assert.equal(command, '/usr/bin/open');
      assert.deepEqual(args, ['-a', '/workspace/Harness Dev.app', 'dsh://open']);
      assert.deepEqual(options, { timeout: 5000 });
      callback(null);
    },
  );
  assert.equal(calls, 1);
  await assert.rejects(activateDesktop(exe, 'win32'), /macOS/);
  await assert.rejects(activateDesktop('/usr/bin/node', 'darwin'), /macOS/);
  await assert.rejects(
    activateDesktop(exe, 'darwin', (_c: string, _a: string[], _o: object, cb: (error: Error) => void) =>
      cb(new Error('failed')),
    ),
    /failed/,
  );
});

test('Windows activation uses the existing private bridge, not a launcher', () => {
  const main = source('main.js');
  const start = main.indexOf("ipcMain.handle('pet:activate-desktop'");
  const end = main.indexOf("ipcMain.on('pet:open-site'", start);
  assert.match(main.slice(start, end), /bridgeRequest\('POST', '\/dsh-pet-7340\/activate-desktop'\)/);
  assert.match(main.slice(start, end), /if \(!BRIDGE\) throw/);
});

test('macOS ignores the Retina compensation cache while Windows retains it', () => {
  const main = source('main.js');
  const start = main.indexOf('let PRIMARY_SCALE = 0;');
  const end = main.indexOf('/** bridge 模式', start);
  assert.ok(start >= 0 && end > start);
  for (const platform of ['darwin', 'win32']) {
    const switches: string[] = [];
    let probes = 0;
    const context = vm.createContext({
      process: { platform, env: { DSH_PET_SCALE: '1' } },
      DPI_PROBE: false,
      readCachedPrimaryScale: () => 2,
      probePrimaryScale: () => {
        probes++;
        return 2;
      },
      app: { commandLine: { appendSwitch: (name: string) => switches.push(name) } },
    });
    const scale = vm.runInContext(main.slice(start, end) + '\npetScale()', context);
    assert.equal(scale, platform === 'darwin' ? 1 : 2);
    assert.equal(switches.length, platform === 'darwin' ? 0 : 1);
    assert.equal(probes, 0);
  }
});

test('double-click activates once, excludes dragging, and reports failed activation', async () => {
  const context = vm.createContext({ window: { petBridge: { activateDesktop: async () => ({ ok: true }) } }, console });
  const Sprite = vm.runInContext(source('sprite.js') + '\nPetSprite', context);
  let calls = 0;
  const pet = Object.create(Sprite.prototype);
  Object.assign(pet, {
    dragState: { active: false, dragging: false },
    justDragged: false,
    stopThrow() {
      calls++;
    },
    stopMove() {},
    ac: { signal: { aborted: false } },
    bubble: { textContent: '', classList: { add() {} } },
  });
  const event = { preventDefault() {}, stopPropagation() {} };
  await pet.onDoubleClick(event);
  assert.equal(calls, 1);
  pet.justDragged = true;
  await pet.onDoubleClick(event);
  assert.equal(calls, 1);
  pet.justDragged = false;
  let finish!: () => void;
  let requests = 0;
  context.window.petBridge.activateDesktop = () => {
    requests++;
    return new Promise<{ ok: boolean }>((resolve) => {
      finish = () => resolve({ ok: true });
    });
  };
  const pending = pet.onDoubleClick(event);
  await pet.onDoubleClick(event);
  assert.equal(requests, 1);
  finish();
  await pending;
  context.window.petBridge.activateDesktop = async () => ({ ok: false, reason: 'unavailable' });
  await pet.onDoubleClick(event);
  assert.match(pet.bubble.textContent, /unavailable/);
  assert.equal(pet.activationPending, false);
  assert.match(source('sprite.js'), /addEventListener\('dblclick'.*signal: ac.signal/);
});
