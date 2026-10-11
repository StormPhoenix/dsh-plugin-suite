import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [new URL('../src/ui/theme.js', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', external: ['react'] });
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) });
const { UI_CSS } = module.exports;
const headerSelector = '.qmr-reader-content>.qmr-topbar';
const fullscreenSelector = '.qmr-overlay:fullscreen .qmr-reader-content>.qmr-topbar';
const rules = [...UI_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const declarations = selector => rules.filter(match => match[1].trim() === selector).map(match => match[2]);

test('reader header consumes host clearance without moving its background or redefining host state', () => {
  const header = declarations(headerSelector)[0];
  assert.match(header, /left:0;right:0/);
  assert.match(header, /padding:6px 12px;padding-inline-start:max\(12px,var\(--dsh-frame-leading-clearance,0px\)\)/);
  assert.doesNotMatch(UI_CSS, /--dsh-frame-leading-clearance\s*:/);
  assert.doesNotMatch(UI_CSS, /--dsh-frame-top-clearance\s*:/);
});

test('narrow header preserves dynamic clearance after its padding shorthand', () => {
  const narrow = declarations(headerSelector).find(rule => rule.includes('padding:6px 8px'));
  assert.match(narrow, /padding:6px 8px;padding-inline-start:max\(8px,var\(--dsh-frame-leading-clearance,0px\)\)/);
  assert.ok(UI_CSS.indexOf(narrow) > UI_CSS.indexOf('@media (max-width:760px)'));
});

test('only reader element fullscreen removes clearance with matching normal and narrow insets', () => {
  assert.deepEqual(declarations(fullscreenSelector), ['padding-inline-start:12px', 'padding-inline-start:8px']);
  assert.doesNotMatch(UI_CSS, /(?:html|\[data-fullscreen\])[^{}]*\{[^{}]*padding-inline-start/);
  const fullscreen = rules.find(match => match[1].trim() === fullscreenSelector);
  const narrowFullscreen = rules.filter(match => match[1].trim() === fullscreenSelector)[1];
  assert.ok(fullscreen.index > rules.find(match => match[1].trim() === headerSelector).index);
  assert.ok(narrowFullscreen.index > rules.find(match => match[2].includes('padding:6px 8px')).index);
});
