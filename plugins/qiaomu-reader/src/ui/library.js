/** 书库：分类导航与清晰书目，保留搜索、排序、导入与阅读操作。 */
import * as React from 'react';
import { ImportQueueView } from './import-queue.js';
import { BookTagChips, BookTagEditor, TagChip, TagFilter, TagOverlay, catalogOf, editableTags, matchesTags, tagText } from './library-tags.js';
import { formatBytes, formatPercent, truncate } from './format.js';
import { IconBook, IconClose, IconFullscreen, IconImport, IconLibrary, IconRefresh, IconTrash, IconSearch, IconHighlight, IconNext, IconNote, IconMore } from './icons.js';

const h = React.createElement;
const MAX_STATE_LOADS = 80;
const FILTERS = [['all', '全部书籍'], ['reading', '正在阅读'], ['finished', '已读完'], ['highlighted', '有划线']];
const tr = (ui, key, fallback, values = {}) => ui.t(`catalog.${key}`, fallback).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

function Cover({ book }) {
  const cover = typeof book.cover === 'string' && /^data:image\//i.test(book.cover) ? book.cover : null;
  return h('span', { className: 'qmr-book-cover', 'aria-hidden': 'true' }, h(IconBook, { width: 20, height: 20 }),
    cover ? h('img', { src: cover, alt: '', loading: 'lazy', onError: event => { event.currentTarget.hidden = true; } }) : null);
}

