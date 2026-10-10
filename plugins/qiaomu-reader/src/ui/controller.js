/**
 * UI 控制器：把 lead 注入的 props 包装成界面可直接调用的动作集合。
 *
 * 最终契约（lead 2025 补充版）：
 * - 数据：getBooks() / getStatus() / engineOf(id) / stateOf(id)[async] / progressOf(id) / actions / host / data
 * - store 由 lead 创建并注入；本控制器复用同一个 store 实例，额外写入自己的 UI 专有键。
 * - stateOf 是异步的：本地 states 缓存是渲染依据，loadState(id) 负责按需拉取（幂等）。
 * - 任何 props / core 调用都包 try/catch，失败退化为可读错误行，绝不白屏。
 *
 * 只 import 契约 4.5 承诺的 core 函数名，且调用点都带本地兜底实现。
 */
import {
  DEFAULT_READER_SETTINGS,
  addHighlight as coreAddHighlight,
  progressOf as coreProgressOf,
  removeHighlight as coreRemoveHighlight,
  updateHighlightNote as coreUpdateHighlightNote,
} from '../core/state.js';
import { createUiStore } from './store.js';
import { bounded, FONT_MIN, FONT_MAX, PDF_ZOOM_MIN, PDF_ZOOM_MAX } from '../core/reader-input.js';
import { UI_SETTING_DEFAULTS, READER_THEMES } from './theme.js';
import { chapterIndexForHref, copyText, formatPercent, localId, normalizePercent, toMarkdown } from './format.js';

const SAVE_DEBOUNCE_MS = 500;
const NOTICE_MS = 3200;

/** 安全取错误文本 */
function messageOf(error) {
  try {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    return String(error.message || error.error || error);
  } catch (_e) {
    return '未知错误';
  }
}

