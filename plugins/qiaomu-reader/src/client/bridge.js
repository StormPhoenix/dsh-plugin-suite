/**
 * 客户端数据面：把「宿主半的持久化」与「浏览器本地缓存」合成一个数据源，
 * 并以 UI 能直接消费的形状暴露书库、单本状态与阅读引擎。
 *
 * 关键设计：**内置公版书永远在册**，即使宿主半不可用、即使浏览器缓存被清空。
 * 用户导入的书先落宿主（有文件系统时），失败再退化为仅浏览器缓存。
 */
import {
  DEFAULT_READER_SETTINGS,
  addBookmark,
  addHighlight,
  createBookState,
  normalizeLibrary,
  normalizeState,
  mergeStates,
  progressOf,
  removeBookmark,
  removeHighlight,
  updateHighlightNote,
} from '../core/state.js';
import { STARTER_BOOKS, decodeStarterBook, starterCatalog } from '../../media/starter-books.js';
import { toMarkdown } from '../ui/format.js';
import {
  clearLocalData,
  loadBookBytes as loadCachedBytes,
  loadLocalLibrary,
  loadLocalState,
  removeBookBytes,
  removeLocalState,
  saveBookBytes,
  saveLocalLibrary,
  saveLocalState,
} from '../client/storage.js';

/** UI 需要的默认设置。 */
export { DEFAULT_READER_SETTINGS };

