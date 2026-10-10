import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parsePdfBook, pdfRenderSize } from '../src/client/pdf-book.js';

function tinyPdf(stream = 'BT /F1 18 Tf 40 100 Td (Hello PDF) Tj ET') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function fakeDom(onContext = () => {}, onImage = () => {}) {
  const canvases = [];
  return {
    canvases,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width: 0, height: 0 };
      const context = new Proxy({ canvas, getTransform: () => new DOMMatrix() }, {
        get(target, key) { return key in target ? target[key] : () => {}; },
      });
      canvas.getContext = () => { onContext(canvas); return context; };
      canvas.toDataURL = (type, quality) => {
        assert.equal(type, 'image/jpeg');
        assert.equal(quality, 0.88);
        onImage(canvas);
        return 'data:image/jpeg;base64,fixture';
      };
      canvases.push(canvas);
      return canvas;
    },
  };
}

test('PDF render sizing retains aspect ratio and caps raster DPR and area', () => {
  assert.deepEqual(pdfRenderSize({ width: 240, height: 150 }, 600, 3), {
    width: 600, height: 375, scale: 2.5, canvasWidth: 1200, canvasHeight: 750,
  });
  for (const base of [{ width: 240, height: 150 }, { width: 1, height: 100_000 }, { width: 100_000, height: 1 }]) {
    for (const width of [1, 300, 10_000, 1_000_000]) {
      const size = pdfRenderSize(base, width, 4);
      assert.ok(size.canvasWidth * size.canvasHeight <= 16_000_000);
      assert.equal(size.height, width * base.height / base.width);
    }
  }
  for (const width of [0, -1, NaN, Infinity]) assert.throws(() => pdfRenderSize({ width: 240, height: 150 }, width), RangeError);
  for (const ratio of [0, -1, NaN, Infinity]) assert.throws(() => pdfRenderSize({ width: 240, height: 150 }, 600, ratio), RangeError);
});

test('PDF zoom shares display-coordinate text, preserves legacy HTML and search', async () => {
  const { engine } = await parsePdfBook(tinyPdf());
  try {
    const legacy = await engine.render(0);
    assert.match(legacy, /width:384px;aspect-ratio:384\/240/);
    const small = await engine.renderPage(0, { width: 120, pixelRatio: 1 });
    const large = await engine.renderPage(0, { width: 960, pixelRatio: 2 });
    assert.match(small, /width:120px;aspect-ratio:120\/75/);
    assert.match(large, /width:960px;aspect-ratio:960\/600/);
    assert.doesNotMatch(large, /max-width/);
    const layer = (html) => html.slice(html.indexOf('<div class="qmr-pdf-text-layer">'));
    assert.equal(layer(small), layer(large));
    assert.match(layer(large), /font-size:7.5cqw/);
    assert.match(await engine.plainTextOf(0), /Hello PDF/);
    assert.equal((await engine.search('hello'))[0].chapterHref, 'pdf/page-1');
    assert.equal(await engine.renderPage(-1, { width: 600 }), '');
    assert.equal(await engine.render(1), '');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(engine.renderPage(0, { width: 600, signal: controller.signal }), { name: 'AbortError' });
  } finally { await engine.dispose(); }
});

test('real PDF.js renders to a capped fake DOM canvas and releases it on success and failure', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const restoreDom = () => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; };
  t.after(restoreDom);
  const { engine } = await parsePdfBook(tinyPdf('0 0 20 20 re f'));
  const sizes = [];
  const dom = fakeDom(() => {}, (canvas) => sizes.push([canvas.width, canvas.height]));
  globalThis.document = dom;
  try {
    assert.match(await engine.renderPage(0, { width: 600, pixelRatio: 3 }), /data:image\/jpeg;base64,fixture/);
    assert.deepEqual(sizes[0], [1200, 750]);
    await engine.renderPage(0, { width: 10_000, pixelRatio: 2 });
    assert.ok(sizes[1][0] * sizes[1][1] <= 16_000_000);
    assert.match(await engine.render(0), /width:384px/);
    assert.deepEqual(sizes[2], [384, 240]);
    globalThis.document = fakeDom(() => {}, () => { throw new Error('JPEG failed'); });
    await assert.rejects(engine.renderPage(0, { width: 600 }), /JPEG failed/);
    for (const canvas of [...dom.canvases, ...globalThis.document.canvases]) {
      assert.equal(canvas.width, 0);
      assert.equal(canvas.height, 0);
    }
    const controller = new AbortController();
    globalThis.document = fakeDom(() => controller.abort());
    await assert.rejects(engine.renderPage(0, { width: 600, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(globalThis.document.canvases[0].width, 0);
    assert.equal(globalThis.document.canvases[0].height, 0);
    const lateAbort = new AbortController();
    globalThis.document = fakeDom(() => {}, () => lateAbort.abort());
    await assert.rejects(engine.renderPage(0, { width: 600, signal: lateAbort.signal }), { name: 'AbortError' });
    assert.equal(globalThis.document.canvases[0].width, 0);
    assert.equal(globalThis.document.canvases[0].height, 0);
  } finally { restoreDom(); await engine.dispose(); }
});

test('AbortSignal cancels the real PDF.js task and disposal waits for canvas cleanup', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const restoreDom = () => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; };
  t.after(restoreDom);
  const probeTask = getDocument({ data: tinyPdf(''), useSystemFonts: true });
  t.after(() => probeTask.destroy());
  const probe = await probeTask.promise;
  const pagePrototype = Object.getPrototypeOf(await probe.getPage(1));
  const originalRender = pagePrototype.render;
  t.after(() => { pagePrototype.render = originalRender; });
  let cancels = 0;
  let block;
  pagePrototype.render = function (options) {
    const task = originalRender.call(this, options);
    task.onContinue = () => {};
    const originalCancel = task.cancel.bind(task);
    task.cancel = () => { cancels += 1; originalCancel(); };
    block?.resolve();
    return task;
  };
  const { engine } = await parsePdfBook(tinyPdf('0 0 20 20 re f'));
  const dom = fakeDom();
  globalThis.document = dom;
  try {
    block = Promise.withResolvers();
    const controller = new AbortController();
    const rendering = engine.renderPage(0, { width: 600, signal: controller.signal });
    const rejected = assert.rejects(rendering, { name: 'AbortError' });
    await block.promise;
    controller.abort();
    await rejected;
    assert.equal(cancels, 1);
    assert.equal(dom.canvases[0].width, 0);
    assert.equal(dom.canvases[0].height, 0);
    assert.equal(dom.canvases.length, 1);

    block = Promise.withResolvers();
    const pending = engine.renderPage(0, { width: 900 });
    const disposedRender = assert.rejects(pending, { name: 'AbortError' });
    await block.promise;
    await engine.dispose();
    await disposedRender;
    assert.equal(cancels, 2);
    assert.equal(dom.canvases[1].width, 0);
    assert.equal(dom.canvases[1].height, 0);
    await assert.rejects(engine.renderPage(0, { width: 600 }), { name: 'AbortError' });
  } finally {
    pagePrototype.render = originalRender;
    restoreDom();
    await engine.dispose();
    await probeTask.destroy();
  }
});
