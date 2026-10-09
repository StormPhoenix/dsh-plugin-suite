/**
 * 乔木阅读 · 核心模块单测（state / search / reader）
 *
 * 运行：node --test test/state.test.mjs
 *
 * reader.js 静态 import ./html.js（由 parser-core 并行实现）。该文件缺失时，
 * 相关用例整体 t.skip()，其余用例仍必须全绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_READER_SETTINGS,
  HIGHLIGHT_COLORS,
  addBookmark,
  addHighlight,
  createBookState,
  mergeStates,
  normalizeLibrary,
  normalizeState,
  progressOf,
  removeBookmark,
  removeHighlight,
  stableId,
  updateHighlightNote,
} from '../src/core/state.js';
import {
  makeSnippet,
  normalizeQuery,
  searchInText,
  sentenceAt,
  splitSentences,
} from '../src/core/search.js';

/** reader.js 是否可用（html.js 未就绪时为 false） */
let readerModule = null;
let readerSkipReason = false;
try {
  readerModule = await import('../src/core/reader.js');
} catch (error) {
  readerSkipReason = `跳过：src/core/html.js 尚未就绪（${error?.code || error?.message || 'unknown'}）`;
}

/** JSON 快照，用于断言入参未被修改 */
const snapshot = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * state.js
 * ------------------------------------------------------------------ */

test('normalizeLibrary: 畸形输入不抛且结构合法', () => {
  const inputs = [null, undefined, [], 'garbage', 42, true, { books: 'nope' }, { books: [null, 7, 'x'] }];
  for (const raw of inputs) {
    const library = normalizeLibrary(raw);
    assert.equal(typeof library, 'object');
    assert.equal(library.version, 1);
    assert.equal(typeof library.updatedAt, 'number');
    assert.ok(Array.isArray(library.books));
    for (const book of library.books) {
      assert.equal(typeof book.id, 'string');
      assert.ok(book.id.length > 0);
      assert.equal(typeof book.title, 'string');
      assert.equal(typeof book.author, 'string');
      assert.equal(typeof book.format, 'string');
      assert.equal(typeof book.file, 'string');
      assert.equal(typeof book.bytes, 'number');
      assert.equal(typeof book.chapterCount, 'number');
      assert.equal(typeof book.source, 'string');
      assert.equal(typeof book.language, 'string');
      assert.ok(book.cover === null || typeof book.cover === 'string');
    }
  }
  assert.deepEqual(normalizeLibrary({ books: 'nope' }).books, []);
  assert.deepEqual(normalizeLibrary({ books: [null, 7, 'x'] }).books, []);
});

test('normalizeLibrary: 补默认值、保留未知字段、按扩展名推 format', () => {
  const library = normalizeLibrary({
    version: 2,
    updatedAt: 1735689600000,
    extraTop: { keep: true },
    books: [
      { title: '道德经', author: '老子', myField: [1, 2] },
      { id: 'b2', file: 'books/b2.TXT', format: '', bytes: '2048', openedAt: null },
      { id: 'b3', file: 'books/b3.epub', openedAt: 1234, bytes: -5, chapterCount: '81' },
    ],
  });
  assert.equal(library.version, 2);
  assert.equal(library.updatedAt, 1735689600000);
  assert.deepEqual(library.extraTop, { keep: true });
  assert.equal(library.books.length, 3);

  const first = library.books[0];
  assert.equal(first.title, '道德经');
  assert.equal(first.author, '老子');
  assert.deepEqual(first.myField, [1, 2]);
  assert.ok(first.id.length > 0);
  assert.equal(first.format, 'epub');
  assert.equal(first.bytes, 0);
  assert.equal(first.cover, null);
  assert.equal(first.addedAt, 0);
  assert.equal(first.openedAt, null);
  assert.equal(first.source, 'starter');
  assert.equal(first.language, 'zh');

  assert.equal(library.books[1].format, 'txt');
  assert.equal(library.books[1].bytes, 2048);
  assert.equal(library.books[1].openedAt, null);

  assert.equal(library.books[2].openedAt, 1234);
  assert.equal(library.books[2].bytes, 0);
  assert.equal(library.books[2].chapterCount, 81);
});

