import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/ui/reader.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react', 'react-dom'],
});

const react = {
  createElement() {}, Fragment: 'fragment', Component: class {},
  useRef: (initial) => ({ current: initial }), useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect() {}, useLayoutEffect() {}, useContext: () => ({}),
};

/** 只实现两个定位函数用到的部分：文档顺序遍历文本节点。 */
function load(textNodes) {
  const module = { exports: {} };
  const document = {
    createTreeWalker: () => {
      let index = 0;
      return { nextNode: () => (index < textNodes.length ? textNodes[index++] : null) };
    },
  };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => (name === 'react' ? react : {}),
    window: {}, document, Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4 },
    setTimeout, clearTimeout, console,
  });
  return module.exports;
}

const flow = {};
const text = (nodeValue) => ({ nodeValue });

test('text offset counts text nodes in document order', () => {
  const nodes = [text('abc'), text(''), text('def')];
  const { textOffsetOf } = load(nodes);
  assert.equal(textOffsetOf(flow, nodes[0], 0), 0);
  assert.equal(textOffsetOf(flow, nodes[0], 2), 2);
  assert.equal(textOffsetOf(flow, nodes[2], 0), 3);
  assert.equal(textOffsetOf(flow, nodes[2], 2), 5);
});

test('text offset is null for a node outside the flow', () => {
  const nodes = [text('abc')];
  const { textOffsetOf } = load(nodes);
  assert.equal(textOffsetOf(flow, text('abc'), 0), null);
});

test('caret lookup returns the same node and offset the offset came from', () => {
  const nodes = [text('abc'), text(''), text('def')];
  const { caretAtTextOffset } = load(nodes);
  // 返回值在 vm 里构造，跨 realm 的 deepEqual 会比原型，这里按字段断言。
  const at = (index) => caretAtTextOffset(flow, index);
  assert.equal(at(0).node, nodes[0]); assert.equal(at(0).offset, 0);
  assert.equal(at(2).node, nodes[0]); assert.equal(at(2).offset, 2);
  assert.equal(at(3).node, nodes[2]); assert.equal(at(3).offset, 0);
  assert.equal(at(5).node, nodes[2]); assert.equal(at(5).offset, 2);
});

test('caret lookup clamps a stale offset past the end to the last character', () => {
  const nodes = [text('abc'), text('def')];
  const { caretAtTextOffset } = load(nodes);
  const result = caretAtTextOffset(flow, 99);
  assert.equal(result.node, nodes[1]);
  assert.equal(result.offset, 2);
});

test('caret lookup returns null when the flow has no text', () => {
  const { caretAtTextOffset } = load([text('')]);
  assert.equal(caretAtTextOffset(flow, 3), null);
});
