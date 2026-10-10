/**
 * 乔木阅读 · 核心状态模型（契约见 docs/ARCHITECTURE.md 4.5）
 *
 * 设计约束：
 * - 纯逻辑模块：不引用 window / document / navigator，不 import 任何第三方包；
 * - 所有导出函数都是纯函数：不修改入参，返回新对象；
 * - 畸形输入（null / 数组 / 字符串 / 缺字段）一律归一化成合法结构，绝不抛异常。
 */

import { bounded, FONT_MIN, FONT_MAX, PDF_ZOOM_MIN, PDF_ZOOM_MAX } from './reader-input.js';
import { normalizeTagModel } from './tags.js';

/** 阅读器默认设置（冻结；调用方只读，不要原地修改） */
export const DEFAULT_READER_SETTINGS = Object.freeze({
  theme: 'paper',
  fontSize: 18,
  pdfZoom: 1,
  lineHeight: 1.75,
  fontFamily: 'serif',
  margin: 64,
  flow: 'paginated',
  justify: true,
});

/** 允许的划线颜色（与 UI 调色板一致，其它值一律回落 yellow） */
export const HIGHLIGHT_COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink']);

/** locator 缺省值：新建状态、坏数据都回落到这里 */
const DEFAULT_LOCATOR = Object.freeze({
  chapterIndex: 0,
  chapterHref: '',
  scroll: 0,
  textQuote: '',
});

