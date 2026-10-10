import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { LIBRARY_MESSAGES } from '../src/ui/library-locale.js';

const result = await build({ entryPoints: [new URL('../src/ui/panel-settings.js', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'] });
const module = { exports: {} };
const react = { createElement: (type, props, ...children) => ({type, props: props || {}, children: children.flat(Infinity)}), useEffect() {}, Fragment: 'fragment' };
vm.runInNewContext(result.outputFiles[0].text, {module, exports:module.exports, require: () => react});
const { SettingsPanel } = module.exports;
const walk = (node) => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function ui(format, lang = 'zh') {
  const events = [];
  return { events, useSel: (select) => select({ bookId: 'b', states: {b: {}} }), bookOf: () => ({format}),
    settingsOf: () => ({theme:'paper', fontSize:18, pdfZoom:1.5, lineHeight:1.75, fontFamily:'serif', margin:64, flow:'paginated'}),
    t: (key, fallback) => key.split('.').reduce((v,k) => v?.[k], LIBRARY_MESSAGES[lang]) ?? fallback,
    beforeSettings: () => events.push('capture'), updateSettings: (id, patch) => events.push({id, patch}) };
}
test('PDF settings only expose page zoom, and capture anchor before changing stored scale', () => {
  const app = ui('pdf', 'en'); const nodes = walk(SettingsPanel({ui:app}));
  const ranges = nodes.filter(n => n.type === 'input' && n.props.type === 'range');
  assert.equal(ranges.length, 1); assert.equal(ranges[0].props['aria-label'], 'Zoom');
  assert.equal(ranges[0].props.value, 150); assert.equal(ranges[0].props.min, 50); assert.equal(ranges[0].props.max, 300);
  ranges[0].props.onChange({target:{value:'180'}});
  assert.equal(app.events[0], 'capture'); assert.equal(app.events[1].patch.pdfZoom, 1.8);
});
test('EPUB settings retain text controls, expanded font range and anchor capture on reset', () => {
  const app = ui('epub'); const nodes = walk(SettingsPanel({ui:app}));
  const font = nodes.find(n => n.type === 'input' && n.props['aria-label'] === '字号');
  assert.equal(font.props.min, 12); assert.equal(font.props.max, 48);
  font.props.onChange({target:{value:'32'}});
  assert.equal(app.events[0], 'capture'); assert.equal(app.events[1].patch.fontSize, 32);
  nodes.find(n => n.type === 'button' && n.children.includes('恢复默认')).props.onClick();
  assert.equal(app.events[2], 'capture'); assert.equal(app.events[3].patch.pdfZoom, 1);
});
