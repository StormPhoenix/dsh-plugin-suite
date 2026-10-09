/**
 * 纯格式化与文本工具：百分比、相对时间、截断、字节数、Markdown 导出、剪贴板/下载。
 * 除剪贴板与下载两个函数需要浏览器环境外，其余全部是纯函数，不依赖 React。
 * 所有函数都做了防御性处理，传入 null/undefined 不会抛异常。
 */

import { highlightLink } from '../core/backlink.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 划线颜色顺序（与 theme.js 的 HIGHLIGHT_COLORS 保持一致） */
export const HIGHLIGHT_COLOR_LABELS = Object.freeze({
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  pink: '粉',
});

/**
 * 把任意来源的进度值归一化到 0~1。
 * core.state.progressOf 的返回可能是 0~1，也可能被上游写成 0~100，这里两种都接受。
 * @param {unknown} value 原始进度值
 * @returns {number} 0~1 之间的数字
 */
export function normalizePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1.0001) return Math.min(1, n / 100);
  return Math.min(1, n);
}

/**
 * 归一化进度转可读百分比文本。
 * @param {unknown} value 0~1 或 0~100
 * @param {number} [digits] 小数位，默认 0
 * @returns {string} 形如 "12%"
 */
export function formatPercent(value, digits = 0) {
  return `${(normalizePercent(value) * 100).toFixed(digits)}%`;
}

/**
 * 相对时间文本。
 * @param {unknown} timestamp 毫秒时间戳（也接受可被 Date.parse 的字符串）
 * @param {number} [now] 当前时间，便于测试
 * @returns {string} 形如 "刚刚 / 12 分钟前 / 3 天前 / 2024-05-06"
 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const at = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp || ''));
  if (!Number.isFinite(at) || at <= 0) return '未读';
  const diff = now - at;
  if (diff < 0) return '刚刚';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return '昨天';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 截断文本，超出时追加省略号。
 * @param {unknown} text 原文
 * @param {number} [max] 最大长度，默认 120
 * @returns {string}
 */
export function truncate(text, max = 120) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 字节数转可读大小。
 * @param {unknown} bytes
 * @returns {string} 形如 "1.2 MB"
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 取书名首字/首字母，用于无封面时的色块占位。
 * @param {unknown} title
 * @returns {string} 1~2 个字符
 */
export function initialsOf(title) {
  const value = String(title == null ? '' : title).trim();
  if (!value) return '书';
  const han = value.match(/[\u3400-\u9fff\uf900-\ufaff]/);
  if (han) return value.slice(Math.max(0, han.index), Math.max(0, han.index) + 2);
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

/**
 * 由 id 稳定地生成一个封面色块颜色。
 * @param {unknown} id
 * @returns {string} hsl 颜色
 */
export function colorOfId(id) {
  const text = String(id == null ? '' : id);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  }
  const hue = hash % 360;
  return `hsl(${hue} 30% 42%)`;
}