test('normalizeState: 畸形输入不抛且结构合法', () => {
  const inputs = [
    null, undefined, [], 'nope', 0,
    { highlights: {}, bookmarks: 'x', settings: 5, locator: 'z' },
    { locator: { scroll: 'NaN' }, highlights: [null, 'x', {}] },
  ];
  for (const raw of inputs) {
    const state = normalizeState(raw, 'book-1');
    assert.equal(state.bookId, 'book-1');
    assert.equal(state.version, 1);
    assert.equal(state.updatedAt, 0);
    assert.deepEqual(state.locator, { chapterIndex: 0, chapterHref: '', scroll: 0, textQuote: '' });
    assert.deepEqual(state.highlights, []);
    assert.deepEqual(state.bookmarks, []);
    assert.deepEqual(state.settings, { ...DEFAULT_READER_SETTINGS });
  }
});

test('normalizeState: 保留未知字段、取 raw.bookId、校验 settings', () => {
  const state = normalizeState(
    {
      bookId: 'from-raw',
      extra: 9,
      locator: { chapterIndex: 3, chapterHref: 'text/ch4.xhtml', scroll: 2, textQuote: '引用' },
      settings: { theme: 'night', fontSize: '20', flow: 'weird', justify: 0, myKey: true },
    },
    'fallback',
  );
  assert.equal(state.bookId, 'from-raw');
  assert.equal(state.extra, 9);
  assert.deepEqual(state.locator, {
    chapterIndex: 3,
    chapterHref: 'text/ch4.xhtml',
    scroll: 1,
    textQuote: '引用',
  });
  assert.equal(state.settings.theme, 'night');
  assert.equal(state.settings.fontSize, 20);
  assert.equal(state.settings.flow, 'paginated');
  assert.equal(state.settings.justify, false);
  assert.equal(state.settings.myKey, true);
  assert.equal(state.settings.lineHeight, DEFAULT_READER_SETTINGS.lineHeight);
  assert.deepEqual(HIGHLIGHT_COLORS, ['yellow', 'green', 'blue', 'pink']);
});

test('normalizeState: 划线 / 书签缺字段补全、坏条目丢弃', () => {
  const state = normalizeState(
    {
      bookId: 'b',
      highlights: [
        { chapterHref: 'text/ch1.xhtml', text: '道可道', color: 'PURPLE', percent: 3 },
        { text: '' },
        'junk',
      ],
      bookmarks: [{ chapterHref: 'text/ch2.xhtml', percent: -1 }, { label: '' }],
    },
    'b',
  );
  assert.equal(state.highlights.length, 1);
  assert.equal(state.highlights[0].color, 'yellow'); // 非法颜色回落
  assert.equal(state.highlights[0].percent, 1); // 夹到 [0,1]
  assert.equal(state.highlights[0].note, '');
  assert.equal(typeof state.highlights[0].id, 'string');
  assert.equal(state.bookmarks.length, 1);
  assert.equal(state.bookmarks[0].percent, 0);
  assert.equal(state.bookmarks[0].label, '');
});

test('createBookState: 空状态、updatedAt 为 0', () => {
  const state = createBookState('b1');
  assert.equal(state.bookId, 'b1');
  assert.equal(state.updatedAt, 0);
  assert.deepEqual(state.highlights, []);
  assert.deepEqual(state.bookmarks, []);
  assert.deepEqual(state.locator, { chapterIndex: 0, chapterHref: '', scroll: 0, textQuote: '' });
});

