/**
 * 乔木阅读 · 搜索与片段（契约见 docs/ARCHITECTURE.md 4.6）
 *
 * 设计约束：
 * - 纯逻辑模块：不引用 window / document / navigator，不 import 任何第三方包；
 * - 偏移量（index / offset）一律是 UTF-16 码元下标，与 DOM Range / String#slice 一致；
 * - 中文友好：CJK 按字匹配，不做分词；英文按大小写不敏感的子串匹配。
 */

/** 句末标点（中英混排）：. ! ? 。 ！ ？ … ； ; 以及换行 */
const SENTENCE_BREAK = /[^.!?。！？…；;\n]*[.!?。！？…；;]+[）」』”’"'\])】]*|[^\n]+/g;

/** 统一转字符串：null / undefined 视为空串 */
function toText(value) {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

/** 取整数，非法回落 fallback */
function toCount(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

/** 转义正则元字符 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 归一化查询串：trim + 折叠连续空白（含全角空格）；中英文混排不做分词
 * @param {string} q
 * @returns {string}
 */
export function normalizeQuery(q) {
  return toText(q).replace(/[\s\u3000]+/g, ' ').trim();
}

/**
 * 把归一化后的查询串编译成正则：词间空白允许匹配原文的任意空白/换行
 * @param {string} needle
 * @returns {RegExp}
 */
function buildPattern(needle) {
  const parts = needle.split(' ').filter(Boolean).map(escapeRegExp);
  return new RegExp(parts.join('[\\s\\u3000]+'), 'giu');
}

/**
 * 在文本中查找全部命中（大小写不敏感子串匹配）
 * @param {string} text
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {{index:number, length:number}[]} 空 query 返回 []
 */
export function searchInText(text, query, opts) {
  const haystack = toText(text);
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const raw = opts?.limit;
  const limit = raw === undefined || raw === null ? Number.POSITIVE_INFINITY : toCount(raw, Number.POSITIVE_INFINITY);
  if (limit <= 0) return [];

  const pattern = buildPattern(needle);
  const hits = [];
  let match;
  while ((match = pattern.exec(haystack)) !== null) {
    hits.push({ index: match.index, length: match[0].length });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * 生成以 at 为中心的摘要窗口，两侧按需补 `…`，内部换行折成空格
 * @param {string} text
 * @param {number} at 命中起点
 * @param {number} span 命中长度
 * @param {number} [width=80] 窗口总宽度
 * @returns {string}
 */
export function makeSnippet(text, at, span, width = 80) {
  const source = toText(text);
  if (!source) return '';
  const total = Math.max(1, toCount(width, 80));
  const matchStart = Math.min(Math.max(toCount(at, 0), 0), source.length);
  const matchEnd = Math.min(source.length, matchStart + Math.max(toCount(span, 0), 0));
  const center = (matchStart + matchEnd) / 2;

  let start = Math.round(center - total / 2);
  let end = start + total;
  if (end > source.length) {
    end = source.length;
    start = end - total;
  }
  if (start < 0) {
    start = 0;
    end = Math.min(source.length, total);
  }
  // 保证命中本身完整落在窗口内
  if (start > matchStart) {
    start = matchStart;
    end = Math.min(source.length, start + total);
  }
  if (end < matchEnd) {
    end = matchEnd;
    start = Math.max(0, end - total);
  }

  const slice = source.slice(start, end).replace(/\s+/g, ' ').trim();
  const lead = start > 0 ? '…' : '';
  const tail = end < source.length ? '…' : '';
  return `${lead}${slice}${tail}`;
}

/**
 * 切句范围（按中英文句末标点与换行），start/end 指向原文下标
 * @param {string} text
 * @returns {{start:number, end:number, text:string}[]}
 */
function sentenceRanges(text) {
  const source = toText(text);
  const ranges = [];
  SENTENCE_BREAK.lastIndex = 0;
  let match;
  while ((match = SENTENCE_BREAK.exec(source)) !== null) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (trimmed) {
      const offset = raw.length - raw.trimStart().length;
      ranges.push({ start: match.index + offset, end: match.index + offset + trimmed.length, text: trimmed });
    }
  }
  return ranges;
}

/**
 * 按中英文句末标点切句（UI 用于「所在句」展示）
 * @param {string} text
 * @returns {string[]} 已 trim、已滤空的句子数组
 */
export function splitSentences(text) {
  return sentenceRanges(text).map((range) => range.text);
}

/**
 * 取包含指定偏移的整句（额外便利函数，供 UI 高亮「所在句」）
 * @param {string} text
 * @param {number} index
 * @returns {string} 找不到返回 ''
 */
export function sentenceAt(text, index) {
  const source = toText(text);
  const ranges = sentenceRanges(source);
  if (!ranges.length) return '';
  const at = Math.min(Math.max(toCount(index, 0), 0), source.length);
  for (const range of ranges) {
    if (at <= range.end) return range.text;
  }
  return ranges[ranges.length - 1].text;
}