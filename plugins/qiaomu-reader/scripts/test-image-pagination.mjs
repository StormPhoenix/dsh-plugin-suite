/** Real Chromium checks for EPUB image fragmentation; set PLAYWRIGHT_MODULE to an installed playwright-core file URL. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to the file URL of an installed playwright-core module');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/ui/theme.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react'],
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: () => ({ createElement() {} }) });
const imagesBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/ui/image-pagination.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'imagePagination',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<html><head></head><body></body></html>');
  await page.addStyleTag({ content: module.exports.UI_CSS });
  await page.addScriptTag({ content: imagesBundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    const src = (w, h) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="red"/></svg>`);
    const image = (w, h, style = '') => `<img style="${style}" src="${src(w, h)}">`;
    const cases = {
      cover: `<p>${image(600, 1800)}</p>`,
      landscape: `<p>${image(1800, 600)}</p>`,
      small: `<p>${image(100, 80)}${image(100, 80)}</p>`,
      blocks: `<div>${image(600, 1800, 'display:block')}${image(600, 1800, 'display:block')}</div>`,
      sameParagraph: `<p>${image(600, 1800)}<br>${image(600, 1800)}</p>`,
      sideBySide: `<p>${image(600, 1800)}${image(600, 1800)}</p>`,
      fixed: `<p>${image(600, 1800, 'width:1000px!important;height:2000px;min-height:2000px')}</p>`,
      text: `<p>${'text '.repeat(180)}</p><p>${image(600, 1800)}</p>`,
      figure: `<figure>${image(600, 1800)}<figcaption>${'caption '.repeat(300)}</figcaption></figure>`,
    };
    const out = [];
    for (const theme of ['white', 'night']) for (const [width, height, perPage, font] of [[800, 600, 1, 18], [640, 300, 1, 18], [1200, 420, 2, 18], [640, 300, 1, 48]]) {
      const columnWidth = (width - (perPage - 1) * 56) / perPage;
      for (const [name, html] of Object.entries(cases)) {
        document.body.innerHTML = `<div data-qmr-theme="${theme}" class="qmr-reader qmr-flow-paginated"><div class="qmr-page-viewport" style="display:block;width:${width}px;height:${height}px"><div data-qmr-image-pages class="qmr-page-flow qmr-paper-body" style="height:${height}px;width:${width}px;column-width:${columnWidth}px;column-count:${perPage};column-gap:56px;column-fill:auto;font:${font}px/1.6 serif;--qmr-image-page-height:${height}px;--qmr-image-column-width:${columnWidth}px">${html}</div></div></div>`;
        await Promise.all([...document.images].map(i => i.decode()));
        const flow = document.querySelector('.qmr-page-flow');
        imagePagination.fitPageImages(flow, true, new WeakMap());
        const base = flow.getBoundingClientRect();
        const images = [...document.images].map(i => {
          const r = i.getBoundingClientRect();
          return { x: r.x - base.x, y: r.y - base.y, width: r.width, height: r.height, bottom: r.bottom - base.y, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight };
        });
        const columns = Math.max(1, Math.round((flow.scrollWidth + 56) / (columnWidth + 56)));
        out.push({ name, theme, width, height, perPage, font, columnWidth, columns, images });
      }
    }
    const current = document.querySelector('.qmr-page-flow');
    const originals = new WeakMap();
    current.innerHTML = cases.fixed;
    await document.images[0].decode();
    const declarations = () => [...document.images[0].style].sort().map(name => [name, document.images[0].style.getPropertyValue(name), document.images[0].style.getPropertyPriority(name)]);
    const originalStyle = JSON.stringify(declarations());
    imagePagination.fitPageImages(current, true, originals);
    current.style.setProperty('--qmr-image-page-height', '220px');
    const resizedHeight = document.images[0].getBoundingClientRect().height;
    imagePagination.fitPageImages(current, false, originals);
    const restoredStyle = JSON.stringify(declarations());
    if (originalStyle !== restoredStyle) throw new Error('Scroll mode did not restore inline image declarations');
    if (resizedHeight > 220) throw new Error('Existing image did not follow resized page budget');
    // Without the EPUB-only marker the old unrestricted image remains taller than the page.
    document.querySelector('.qmr-page-flow').removeAttribute('data-qmr-image-pages');
    document.querySelector('.qmr-page-flow').innerHTML = cases.cover;
    await document.images[0].decode();
    const baselineHeight = document.images[0].getBoundingClientRect().height;
    return { out, baselineHeight };
  });
  assert.ok(results.baselineHeight > 300, 'negative control reproduces the unrestricted tall image');
  for (const result of results.out) {
    const label = JSON.stringify({ ...result, images: undefined });
    for (const image of result.images) {
      assert.ok(image.y >= -1 && image.bottom <= result.height + 1, `vertical bounds: ${label}`);
      assert.ok(image.width <= result.columnWidth + 1, `column width: ${label}`);
      assert.ok(image.width <= image.naturalWidth + 1 && image.height <= image.naturalHeight + 1, `no enlargement: ${label}`);
      assert.ok(Math.abs(image.width / image.height - image.naturalWidth / image.naturalHeight) < 0.02, `aspect ratio: ${label}`);
      const column = Math.floor((image.x + 1) / (result.columnWidth + 56));
      assert.ok(image.x + image.width <= column * (result.columnWidth + 56) + result.columnWidth + 1, `not crossing a column: ${label}`);
      assert.ok(column < result.columns, `reachable by page navigation: ${label}`);
    }
    if (['blocks', 'sameParagraph'].includes(result.name)) assert.ok(result.images[1].x > result.images[0].x, `multiple large images advance columns: ${label}`);
    if (result.name === 'small') {
      assert.equal(result.images[0].width, 100);
      assert.equal(result.images[1].y, result.images[0].y);
    }
  }
  console.log(`Passed ${results.out.length} Chromium image-layout cases; unrestricted tall-image negative control reproduced.`);
} finally {
  await browser.close();
}
