import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTextBook } from '../src/client/text-book.js';
import { parsePdfBook } from '../src/client/pdf-book.js';
import { highlightLink, parseHighlightLink } from '../src/core/backlink.js';
import { mergeManagedNotes } from '../src/core/markdown-notes.js';
import { toMarkdown } from '../src/ui/format.js';
import { addHighlight, createBookState } from '../src/core/state.js';
import { createDataLayer } from '../src/client/bridge.js';
import { STARTER_BOOKS, decodeStarterBook } from '../media/starter-books.js';

function tinyPdf() {
  const stream = 'BT /F1 18 Tf 40 100 Td (Hello PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('TXT chapters escape source HTML and keep searchable text', async () => {
  const { engine } = parseTextBook(new TextEncoder().encode('Hello <script>\n\nSecond line'), 'Sample');
  const html = await engine.render(0);
  assert.match(html, /&lt;script&gt;/);
  assert.match(await engine.plainTextOf(0), /Second line/);
  assert.equal(engine.chapterCount(), 1);
});

test('PDF exposes selectable page text, page search and a rendered sheet', async () => {
  const { engine } = await parsePdfBook(tinyPdf(), 'Sample PDF');
  try {
    assert.equal(engine.chapterCount(), 1);
    assert.match(await engine.plainTextOf(0), /Hello PDF/);
    assert.equal((await engine.search('hello', 300))[0].chapterIndex, 0);
    assert.match(await engine.render(0), /qmr-pdf-text-layer/);
  } finally { await engine.dispose(); }
});

test('Markdown backlink resolves stable highlight and generated block preserves hand edits', () => {
  const link = highlightLink('book 1', 'mark/2');
  assert.deepEqual(parseHighlightLink(link), { bookId: 'book 1', highlightId: 'mark/2' });
  const book = { id: 'book 1', title: 'Sample' };
  const state = { highlights: [{ id: 'mark/2', chapterHref: 'text/page-1.xhtml', text: 'The quote', color: 'yellow', percent: 0.2 }] };
  const markdown = toMarkdown(state, book);
  assert.match(markdown, /\[↩ 回到原文\]\(#qmr-book=book%201&qmr-highlight=mark%2F2\)/);
  const first = mergeManagedNotes('My private note\n', markdown);
  assert.match(first, /^My private note/);
  const second = mergeManagedNotes(first, 'new highlights');
  assert.match(second, /^My private note/);
  assert.doesNotMatch(second, /The quote/);
});

test('same text in one chapter can mark distinct occurrences for exact return', () => {
  const first = addHighlight(createBookState('b1'), { chapterHref: 'pdf/page-1', text: 'repeat', textOffset: 10 });
  const second = addHighlight(first.state, { chapterHref: 'pdf/page-1', text: 'repeat', textOffset: 80 });
  assert.equal(second.state.highlights.length, 2);
  assert.equal(second.state.highlights[1].textOffset, 80);
  assert.notEqual(first.highlight.id, second.highlight.id);
});

test('TXT import, state save and Markdown export use one host library in order', async () => {
  const events = [];
  const host = {
    library: async () => ({ books: [] }),
    import: async ({ filename, base64 }) => {
      assert.equal(filename, 'sample.txt');
      assert.ok(base64);
      events.push('import');
      return { book: { id: 'fixture', title: 'sample', format: 'txt', bytes: 12, chapterCount: 1 } };
    },
    saveState: async () => { events.push('save'); },
    loadState: async () => null,
    exportNotes: async () => { events.push('export'); },
  };
  const data = createDataLayer({ host });
  await data.refreshLibrary();
  const bytes = new TextEncoder().encode('Hello there');
  const imported = await data.importBook({ name: 'sample.txt', arrayBuffer: async () => bytes.buffer });
  assert.equal(imported.ok, true);
  assert.equal(imported.book.id, 'fixture');
  const state = addHighlight(createBookState('fixture'), { chapterHref: 'text/page-1.xhtml', text: 'Hello', textOffset: 0 }).state;
  data.persistState('fixture', state);
  const { markdown } = await data.exportNotes('fixture');
  assert.match(markdown, /\[↩ 回到原文\]\(#qmr-book=fixture&qmr-highlight=/);
  assert.deepEqual(events, ['import', 'save', 'export']);
});

test('EPUB import sends its embedded cover to the host library', async () => {
  let uploadedCover = null;
  const host = {
    library: async () => ({ books: [] }),
    import: async (input) => {
      uploadedCover = input.cover;
      return { book: { id: 'imported-epub', title: input.title, format: 'epub', cover: input.cover } };
    },
  };
  const data = createDataLayer({ host });
  await data.refreshLibrary();
  const bytes = decodeStarterBook(STARTER_BOOKS[0]);
  const result = await data.importBook({ name: 'my-book.epub', arrayBuffer: async () => bytes.buffer });
  assert.equal(result.ok, true);
  assert.equal(uploadedCover, STARTER_BOOKS[0].cover);
  assert.equal(result.book.cover, STARTER_BOOKS[0].cover);
});

test('connecting Reader Remote migrates an offline TXT and its highlights', async () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  try {
    const data = createDataLayer();
    await data.refreshLibrary();
    const bytes = new TextEncoder().encode('Offline paragraph');
    const local = await data.importBook({ name: 'offline.txt', arrayBuffer: async () => bytes.buffer });
    const marked = addHighlight(createBookState(local.book.id), { chapterHref: 'text/page-1.xhtml', text: 'Offline' }).state;
    data.persistState(local.book.id, marked);
    const books = [];
    let saved;
    const host = {
      library: async () => ({ books }),
      import: async () => {
        const book = { id: 'host-1', title: 'offline', format: 'txt', chapterCount: 1 };
        books.push(book);
        return { book };
      },
      loadState: async () => null,
      saveState: async (_id, state) => { saved = state; },
    };
    await data.setHost(host);
    assert.equal(data.getLibrary().books.some((book) => book.id === 'host-1'), true);
    assert.equal(data.getLibrary().books.some((book) => book.id === local.book.id), false);
    assert.equal(saved.highlights[0].text, 'Offline');
  } finally { globalThis.localStorage = previous; }
});