function BookRow({ ui, book, busy, selecting, selected, onSelect, onEdit }) {
  const id = book.id;
  const progress = ui.progressOfBook(id);
  const state = ui.readingStateOf(id);
  const highlights = ui.highlightCountOf(id);
  const [menu, setMenu] = React.useState(false);
  const triggerRef = React.useRef(null);
  const closeMenu = React.useMemo(() => () => setMenu(false), []);
  const openPanel = async (panel) => {
    setMenu(false);
    if (await ui.openBook(id)) {
      ui.store.set({ notesMode: panel === 'notes' ? 'notes' : 'list' });
      ui.setPanel(panel);
    }
  };
  const remove = () => {
    setMenu(false);
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      && window.confirm(tr(ui, 'deleteConfirm', '从书库删除《{title}》？\n只删除书库副本，不影响原始文件。', { title: book.title || id }));
    if (confirmed) ui.removeBook(id);
  };
  const progressText = state === 'finished' ? tr(ui, 'finished', '已读完')
    : progress > 0 ? formatPercent(progress)
      : state === 'reading' ? tr(ui, 'justStarted', '刚开始') : tr(ui, 'unread', '未读');
  const action = (Icon, key, fallback, onClick, danger = false) => h('button', {
    type: 'button', className: danger ? 'is-danger' : '', onClick,
  }, h(Icon, { width: 16, height: 16 }), tr(ui, key, fallback));
  return h('div', { className: `qmr-book-row${menu ? ' is-menu-open' : ''}${selecting && selected ? ' is-selected' : ''}`, role: 'listitem' },
    h('div', { className: 'qmr-book-primary' }, selecting ? h('input', { type: 'checkbox', checked: selected,
      'aria-label': tagText(ui, 'selectBook', { title: book.title || id }), onChange: onSelect }) : null,
    h('button', {
      type: 'button', className: 'qmr-book-open', disabled: busy,
      title: book.title || id,
      'aria-label': tr(ui, 'openBook', '打开《{title}》', { title: book.title || id }),
      onClick: () => ui.openBook(id),
    }, h(Cover, { book }), h('span', { className: 'qmr-book-copy' },
      h('span', { className: 'qmr-book-title' }, book.title || id),
      h('span', { className: 'qmr-book-author' }, book.author || tr(ui, 'unknownAuthor', '未知作者')),
      h(BookTagChips, { ui, bookId: id })))),
    h('span', { className: 'qmr-book-format', title: formatBytes(book.bytes) || undefined }, String(book.format || 'epub').toUpperCase()),
    h('div', { className: `qmr-book-progress${state === 'new' ? ' is-unread' : ''}` },
      h('span', null, busy ? tr(ui, 'opening', '打开中…') : progressText),
      state !== 'new' ? h('span', { className: 'qmr-book-track', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round(progress * 100)}%` } })) : null),
    h('button', { type: 'button', className: 'qmr-book-highlights', disabled: busy, onClick: () => openPanel('highlights'),
      title: tr(ui, 'highlightsCount', '{count} 条划线', { count: highlights }),
      'aria-label': tr(ui, 'bookHighlights', '查看《{title}》的 {count} 条划线', { title: book.title || id, count: highlights }),
    }, highlights > 0 ? h(React.Fragment, null, h(IconHighlight, { width: 14, height: 14 }), highlights) : h('span', { 'aria-hidden': 'true' }, '—')),
    h('div', { className: 'qmr-book-more' },
      h('button', { ref: triggerRef, type: 'button', className: 'qmr-lib-icon', disabled: busy, 'aria-expanded': menu,
        'aria-label': tr(ui, 'bookActions', '《{title}》的更多操作', { title: book.title || id }),
        title: tr(ui, 'more', '更多操作'), onClick: () => setMenu(!menu),
      }, h(IconMore, { width: 18, height: 18 })),
      menu ? h(TagOverlay, { ui, title: tr(ui, 'bookActions', '《{title}》的更多操作', { title: book.title || id }), onClose: closeMenu },
        h('div', { className: 'qmr-book-menu' },
        h('button', { type: 'button', disabled: !editableTags(ui), title: !editableTags(ui) ? tagText(ui, 'offline') : undefined, onClick: () => { triggerRef.current?.focus(); setMenu(false); onEdit(id); } }, tagText(ui, 'edit')),
        !editableTags(ui) ? h('p', { className: 'qmr-muted' }, tagText(ui, 'offline')) : null,
        action(IconNote, 'notes', '阅读笔记', () => openPanel('notes')),
        action(IconHighlight, 'highlights', '查看划线', () => openPanel('highlights')),
        h('div', { className: 'qmr-book-menu-meta' }, `${String(book.format || 'epub').toUpperCase()}${formatBytes(book.bytes) ? ` · ${formatBytes(book.bytes)}` : ''}`),
        action(IconTrash, 'delete', '从书库删除', remove, true))) : null));
}

export function LibraryView({ ui }) {
  const dataRevision = ui.useSel(state => state.dataRevision);
  const statesVersion = ui.useSel(state => state.statesRevision) || 0;
  const query = ui.useSel(state => state.libraryQuery) || '';
  const sort = ui.useSel(state => state.librarySort) || 'recent';
  const filter = ui.useSel(state => state.libraryFilter) || 'all';
  const format = ui.useSel(state => state.libraryFormat) || 'all';
  const loading = ui.useSel(state => state.libraryLoading);
  const queue = ui.useSel(state => state.importQueue);
  const importing = queue && ['running', 'stopping', 'paused'].includes(queue.mode);
  const busyBookId = ui.useSel(state => state.busyBookId);
  const fileRef = React.useRef(null);
  const status = ui.status();
  const books = ui.books();
  const tagIds = ui.useSel(state => state.libraryTagIds) || [];
  const tagMode = ui.useSel(state => state.libraryTagMode) || 'any';
  const untagged = !!ui.useSel(state => state.libraryUntagged);
  const catalog = catalogOf(ui);
  const [dialog, setDialog] = React.useState(null);
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState([]);
  const closeDialog = React.useMemo(() => () => setDialog(null), []);
  const finishSelection = React.useMemo(() => () => { setSelected([]); setSelecting(false); }, []);
  const filterKey = JSON.stringify([query, filter, format, tagIds, tagMode, untagged]);
  React.useEffect(() => { setSelected([]); }, [filterKey]);
  React.useEffect(() => {
    setSelected(ids => ids.filter(id => books.some(book => book.id === id)));
    const retained = tagIds.filter(id => catalog.tags.some(tag => tag.id === id));
    if (retained.length !== tagIds.length) ui.store.set({ libraryTagIds: retained });
  }, [dataRevision]);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const book of ui.books().slice(0, MAX_STATE_LOADS)) {
        if (cancelled) return;
        try { await ui.loadState(book.id); } catch (_error) { /* 单本失败不影响书库。 */ }
      }
    })();
    return () => { cancelled = true; };
  }, [ui, dataRevision, statesVersion]);

  const matchesFilter = (book, key) => key === 'reading' ? ui.readingStateOf(book.id) === 'reading'
    : key === 'finished' ? ui.readingStateOf(book.id) === 'finished'
      : key === 'highlighted' ? ui.highlightCountOf(book.id) > 0 : true;
  const visibleBooks = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = books.filter(book => book && matchesFilter(book, filter)
      && matchesTags(catalog.bookTags[book.id] || [], tagIds, tagMode, untagged)
      && (format === 'all' || String(book.format || 'epub').toLowerCase() === format)
      && (!needle || `${book.title || ''} ${book.author || ''}`.toLowerCase().includes(needle)));
    return list.sort((a, b) => sort === 'title' ? String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')
      : sort === 'added' ? (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0)
        : (Number(b.openedAt) || Number(b.addedAt) || 0) - (Number(a.openedAt) || Number(a.addedAt) || 0));
  }, [books, query, sort, filter, format, statesVersion, dataRevision, tagIds, tagMode, untagged, ui]);
  const pickFile = () => {
    try { fileRef.current?.click(); } catch (_error) { ui.toast(tr(ui, 'pickerError', '当前环境无法打开文件选择器'), 'warn'); }
  };
  const clearFilters = () => ui.store.set({ libraryQuery: '', libraryFilter: 'all', libraryFormat: 'all', libraryTagIds: [], libraryTagMode: 'any', libraryUntagged: false });
  const hasFilters = filter !== 'all' || format !== 'all' || !!query.trim() || tagIds.length > 0 || untagged;
  const showLoading = (loading || status.status === 'loading') && !books.length;
  const resumeBook = !hasFilters
    ? [...books].filter(book => ui.readingStateOf(book.id) === 'reading')
      .sort((a, b) => (Number(b.openedAt) || 0) - (Number(a.openedAt) || 0))[0] : null;
  const selectedLabel = tr(ui, filter, FILTERS.find(([key]) => key === filter)?.[1] || '全部书籍');
  const iconButton = (Icon, key, fallback, onClick, disabled = false) => h('button', {
    type: 'button', className: 'qmr-lib-icon', title: tr(ui, key, fallback), 'aria-label': tr(ui, key, fallback), onClick, disabled,
  }, h(Icon, { width: 18, height: 18 }));
  const importButton = h('button', { type: 'button', className: 'qmr-lib-import', onClick: pickFile },
    h(IconImport, { width: 17, height: 17 }), importing ? tr(ui, 'queue.add', '追加文件') : tr(ui, 'import', '导入书籍'));
  const error = status.error;

  return h('div', { className: 'qmr-library' },
    h('input', { ref: fileRef, type: 'file', accept: '.epub,.pdf,.txt', multiple: true, hidden: true, tabIndex: -1, onChange: event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length) ui.enqueueImports(files);
    } }),
    h('aside', { className: 'qmr-library-sidebar', 'aria-label': tr(ui, 'categories', '书库分类') },
      h('div', { className: 'qmr-library-brand' }, h(IconLibrary, { width: 22, height: 22 }), h('span', null, ui.t('library', '书库'))),
      h('nav', { className: 'qmr-library-nav', 'aria-label': tr(ui, 'filter', '阅读状态') }, FILTERS.map(([key, fallback]) => h('button', {
        key, type: 'button', className: filter === key ? 'is-active' : '', 'aria-pressed': filter === key,
        onClick: () => ui.store.set({ libraryFilter: key }),
      }, h('span', null, tr(ui, key, fallback)), h('span', { className: 'qmr-library-count' }, books.filter(book => matchesFilter(book, key)).length)))),
      h('div', { className: 'qmr-library-formats' }, h('div', { className: 'qmr-library-section-label' }, tr(ui, 'formats', '文件格式')),
        ['all', 'epub', 'pdf', 'txt'].map(key => h('button', { key, type: 'button', className: format === key ? 'is-active' : '',
          'aria-pressed': format === key, onClick: () => ui.store.set({ libraryFormat: key }),
        }, h('span', null, key === 'all' ? tr(ui, 'allFormats', '全部格式') : key.toUpperCase()),
        h('span', { className: 'qmr-library-count' }, books.filter(book => key === 'all' || String(book.format || 'epub').toLowerCase() === key).length)))),
      h('div', { className: 'qmr-library-sidebar-foot' }, importButton, h('span', null, 'EPUB · PDF · TXT'))),
    h('main', { className: 'qmr-library-main', 'aria-label': selectedLabel },
      h('header', { className: 'qmr-library-header' },
        h('div', { className: 'qmr-library-heading' }, h('h1', null, selectedLabel), h('span', { className: 'qmr-library-total', role: 'status' }, tr(ui, 'bookCount', '{count} 本书', { count: visibleBooks.length }))),
        h('div', { className: 'qmr-library-tools' },
          h('label', { className: 'qmr-library-search' }, h(IconSearch, { width: 17, height: 17 }), h('input', { type: 'search', value: query,
            placeholder: tr(ui, 'searchPlaceholder', '搜索书名或作者'), 'aria-label': tr(ui, 'search', '搜索书库'),
            onChange: event => ui.store.set({ libraryQuery: event.target.value }),
          })),
          h('button', { type: 'button', className: `qmr-btn${tagIds.length || untagged ? ' is-active' : ''}`, 'aria-expanded': dialog?.kind === 'filter', onClick: () => setDialog({ kind: 'filter' }) }, tagText(ui, 'filter')),
          iconButton(IconRefresh, 'refresh', '刷新书库', () => ui.refreshLibrary(), !!loading),
          iconButton(IconFullscreen, 'fullscreen', '全屏', () => ui.toggleFullscreen()),
          iconButton(IconClose, 'close', '关闭阅读器', () => ui.closeOverlay()))),
      h('div', { className: 'qmr-lib-scroll' },
        h(ImportQueueView, { ui }),
        hasFilters ? h('div', { className: 'qmr-tag-summary', 'aria-label': tagText(ui, 'activeFilters') },
          query.trim() ? h('span', { className: 'qmr-tag-badge' }, query.trim()) : null,
          filter !== 'all' ? h('span', { className: 'qmr-tag-badge' }, selectedLabel) : null,
          format !== 'all' ? h('span', { className: 'qmr-tag-badge' }, format.toUpperCase()) : null,
          catalog.tags.filter(tag => tagIds.includes(tag.id)).map(tag => h(TagChip, { key: tag.id, tag, remove: true, label: tagText(ui, 'removeFilter', { name: tag.name }), onClick: () => ui.store.set({ libraryTagIds: tagIds.filter(id => id !== tag.id) }) })),
          untagged ? h('button', { type: 'button', className: 'qmr-chip', onClick: () => ui.store.set({ libraryUntagged: false }) }, tagText(ui, 'untagged'), ' ×') : null,
          tagIds.length ? h('span', { className: 'qmr-muted' }, tagText(ui, tagMode === 'all' ? 'all' : 'any')) : null,
          h('button', { type: 'button', className: 'qmr-btn', onClick: clearFilters }, tagText(ui, 'clearAll'))) : null,
        queue?.items.length && hasFilters
          ? h('div', { className: 'qmr-muted qmr-small' }, tr(ui, 'queue.filtered', '新导入的书可能被当前筛选隐藏')) : null,
        error ? h('div', { className: 'qmr-errorbox', role: 'alert' }, h('div', { className: 'qmr-errorbox-title' }, tr(ui, 'error', '书库操作失败')),
          h('div', { className: 'qmr-errorbox-text' }, String(error)), h('button', { type: 'button', className: 'qmr-btn', onClick: () => ui.refreshLibrary() }, tr(ui, 'retry', '重试'))) : null,
        resumeBook ? h('section', { className: 'qmr-library-resume', 'aria-label': tr(ui, 'continue', '继续阅读') },
          h(Cover, { book: resumeBook }), h('div', { className: 'qmr-library-resume-copy' },
            h('span', { className: 'qmr-library-section-label' }, tr(ui, 'continue', '继续阅读')),
            h('span', { className: 'qmr-library-resume-title' }, resumeBook.title || resumeBook.id)),
          h('span', { className: 'qmr-library-resume-progress' }, ui.progressOfBook(resumeBook.id) > 0 ? formatPercent(ui.progressOfBook(resumeBook.id)) : tr(ui, 'justStarted', '刚开始')),
          h('button', { type: 'button', className: 'qmr-library-continue', disabled: busyBookId === resumeBook.id, onClick: () => ui.openBook(resumeBook.id) },
            tr(ui, 'continue', '继续阅读'), h(IconNext, { width: 16, height: 16 }))) : null,
        h('div', { className: 'qmr-library-toolbar' },
          !selecting ? h('button', { type: 'button', className: 'qmr-btn qmr-selection-toggle', disabled: !editableTags(ui), title: !editableTags(ui) ? tagText(ui, 'offline') : undefined, onClick: () => setSelecting(true) }, tagText(ui, 'select')) : null,
          h('select', { className: 'qmr-library-mobile-format', value: format, 'aria-label': tr(ui, 'formats', '文件格式'), onChange: event => ui.store.set({ libraryFormat: event.target.value }) },
            ['all', 'epub', 'pdf', 'txt'].map(key => h('option', { key, value: key }, key === 'all' ? tr(ui, 'allFormats', '全部格式') : key.toUpperCase()))),
          h('select', { className: 'qmr-library-sort', value: sort, 'aria-label': tr(ui, 'sort', '排序方式'), onChange: event => ui.store.set({ librarySort: event.target.value }) },
            h('option', { value: 'recent' }, tr(ui, 'recent', '最近阅读')), h('option', { value: 'added' }, tr(ui, 'added', '加入时间')), h('option', { value: 'title' }, tr(ui, 'title', '书名')))),
        !editableTags(ui) ? h('p', { className: 'qmr-muted qmr-small' }, tagText(ui, 'offline')) : null,
        selecting ? h('div', { className: 'qmr-tag-selection' },
          h('span', { role: 'status' }, tagText(ui, 'selected', { count: selected.length })),
          h('button', { type: 'button', className: 'qmr-btn', onClick: () => setSelected(visibleBooks.map(book => book.id)) }, tagText(ui, 'selectResults', { count: visibleBooks.length })),
          h('button', { type: 'button', className: 'qmr-btn', disabled: !selected.length, onClick: () => setSelected([]) }, tagText(ui, 'clearSelection')),
          !selected.length ? h('span', { className: 'qmr-muted' }, tagText(ui, 'chooseBooks')) : null,
          h('button', { type: 'button', className: 'qmr-btn qmr-selection-add', disabled: !selected.length || !editableTags(ui), onClick: () => setDialog({ kind: 'edit', mode: 'add', bookIds: [...selected] }) }, tagText(ui, 'bulkAdd')),
          h('button', { type: 'button', className: 'qmr-btn', disabled: !selected.length || !editableTags(ui), onClick: () => setDialog({ kind: 'edit', mode: 'remove', bookIds: [...selected] }) }, tagText(ui, 'bulkRemove')),
          h('button', { type: 'button', className: 'qmr-btn', onClick: finishSelection }, tagText(ui, 'exitSelection'))) : null,
        showLoading ? h('div', { className: 'qmr-busy', role: 'status' }, tr(ui, 'loading', '书库正在加载…'))
          : !visibleBooks.length ? h('div', { className: 'qmr-empty' }, h(IconBook, { width: 32, height: 32 }),
            h('div', { className: 'qmr-empty-title' }, books.length ? tr(ui, 'noResults', '没有符合条件的书') : tr(ui, 'empty', '从第一本书开始')),
            h('p', null, books.length ? tr(ui, 'noResultsHelp', '换个关键词，或清空筛选。') : tr(ui, 'emptyHelp', '导入 EPUB、PDF 或 TXT，开始阅读。')),
            h('div', { className: 'qmr-empty-actions' }, books.length ? h('button', { type: 'button', className: 'qmr-btn', onClick: clearFilters }, tr(ui, 'clear', '清空筛选')) : importButton))
            : h(React.Fragment, null,
              h('div', { className: 'qmr-library-columns', 'aria-hidden': 'true' }, h('span', null, tr(ui, 'titleAuthor', '书名 / 作者')), h('span', null, tr(ui, 'format', '格式')), h('span', null, tr(ui, 'progress', '阅读进度')), h('span', null, tr(ui, 'annotations', '划线')), h('span')),
              h('div', { className: 'qmr-book-list', role: 'list', 'aria-label': tr(ui, 'collection', '我的书目') }, visibleBooks.map(book => h(BookRow, { key: book.id, ui, book, busy: busyBookId === String(book.id), selecting, selected: selected.includes(book.id), onSelect: () => setSelected(ids => ids.includes(book.id) ? ids.filter(id => id !== book.id) : [...ids, book.id]), onEdit: id => setDialog({ kind: 'edit', mode: 'replace', bookIds: [id] }) }))))),
      dialog?.kind === 'filter' ? h(TagFilter, { ui, ids: tagIds, mode: tagMode, untagged, onClose: closeDialog }) : null,
      dialog?.kind === 'edit' ? h(BookTagEditor, { key: `${dialog.mode}:${dialog.bookIds.join(',')}`, ui, bookIds: dialog.bookIds, mode: dialog.mode, onClose: closeDialog, onSuccess: dialog.mode === 'add' ? finishSelection : undefined }) : null));
}
export const truncateForCard = value => truncate(value, 60);