test('progressOf: 0 章、1 章、最后一章 scroll=1 等边界', () => {
  assert.equal(progressOf(createBookState('b'), 0), 0);
  assert.equal(progressOf(null, 0), 0);
  assert.equal(progressOf(null, undefined), 0);
  assert.equal(progressOf({ locator: { chapterIndex: 0, scroll: 0 } }, 1), 0);
  assert.equal(progressOf({ locator: { chapterIndex: 0, scroll: 1 } }, 1), 1);
  assert.equal(progressOf({ locator: { chapterIndex: 2, scroll: 1 } }, 3), 1);
  assert.equal(progressOf({ locator: { chapterIndex: 1, scroll: 0.5 } }, 4), 0.375);
  assert.equal(progressOf({ locator: { chapterIndex: 99, scroll: 1 } }, 3), 1);
  assert.equal(progressOf({ locator: { chapterIndex: -3, scroll: 0.5 } }, 2), 0.25);
  assert.equal(progressOf({ locator: { chapterIndex: 1, scroll: 5 } }, 2), 1);
});

test('addHighlight: 去重、稳定 id、不可变性', () => {
  const state = createBookState('book-1');
  const before = snapshot(state);

  const first = addHighlight(state, {
    chapterHref: 'text/ch1.xhtml',
    text: '道可道',
    color: 'yellow',
    percent: 0.1,
    createdAt: 1000,
  });
  assert.equal(first.state.highlights.length, 1);
  assert.equal(first.highlight.text, '道可道');
  assert.equal(first.highlight.percent, 0.1);
  assert.ok(first.highlight.id.length > 0);
  assert.equal(state.highlights.length, 0);
  assert.deepEqual(state, before);

  // 同章 + 同 text + 同 color 视为已存在，返回原 state
  const again = addHighlight(first.state, {
    chapterHref: 'text/ch1.xhtml',
    text: '道可道',
    color: 'yellow',
    createdAt: 2000,
  });
  assert.equal(again.state.highlights.length, 1);
  assert.equal(again.highlight.id, first.highlight.id);
  assert.equal(again.state, first.state);
  assert.equal(again.highlight.percent, 0.1);

  // 换颜色是另一条划线
  const otherColor = addHighlight(first.state, {
    chapterHref: 'text/ch1.xhtml',
    text: '道可道',
    color: 'blue',
    createdAt: 3000,
  });
  assert.equal(otherColor.state.highlights.length, 2);
  assert.notEqual(otherColor.highlight.id, first.highlight.id);

  // 换文本是另一条划线
  const otherText = addHighlight(first.state, {
    chapterHref: 'text/ch1.xhtml',
    text: '非常道',
    color: 'yellow',
    createdAt: 4000,
  });
  assert.equal(otherText.state.highlights.length, 2);

  // 空白文本不生成划线
  const invalid = addHighlight(first.state, { chapterHref: 'text/ch1.xhtml', text: '   ' });
  assert.equal(invalid.highlight, null);
  assert.equal(invalid.state, first.state);

  // 坏 state 也不抛
  const fromBroken = addHighlight(null, { chapterHref: 'text/ch1.xhtml', text: '无', createdAt: 5000 });
  assert.equal(fromBroken.state.highlights.length, 1);
  assert.equal(fromBroken.state.highlights[0].note, '');
});

test('removeHighlight / updateHighlightNote: 返回值与不可变性', () => {
  const added = addHighlight(createBookState('book-1'), {
    chapterHref: 'text/ch1.xhtml',
    text: '上善若水',
    color: 'green',
    createdAt: 1000,
  });
  const id = added.highlight.id;
  const state = added.state;
  const before = snapshot(state);

  const removed = removeHighlight(state, id);
  assert.equal(removed.removed, true);
  assert.equal(removed.state.highlights.length, 0);
  assert.equal(state.highlights.length, 1);
  assert.deepEqual(state, before);

  const missing = removeHighlight(state, 'nope');
  assert.equal(missing.removed, false);
  assert.equal(missing.state, state);
  assert.equal(removeHighlight(state, '').removed, false);

  const noted = updateHighlightNote(state, id, '  水的品格  ');
  assert.equal(noted.highlights[0].note, '水的品格');
  assert.equal(state.highlights[0].note, '');
  assert.deepEqual(state, before);

  const cleared = updateHighlightNote(noted, id, '');
  assert.equal(cleared.highlights[0].note, '');

  assert.equal(updateHighlightNote(state, id, ''), state); // 内容未变化 → 引用不变
  assert.equal(updateHighlightNote(state, 'nope', 'x'), state);
});

