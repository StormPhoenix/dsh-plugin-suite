import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareImageResources, resolveImageResource } from '../src/ui/image-resources.js';
import { createReaderEngine } from '../src/core/reader.js';

const engineOf = (read) => createReaderEngine({
  chapters: [{ href: 'EPUB/text/a.xhtml', xhtml: '<p>Text</p><img src="../images/a.png">' }],
  resources: { 'EPUB/images/a.png': { mediaType: 'image/png' } }, resourceBytes: read,
});
test('rendering after page resolver recreation reuses engine image addresses', async () => {
  let reads = 0;
  const engine = engineOf(async () => { reads++; return new Uint8Array([1, 2, 3]); });
  await Promise.all([prepareImageResources(engine), prepareImageResources(engine)]);
  const render = () => engine.render(0, (path) => resolveImageResource(engine, path));
  assert.match(await render(), /data:image\/png;base64,AQID/);
  await prepareImageResources(engine);
  assert.match(await render(), /data:image\/png;base64,AQID/);
  assert.equal(reads, 1);
  const other = engineOf(async () => new Uint8Array([4]));
  assert.equal(resolveImageResource(other, 'EPUB/images/a.png'), null);
  await prepareImageResources(other);
  assert.match(await other.render(0, (path) => resolveImageResource(other, path)), /base64,BA==/);
});
test('failed images can retry without rejecting preparation', async () => {
  let attempts = 0;
  const engine = engineOf(async () => { if (++attempts === 1) throw new Error('missing'); return new Uint8Array([1]); });
  await prepareImageResources(engine);
  assert.equal(resolveImageResource(engine, 'EPUB/images/a.png'), null);
  await prepareImageResources(engine);
  assert.match(resolveImageResource(engine, '../images/a.png'), /base64,AQ==/);
  await prepareImageResources({ book: { format: 'pdf' } });
});