/** 合法的翻页模式 */
const FLOW_MODES = Object.freeze(['paginated', 'scroll']);

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 是否为「普通对象」（排除 null / 数组） */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅接受字符串；其它类型不做隐式 toString，避免把对象变成 "[object Object]" */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 宽松取数：接受 number 与数字字符串，否则回落 fallback */
function num(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 取正数，非正 / 非法回落 fallback */
function positiveNum(value, fallback) {
  const n = num(value, fallback);
  return n > 0 ? n : fallback;
}

/** 取非负数，负数 / 非法回落 fallback */
function nonNegativeNum(value, fallback) {
  const n = num(value, fallback);
  return n >= 0 ? n : fallback;
}

/** 归一到 [0, 1] */
function clamp01(value) {
  const n = num(value, 0);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 时间戳：非正数 / 非法值一律视为 0（未设置） */
function toTimestamp(value) {
  const n = num(value, 0);
  return n > 0 ? Math.floor(n) : 0;
}

/** 非负整数 */
function toNonNegativeInt(value) {
  const n = num(value, 0);
  return n > 0 ? Math.floor(n) : 0;
}

/** 取文件扩展名（小写，不含点） */
function extOf(file) {
  const name = str(file);
  const cut = name.lastIndexOf('.');
  if (cut <= 0 || cut === name.length - 1) return '';
  return name.slice(cut + 1).toLowerCase();
}

/** 划线颜色白名单 */
function pickColor(value) {
  const color = str(value).toLowerCase();
  return HIGHLIGHT_COLORS.includes(color) ? color : HIGHLIGHT_COLORS[0];
}

/** 去重用的文本指纹：折叠空白，忽略首尾空白差异 */
function normKey(value) {
  return str(value).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/**
 * 归一化 locator：缺字段补默认，scroll 夹到 [0, 1]
 * @param {unknown} raw
 * @returns {{chapterIndex:number, chapterHref:string, scroll:number, textQuote:string}}
 */
function normalizeLocator(raw) {
  const source = isObject(raw) ? raw : {};
  const chapterIndex = num(source.chapterIndex, DEFAULT_LOCATOR.chapterIndex);
  return {
    ...DEFAULT_LOCATOR,
    ...source,
    chapterIndex: chapterIndex > 0 ? Math.floor(chapterIndex) : 0,
    chapterHref: str(source.chapterHref),
    scroll: clamp01(source.scroll),
    textQuote: str(source.textQuote),
  };
}

/**
 * 归一化阅读设置：已知字段做类型校验，未知字段原样保留
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeSettings(raw) {
  const source = isObject(raw) ? raw : {};
  const flow = str(source.flow).toLowerCase();
  return {
    ...DEFAULT_READER_SETTINGS,
    ...source,
    theme: str(source.theme).trim() || DEFAULT_READER_SETTINGS.theme,
    fontSize: bounded(source.fontSize, DEFAULT_READER_SETTINGS.fontSize, FONT_MIN, FONT_MAX),
    pdfZoom: bounded(source.pdfZoom, 1, PDF_ZOOM_MIN, PDF_ZOOM_MAX),
    lineHeight: positiveNum(source.lineHeight, DEFAULT_READER_SETTINGS.lineHeight),
    fontFamily: str(source.fontFamily).trim() || DEFAULT_READER_SETTINGS.fontFamily,
    margin: nonNegativeNum(source.margin, DEFAULT_READER_SETTINGS.margin),
    flow: FLOW_MODES.includes(flow) ? flow : DEFAULT_READER_SETTINGS.flow,
    justify: source.justify === undefined ? DEFAULT_READER_SETTINGS.justify : Boolean(source.justify),
  };
}

/** 设置是否完全等于默认值（用于合并时的信息量取舍） */
function isDefaultSettings(settings) {
  return Object.keys(DEFAULT_READER_SETTINGS).every(
    (key) => settings?.[key] === DEFAULT_READER_SETTINGS[key],
  );
}

/**
 * 归一化单条划线；完全没有信息（无 href 且无 text）的条目丢弃
 * @param {unknown} raw
 * @param {string} bookId
 * @returns {object|null}
 */
function normalizeHighlight(raw, bookId) {
  if (!isObject(raw)) return null;
  const chapterHref = str(raw.chapterHref);
  const text = str(raw.text).trim();
  if (!chapterHref && !text) return null;
  const createdAt = toTimestamp(raw.createdAt);
  return {
    ...raw,
    id: str(raw.id) || stableId('h', bookId, chapterHref, normKey(text), createdAt),
    chapterHref,
    text,
    note: str(raw.note),
    color: pickColor(raw.color),
    createdAt,
    percent: clamp01(raw.percent),
  };
}

/**
 * 归一化单条书签；完全没有信息（无 href 且无 label）的条目丢弃
 * @param {unknown} raw
 * @param {string} bookId
 * @returns {object|null}
 */
function normalizeBookmark(raw, bookId) {
  if (!isObject(raw)) return null;
  const chapterHref = str(raw.chapterHref);
  const label = str(raw.label).trim();
  if (!chapterHref && !label) return null;
  const createdAt = toTimestamp(raw.createdAt);
  const percent = clamp01(raw.percent);
  return {
    ...raw,
    id: str(raw.id) || stableId('b', bookId, chapterHref, percent, createdAt),
    chapterHref,
    percent,
    label,
    createdAt,
  };
}

/**
 * 归一化单本书目；非对象条目返回 null（由调用方过滤）
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeBook(raw) {
  if (!isObject(raw)) return null;
  const file = str(raw.file);
  const source = str(raw.source);
  return {
    ...raw,
    id: str(raw.id) || stableId('book', str(raw.title), str(raw.author), file, toTimestamp(raw.addedAt)),
    title: str(raw.title),
    author: str(raw.author),
    format: (str(raw.format) || extOf(file) || 'epub').toLowerCase(),
    file,
    bytes: toNonNegativeInt(raw.bytes),
    cover: str(raw.cover) || null,
    addedAt: toTimestamp(raw.addedAt),
    openedAt: raw.openedAt === null || raw.openedAt === undefined ? null : toTimestamp(raw.openedAt),
    source: source || 'starter',
    language: str(raw.language) || 'zh',
    chapterCount: toNonNegativeInt(raw.chapterCount),
  };
}

/**
 * 归一化任意来源的 library 数据
 * @param {unknown} raw
 * @returns {{version:number, updatedAt:number, books:object[]}}
 */
export function normalizeLibrary(raw) {
  const source = isObject(raw) ? raw : {};
  const books = Array.isArray(source.books)
    ? source.books.map((book) => normalizeBook(book)).filter(Boolean)
    : [];
  return {
    ...source,
    version: toNonNegativeInt(source.version) || 1,
    updatedAt: toTimestamp(source.updatedAt),
    ...normalizeTagModel(source),
    books,
  };
}

/**
 * 归一化任意来源的 book state 数据
 * @param {unknown} raw
 * @param {string} [bookId] 兜底 bookId（raw.bookId 缺失时使用）
 * @returns {{version:number, bookId:string, locator:object, updatedAt:number,
 *            highlights:object[], bookmarks:object[], settings:object}}
 */
export function normalizeState(raw, bookId) {
  const source = isObject(raw) ? raw : {};
  const id = str(source.bookId) || str(bookId);
  const highlights = Array.isArray(source.highlights)
    ? source.highlights.map((item) => normalizeHighlight(item, id)).filter(Boolean)
    : [];
  const bookmarks = Array.isArray(source.bookmarks)
    ? source.bookmarks.map((item) => normalizeBookmark(item, id)).filter(Boolean)
    : [];
  return {
    ...source,
    version: toNonNegativeInt(source.version) || 1,
    bookId: id,
    locator: normalizeLocator(source.locator),
    updatedAt: toTimestamp(source.updatedAt),
    highlights,
    bookmarks,
    settings: normalizeSettings(source.settings),
  };
}

/**
 * 新建一本书的空状态。
 * updatedAt 保持 0（「从未保存」），这样与磁盘读回的真实状态合并时不会压掉对方。
 * @param {string} bookId
 * @returns {object}
 */
export function createBookState(bookId) {
  return normalizeState({ bookId: str(bookId) }, bookId);
}

/* ------------------------------------------------------------------ *
 * 稳定 id
 * ------------------------------------------------------------------ */

/**
 * 由任意参数生成稳定的短 id（FNV-1a + djb2 双散列，纯 JS，无 crypto 依赖）
 * @param {...unknown} parts
 * @returns {string}
 */
export function stableId(...parts) {
  const input = parts
    .map((part) => (part === null || part === undefined ? '' : String(part)))
    .join('\u0000');
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return `${fnv.toString(36)}-${djb.toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * 划线 / 书签
 * ------------------------------------------------------------------ */

/**
 * 追加一条划线。
 * 去重规则：同一章节 + 同一 text + 同一 color 视为已存在，直接返回原 state。
 * @param {object} state
 * @param {{chapterHref?:string, text?:string, note?:string, color?:string,
 *          percent?:number, createdAt?:number, id?:string}} input
 * @returns {{state:object, highlight:object|null}} highlight 为 null 表示输入无效
 */
export function addHighlight(state, input) {
  const source = isObject(input) ? input : {};
  const original = isObject(state) ? state : null;
  const base = normalizeState(state, original?.bookId);
  const chapterHref = str(source.chapterHref);
  const text = str(source.text).trim();
  if (!text) {
    return { state: original || base, highlight: null };
  }
  const color = pickColor(source.color);
  const textOffset = Number.isFinite(source.textOffset) ? Math.max(0, Math.floor(source.textOffset)) : null;
  const key = `${chapterHref}\u0000${normKey(text)}\u0000${color}\u0000${textOffset ?? ''}`;
  const existing = base.highlights.find(
    (item) => `${item.chapterHref}\u0000${normKey(item.text)}\u0000${item.color}\u0000${item.textOffset ?? ''}` === key,
  );
  if (existing) return { state: original || base, highlight: existing };

  const createdAt = toTimestamp(source.createdAt) || Date.now();
  const highlight = {
    id: str(source.id) || stableId('h', base.bookId, chapterHref, normKey(text), color, textOffset, createdAt),
    chapterHref,
    text,
    note: str(source.note),
    color,
    createdAt,
    percent: clamp01(source.percent),
    textOffset,
  };
  return {
    state: {
      ...base,
      highlights: [...base.highlights, highlight],
      updatedAt: Math.max(base.updatedAt, createdAt),
    },
    highlight,
  };
}

/**
 * 删除一条划线
 * @param {object} state
 * @param {string} id
 * @returns {{state:object, removed:boolean}}
 */
export function removeHighlight(state, id) {
  const original = isObject(state) ? state : null;
  const base = normalizeState(state, original?.bookId);
  const target = str(id);
  if (!target) return { state: original || base, removed: false };
  const index = base.highlights.findIndex((item) => item.id === target);
  if (index < 0) return { state: original || base, removed: false };
  const highlights = base.highlights.filter((_, i) => i !== index);
  return {
    state: { ...base, highlights, updatedAt: Math.max(base.updatedAt, Date.now()) },
    removed: true,
  };
}

/**
 * 更新划线批注（note 传空串表示清除批注）
 * @param {object} state
 * @param {string} id
 * @param {string} note
 * @returns {object} 未命中或内容未变化时返回原 state（引用不变）
 */
export function updateHighlightNote(state, id, note) {
  const original = isObject(state) ? state : null;
  const base = normalizeState(state, original?.bookId);
  const target = str(id);
  const text = str(note).trim();
  const index = target ? base.highlights.findIndex((item) => item.id === target) : -1;
  if (index < 0 || base.highlights[index].note === text) return original || base;
  const highlights = base.highlights.map((item, i) => (i === index ? { ...item, note: text } : item));
  return { ...base, highlights, updatedAt: Math.max(base.updatedAt, Date.now()) };
}

/**
 * 追加一条书签（章节 + 位置 + 标签完全相同视为已存在）
 * @param {object} state
 * @param {{chapterHref?:string, percent?:number, label?:string,
 *          createdAt?:number, id?:string}} input
 * @returns {{state:object, bookmark:object|null}}
 */
export function addBookmark(state, input) {
  const source = isObject(input) ? input : {};
  const original = isObject(state) ? state : null;
  const base = normalizeState(state, original?.bookId);
  const chapterHref = str(source.chapterHref);
  const label = str(source.label).trim();
  const percent = clamp01(source.percent);
  if (!chapterHref && !label) return { state: original || base, bookmark: null };

  const existing = base.bookmarks.find(
    (item) => item.chapterHref === chapterHref && item.percent === percent && item.label === label,
  );
  if (existing) return { state: original || base, bookmark: existing };

  const createdAt = toTimestamp(source.createdAt) || Date.now();
  const bookmark = {
    id: str(source.id) || stableId('b', base.bookId, chapterHref, percent, label, createdAt),
    chapterHref,
    percent,
    label,
    createdAt,
  };
  return {
    state: {
      ...base,
      bookmarks: [...base.bookmarks, bookmark],
      updatedAt: Math.max(base.updatedAt, createdAt),
    },
    bookmark,
  };
}

/**
 * 删除一条书签
 * @param {object} state
 * @param {string} id
 * @returns {object} 未命中时返回原 state（引用不变）
 */
export function removeBookmark(state, id) {
  const original = isObject(state) ? state : null;
  const base = normalizeState(state, original?.bookId);
  const target = str(id);
  const index = target ? base.bookmarks.findIndex((item) => item.id === target) : -1;
  if (index < 0) return original || base;
  const bookmarks = base.bookmarks.filter((_, i) => i !== index);
  return { ...base, bookmarks, updatedAt: Math.max(base.updatedAt, Date.now()) };
}

/* ------------------------------------------------------------------ *
 * 进度与合并
 * ------------------------------------------------------------------ */

/**
 * 阅读进度（0..1）：以「第 chapterIndex 章 + 章内比例」估算
 * @param {object} state
 * @param {number} chapterCount
 * @returns {number}
 */
export function progressOf(state, chapterCount) {
  const total = toNonNegativeInt(chapterCount);
  if (total <= 0) return 0;
  const locator = normalizeLocator(isObject(state) ? state.locator : null);
  const chapterIndex = Math.min(Math.max(locator.chapterIndex, 0), total - 1);
  return clamp01((chapterIndex + clamp01(locator.scroll)) / total);
}

/** 单条记录的时间戳（优先 updatedAt，其次 createdAt） */
function entryTime(entry) {
  return Math.max(toTimestamp(entry?.updatedAt), toTimestamp(entry?.createdAt));
}

/**
 * 按 id 合并两组记录：新者胜，时间相同保留 a（先出现者）的顺序与内容
 * @param {object[]} leftList
 * @param {object[]} rightList
 * @returns {object[]}
 */
function mergeEntriesById(leftList, rightList) {
  const merged = leftList.map((item) => ({ ...item }));
  const indexOfId = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of rightList) {
    const index = indexOfId.get(item.id);
    if (index === undefined) {
      merged.push({ ...item });
      indexOfId.set(item.id, merged.length - 1);
      continue;
    }
    if (entryTime(item) > entryTime(merged[index])) merged[index] = { ...item };
  }
  return merged;
}

/** locator 是否携带了实际信息（用于时间相同但一方为空时的取舍） */
function hasLocatorInfo(locator) {
  return Boolean(locator?.chapterHref) || Boolean(locator?.textQuote) || (locator?.chapterIndex ?? 0) > 0;
}

/**
 * 合并两台设备的状态（契约 4.5）
 * - 划线 / 书签按 id 合并，updatedAt / createdAt 新者胜；
 * - locator 取 updatedAt 新的一方；时间相同取信息更全的一方；
 * - settings 取 b 的（仅在 b 的 updatedAt 更新时），时间相同时取非默认的一方；
 * - 顶层未知字段保留，冲突时右侧胜。
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
export function mergeStates(a, b) {
  const left = normalizeState(a, a?.bookId);
  const right = normalizeState(b, b?.bookId);
  const aTime = left.updatedAt;
  const bTime = right.updatedAt;
  const bNewer = bTime > aTime;
  const aNewer = aTime > bTime;

  let locator;
  if (bNewer) locator = { ...right.locator };
  else if (aNewer) locator = { ...left.locator };
  else locator = hasLocatorInfo(right.locator) && !hasLocatorInfo(left.locator)
    ? { ...right.locator }
    : { ...left.locator };

  let settings;
  if (bNewer) settings = { ...right.settings };
  else if (aNewer) settings = { ...left.settings };
  else settings = isDefaultSettings(left.settings) && !isDefaultSettings(right.settings)
    ? { ...right.settings }
    : { ...left.settings };

  return {
    ...left,
    ...right,
    version: Math.max(left.version, right.version) || 1,
    bookId: left.bookId || right.bookId,
    locator,
    updatedAt: Math.max(aTime, bTime),
    highlights: mergeEntriesById(left.highlights, right.highlights),
    bookmarks: mergeEntriesById(left.bookmarks, right.bookmarks),
    settings,
  };
}