test('addBookmark / removeBookmark: 返回值与不可变性', () => {
  const base = createBookState('book-1');
  const before = snapshot(base);

  const added = addBookmark(base, {
    chapterHref: 'text/ch2.xhtml',
    percent: 0.3,
    label: '第二章',
    createdAt: 1000,
  });
  assert.equal(added.bookmark.percent, 0.3);
  assert.equal(added.bookmark.label, '第二章');
  assert.equal(added.state.bookmarks.length, 1);
  assert.deepEqual(base, before);

  const duplicate = addBookmark(added.state, {
    chapterHref: 'text/ch2.xhtml',
    percent: 0.3,
    label: '第二章',
    createdAt: 2000,
  });
  assert.equal(duplicate.state.bookmarks.length, 1);
  assert.equal(duplicate.bookmark.id, added.bookmark.id);

  const another = addBookmark(added.state, { chapterHref: 'text/ch3.xhtml', percent: 5, label: '第三章' });
  assert.equal(another.bookmark.percent, 1);
  assert.equal(another.state.bookmarks.length, 2);

  assert.equal(addBookmark(added.state, { chapterHref: '', label: '' }).bookmark, null);

  const removed = removeBookmark(added.state, added.bookmark.id);
  assert.equal(removed.bookmarks.length, 0);
  assert.equal(added.state.bookmarks.length, 1);

  const missing = removeBookmark(added.state, 'nope');
  assert.equal(missing, added.state);
});

test('mergeStates: 按 id 合并、新者胜、空状态不压掉真实状态', () => {
  const a = addHighlight(
    {
      ...createBookState('book-1'),
      updatedAt: 100,
      locator: { chapterIndex: 0, chapterHref: 'text/ch1.xhtml', scroll: 0.2 },
    },
    { id: 'h1', chapterHref: 'text/ch1.xhtml', text: '旧文本', color: 'yellow', createdAt: 100 },
  ).state;
  const b = {
    ...createBookState('book-1'),
    updatedAt: 200,
    locator: { chapterIndex: 2, chapterHref: 'text/ch3.xhtml', scroll: 0.4 },
    settings: { ...DEFAULT_READER_SETTINGS, theme: 'night', fontSize: 22 },
    highlights: [
      { id: 'h1', chapterHref: 'text/ch1.xhtml', text: '新文本', color: 'green', createdAt: 200 },
      { id: 'h2', chapterHref: 'text/ch2.xhtml', text: '仅 B 有', color: 'pink', createdAt: 250 },
    ],
    bookmarks: [{ id: 'k1', chapterHref: 'text/ch1.xhtml', percent: 0.5, label: '中点', createdAt: 150 }],
  };

  const merged = mergeStates(a, b);
  assert.equal(merged.updatedAt, 200);
  assert.equal(merged.bookId, 'book-1');
  assert.equal(merged.locator.chapterHref, 'text/ch3.xhtml');
  assert.equal(merged.settings.theme, 'night');
  assert.equal(merged.settings.fontSize, 22);
  assert.equal(merged.highlights.length, 2);
  assert.equal(merged.highlights.find((item) => item.id === 'h1').text, '新文本');
  assert.equal(merged.highlights.find((item) => item.id === 'h1').color, 'green');
  assert.equal(merged.highlights.find((item) => item.id === 'h2').text, '仅 B 有');
  assert.equal(merged.bookmarks.length, 1);
  assert.equal(merged.bookmarks[0].label, '中点');
  assert.equal(a.highlights[0].text, '旧文本'); // 入参未被修改
  assert.equal(b.highlights[0].text, '新文本');

  // 反向合并：时间戳仍然决定胜负
  const reversed = mergeStates(b, a);
  assert.equal(reversed.locator.chapterHref, 'text/ch3.xhtml');
  assert.equal(reversed.settings.theme, 'night');
  assert.equal(reversed.highlights.find((item) => item.id === 'h1').text, '新文本');
  assert.equal(reversed.highlights.length, 2);

  // 同 id 且时间相同 → 保留 a
  const left = {
    ...createBookState('b'),
    updatedAt: 5,
    highlights: [{ id: 'x', chapterHref: 't/1.xhtml', text: 'A', color: 'yellow', createdAt: 3 }],
  };
  const right = {
    ...createBookState('b'),
    updatedAt: 5,
    highlights: [{ id: 'x', chapterHref: 't/1.xhtml', text: 'B', color: 'yellow', createdAt: 3 }],
  };
  assert.equal(mergeStates(left, right).highlights[0].text, 'A');

  // 新建空状态（updatedAt 0）不得压掉磁盘读回的状态
  const fromDisk = {
    ...createBookState('book-1'),
    updatedAt: 900,
    locator: { chapterIndex: 1, chapterHref: 'text/ch2.xhtml', scroll: 0.5 },
    settings: { ...DEFAULT_READER_SETTINGS, theme: 'moon' },
  };
  const mergedEmpty = mergeStates(createBookState('book-1'), fromDisk);
  assert.equal(mergedEmpty.locator.chapterHref, 'text/ch2.xhtml');
  assert.equal(mergedEmpty.settings.theme, 'moon');

  // 坏输入不抛
  assert.equal(typeof mergeStates(null, undefined).bookId, 'string');
});