/** base64 与 Uint8Array 互转（不依赖 Buffer）。 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 由字节生成稳定 id（与宿主半同算法，保证两边认同一本书）。 */
function bookIdOf(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + bytes[i] * (i + 1)) >>> 0;
  }
  return `c${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** 由文件名猜格式。 */
function formatOf(filename) {
  const name = String(filename ?? '').toLowerCase();
  if (name.endsWith('.epub')) return 'epub';
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.txt')) return 'txt';
  if (name.endsWith('.fb2')) return 'fb2';
  return 'epub';
}

/** 把内置书元数据变成 UI 需要的书本记录。 */
function starterBookRecord(meta) {
  return {
    id: meta.id,
    title: meta.title,
    author: meta.author,
    format: 'epub',
    file: null,
    bytes: meta.bytes,
    cover: meta.cover ?? null,
    addedAt: 0,
    openedAt: null,
    source: 'starter',
    language: meta.language,
    chapterCount: meta.chapterCount,
    identifier: meta.identifier,
    builtin: true,
  };
}

/** 内置书 id 集合，避免用户导入的同名文件被当成内置书。 */
const STARTER_BY_ID = new Map(STARTER_BOOKS.map((book) => [book.id, book]));

/**
 * 客户端数据面。
 *
 * @param {object} options - { host: 宿主数据面 | null, maxCacheBooks: 内存里最多缓存几本解析结果 }
 */
export function createDataLayer(options = {}) {
  let host = options.host ?? null;
  const maxCacheBooks = Number.isFinite(options.maxCacheBooks) ? options.maxCacheBooks : 3;

  /** 内存中的书库与状态，UI 通过 get() 读。 */
  let library = normalizeLibrary(null);
  const states = new Map();
  /** bookId -> { book, engine, bytes } */
  const engines = new Map();
  /** 打开中的书，避免重复解析。 */
  const opening = new Map();
  const pendingStateWrites = new Map();
  const migratedLocalIds = new Set();
  const listeners = new Set();
  let status = 'idle';
  let lastError = '';
  let libraryOperations = Promise.resolve();
  const serializeLibrary = (operation) => {
    const result = libraryOperations.then(operation);
    libraryOperations = result.catch(() => undefined);
    return result;
  };

  function emit() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[乔木阅读] 订阅者异常', error);
      }
    }
  }

  function setStatus(next, error = '') {
    status = next;
    lastError = error;
    emit();
  }

  async function setHost(api) {
    host = api;
    const cached = normalizeLibrary(await loadLocalLibrary().catch(() => null));
    const candidates = new Map([...cached.books, ...library.books]
      .filter((book) => book && !STARTER_BY_ID.has(book.id) && (book.source === 'local' || book.source === 'local-offline'))
      .map((book) => [book.id, book]));
    for (const book of candidates.values()) {
      try {
        const bytes = await loadCachedBytes(book.id);
        if (!bytes) continue;
        const result = await api.import({
          filename: `${book.title || book.id}.${book.format}`,
          base64: bytesToBase64(bytes), title: book.title, author: book.author,
          chapterCount: book.chapterCount, language: book.language, identifier: book.identifier,
        });
        const nextId = result?.book?.id;
        if (!nextId) continue;
        const localState = await loadLocalState(book.id).catch(() => null);
        if (localState) {
          const remoteState = await api.loadState(nextId).catch(() => null);
          const merged = mergeStates(normalizeState(remoteState, nextId), normalizeState({ ...localState, bookId: nextId }, nextId));
          await api.saveState(nextId, merged);
          states.set(nextId, merged);
        }
        await saveBookBytes(nextId, bytes).catch(() => undefined);
        migratedLocalIds.add(book.id);
      } catch (error) {
        console.warn('[乔木阅读] 本地书迁移到宿主失败', book.id, error);
      }
    }
    return refreshLibrary();
  }

  /** 把内置书合并进库：内置书始终在前，且不被用户导入的副本覆盖。 */
  function mergeStarter(catalog) {
    const starters = starterCatalog().map(starterBookRecord);
    const starterIds = new Set(starters.map((book) => book.id));
    // 用户库里如果存在与内置书同 identifier 的记录，视为同一本书，用内置元数据为准，
    // 但保留用户的 openedAt / addedAt，这样「继续阅读」不丢。
    const userBooks = catalog.books.filter((book) => {
      if (starterIds.has(book.id)) return false;
      if (typeof book.identifier === 'string' && book.identifier.startsWith('urn:qbr:starter:')) return false;
      return true;
    });
    const decorated = starters.map((book) => {
      const previous = catalog.books.find((entry) => entry.id === book.id);
      return previous === undefined
        ? book
        : { ...book, openedAt: previous.openedAt ?? null, addedAt: previous.addedAt || book.addedAt };
    });
    return normalizeLibrary({ ...catalog, books: [...decorated, ...userBooks] });
  }

  /** 首次加载：宿主优先，客户端缓存兜底，最后叠加内置书。 */
  async function refreshLibrary() {
    setStatus('loading');
    let fetched = null;
    let failure = '';
    if (host !== null) {
      try {
        fetched = await host.library();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    let cached = null;
    try {
      cached = await loadLocalLibrary();
    } catch {
      cached = null;
    }
    const remoteBooks = Array.isArray(fetched?.books) ? fetched.books : [];
    const remoteIds = new Set(remoteBooks.map((book) => book.id));
    const localOnly = Array.isArray(cached?.books) ? cached.books.filter((book) =>
      book && (book.source === 'local' || book.source === 'local-offline')
      && !STARTER_BY_ID.has(book.id) && !remoteIds.has(book.id) && !migratedLocalIds.has(book.id)) : [];
    const source = fetched ? { ...fetched, books: [...remoteBooks, ...localOnly] } : cached ?? null;
    library = mergeStarter(normalizeLibrary(source));
    // 回写缓存，保证离线下次也有同样的书单。
    try {
      await saveLocalLibrary(library);
    } catch {
      /* 缓存失败不影响内存 */
    }
    setStatus('ready', failure);
    return library;
  }

  /** 读取某本书的状态：内存 → 宿主 → 本地缓存 → 空壳。 */
  async function ensureState(bookId) {
    if (states.has(bookId)) return states.get(bookId);
    let raw = null;
    if (host !== null) {
      try {
        raw = await host.loadState(bookId);
      } catch {
        raw = null;
      }
    }
    if (raw === null) {
      try {
        raw = await loadLocalState(bookId);
      } catch {
        raw = null;
      }
    }
    const state = normalizeState(raw, bookId);
    states.set(bookId, state);
    return state;
  }

  /** 写入状态：先更新内存并通知 UI，再异步落两处。 */
  function persistState(bookId, nextState) {
    const state = { ...nextState, bookId };
    states.set(bookId, state);
    emit();
    const writes = [saveLocalState(bookId, state).catch(() => undefined)];
    if (host !== null) writes.push(host.saveState(bookId, state).catch(() => undefined));
    const pending = Promise.all(writes);
    pendingStateWrites.set(bookId, pending);
    void pending.finally(() => { if (pendingStateWrites.get(bookId) === pending) pendingStateWrites.delete(bookId); });
    return state;
  }

  /**
 * 取书籍字节，按确定性回退链：
 *   1. 本次会话已解析的引擎（内存）
 *   2. 浏览器字节缓存（用户导入的书主要靠它）
 *   3. 内置公版书（随 bundle 内联，永远可用）
 *   4. 宿主半（有宿主时才有，且返回的是最新版本）
 */
  async function loadBookBytes(bookId) {
    const cached = engines.get(bookId);
    if (cached !== undefined) return cached.bytes;
    const local = await loadCachedBytes(bookId).catch(() => undefined);
    if (local !== undefined) return local;
    const starter = STARTER_BY_ID.get(bookId);
    if (starter !== undefined) return decodeStarterBook(starter);
    if (host !== null) {
      const result = await host.readBookBytes(bookId);
      if (typeof result?.base64 !== 'string') throw new Error('宿主没有返回书籍内容');
      const bytes = base64ToBytes(result.base64);
      await saveBookBytes(bookId, bytes).catch(() => undefined);
      return bytes;
    }
    throw new Error('这本书的正文不在本地缓存里，请重新导入');
  }

  /** 解析并缓存阅读引擎（超出上限时淘汰最早打开的）。 */
  async function openBook(bookId) {
    const entry = library.books.find((book) => book.id === bookId);
    if (entry && !['epub', 'pdf', 'txt'].includes(entry.format)) throw new Error(`不支持打开 ${entry.format.toUpperCase()}`);
    if (engines.has(bookId)) return engines.get(bookId);
    if (opening.has(bookId)) return opening.get(bookId);
    const task = (async () => {
      const bytes = await loadBookBytes(bookId);
      let record;
      if (entry?.format === 'pdf') {
        const { parsePdfBook } = await import('./pdf-book.js');
        record = await parsePdfBook(bytes, entry.title);
      } else if (entry?.format === 'txt') {
        const { parseTextBook } = await import('./text-book.js');
        record = parseTextBook(bytes, entry.title);
      } else {
        const { parseEpub } = await import('../core/epub.js');
        const parsed = await parseEpub(bytes);
        const { createReaderEngine } = await import('../core/reader.js');
        record = { book: parsed, engine: createReaderEngine(parsed), bytes };
      }
      engines.set(bookId, record);
      while (engines.size > maxCacheBooks) {
        const oldest = engines.keys().next().value;
        if (oldest === bookId) break;
        await engines.get(oldest)?.engine?.dispose?.();
        engines.delete(oldest);
      }
      return record;
    })();
    opening.set(bookId, task);
    try {
      return await task;
    } finally {
      opening.delete(bookId);
    }
  }

  /** 导入一本书：先落宿主，再更新内存与缓存。 */
  async function importBook(file) {
    if (file === undefined || file === null) return { ok: false, error: '没有选择文件' };
    const filename = typeof file.name === 'string' ? file.name : 'book.epub';
    const format = formatOf(filename);
    if (!/\.(epub|pdf|txt)$/i.test(filename)) return { ok: false, error: '支持 EPUB、PDF 和 TXT 文件' };
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      return { ok: false, error: `读取文件失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (bytes.byteLength === 0) return { ok: false, error: '文件是空的' };
    const fallbackId = bookIdOf(bytes);
    let meta = null;
    if (format === 'epub') {
      try {
        const { parseEpub } = await import('../core/epub.js');
        const parsed = await parseEpub(bytes);
        const coverBytes = parsed.coverHref ? await parsed.resourceBytes(parsed.coverHref) : null;
        const coverType = parsed.coverHref ? parsed.resources[parsed.coverHref]?.mediaType : null;
        const cover = coverBytes && coverBytes.byteLength <= 1024 * 1024
          && /^image\/(?:jpeg|png|webp|gif)$/i.test(coverType || '')
          ? `data:${coverType};base64,${bytesToBase64(coverBytes)}` : null;
        meta = {
          title: parsed.title,
          author: parsed.author,
          language: parsed.language,
          identifier: parsed.identifier,
          chapterCount: parsed.chapters.length,
          cover,
        };
      } catch (error) {
        return { ok: false, error: `解析 EPUB 失败：${error instanceof Error ? error.message : String(error)}` };
      }
    } else if (format === 'txt') {
      try {
        const { parseTextBook } = await import('./text-book.js');
        meta = { chapterCount: parseTextBook(bytes, filename.replace(/\.[^.]+$/, '')).book.chapters.length };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else if (format === 'pdf') {
      try {
        const { parsePdfBook } = await import('./pdf-book.js');
        const record = await parsePdfBook(bytes, filename.replace(/\.[^.]+$/, ''));
        meta = { chapterCount: record.engine.chapterCount() };
        await record.engine.dispose();
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    let book = null;
    let existing = library.books.some((entry) => entry.id === fallbackId);
    let hostError = '';
    if (host !== null) {
      try {
        const result = await host.import({ filename, base64: bytesToBase64(bytes), ...meta });
        book = result?.book ?? null;
        existing = result?.existing ?? existing;
        if (book === null) hostError = '宿主未返回书籍记录';
      } catch (error) {
        hostError = error instanceof Error ? error.message : String(error);
      }
    } else hostError = '宿主书库未连接，文件仅保存在本机缓存';
    if (book === null) {
      // 宿主不可用：登记到本地书库，正文进浏览器字节缓存，刷新后仍可打开。
      book = {
        id: fallbackId,
        title: meta?.title || filename.replace(/\.[^.]+$/, ''),
        author: meta?.author ?? '',
        format,
        file: null,
        bytes: bytes.byteLength,
        cover: meta?.cover ?? null,
        addedAt: Date.now(),
        openedAt: null,
        source: hostError === '' ? 'local' : 'local-offline',
        language: meta?.language ?? '',
        chapterCount: meta?.chapterCount ?? 0,
        identifier: meta?.identifier ?? '',
      };
    }
    const storage = hostError ? 'browser' : 'host';
    const localPrevious = library.books.find((entry) => entry.id === fallbackId && ['local', 'local-offline'].includes(entry.source));
    let migratedFrom = null;
    let migrationWarning = '';
    if (storage === 'host' && localPrevious && book.id !== fallbackId) {
      try {
        const localState = states.get(fallbackId) ?? await loadLocalState(fallbackId);
        if (localState) {
          const remoteState = await host.loadState(book.id);
          const merged = mergeStates(normalizeState(remoteState, book.id), normalizeState({ ...localState, bookId: book.id }, book.id));
          await host.saveState(book.id, merged);
          states.set(book.id, merged);
          await saveLocalState(book.id, merged);
        }
        migratedFrom = fallbackId;
        migratedLocalIds.add(fallbackId);
        const parsed = engines.get(fallbackId);
        if (parsed) { engines.delete(fallbackId); engines.set(book.id, parsed); }
        states.delete(fallbackId);
      } catch (error) {
        migrationWarning = `已入库，但原缓存书籍的笔记迁移失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const bytesSaved = await saveBookBytes(book.id, bytes).catch(() => false);
    if (storage === 'browser' && !bytesSaved) {
      return { ok: false, error: `${hostError}；浏览器也无法保存文件，请检查存储空间后重试` };
    }
    const nextLibrary = normalizeLibrary({ ...library, books: [...library.books.filter((entry) => entry.id !== book.id && entry.id !== migratedFrom), book] });
    const indexSaved = await saveLocalLibrary(nextLibrary).catch(() => false);
    if (storage === 'browser' && !indexSaved) {
      return { ok: false, error: `${hostError}；浏览器无法保存书库索引，请检查存储空间后重试` };
    }
    // Imported EPUBs are parsed on open, within the existing engine-cache limit.
    library = nextLibrary;
    const warning = migrationWarning || (storage === 'browser' ? hostError : !bytesSaved || !indexSaved ? '已保存到书库，但浏览器缓存不可用' : '');
    if (migratedFrom && bytesSaved && indexSaved) {
      await removeLocalState(migratedFrom).catch(() => undefined);
      await removeBookBytes(migratedFrom).catch(() => undefined);
    }
    setStatus('ready', warning);
    emit();
    return { ok: true, book, hostError, storage, existing, warning, migratedFrom };
  }

  /** 删除一本书及它的状态。 */
  async function removeBook(bookId) {
    if (STARTER_BY_ID.has(bookId)) return { ok: false, error: '内置书不能删除' };
    let hostError = '';
    if (host !== null) {
      try {
        await host.remove(bookId);
      } catch (error) {
        hostError = error instanceof Error ? error.message : String(error);
      }
    }
    library = normalizeLibrary({ ...library, books: library.books.filter((book) => book.id !== bookId) });
    states.delete(bookId);
    engines.delete(bookId);
    await saveLocalLibrary(library).catch(() => undefined);
    await removeLocalState(bookId).catch(() => undefined);
    await removeBookBytes(bookId).catch(() => undefined);
    emit();
    return { ok: true, hostError };
  }

  /** 导出 Markdown 阅读笔记。 */
  async function exportNotes(bookId) {
    const book = library.books.find((entry) => entry.id === bookId);
    const state = await ensureState(bookId);
    const markdown = toMarkdown(state, book, engines.get(bookId)?.engine);
    if (host !== null) {
      try {
        await pendingStateWrites.get(bookId);
        await host.exportNotes(bookId);
      } catch {
        /* 落宿主失败不影响复制到剪贴板 */
      }
    }
    return { markdown };
  }

  return {
    setHost: (api) => serializeLibrary(() => setHost(api)),
    /* --- 读取 --- */
    getLibrary: () => library,
    getStatus: () => ({ status, error: lastError }),
    getState: (bookId) => states.get(bookId),
    getEngine: (bookId) => engines.get(bookId)?.engine,
    getParsedBook: (bookId) => engines.get(bookId)?.book,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /* --- 操作 --- */
    refreshLibrary: () => serializeLibrary(refreshLibrary),
    ensureState,
    openBook,
    importBook: (file) => serializeLibrary(() => importBook(file)),
    removeBook: (id) => serializeLibrary(() => removeBook(id)),
    exportNotes,
    clearLocalData,

    /* --- 状态改写（全部走不可变纯函数） --- */
    /** 直接落盘一份状态：UI 的 actions.saveState 走这里。 */
    persistState(bookId, nextState) {
      return persistState(bookId, nextState);
    },
    async addHighlight(bookId, input) {
      const state = await ensureState(bookId);
      const result = addHighlight(state, input);
      persistState(bookId, result.state);
      return result;
    },
    async removeHighlight(bookId, id) {
      const state = await ensureState(bookId);
      const result = removeHighlight(state, id);
      persistState(bookId, result.state);
      return result;
    },
    async updateHighlightNote(bookId, id, note) {
      const state = await ensureState(bookId);
      persistState(bookId, updateHighlightNote(state, id, note));
    },
    async addBookmark(bookId, input) {
      const state = await ensureState(bookId);
      const result = addBookmark(state, input);
      persistState(bookId, result.state);
      return result;
    },
    async removeBookmark(bookId, id) {
      const state = await ensureState(bookId);
      persistState(bookId, removeBookmark(state, id));
    },
    /** 保存阅读位置与设置。 */
    async saveProgress(bookId, locator) {
      const state = await ensureState(bookId);
      persistState(bookId, { ...state, locator });
    },
    async saveSettings(bookId, settings) {
      const state = await ensureState(bookId);
      persistState(bookId, { ...state, settings: { ...state.settings, ...settings } });
    },
    /** 进度百分比，供书库卡片与工具条使用。 */
    progressOf(bookId) {
      const book = library.books.find((entry) => entry.id === bookId);
      const state = states.get(bookId);
      if (book === undefined || state === undefined) return 0;
      return progressOf(state, book.chapterCount || 1);
    },
    /** 新建一本书的空状态（避免首次打开时闪烁）。 */
    primeState(bookId) {
      if (!states.has(bookId)) states.set(bookId, createBookState(bookId));
      return states.get(bookId);
    },
  };
}
