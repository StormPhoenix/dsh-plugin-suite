/**
 * 乔木阅读 · 阅读引擎（契约见 docs/ARCHITECTURE.md 4.4）
 *
 * 设计约束：
 * - 纯逻辑模块：不引用 window / document / navigator，不 import 任何第三方包；
 * - 章节解析与 HTML 处理交给 ./html.js（契约 4.3，由 parser-core 提供）；
 * - 搜索能力复用 ./search.js（同为核心模块，零依赖）；
 * - 所有方法对坏数据容错：章节不存在返回空串 / 空数组，绝不抛异常。
 */
import {
  extractBody,
  sanitizeHtml,
  toPlainText,
  absolutize,
  rewriteResources,
} from './html.js';
import { makeSnippet, normalizeQuery, searchInText } from './search.js';

/** search() 默认最多返回的命中数 */
const DEFAULT_SEARCH_LIMIT = 80;
/** 单章最多贡献的命中数，避免长章节淹没全书结果 */
const MAX_HITS_PER_CHAPTER = 5;
/** 摘要窗口宽度 */
const SNIPPET_WIDTH = 80;

/** 外部协议（http:/https:/data: 等）不参与 spine 内部链接解析 */
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 取整数下标，非法返回 NaN */
function toIndex(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : NaN;
  }
  return NaN;
}

/** 取字符串（非字符串一律空串） */
function toText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 路径百分号解码（容错：非法编码原样返回）
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 去掉 #fragment 与 ?query */
function stripFragment(href) {
  return toText(href).split('#')[0].split('?')[0];
}

/**
 * 归一化 zip 内路径：统一斜杠、去掉 . 与 ..（根部 .. 直接丢弃）
 * @param {string} value
 * @returns {string}
 */
function normalizePath(value) {
  const segments = safeDecode(stripFragment(value)).replace(/\\/g, '/').split('/');
  const out = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** 取 href 所在目录（带结尾斜杠，无目录返回空串） */
function dirOf(href) {
  const path = normalizePath(href);
  const cut = path.lastIndexOf('/');
  return cut >= 0 ? path.slice(0, cut + 1) : '';
}

/**
 * 以 baseDir 为基准解析相对路径
 * @param {string} baseDir
 * @param {string} path
 * @returns {string}
 */
function resolveFrom(baseDir, path) {
  if (!path) return '';
  return normalizePath(path.startsWith('/') ? path.slice(1) : `${baseDir}${path}`);
}

/** full 是否以 suffix 结尾（按路径边界比较） */
function endsWithPath(full, suffix) {
  if (!suffix) return false;
  return full === suffix || full.endsWith(`/${suffix}`);
}

/** 取 search() 的 limit：非法回落默认值，0 表示不返回 */
function normalizeLimit(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return fallback;
}

/**
 * 建立 TOC 查找表：归一化 href -> 从根到该节点的祖先链
 * @param {object|null} book
 * @returns {Map<string, object[]>}
 */
function buildTocMap(book) {
  const map = new Map();
  const walk = (entries, ancestors) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const chain = [...ancestors, entry];
      const href = normalizePath(entry.href);
      if (href && !map.has(href)) map.set(href, chain);
      walk(entry.children, chain);
    }
  };
  walk(book?.toc, []);
  return map;
}

/**
 * 创建阅读引擎
 * @param {object} book EpubBook（契约 4.2）；坏数据也能构造，只是返回空结果
 * @returns {object} ReaderEngine（契约 4.4）
 */