test('stableId: 确定、唯一、字符安全', () => {
  const a = stableId('book-1', 'text/ch1.xhtml', '道可道', 1000);
  const b = stableId('book-1', 'text/ch1.xhtml', '道可道', 1000);
  const c = stableId('book-1', 'text/ch1.xhtml', '道可道', 1001);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-z]+-[0-9a-z]+$/);
  assert.ok(stableId().length > 0);

  const many = new Set();
  for (let i = 0; i < 500; i++) many.add(stableId('h', 'text/ch1.xhtml', `句子 ${i}`, i));
  assert.equal(many.size, 500);
});

/* ------------------------------------------------------------------ *
 * search.js
 * ------------------------------------------------------------------ */

test('normalizeQuery: trim、空白折叠、不切词', () => {
  assert.equal(normalizeQuery('  Hello   World  '), 'Hello World');
  assert.equal(normalizeQuery('道德  经'), '道德 经');
  assert.equal(normalizeQuery('\t苹果\u3000香蕉\n'), '苹果 香蕉');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery(undefined), '');
  assert.equal(normalizeQuery(123), '123');
});

test('searchInText: 英文大小写、中文单字、limit、空查询', () => {
  const text = 'Hello world hello';
  assert.deepEqual(searchInText(text, 'hello'), [{ index: 0, length: 5 }, { index: 12, length: 5 }]);
  assert.deepEqual(searchInText(text, 'HELLO'), [{ index: 0, length: 5 }, { index: 12, length: 5 }]);
  assert.deepEqual(searchInText(text, 'missing'), []);
  assert.deepEqual(searchInText(text, ''), []);
  assert.deepEqual(searchInText(text, '   '), []);
  assert.deepEqual(searchInText(text, null), []);
  assert.deepEqual(searchInText(text, 'hello', { limit: 1 }), [{ index: 0, length: 5 }]);
  assert.deepEqual(searchInText(text, 'hello', { limit: 0 }), []);
  assert.deepEqual(searchInText(text, 'hello', { limit: -3 }), []);

  const chinese = '道德经第一章 道可道';
  assert.deepEqual(searchInText(chinese, '道'), [
    { index: 0, length: 1 },
    { index: 7, length: 1 },
    { index: 9, length: 1 },
  ]);
  assert.equal(searchInText(chinese, '道', { limit: 2 }).length, 2);
  assert.deepEqual(searchInText(chinese, '可道'), [{ index: 8, length: 2 }]);

  // 查询中的空白可匹配原文换行
  assert.deepEqual(searchInText('foo\nbar', 'foo bar'), [{ index: 0, length: 7 }]);
  // 不修改 lastIndex 状态：连续调用结果一致
  assert.deepEqual(searchInText(text, 'hello'), searchInText(text, 'hello'));
});