/** HTML 转义 */
export function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 去掉 HTML 标签的纯文本化（用于标题/摘要类展示） */
export function stripTags(text) {
  return String(text == null ? '' : text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 生成一个本地唯一 id（仅在没有 core.stableId 可用时兜底）。
 * @param {string} [prefix]
 * @returns {string}
 */
export function localId(prefix = 'qmr') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 建立「章节 index -> 标签」映射，优先使用 TOC 标签，其次回退为「第 N 章」。
 * @param {object|null|undefined} engine ReaderEngine（契约 4.4）
 * @returns {Map<number,string>}
 */
export function chapterLabelMap(engine) {
  const labels = new Map();
  try {
    const chapters = (engine && engine.book && engine.book.chapters) || [];
    const toc = (engine && engine.book && engine.book.toc) || [];
    const byHref = new Map();
    chapters.forEach((chapter, index) => {
      const href = String((chapter && chapter.href) || '');
      if (href) byHref.set(href, index);
    });
    const walk = (entries) => {
      for (const entry of entries || []) {
        if (!entry) continue;
        const href = String(entry.href || '');
        let index = byHref.get(href);
        if (index == null && href) {
          const base = href.split('/').pop();
          for (const [chapterHref, chapterIndex] of byHref) {
            if (chapterHref === href || chapterHref.split('/').pop() === base) {
              index = chapterIndex;
              break;
            }
          }
        }
        if (index != null && !labels.has(index)) {
          labels.set(index, stripTags(entry.label) || `第 ${index + 1} 章`);
        }
        walk(entry.children);
      }
    };
    walk(toc);
    chapters.forEach((_chapter, index) => {
      if (!labels.has(index)) labels.set(index, `第 ${index + 1} 章`);
    });
  } catch (_error) {
    /* 映射失败不影响阅读，回退为空 Map */
  }
  return labels;
}

/**
 * 由 chapterHref 找章节 index。
 * @param {object|null|undefined} engine ReaderEngine
 * @param {string} href
 * @returns {number} 找不到返回 -1
 */
export function chapterIndexForHref(engine, href) {
  try {
    const chapters = (engine && engine.book && engine.book.chapters) || [];
    const target = String(href || '');
    if (!target) return -1;
    for (let i = 0; i < chapters.length; i += 1) {
      if (chapters[i] && chapters[i].href === target) return i;
    }
    const base = target.split('/').pop();
    for (let i = 0; i < chapters.length; i += 1) {
      const chapterHref = String((chapters[i] && chapters[i].href) || '');
      if (chapterHref.split('/').pop() === base) return i;
    }
  } catch (_error) {
    /* 忽略 */
  }
  return -1;
}

/**
 * 把一本书的划线与批注导出为 Markdown 阅读笔记。
 * @param {object|null|undefined} state BookState（契约 3.3）
 * @param {object|null|undefined} book 书库条目
 * @param {object|null|undefined} [engine] ReaderEngine，用于补章节名
 * @returns {string} Markdown 文本
 */
export function toMarkdown(state, book, engine) {
  const title = stripTags((book && book.title) || '') || '未命名';
  const author = stripTags((book && book.author) || '');
  const highlights = Array.isArray(state && state.highlights) ? state.highlights.slice() : [];
  const labels = chapterLabelMap(engine);
  const lines = [`# 《${title}》阅读笔记`, ''];
  if (author) lines.push(`> ${author}`, '');
  lines.push('## 划线与批注', '');
  if (!highlights.length) {
    lines.push('_暂无划线。_');
  } else {
    for (const highlight of highlights) {
      if (!highlight) continue;
      const quote = String(highlight.text || '').replace(/\s+/g, ' ').trim();
      const note = String(highlight.note || '').trim();
      const index = chapterIndexForHref(engine, highlight.chapterHref);
      const chapter = index >= 0 ? labels.get(index) || `第 ${index + 1} 章` : '未知章节';
      const color = HIGHLIGHT_COLOR_LABELS[highlight.color] || '黄';
      lines.push(`### ${chapter}`, '');
      const link = highlightLink(book?.id, highlight.id);
      lines.push(`> ${quote}${link ? ` [↩ 回到原文](${link})` : ''}`, '');
      if (note) lines.push(note, '');
      lines.push(`*（${color}色划线 · ${formatPercent(highlight.percent)}）*`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\s*$/, '')}\n`;
}

/**
 * 剪贴板/下载使用的临时 DOM 宿主（由 shell.js 注册为浮层根节点）。
 * 这样就不需要写入 document.body，也不接管宿主页面。
 */
let uiHost = null;

/**
 * 注册临时 DOM 宿主（浮层根节点）。
 * @param {Element|null} element
 */
export function setUiHost(element) {
  uiHost = element || null;
}

/** 取可用的宿主节点 */
function hostOf() {
  try {
    if (uiHost && uiHost.nodeType === 1 && uiHost.isConnected !== false) return uiHost;
  } catch (_error) {
    /* 忽略 */
  }
  return null;
}

/**
 * 复制文本到剪贴板；返回是否成功。失败不抛异常，也不写 document.body。
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const value = String(text == null ? '' : text);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_error) {
    /* 回退到临时 textarea */
  }
  try {
    const host = hostOf();
    if (!host || typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    host.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    host.removeChild(area);
    return !!ok;
  } catch (_error) {
    return false;
  }
}

/**
 * 触发浏览器下载一段文本（用于「导出 Markdown」）。临时节点挂在浮层内，不写 document.body。
 * @param {string} text 文件内容
 * @param {string} filename 文件名
 * @returns {boolean} 是否发起下载
 */
export function downloadText(text, filename) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
    const blob = new Blob([String(text == null ? '' : text)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(filename || 'reading-note.md').replace(/[\\/:*?"<>|]/g, '_');
    anchor.style.display = 'none';
    const host = hostOf();
    if (host) host.appendChild(anchor);
    anchor.click();
    if (host && anchor.parentNode === host) host.removeChild(anchor);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_error) {
        /* 忽略 */
      }
    }, 2000);
    return true;
  } catch (_error) {
    return false;
  }
}
