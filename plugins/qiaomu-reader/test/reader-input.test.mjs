import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomValue, bounded, createWheelIntent, createZoomIntent, wheelPixels } from '../src/core/reader-input.js';
import { normalizeSettings } from '../src/core/state.js';

test('text and PDF zoom use shared ranges and old settings default to fit width', () => {
  assert.equal(zoomValue('pdf', 1, 1), 1.1);
  assert.equal(zoomValue('pdf', 3, 1), 3);
  assert.equal(zoomValue('pdf', 0.5, -1), 0.5);
  assert.equal(zoomValue('epub', 18, 1), 19);
  assert.equal(zoomValue('txt', 48, 1), 48);
  assert.equal(zoomValue('txt', 12, -1), 12);
  assert.equal(normalizeSettings({}).pdfZoom, 1);
  assert.equal(normalizeSettings({ fontSize: 60, pdfZoom: -1 }).fontSize, 48);
  assert.equal(normalizeSettings({ pdfZoom: 30 }).pdfZoom, 3);
  assert.equal(bounded(NaN, 18, 12, 48), 18);
});

test('wheel unit normalization and accumulated navigation reject inertia and reset direction', () => {
  assert.deepEqual(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 600), {x: 16, y: 48});
  assert.equal(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600).y, 600);
  const wheel = createWheelIntent();
  assert.equal(wheel.push(40, 0), 0);
  assert.equal(wheel.push(-40, 20), 0);
  assert.equal(wheel.push(-40, 40), -1);
  assert.equal(wheel.push(120, 80), 0);
  assert.equal(wheel.push(120, 160), 0);
  assert.equal(wheel.push(120, 400), 1);
  assert.equal(wheel.push(120, 500), 0);
  assert.equal(wheel.push(120, 600), 0);
  assert.equal(wheel.push(120, 700), 0);
  assert.equal(wheel.push(120, 1000), 1);
  wheel.reset(); assert.equal(wheel.push(-120, 1010), -1);
  wheel.observe(1020); assert.equal(wheel.push(120, 1070), 0);
  assert.equal(wheel.push(120, 1400), 1);
});

test('zoom fine-motion accumulation allows continuous changes without navigation cooldown', () => {
  const wheel = createZoomIntent();
  assert.equal(wheel.push(-20), 0); assert.equal(wheel.push(-20), -1);
  assert.equal(wheel.push(-100), -1); assert.equal(wheel.push(-100), -1);
  assert.equal(wheel.push(20), 0); assert.equal(wheel.push(-20), 0);
  wheel.reset(); assert.equal(wheel.push(20, 0), 0);
  assert.equal(wheel.push(20, 60000), 0);
  assert.equal(wheel.push(20, 60020), 1);
});