test('makeSnippet: 开头 / 结尾 / 中间与换行折叠', () => {
  const text = '甲'.repeat(200) + '命中' + '乙'.repeat(200);

  const middle = makeSnippet(text, 200, 2, 40);
  assert.ok(middle.startsWith('…'));
  assert.ok(middle.endsWith('…'));
  assert.ok(middle.includes('命中'));
  assert.ok(middle.replace(/…/g, '').length <= 40);

  const head = makeSnippet(text, 0, 2, 40);
  assert.ok(!head.startsWith('…'));
  assert.ok(head.endsWith('…'));
  assert.ok(head.startsWith('甲甲'));

  const tail = makeSnippet(text, text.length - 2, 2, 40);
  assert.ok(tail.startsWith('…'));
  assert.ok(!tail.endsWith('…'));
  assert.ok(tail.endsWith('乙乙'));

  assert.equal(makeSnippet('', 0, 0, 40), '');
  assert.equal(makeSnippet(null, 0, 0, 40), '');

  const folded = makeSnippet('第一行\n第二行\n第三行', 4, 3, 80);
  assert.ok(!folded.includes('\n'));
  assert.ok(folded.includes('第二行'));
  assert.ok(!folded.startsWith('…'));
  assert.ok(!folded.endsWith('…'));

  // at / span 越界不抛
  assert.equal(typeof makeSnippet('abc', 999, 999, 10), 'string');
  assert.equal(typeof makeSnippet('abc', -5, -5, 10), 'string');
});

test('splitSentences / sentenceAt: 中英句末标点', () => {
  const text = 'Hello world. This is fine! 你好。再见';
  assert.deepEqual(splitSentences(text), ['Hello world.', 'This is fine!', '你好。', '再见']);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   \n  '), []);
  assert.deepEqual(splitSentences(null), []);

  assert.equal(sentenceAt(text, 3), 'Hello world.');
  assert.equal(sentenceAt(text, text.indexOf('你好')), '你好。');
  assert.equal(sentenceAt(text, text.length), '再见');
  assert.equal(sentenceAt('', 0), '');
});

/* ------------------------------------------------------------------ *
 * reader.js（依赖 src/core/html.js，未就绪时跳过）
 * ------------------------------------------------------------------ */

/** 3 章假书，覆盖相对链接、图片、脚本、TOC 嵌套 */
function fakeBook() {
  return {
    title: '测试书',
    author: '作者',
    language: 'zh',
    rootDir: 'OEBPS/',
    resources: {},
    coverHref: null,
    chapters: [
      {
        index: 0,
        href: 'OEBPS/text/ch1.xhtml',
        id: 'c1',
        mediaType: 'application/xhtml+xml',
        xhtml:
          '<html><head><title>一</title><style>.a{color:red}</style></head><body>'
          + '<h1>第一章</h1><p>Apple 苹果派。</p>'
          + '<p><a href="../text/ch2.xhtml">去第二章</a></p>'
          + '<img src="../images/pic.png" alt="图"/>'
          + '<script>bad()</script></body></html>',
      },
      {
        index: 1,
        href: 'OEBPS/text/ch2.xhtml',
        id: 'c2',
        mediaType: 'application/xhtml+xml',
        xhtml: '<html><body><h1>第二章</h1><p>apple apple apple apple apple apple apple</p></body></html>',
      },
      {
        index: 2,
        href: 'OEBPS/text/ch3.xhtml',
        id: 'c3',
        mediaType: 'application/xhtml+xml',
        xhtml: '<html><body><h1>第三章</h1><p>结束。</p></body></html>',
      },
    ],
    toc: [
      { label: '第一章', href: 'OEBPS/text/ch1.xhtml', children: [] },
      {
        label: '第二章',
        href: 'OEBPS/text/ch2.xhtml',
        children: [{ label: '第三节', href: 'OEBPS/text/ch3.xhtml', children: [] }],
      },
    ],
  };
}

