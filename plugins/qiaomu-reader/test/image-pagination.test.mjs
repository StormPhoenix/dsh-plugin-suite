import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPageImages } from '../src/ui/image-pagination.js';

function image(width, height, declarations = {}) {
  const values = new Map(Object.entries(declarations));
  return {
    naturalWidth: width, naturalHeight: height,
    style: {
      getPropertyValue: name => values.get(name)?.[0] || '',
      getPropertyPriority: name => values.get(name)?.[1] || '',
      setProperty: (name, value, priority) => values.set(name, [value, priority]),
      removeProperty: name => values.delete(name),
    },
    values,
  };
}

test('pagination overrides fixed inline sizes and restores their values and priorities in scroll mode', () => {
  const original = { width: ['1000px', 'important'], height: ['2000px', ''], 'min-height': ['2000px', 'important'], display: ['block', ''] };
  const cover = image(600, 1800, original);
  const flow = { querySelectorAll: () => [cover] };
  const saved = new WeakMap();
  fitPageImages(flow, true, saved);
  assert.deepEqual(cover.values.get('width'), ['auto', 'important']);
  assert.equal(cover.style.getPropertyValue('max-width'), 'min(600px,100%,var(--qmr-image-column-width))');
  assert.equal(cover.style.getPropertyValue('max-height'), 'min(1800px,max(1px,calc(var(--qmr-image-page-height) - 1.2em - 1lh)))');
  fitPageImages(flow, true, saved);
  fitPageImages(flow, false, saved);
  assert.deepEqual(Object.fromEntries(cover.values), original);
  assert.equal(saved.has(cover), false);
  fitPageImages(flow, false, saved);
  assert.deepEqual(Object.fromEntries(cover.values), original);
});

test('each image updates its intrinsic size cap after loading without changing its enclosing content', () => {
  const first = image(0, 0), second = image(100, 80);
  const children = [first, second];
  const flow = { querySelectorAll: selector => { assert.equal(selector, 'img'); return children; } };
  const saved = new WeakMap();
  fitPageImages(flow, true, saved);
  assert.equal(first.style.getPropertyValue('max-width'), 'min(100%,var(--qmr-image-column-width))');
  first.naturalWidth = 600; first.naturalHeight = 1800;
  fitPageImages(flow, true, saved);
  assert.equal(first.style.getPropertyValue('max-width'), 'min(600px,100%,var(--qmr-image-column-width))');
  assert.equal(second.style.getPropertyValue('max-width'), 'min(100px,100%,var(--qmr-image-column-width))');
  assert.deepEqual(children, [first, second]);
  fitPageImages(flow, false, saved);
  assert.equal(first.values.size, 0);
  assert.equal(second.values.size, 0);
});

test('scroll and PDF measurements do not change images that pagination has never owned', () => {
  const sheet = image(600, 800, { width: ['100%', ''], height: ['100%', ''] });
  fitPageImages({ querySelectorAll: () => [sheet] }, false, new WeakMap());
  assert.deepEqual(Object.fromEntries(sheet.values), { width: ['100%', ''], height: ['100%', ''] });
});
