import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [new URL('../src/ui/theme.js', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', external: ['react'] });
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) });
const { UI_CSS } = module.exports;

test('PDF sheet overrides body div margins with horizontal auto margins', () => {
  const rule = UI_CSS.match(/\.qmr-reader-pdf\s+\.qmr-pdf-sheet\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, 'PDF-specific selector must outrank .qmr-paper-body div');
  assert.match(rule, /(?:^|;)\s*margin:\s*0\s+auto\s*(?:;|$)/);
  assert.match(rule, /max-width:\s*none/);
});