test('reader: chapterCount / plainTextOf / render 容错', { skip: readerSkipReason }, async () => {
  const book = fakeBook();
  const engine = readerModule.createReaderEngine(book);
  assert.equal(engine.book, book);
  assert.equal(engine.chapterCount(), 3);

  const text0 = await engine.plainTextOf(0);
  assert.match(text0, /第一章/);
  assert.match(text0, /apple/i);
  assert.match(text0, /苹果派/);
  assert.ok(!text0.includes('bad()'), 'script 内容不应进入纯文本');
  assert.ok(!text0.includes('color:red'), 'style 内容不应进入纯文本');
  // 纯文本缓存：重复调用结果一致
  const text1a = await engine.plainTextOf(1);
  const text1b = await engine.plainTextOf(1);
  assert.equal(text1a, text1b);
  assert.match(text1a, /apple/i);

  assert.equal(await engine.plainTextOf(99), '');
  assert.equal(await engine.plainTextOf(-1), '');
  assert.equal(await engine.plainTextOf('x'), '');
  assert.equal(await engine.plainTextOf(null), '');

  const asked = [];
  const html = await engine.render(0, (zipPath) => {
    asked.push(zipPath);
    return `blob:${zipPath}`;
  });
  assert.match(html, /第一章/);
  assert.ok(!/<script/i.test(html), 'render 结果不应含 script');
  assert.ok(!/color:red/.test(html), 'render 结果不应含 style');
  // 资源回调必须收到 zip 根路径（不能二次拼接 baseDir）
  assert.deepEqual(asked, ['OEBPS/images/pic.png']);
  assert.match(html, /src="blob:OEBPS\/images\/pic\.png"/);
  // 章节内链应被 absolutize 成 zip 根路径，供 resolveLink 使用
  assert.match(html, /href="OEBPS\/text\/ch2\.xhtml"/);
  // 未提供 resolveResource 时也不抛，返回字符串
  assert.equal(typeof await engine.render(0, null), 'string');
  assert.equal(typeof await engine.render(0, undefined), 'string');
  assert.equal(await engine.render(99, () => null), '');

  // 坏数据引擎不抛
  const broken = readerModule.createReaderEngine(null);
  assert.equal(broken.chapterCount(), 0);
  assert.equal(await broken.plainTextOf(0), '');
  assert.equal(await broken.render(0, () => null), '');
  assert.deepEqual(await broken.search('x'), []);
  assert.equal(broken.resolveLink(0, 'a.xhtml'), null);
  assert.deepEqual(broken.tocFor(0), []);

  const broken2 = readerModule.createReaderEngine({ chapters: [null, 'x', { href: 'a.xhtml' }] });
  assert.equal(broken2.chapterCount(), 3);
  assert.equal(await broken2.plainTextOf(0), '');
  assert.equal(typeof await broken2.plainTextOf(2), 'string');
  assert.equal(broken2.resolveLink(2, '#frag'), 2);
});

test('reader: resolveLink 相对路径 / #frag / 未知路径', { skip: readerSkipReason }, () => {
  const engine = readerModule.createReaderEngine(fakeBook());
  assert.equal(engine.resolveLink(0, '../text/ch2.xhtml'), 1);
  assert.equal(engine.resolveLink(0, 'ch2.xhtml'), 1);
  assert.equal(engine.resolveLink(0, 'text/ch2.xhtml'), 1);
  assert.equal(engine.resolveLink(0, 'OEBPS/text/ch3.xhtml'), 2);
  assert.equal(engine.resolveLink(1, './ch1.xhtml'), 0);
  assert.equal(engine.resolveLink(1, '../text/ch1.xhtml'), 0);
  assert.equal(engine.resolveLink(1, '#frag'), 1);
  assert.equal(engine.resolveLink(2, '#top'), 2);
  assert.equal(engine.resolveLink(0, 'ch1.xhtml#section-3'), 0);
  assert.equal(engine.resolveLink(0, 'unknown.xhtml'), null);
  assert.equal(engine.resolveLink(0, ''), null);
  assert.equal(engine.resolveLink(99, '#frag'), null);
  assert.equal(engine.resolveLink(0, 'https://example.com/text/ch2.xhtml'), null);
  assert.equal(engine.resolveLink(0, 'mailto:a@b.c'), null);
});