/** 整数并夹在范围内 */
function clampInt(value, min, max) {
  const n = Math.floor(Number(value) || 0);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Uint8Array -> dataURL（EPUB 插图用；失败返回 null） */
function bytesToDataUrl(bytes, mediaType) {
  try {
    if (!bytes || !bytes.length) return null;
    const type = String(mediaType || 'image/png');
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
    return `data:${type};base64,${base64}`;
  } catch (_error) {
    return null;
  }
}

/** 判断某个对象是否像 UI store */
function looksLikeStore(value) {
  return !!value && typeof value.get === 'function' && typeof value.set === 'function' && typeof value.subscribe === 'function';
}

/** 空状态（未加载时的安全读） */
function emptyState(id) {
  return {
    bookId: String(id == null ? '' : id),
    locator: { chapterIndex: 0, chapterHref: '', scroll: 0, textQuote: '' },
    highlights: [],
    bookmarks: [],
    settings: {},
    updatedAt: 0,
  };
}

/** 归一化宿主状态 */
function normalizeState(id, raw) {
  if (!raw || typeof raw !== 'object') return emptyState(id);
  return {
    bookId: String(id),
    locator: raw.locator && typeof raw.locator === 'object' ? { ...raw.locator } : emptyState(id).locator,
    highlights: Array.isArray(raw.highlights) ? raw.highlights.filter(Boolean) : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks.filter(Boolean) : [],
    settings: raw.settings && typeof raw.settings === 'object' ? { ...raw.settings } : {},
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

/**
 * 创建 UI 控制器。
 * @param {() => object} getProps 返回最新 props 的函数（组件用 ref 维持）
 * @param {object} [store] 注入的 UI store；不合法时新建一个
 * @returns {object} 控制器
 */
export function createController(getProps, store) {
  const uiStore = looksLikeStore(store) ? store : createUiStore();
  const saveTimers = new Map();
  const noticeTimer = { id: null };
  /** bookId -> Map(zipPath -> dataURL) */
  const imageCaches = new Map();
  /** bookId -> Promise<state>（幂等加载） */
  const stateLoads = new Map();
  let searchToken = 0;
  let overlayEl = null;

  const props = () => {
    try {
      return getProps() || {};
    } catch (_error) {
      return {};
    }
  };

  const actions = () => {
    const value = props().actions;
    return value && typeof value === 'object' ? value : {};
  };

  /** 调用宿主 action，永不抛异常；统一成 { ok, ... } */
  async function callAction(name, ...args) {
    const fn = actions()[name];
    if (typeof fn !== 'function') return { ok: false, error: `宿主未提供 ${name}()` };
    try {
      const result = await fn(...args);
      if (result && typeof result === 'object' && result.ok === false) {
        return { ok: false, error: messageOf(result.error || '操作失败') };
      }
      if (result && typeof result === 'object' && result.error && result.ok === undefined) {
        return { ok: false, error: messageOf(result.error) };
      }
      return result === undefined ? { ok: true } : result;
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 书库数组（每次现取，不缓存快照） */
  function books() {
    const p = props();
    try {
      if (typeof p.getBooks === 'function') {
        const list = p.getBooks();
        if (Array.isArray(list)) return list.filter(Boolean);
      }
    } catch (_error) {
      /* 回退 */
    }
    return Array.isArray(p.books) ? p.books.filter(Boolean) : [];
  }

  /** 书库加载状态 */
  function status() {
    const p = props();
    try {
      if (typeof p.getStatus === 'function') {
        const value = p.getStatus();
        if (value && typeof value === 'object') return value;
      }
    } catch (_error) {
      /* 回退 */
    }
    return {
      status: p.libraryLoading ? 'loading' : 'ready',
      error: p.libraryError || null,
    };
  }

  const libraryLoading = () => status().status === 'loading' && books().length === 0;

  /** 取书库条目 */
  function bookOf(id) {
    if (id == null) return null;
    return books().find((book) => book && String(book.id) === String(id)) || null;
  }

  /** 取阅读引擎（每次从 props 现取） */
  function engineOf(id) {
    if (id == null) return undefined;
    const fn = props().engineOf;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(id) || undefined;
    } catch (_error) {
      return undefined;
    }
  }

  // ------------------------------------------------------------- 状态加载/缓存

  const isLoaded = (id) => !!(id != null && uiStore.get().states && uiStore.get().states[id]);

  /** 缓存中的状态，未加载返回 null */
  function stateOfBook(id) {
    if (id == null) return null;
    const states = uiStore.get().states;
    return (states && states[id]) || null;
  }

  /** 安全读：未加载时返回空状态（不会写缓存，便于渲染） */
  function stateOr(id) {
    return stateOfBook(id) || emptyState(id);
  }

  /**
   * 按需加载某本书的状态（幂等，并发复用同一个 Promise）。
   * @param {string} id
   * @returns {Promise<object>} BookState
   */
  function loadState(id) {
    if (id == null) return Promise.resolve(emptyState(id));
    const cached = stateOfBook(id);
    if (cached) return Promise.resolve(cached);
    const pending = stateLoads.get(id);
    if (pending) return pending;
    const fn = props().stateOf;
    const promise = Promise.resolve()
      .then(() => (typeof fn === 'function' ? fn(id) : null))
      .then((raw) => normalizeState(id, raw))
      .catch((error) => {
        reportError(error, true);
        return emptyState(id);
      })
      .then((state) => {
        stateLoads.delete(id);
        setStates({ ...(uiStore.get().states || {}), [id]: state });
        return state;
      });
    stateLoads.set(id, promise);
    return promise;
  }

  /** 确保状态已加载后执行（写入类操作在未加载时排队） */
  function whenLoaded(id, run) {
    if (id == null) return;
    if (isLoaded(id)) {
      run();
      return;
    }
    loadState(id).then(run, run);
  }

  /** 合并式更新状态并持久化 */
/** 写入 states 缓存并推进版本号（书库用它订阅每本书的状态元数据） */
  function setStates(next) {
    uiStore.set({ states: next, statesRevision: (Number(uiStore.get().statesRevision) || 0) + 1 });
  }

  function patchState(id, patch) {
    if (id == null) return null;
    const current = stateOfBook(id) || emptyState(id);
    const next = normalizeState(id, { ...current, ...(patch || {}) });
    next.updatedAt = Date.now();
    setStates({ ...(uiStore.get().states || {}), [id]: next });
    const keys = patch ? Object.keys(patch) : [];
    const locatorOnly = keys.length === 1 && keys[0] === 'locator';
    scheduleSave(id, next, locatorOnly ? 'throttle' : 'debounce');
    return next;
  }

  /** 用完整状态对象替换（core 函数返回的 state 用这里） */
  function replaceState(id, next) {
    if (id == null || !next || typeof next !== 'object') return stateOfBook(id);
    const normalized = normalizeState(id, { ...next, updatedAt: Date.now() });
    // 保留 UI 专有设置字段：core 的 normalize 可能丢弃不认识的键（如 spread），
    // 用旧设置兜底，再由新设置覆盖。
    const previous = stateOfBook(id);
    normalized.settings = { ...((previous && previous.settings) || {}), ...(normalized.settings || {}) };
    setStates({ ...(uiStore.get().states || {}), [id]: normalized });
    scheduleSave(id, normalized);
    return normalized;
  }

  /**
   * 持久化调度。
   * - mode='debounce'：内容类写入（划线/批注/设置），每次重置定时器，最后一次写入后落盘。
   * - mode='throttle'：只更新 locator 的位置上报，不重置已有定时器，避免连续翻页把保存无限推迟。
   * @param {string} id bookId
   * @param {object} state 完整状态
   * @param {'debounce'|'throttle'} [mode]
   */
  function scheduleSave(id, state, mode = 'debounce') {
    try {
      const previous = saveTimers.get(id);
      if (previous && mode === 'throttle') return;
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        saveTimers.delete(id);
        const fn = actions().saveState;
        if (typeof fn !== 'function') return;
        try {
          const result = fn(id, state);
          if (result && typeof result.then === 'function') result.then(() => {}, () => {});
        } catch (_error) {
          /* 持久化失败不打断阅读 */
        }
      }, SAVE_DEBOUNCE_MS);
      saveTimers.set(id, timer);
    } catch (_error) {
      /* 忽略 */
    }
  }

  /** 合并后的阅读设置（永不返回 null） */
  function settingsOf(id) {
    const state = stateOfBook(id);
    const base = { ...UI_SETTING_DEFAULTS, ...(DEFAULT_READER_SETTINGS || {}) };
    const own = (state && state.settings) || {};
    const merged = { ...base, ...own };
    merged.fontSize = Math.round(bounded(merged.fontSize, base.fontSize, FONT_MIN, FONT_MAX));
    merged.pdfZoom = bounded(merged.pdfZoom, 1, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    merged.lineHeight = Math.min(2.2, Math.max(1.4, Number(merged.lineHeight) || base.lineHeight));
    merged.margin = clampInt(merged.margin || base.margin, 32, 120);
    if (!READER_THEMES[merged.theme]) merged.theme = base.theme;
    if (!['serif', 'sans-serif', 'mono'].includes(merged.fontFamily)) merged.fontFamily = 'serif';
    if (merged.flow !== 'scroll') merged.flow = 'paginated';
    merged.justify = merged.justify !== false;
    merged.spread = merged.spread === true;
    return merged;
  }

  /** 更新阅读设置（未加载时先加载再写） */
  function updateSettings(id, patch) {
    whenLoaded(id, () => {
      const state = stateOfBook(id) || emptyState(id);
      const merged = { ...(state.settings || {}), ...(patch || {}) };
      patchState(id, { settings: merged });
    });
  }

  /** 章节数 */
  function chapterCountOf(id) {
    const engine = engineOf(id);
    if (engine) {
      try {
        const count = Number(engine.chapterCount ? engine.chapterCount() : 0);
        if (Number.isFinite(count) && count > 0) return count;
      } catch (_error) {
        /* 回退到书库索引里的 chapterCount */
      }
    }
    const book = bookOf(id);
    const fromBook = Number(book && book.chapterCount);
    if (Number.isFinite(fromBook) && fromBook > 0) return fromBook;
    const state = uiStore.get();
    return String(state.bookId) === String(id) ? Number(state.chapterCount) || 0 : 0;
  }

  /** 本地估算进度 0~1（state 未加载时返回 0） */
  function localProgress(id) {
    const state = stateOfBook(id);
    if (!state) return 0;
    const count = chapterCountOf(id);
    try {
      const value = coreProgressOf(state, count);
      if (Number.isFinite(Number(value))) return normalizePercent(value);
    } catch (_error) {
      /* 回退到本地估算 */
    }
    if (!count) return 0;
    const locator = state.locator || {};
    const index = Number(locator.chapterIndex) || 0;
    const within = Math.min(1, Math.max(0, Number(locator.scroll) || 0));
    return Math.min(1, Math.max(0, (index + within) / count));
  }

  /** 阅读进度 0~1：宿主 progressOf 与本地估算取较大值（进度不回退） */
  function progressOfBook(id) {
    let external = 0;
    const fn = props().progressOf;
    if (typeof fn === 'function') {
      try {
        const value = fn(id);
        if (Number.isFinite(Number(value))) external = normalizePercent(value);
      } catch (_error) {
        external = 0;
      }
    }
    return Math.max(external, localProgress(id));
  }

  const progressTextOf = (id) => formatPercent(progressOfBook(id));

  /** 划线数量 */
  function highlightCountOf(id) {
    const state = stateOfBook(id);
    return state && Array.isArray(state.highlights) ? state.highlights.length : 0;
  }

  /** 阅读状态：new | reading | finished */
  function readingStateOf(id) {
    const state = stateOfBook(id);
    if (progressOfBook(id) >= 0.995) return 'finished';
    if (state && (state.updatedAt || (state.locator && Number(state.locator.chapterIndex) > 0))) return 'reading';
    return 'new';
  }

  /** 顶部提示条（写入 lead 约定的 notice 键，额外带 noticeKind） */
  function toast(message, kind = 'info') {
    try {
      if (noticeTimer.id) clearTimeout(noticeTimer.id);
      uiStore.set({ notice: String(message || ''), noticeKind: kind });
      noticeTimer.id = setTimeout(() => {
        noticeTimer.id = null;
        uiStore.set({ notice: null, noticeKind: null });
      }, NOTICE_MS);
    } catch (_error) {
      /* 忽略 */
    }
  }

  /** 记录错误（写入 lead 约定的 lastError 键） */
  /**
   * 取宿主 locale 文案（slot 注入的 `t`），字典缺失时回退到 UI 自带中文。
   * @param {string} key 文案键
   * @param {string} [fallback] 缺失时的中文回退
   * @returns {string}
   */
  function t(key, fallback) {
    try {
      const fn = props().t;
      if (typeof fn === 'function') {
        const value = fn(key);
        if (value && value !== key) return String(value);
      }
    } catch (_error) {
      /* 忽略 */
    }
    return fallback === undefined ? String(key) : fallback;
  }

  function reportError(error, silent) {
    const text = messageOf(error);
    if (!silent) uiStore.set({ lastError: text });
    return text;
  }

  const clearError = () => uiStore.set({ lastError: null });

  // ---------------------------------------------------------------- 浮层开关

  function setVisible(visible) {
    uiStore.set({ visible: !!visible });
    if (!visible) clearSelection();
  }

  function openLibrary() {
    uiStore.set({
      visible: true,
      view: 'library',
      panel: null,
      selection: null,
      searchQuery: '',
      searchResults: [],
      searchIndex: -1,
      lastError: null,
    });
  }

  function closeOverlay() {
    const p = props();
    try {
      if (typeof p.onRequestClose === 'function') p.onRequestClose();
    } catch (_error) {
      /* 忽略 */
    }
    if (typeof actions().close === 'function') callAction('close');
    uiStore.set({ visible: false, panel: null, selection: null, notice: null, lastError: null });
  }

  const backToLibrary = () => uiStore.set({
    view: 'library',
    panel: null,
    selection: null,
    searchQuery: '',
    searchResults: [],
    searchIndex: -1,
    focusHighlightId: null,
    editingHighlightId: null,
  });

  // ---------------------------------------------------------------- 打开书籍

  /** EPUB 插图预取 */
  function startImagePrefetch(id, engine) {
    try {
      const book = engine && engine.book;
      if (!book || !book.resources || typeof book.resourceBytes !== 'function') return;
      const cache = imageCaches.get(id) || new Map();
      imageCaches.set(id, cache);
      const entries = Object.keys(book.resources)
        .map((key) => [key, book.resources[key]])
        .filter(([, res]) => res && /^image\//i.test(String(res.mediaType || '')));
      let pending = 0;
      const done = () => {
        pending -= 1;
        if (pending <= 0) uiStore.set({ imagesVersion: (uiStore.get().imagesVersion || 0) + 1 });
      };
      for (const [zipPath, res] of entries) {
        if (cache.has(zipPath)) continue;
        pending += 1;
        Promise.resolve()
          .then(() => book.resourceBytes(zipPath))
          .then((bytes) => {
            const dataUrl = bytesToDataUrl(bytes, res.mediaType);
            if (dataUrl) cache.set(zipPath, dataUrl);
          })
          .catch(() => {})
          .then(done, done);
      }
    } catch (_error) {
      /* 图片不可用不影响阅读 */
    }
  }

  /** render(chapterIndex, resolveResource) 需要的同步资源解析器 */
  function resourceResolver(id) {
    return (zipPath) => {
      try {
        const cache = imageCaches.get(id);
        if (!cache || !cache.size) return null;
        const raw = String(zipPath || '');
        if (cache.has(raw)) return cache.get(raw);
        let decoded = raw;
        try {
          decoded = decodeURIComponent(raw);
        } catch (_error) {
          decoded = raw;
        }
        if (cache.has(decoded)) return cache.get(decoded);
        const base = decoded.split('/').pop();
        for (const [key, value] of cache) {
          if (key.split('/').pop() === base) return value;
        }
        return null;
      } catch (_error) {
        return null;
      }
    };
  }

  /**
   * 打开一本书并切到阅读视图。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function openBook(id) {
    if (id == null) return false;
    uiStore.set({ busyBookId: String(id), lastError: null });
    try {
      const state = await loadState(id);
      if (!engineOf(id)) {
        const result = await callAction('openBook', id);
        if (result && result.ok === false) throw new Error(result.error || '打开失败');
      }
      const engine = engineOf(id);
      if (!engine) throw new Error('解析引擎未就绪，请稍后重试');
      const count = Number(engine.chapterCount ? engine.chapterCount() : 0) || chapterCountOf(id);
      if (!count) throw new Error('这本书没有可读章节');
      const locator = (state && state.locator) || {};
      const chapterIndex = clampInt(locator.chapterIndex, 0, Math.max(0, count - 1));
      uiStore.set({
        visible: true,
        view: 'reader',
        bookId: String(id),
        chapterIndex,
        page: 0,
        chapterCount: count,
        chapterBusy: true,
        panel: null,
        selection: null,
        focusHighlightId: null,
        editingHighlightId: null,
        restoreScroll: Math.min(1, Math.max(0, Number(locator.scroll) || 0)),
        engineVersion: (uiStore.get().engineVersion || 0) + 1,
        imagesVersion: 0,
        busyBookId: null,
        lastError: null,
      });
      startImagePrefetch(id, engine);
      return true;
    } catch (error) {
      const text = reportError(error, true);
      uiStore.set({ busyBookId: null, view: 'library', lastError: text });
      return false;
    }
  }

  // ---------------------------------------------------------------- 翻页/定位

  /** 阅读器注册的分页器（reader.js 覆盖） */
  const pager = {
    next() {
      goChapter((Number(uiStore.get().chapterIndex) || 0) + 1);
    },
    prev() {
      goChapter((Number(uiStore.get().chapterIndex) || 0) - 1);
    },
    goChapter() {},
    jump() {},
  };

  function registerPager(next) {
    try {
      if (!next) return;
      if (typeof next.next === 'function') pager.next = next.next;
      if (typeof next.prev === 'function') pager.prev = next.prev;
      if (typeof next.goChapter === 'function') pager.goChapter = next.goChapter;
      if (typeof next.jump === 'function') pager.jump = next.jump;
    } catch (_error) {
      /* 忽略 */
    }
  }

  /** 翻下一页（到章尾自动进下一章由 reader 的 pager 处理） */
  function turnPage(direction) {
    try {
      if (direction < 0) pager.prev();
      else pager.next();
    } catch (error) {
      reportError(error, true);
    }
  }

  /** 跳到指定章 */
  function goChapter(index) {
    const state = uiStore.get();
    const count = Number(state.chapterCount) || chapterCountOf(state.bookId) || 1;
    const target = clampInt(index, 0, Math.max(0, count - 1));
    if (target === state.chapterIndex && !state.restoreScroll) {
      uiStore.set({ page: 0 });
      return;
    }
    try {
      pager.goChapter(target);
    } catch (_error) {
      /* 忽略 */
    }
    uiStore.set({ chapterIndex: target, page: 0, restoreScroll: null });
    updateLocator(state.bookId, { chapterIndex: target, scroll: 0 });
  }

  /** 跳到全书百分比位置 */
  function goPercent(fraction) {
    const state = uiStore.get();
    const count = Number(state.chapterCount) || chapterCountOf(state.bookId) || 1;
    const ratio = Math.min(1, Math.max(0, Number(fraction) || 0));
    goChapter(Math.round(ratio * (count - 1)));
  }

  /** 更新 locator 并持久化 */
  function updateLocator(id, patch) {
    if (id == null) return;
    whenLoaded(id, () => {
      const state = stateOfBook(id) || emptyState(id);
      patchState(id, { locator: { ...(state.locator || {}), ...(patch || {}) } });
    });
  }

  /** 阅读器上报当前位置（节流后的调用即可） */
  function reportPosition(id, position) {
    if (id == null || !position) return;
    whenLoaded(id, () => {
      const state = stateOfBook(id) || emptyState(id);
      const locator = {
        ...(state.locator || {}),
        chapterIndex: clampInt(position.chapterIndex, 0, 100000),
        scroll: Math.min(1, Math.max(0, Number(position.scroll) || 0)),
      };
      if (position.chapterHref) locator.chapterHref = String(position.chapterHref);
      if (position.textQuote) locator.textQuote = String(position.textQuote).slice(0, 200);
      patchState(id, { locator });
    });
  }

  // ---------------------------------------------------------------- 面板

  function setPanel(panel) {
    const current = uiStore.get().panel;
    const next = current === panel ? null : panel;
    if (next === 'search' && current !== 'search') {
      const state = uiStore.get();
      uiStore.set({ searchReturn: { chapterIndex: state.chapterIndex, page: state.page } });
    }
    if (current === 'search' && next !== 'search') searchToken += 1;
    uiStore.set({
      panel: next,
      selection: null,
      ...(next === 'companion' && !uiStore.get().selection ? { companionSelection: null } : {}),
      ...(next === 'search' ? {} : { searchQuery: '', searchResults: [], searchIndex: -1, searchBusy: false }),
    });
  }

  // ---------------------------------------------------------------- 划线/批注

  /**
   * 新增划线。
   * @param {string} id bookId
   * @param {object} input { text, chapterHref, color, note, percent }
   * @returns {object|null} 新增的 highlight（未加载完成时可能为 null）
   */
  function addHighlight(id, input) {
    if (id == null) return null;
    const state = stateOr(id);
    const payload = {
      chapterHref: String((input && input.chapterHref) || (state.locator || {}).chapterHref || ''),
      text: String((input && input.text) || '').replace(/\s+/g, ' ').trim(),
      note: String((input && input.note) || '').trim(),
      color: ['yellow', 'green', 'blue', 'pink'].includes(input && input.color) ? input.color : 'yellow',
      percent: normalizePercent(input && input.percent),
      textOffset: Number.isFinite(input?.textOffset) ? Math.max(0, Math.floor(input.textOffset)) : null,
      createdAt: Date.now(),
    };
    if (!payload.text) return null;
    let created = null;
    whenLoaded(id, () => {
      const current = stateOr(id);
      let next = null;
      let highlight = null;
      try {
        const result = coreAddHighlight(current, payload);
        if (result && result.state && Array.isArray(result.state.highlights)) {
          next = result.state;
          highlight = result.highlight || null;
        } else if (result && Array.isArray(result.highlights)) {
          next = result;
        }
      } catch (error) {
        reportError(error, true);
      }
      if (!next) {
        highlight = { id: localId('hl'), ...payload };
        next = { ...current, highlights: [...(current.highlights || []), highlight] };
      }
      if (!highlight) {
        const list = next.highlights || [];
        highlight = list.length ? list[list.length - 1] : null;
      }
      created = highlight;
      replaceState(id, next);
      uiStore.set({ focusHighlightId: highlight ? highlight.id : null, selection: null });
    });
    return created;
  }

  function removeHighlight(id, highlightId) {
    whenLoaded(id, () => {
      const state = stateOr(id);
      let next = null;
      try {
        const result = coreRemoveHighlight(state, highlightId);
        if (result && result.state && Array.isArray(result.state.highlights)) next = result.state;
        else if (result && Array.isArray(result.highlights)) next = result;
      } catch (error) {
        reportError(error, true);
      }
      if (!next) {
        next = { ...state, highlights: (state.highlights || []).filter((item) => item && item.id !== highlightId) };
      }
      replaceState(id, next);
      if (uiStore.get().editingHighlightId === highlightId) uiStore.set({ editingHighlightId: null });
    });
  }

  function updateHighlightNote(id, highlightId, note) {
    whenLoaded(id, () => {
      const state = stateOr(id);
      let next = null;
      try {
        const result = coreUpdateHighlightNote(state, highlightId, note);
        if (result && result.state && Array.isArray(result.state.highlights)) next = result.state;
        else if (result && Array.isArray(result.highlights)) next = result;
      } catch (error) {
        reportError(error, true);
      }
      if (!next) {
        next = {
          ...state,
          highlights: (state.highlights || []).map((item) =>
            item && item.id === highlightId ? { ...item, note: String(note || ''), updatedAt: Date.now() } : item),
        };
      }
      replaceState(id, next);
    });
  }

  function setHighlightColor(id, highlightId, color) {
    if (!['yellow', 'green', 'blue', 'pink'].includes(color)) return;
    whenLoaded(id, () => {
      const state = stateOr(id);
      replaceState(id, {
        ...state,
        highlights: (state.highlights || []).map((item) =>
          item && item.id === highlightId ? { ...item, color, updatedAt: Date.now() } : item),
      });
    });
  }

  /** 定位某条划线：切章 + 让阅读器滚动并高亮 */
  function focusHighlight(id, highlightId) {
    const state = stateOr(id);
    const highlight = (state.highlights || []).find((item) => item && item.id === highlightId);
    if (!highlight) return;
    const index = chapterIndexForHref(engineOf(id), highlight.chapterHref);
    if (index >= 0) goChapter(index);
    uiStore.set({ focusHighlightId: highlightId, focusToken: (uiStore.get().focusToken || 0) + 1 });
  }

  // ---------------------------------------------------------------- 选中

  function setSelection(selection) {
    uiStore.set({ selection: selection || null,
      ...(selection && uiStore.get().panel === 'companion' ? { companionSelection: { text: selection.text, chapterHref: selection.chapterHref, id: Date.now() } } : {}),
    });
  }

  function clearSelection() {
    uiStore.set({ selection: null });
    try {
      if (typeof window !== 'undefined' && window.getSelection) {
        const sel = window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      }
    } catch (_error) {
      /* 忽略 */
    }
  }

  // ---------------------------------------------------------------- 搜索

  /**
   * 全书搜索（token 防止过期结果覆盖）。
   * @param {string} id bookId
   * @param {string} query
   */
  async function search(id, query) {
    const engine = engineOf(id);
    const text = String(query || '');
    const trimmed = text.trim();
    if (!engine || !trimmed) {
      searchToken += 1;
      uiStore.set({ searchQuery: text, searchResults: [], searchIndex: -1, searchBusy: false, searchError: null });
      return;
    }
    const token = (searchToken += 1);
    uiStore.set({ searchQuery: text, searchBusy: true, searchError: null });
    try {
      const hits = await engine.search(trimmed, 300);
      if (token !== searchToken) return;
      const list = Array.isArray(hits) ? hits.filter(Boolean) : [];
      uiStore.set({ searchResults: list, searchIndex: list.length ? 0 : -1, searchBusy: false });
      if (list.length) focusSearchHit(0, true);
    } catch (error) {
      if (token !== searchToken) return;
      uiStore.set({ searchBusy: false, searchResults: [], searchIndex: -1, searchError: reportError(error, true) });
    }
  }

  /** 命中项跳转 */
  function focusSearchHit(index, keepPanel) {
    const state = uiStore.get();
    const list = state.searchResults || [];
    if (!list.length) return;
    const target = ((index % list.length) + list.length) % list.length;
    const hit = list[target] || {};
    uiStore.set({ searchIndex: target, ...(keepPanel ? {} : { panel: 'search' }) });
    const chapterIndex = Number(hit.chapterIndex);
    if (Number.isFinite(chapterIndex) && chapterIndex !== state.chapterIndex) {
      goChapter(chapterIndex);
    } else {
      uiStore.set({ searchFocusToken: (state.searchFocusToken || 0) + 1 });
    }
  }

  function searchNext(direction) {
    const state = uiStore.get();
    if (!(state.searchResults || []).length) return;
    focusSearchHit((state.searchIndex || 0) + (direction < 0 ? -1 : 1), true);
  }

  /** 关闭搜索并回到原位置 */
  function closeSearch() {
    const state = uiStore.get();
    searchToken += 1;
    const back = state.searchReturn || null;
    uiStore.set({
      panel: null,
      searchQuery: '',
      searchResults: [],
      searchIndex: -1,
      searchBusy: false,
      searchError: null,
      searchReturn: null,
    });
    if (back && typeof back.chapterIndex === 'number') {
      const count = Number(state.chapterCount) || chapterCountOf(state.bookId) || 1;
      const index = clampInt(back.chapterIndex, 0, Math.max(0, count - 1));
      if (index !== state.chapterIndex) goChapter(index);
      else uiStore.set({ page: back.page || 0 });
    }
  }

  // ---------------------------------------------------------------- 书库操作

  async function refreshLibrary() {
    uiStore.set({ libraryLoading: true });
    const result = await callAction('refreshLibrary');
    uiStore.set({ libraryLoading: false });
    if (result && result.ok === false) uiStore.set({ lastError: result.error });
    return result;
  }

  /** Enqueue one file; the plugin instance owns execution across page switches. */
  function importBook(file) {
    return callAction('enqueueImports', file ? [file] : []);
  }

  async function removeBook(id) {
    const book = bookOf(id);
    const result = await callAction('removeBook', id);
    if (result && result.ok === false) {
      toast(result.error || '删除失败', 'error');
      return result;
    }
    const states = { ...(uiStore.get().states || {}) };
    delete states[id];
    imageCaches.delete(id);
    setStates(states);
    uiStore.set({ lastError: null });
    await refreshLibrary();
    toast(`已删除《${(book && book.title) || id}》`, 'ok');
    return result;
  }

  /** 导出阅读笔记 Markdown：优先宿主 action，失败回退本地生成 */
  async function exportNotes(id) {
    const timer = saveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(id);
      await callAction('saveState', id, stateOr(id));
    }
    const result = await callAction('exportNotes', id);
    if (result && typeof result.markdown === 'string' && result.markdown.trim()) return result.markdown;
    return toMarkdown(stateOr(id), bookOf(id), engineOf(id));
  }

  /** 复制文本 + 提示 */
  async function copy(value, label = '已复制') {
    const ok = await copyText(value);
    toast(ok ? label : '复制失败，请手动选择文本', ok ? 'ok' : 'error');
    return ok;
  }

  // ---------------------------------------------------------------- 全屏

  function attachOverlay(element) {
    overlayEl = element || null;
  }

  /** 切换全屏（宿主不支持时给出可读提示，而不是静默失败） */
  function toggleFullscreen() {
    try {
      if (typeof document === 'undefined') return;
      if (document.fullscreenElement) {
        const exit = document.exitFullscreen && document.exitFullscreen();
        if (exit && typeof exit.catch === 'function') exit.catch(() => {});
        return;
      }
      const target = overlayEl || document.documentElement;
      if (!target || typeof target.requestFullscreen !== 'function') {
        toast('当前环境不支持全屏', 'warn');
        return;
      }
      const request = target.requestFullscreen();
      if (request && typeof request.catch === 'function') request.catch(() => toast('全屏请求被浏览器拒绝', 'warn'));
    } catch (_error) {
      toast('当前环境不支持全屏', 'warn');
    }
  }

  return {
    store: uiStore,
    props,
    actions,
    books,
    status,
    libraryLoading,
    bookOf,
    engineOf,
    stateOfBook,
    stateOr,
    loadState,
    isLoaded,
    patchState,
    replaceState,
    settingsOf,
    updateSettings,
    chapterCountOf,
    progressOfBook,
    progressTextOf,
    highlightCountOf,
    readingStateOf,
    toast,
    reportError,
    t,
    clearError,
    setVisible,
    openLibrary,
    backToLibrary,
    closeOverlay,
    openBook,
    pager,
    registerPager,
    turnPage,
    goChapter,
    goPercent,
    updateLocator,
    reportPosition,
    setPanel,
    addHighlight,
    removeHighlight,
    updateHighlightNote,
    setHighlightColor,
    focusHighlight,
    setSelection,
    clearSelection,
    search,
    searchNext,
    focusSearchHit,
    closeSearch,
    refreshLibrary,
    importBook,
    enqueueImports: (files) => callAction('enqueueImports', files),
    stopImports: () => callAction('stopImports'),
    resumeImports: () => callAction('resumeImports'),
    retryImport: (id) => callAction('retryImport', id),
    retryFailedImports: () => callAction('retryFailedImports'),
    cancelImport: (id) => callAction('cancelImport', id),
    clearImports: () => callAction('clearImports'),
    removeBook,
    exportNotes,
    copy,
    attachOverlay,
    toggleFullscreen,
    resourceResolver,
  };
}
