import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped factory, including its registration and activation entry.
const bundle = await readFile(new URL('../client.js', import.meta.url), 'utf8');

function harness() {
  let plugin;
  const listeners = new Map();
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load({ factory }) {
      plugin = factory((id) => {
        assert.ok(['react', 'react-dom'].includes(id), `unexpected external module: ${id}`);
        return id === 'react-dom' ? { createPortal() {} } : { createElement() {}, Component: class {} };
      });
    } } },
    console: { warn() {}, error() {} },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
  });

  const slots = new Set();
  const services = new Map([['layout', {
    selectPanel() {},
    panelInfo: { getSnapshot: () => ({ activePanelId: null }) },
  }], ['slots', {
    inject(_name, callback) { return callback(); },
    register({ name }) { slots.add(name); return () => slots.delete(name); },
  }]]);
  const disposers = [];
  const pending = [];
  function context(dependencies) {
    return new Proxy({
      reflect: { get: (name) => services.get(name) },
      effect(callback) {
        const cleanup = callback();
        if (typeof cleanup === 'function') disposers.push(cleanup);
        return cleanup;
      },
      inject(names, callback) {
        const activate = () => {
          if (!names.every((name) => services.has(name))) return false;
          const cleanup = callback(context(names));
          if (typeof cleanup === 'function') disposers.push(cleanup);
          return true;
        };
        if (!activate()) pending.push(activate);
      },
    }, {
      get(target, name) {
        if (name in target) return target[name];
        // Match Cordis: optional chaining does not bypass dependency checks.
        if (!dependencies.includes(name)) {
          throw new Error(`cannot get property "${name}" without inject`);
        }
        return services.get(name);
      },
    });
  }
  return {
    slots, listeners,
    start: () => plugin.apply(context(plugin.inject)),
    provide(name, value) {
      services.set(name, value);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]()) pending.splice(i, 1);
      }
    },
    dispose() { for (const cleanup of disposers.reverse()) cleanup(); },
  };
}

for (const timing of ['before', 'after', 'absent']) {
  test(`client activation: locale ${timing} startup`, () => {
    const app = harness();
    const dictionaries = new Set();
    const locale = { register(namespace, translations) {
      assert.equal(translations.en.open, 'Qiaomu Reader');
      dictionaries.add(namespace);
      return () => dictionaries.delete(namespace);
    } };
    if (timing === 'before') app.provide('locale', locale);
    assert.doesNotThrow(() => app.start());
    assert.deepEqual([...app.slots], ['main', 'qiaomu-reader.chat', 'sidebar.panellist']);
    assert.ok(app.listeners.has('keydown'));
    if (timing === 'after') app.provide('locale', locale);
    assert.equal(dictionaries.has('qiaomu-reader'), timing !== 'absent');
    app.dispose();
    assert.equal(dictionaries.size, 0);
    assert.equal(app.slots.size, 0);
    assert.equal(app.listeners.size, 0);
  });
}

test('client mounts Reader Remote descriptors when Harness remote is available', async () => {
  const app = harness();
  let descriptor;
  app.provide('remote', { $mount: async (value) => { descriptor = value; } });
  app.start();
  await Promise.resolve();
  assert.equal(descriptor.package, 'qiaomu-reader-dsh');
  assert.deepEqual(Array.from(descriptor.descriptors, (item) => item.method), [
    'info', 'library', 'importBook', 'removeBook', 'loadState', 'saveState', 'readBookBytes', 'highlights', 'exportNotes', 'setReadingContext',
  ]);
  app.dispose();
});