test('reader: search 命中章号、百分比、每章上限与 limit', { skip: readerSkipReason }, async () => {
  const engine = readerModule.createReaderEngine(fakeBook());
  const hits = await engine.search('apple');
  const fromFirst = hits.filter((hit) => hit.chapterIndex === 0);
  const fromSecond = hits.filter((hit) => hit.chapterIndex === 1);
  assert.equal(fromFirst.length, 1);
  assert.equal(fromSecond.length, 5, '每章最多 5 条');
  assert.equal(hits.length, 6);

  assert.equal(fromFirst[0].percent, 0);
  assert.equal(fromSecond[0].percent, 1 / 3);
  assert.equal(fromFirst[0].chapterLabel, '第一章');
  assert.equal(fromSecond[0].chapterLabel, '第二章');
  assert.match(fromFirst[0].snippet, /apple/i);
  assert.equal(typeof fromFirst[0].offset, 'number');
  assert.ok(fromFirst[0].offset >= 0);
  assert.deepEqual(Object.keys(fromFirst[0]).sort(), [
    'chapterIndex', 'chapterLabel', 'offset', 'percent', 'snippet',
  ]);

  assert.equal((await engine.search('apple', 2)).length, 2);
  assert.equal((await engine.search('apple', 1)).length, 1);
  assert.deepEqual(await engine.search('apple', 0), []);
  assert.deepEqual(await engine.search('   '), []);
  assert.deepEqual(await engine.search('找不到的词'), []);

  const chinese = await engine.search('苹果派');
  assert.equal(chinese.length, 1);
  assert.equal(chinese[0].chapterIndex, 0);
  assert.match(chinese[0].snippet, /苹果派/);

  const third = await engine.search('结束');
  assert.equal(third.length, 1);
  assert.equal(third[0].chapterIndex, 2);
  assert.equal(third[0].chapterLabel, '第三节');
  assert.equal(third[0].percent, 2 / 3);
});

test('reader: tocFor 返回根到节点的路径', { skip: readerSkipReason }, () => {
  const engine = readerModule.createReaderEngine(fakeBook());
  const first = engine.tocFor(0);
  assert.equal(first.length, 1);
  assert.equal(first[0].label, '第一章');

  const third = engine.tocFor(2);
  assert.deepEqual(third.map((entry) => entry.label), ['第二章', '第三节']);

  assert.deepEqual(engine.tocFor(99), []);
  assert.deepEqual(engine.tocFor(-1), []);
  assert.deepEqual(readerModule.createReaderEngine({}).tocFor(0), []);
});

/* ------------------------------------------------------------------ *
 * core 模块的硬性约束自检
 * ------------------------------------------------------------------ */

test('core 模块不引用 DOM 全局、不依赖第三方包', async () => {
  const files = ['state.js', 'search.js', 'reader.js'];
  for (const file of files) {
    const url = new URL(`../src/core/${file}`, import.meta.url);
    const source = await readFile(url, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['window', 'document', 'navigator']) {
      assert.ok(!new RegExp(`\\b${banned}\\b`).test(code), `${file} 不应引用 ${banned}`);
    }
    assert.ok(!/\brequire\s*\(/.test(code), `${file} 不应使用 require`);
    const imports = [...code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('node:'),
        `${file} 只允许相对依赖或 node: 内置模块，发现 ${specifier}`,
      );
    }
  }
});