export function createReaderEngine(book) {
  const source = book && typeof book === 'object' ? book : null;
  const chapters = Array.isArray(source?.chapters) ? source.chapters : [];
  const tocMap = buildTocMap(source);
  /** 章节清洗后的 HTML（缓存，避免重复解析） */
  const bodyCache = new Map();
  /** 章节纯文本（缓存） */
  const textCache = new Map();

  /** 章节索引（合法整数）或 -1 */
  function indexOf(chapterIndex) {
    const i = toIndex(chapterIndex);
    return Number.isInteger(i) && i >= 0 && i < chapters.length ? i : -1;
  }

  /**
   * 章节清洗后的 HTML（extractBody + sanitizeHtml），带缓存
   * @param {number} index 已校验的下标
   * @returns {string}
   */
  function sanitizedBody(index) {
    if (bodyCache.has(index)) return bodyCache.get(index);
    const chapter = chapters[index];
    let body = '';
    try {
      body = sanitizeHtml(extractBody(toText(chapter?.xhtml)));
    } catch {
      body = '';
    }
    bodyCache.set(index, body);
    return body;
  }

  /**
   * 章节纯文本（带缓存）；内部与 plainTextOf 共用，避免依赖 this
   * @param {number} index 已校验的下标
   * @returns {Promise<string>}
   */
  async function plainTextAt(index) {
    if (textCache.has(index)) return textCache.get(index);
    let text = '';
    try {
      text = toText(toPlainText(sanitizedBody(index)));
    } catch {
      text = '';
    }
    textCache.set(index, text);
    return text;
  }

  /** 按 href 匹配章节：先精确匹配，再按路径尾部匹配 */
  function matchChapterByPath(target) {
    if (!target) return null;
    const normalized = chapters.map((chapter) => normalizePath(chapter?.href));
    const exact = normalized.indexOf(target);
    if (exact >= 0) return exact;
    const tail = normalized.findIndex((href) => endsWithPath(href, target));
    return tail >= 0 ? tail : null;
  }

  /** 在 TOC 中查找章节：精确优先，其次尾部匹配 */
  function tocChainOf(index) {
    const href = normalizePath(chapters[index]?.href);
    if (!href) return [];
    if (tocMap.has(href)) return tocMap.get(href);
    for (const [key, chain] of tocMap) {
      if (endsWithPath(href, key) || endsWithPath(key, href)) return chain;
    }
    return [];
  }

  /** 章节展示名：TOC 标题优先，其次 chapter.label，最后「第 N 章」 */
  function labelOf(index) {
    const chain = tocChainOf(index);
    const label = toText(chain[chain.length - 1]?.label).trim();
    if (label) return label;
    const own = toText(chapters[index]?.label).trim();
    return own || `第 ${index + 1} 章`;
  }

  return {
    book: source,

    /**
     * 章节数量
     * @returns {number}
     */
    chapterCount() {
      return chapters.length;
    },

    /**
     * 该章可渲染的干净 HTML（已 absolutize + rewriteResources）
     * @param {number} chapterIndex
     * @param {(zipPath: string) => string|null} resolveResource
     * @returns {Promise<string>} 章节不存在 / 处理失败返回空串
     */
    async render(chapterIndex, resolveResource) {
      const index = indexOf(chapterIndex);
      if (index < 0) return '';
      const baseDir = dirOf(chapters[index]?.href);
      const resolve = typeof resolveResource === 'function' ? resolveResource : () => null;
      try {
        // 顺序很重要：rewriteResources 需要「相对路径 + baseDir」才能算出正确的 zip 路径
        // （它同时处理 src / srcset / poster / xlink:href）；先改写资源，再用
        // absolutize 把剩下的相对 href（章节内链）补成 zip 根路径。
        // 已换成 blob: 的 src 会被 absolutize 视为外部链接而原样保留。
        const rewritten = rewriteResources(sanitizedBody(index), baseDir, resolve);
        return absolutize(rewritten, baseDir);
      } catch {
        return '';
      }
    },

    /**
     * 该章纯文本（供搜索与 Agent 读取）
     * @param {number} chapterIndex
     * @returns {Promise<string>} 章节不存在返回空串
     */
    async plainTextOf(chapterIndex) {
      const index = indexOf(chapterIndex);
      if (index < 0) return '';
      return plainTextAt(index);
    },

    /**
     * 全书搜索：逐章取纯文本，每章最多 MAX_HITS_PER_CHAPTER 条
     * @param {string} query
     * @param {number} [limit=80]
     * @returns {Promise<{chapterIndex:number, chapterLabel:string, snippet:string,
     *                    offset:number, percent:number}[]>}
     */
    async search(query, limit = DEFAULT_SEARCH_LIMIT) {
      const needle = normalizeQuery(query);
      const max = normalizeLimit(limit, DEFAULT_SEARCH_LIMIT);
      if (!needle || max <= 0 || !chapters.length) return [];
      const hits = [];
      for (let index = 0; index < chapters.length && hits.length < max; index++) {
        const text = await plainTextAt(index);
        if (!text) continue;
        const found = searchInText(text, needle, { limit: MAX_HITS_PER_CHAPTER });
        for (const match of found) {
          hits.push({
            chapterIndex: index,
            chapterLabel: labelOf(index),
            snippet: makeSnippet(text, match.index, match.length, SNIPPET_WIDTH),
            offset: match.index,
            percent: index / chapters.length,
          });
          if (hits.length >= max) break;
        }
      }
      return hits;
    },

    /**
     * spine 内相对链接解析
     * - 纯 `#frag` 返回当前章；
     * - 相对路径先按当前章目录解析，再按章节 href 尾部比对；
     * - 外部协议、未知路径返回 null。
     * @param {number} currentIndex
     * @param {string} href
     * @returns {number|null}
     */
    resolveLink(currentIndex, href) {
      const current = indexOf(currentIndex);
      const raw = toText(href).trim();
      if (!raw || EXTERNAL_SCHEME.test(raw)) return null;
      const path = stripFragment(raw);
      if (!path) return current >= 0 ? current : null; // 纯 #frag
      const currentHref = current >= 0 ? chapters[current]?.href : '';
      const resolved = resolveFrom(dirOf(currentHref), path);
      const matched = matchChapterByPath(resolved) ?? matchChapterByPath(normalizePath(path));
      return matched === null ? null : matched;
    },

    /**
     * 从章节反查 TOC 路径（根 -> 该节点）
     * @param {number} chapterIndex
     * @returns {object[]} 找不到返回 []
     */
    tocFor(chapterIndex) {
      const index = indexOf(chapterIndex);
      if (index < 0) return [];
      return tocChainOf(index).map((entry) => ({ ...entry }));
    },
  };
}