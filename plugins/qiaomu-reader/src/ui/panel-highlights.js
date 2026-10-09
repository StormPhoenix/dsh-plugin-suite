/**
 * 划线/批注面板 + 阅读笔记视图。
 * - 列表视图：按章节分组，显示引文、颜色点、批注；点击跳原文；可改色、编辑批注、删除。
 * - 笔记视图：把全书划线/批注渲染成 Markdown 预览，可复制、可导出 .md。
 */
import * as React from 'react';
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_LABELS } from './theme.js';
import { chapterIndexForHref, chapterLabelMap, downloadText, formatPercent, toMarkdown, truncate } from './format.js';
import { IconClose, IconCopy, IconExport, IconHighlight, IconTrash } from './icons.js';
import { highlightLink } from '../core/backlink.js';

const h = React.createElement;

/** 估算章内偏移对应的全书百分比（划线 percent 兜底） */
function percentOfHighlight(highlight) {
  return formatPercent(highlight && highlight.percent);
}

/** 按章节分组 */
function groupByChapter(highlights, engine) {
  const groups = new Map();
  for (const highlight of highlights) {
    if (!highlight) continue;
    let index = chapterIndexForHref(engine, highlight.chapterHref);
    if (index < 0) index = Number.MAX_SAFE_INTEGER;
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(highlight);
  }
  return Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, items]) => ({
      index,
      items: items.slice().sort((a, b) => Number(a.percent || 0) - Number(b.percent || 0)),
    }));
}

/**
 * 单条划线。
 * @param {object} props
 * @param {object} props.ui
 * @param {object} props.highlight
 * @param {string} props.bookId
 * @param {boolean} props.editing
 * @returns {React.ReactElement}
 */
function HighlightItem({ ui, highlight, bookId, editing }) {
  const [draft, setDraft] = React.useState(String(highlight.note || ''));
  React.useEffect(() => {
    setDraft(String(highlight.note || ''));
  }, [highlight.id, highlight.note, editing]);

  const swatches = HIGHLIGHT_COLORS.map((color) =>
    h('button', {
      key: color,
      type: 'button',
      className: `qmr-swatch${highlight.color === color ? ' is-active' : ''}`,
      'aria-label': `${HIGHLIGHT_COLOR_LABELS[color]}色`,
      onClick: () => ui.setHighlightColor(bookId, highlight.id, color),
    }));

  const requestDelete = () => {
    let confirmed = true;
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        confirmed = window.confirm(`删除这条划线？\n\n${truncate(highlight.text, 60)}`);
      }
    } catch (_error) {
      confirmed = true;
    }
    if (confirmed) ui.removeHighlight(bookId, highlight.id);
  };

  return h(
    'div',
    { className: 'qmr-hl-item' },
    h(
      'div',
      { className: 'qmr-hl-top' },
      h('span', { className: `qmr-dot qmr-dot-${highlight.color || 'yellow'}`, 'aria-hidden': 'true' }),
      h('div', {
        className: 'qmr-hl-quote',
        role: 'button',
        tabIndex: 0,
        onClick: () => ui.focusHighlight(bookId, highlight.id),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') ui.focusHighlight(bookId, highlight.id);
        },
      }, highlight.text || '（空引文）'),
    ),
    highlight.note && !editing ? h('div', { className: 'qmr-hl-note' }, highlight.note) : null,
    editing
      ? h(
        'div',
        { style: { marginTop: 8 } },
        h('textarea', {
          className: 'qmr-textarea',
          value: draft,
          placeholder: '写点什么…',
          'aria-label': '批注内容',
          onChange: (event) => setDraft(event.target.value),
        }),
        h(
          'div',
          { className: 'qmr-hl-tools' },
          h('button', {
            type: 'button',
            className: 'qmr-btn qmr-btn-sm qmr-btn-primary',
            onClick: () => {
              ui.updateHighlightNote(bookId, highlight.id, draft);
              ui.store.set({ editingHighlightId: null });
            },
          }, '保存批注'),
          h('button', {
            type: 'button',
            className: 'qmr-btn qmr-btn-sm',
            onClick: () => ui.store.set({ editingHighlightId: null }),
          }, '取消'),
        ),
      )
      : h(
        'div',
        { className: 'qmr-hl-tools' },
        h('span', { className: 'qmr-swatches', 'aria-label': '改颜色' }, swatches),
        h('button', {
          type: 'button',
          className: 'qmr-btn qmr-btn-sm',
          onClick: () => ui.store.set({ editingHighlightId: highlight.id }),
        }, highlight.note ? '编辑批注' : '写批注'),
        h('button', {
          type: 'button',
          className: 'qmr-btn qmr-btn-sm',
          'aria-label': '删除划线',
          onClick: requestDelete,
        }, h(IconTrash, { width: 14, height: 14 })),
        h('span', { className: 'qmr-muted qmr-small' }, percentOfHighlight(highlight)),
      ),
  );
}

/**
 * 划线面板（含阅读笔记视图）。
 * @param {object} props
 * @param {object} props.ui 控制器
 * @returns {React.ReactElement}
 */
export function HighlightsPanel({ ui }) {
  const bookId = ui.useSel((state) => state.bookId);
  const bookState = ui.useSel((state) => (state.states || {})[bookId] || null);
  const mode = ui.useSel((state) => state.notesMode) || 'list';
  const editingId = ui.useSel((state) => state.editingHighlightId);
  const engineVersion = ui.useSel((state) => state.engineVersion);
  const engine = ui.engineOf(bookId);
  const book = ui.bookOf(bookId);

  React.useEffect(() => {
    if (bookId != null) ui.loadState(bookId);
  }, [bookId, ui]);

  const highlights = (bookState && bookState.highlights) || [];
  const highlightsRef = React.useRef(highlights);
  highlightsRef.current = highlights;
  const engineRef = React.useRef(engine);
  engineRef.current = engine;
  const labels = React.useMemo(() => chapterLabelMap(engine), [engine, engineVersion]);
  const groups = React.useMemo(() => groupByChapter(highlights, engine), [highlights, engine]);
  const markdown = React.useMemo(
    () => toMarkdown(bookState || {}, book, engine),
    [bookState, book, engine],
  );
  const noteCount = highlights.filter((item) => item && String(item.note || '').trim()).length;

  const copyMarkdown = () => ui.copy(markdown, '阅读笔记已复制');

  const exportMarkdown = async () => {
    try {
      const text = await ui.exportNotes(bookId);
      const title = (book && book.title) || '阅读笔记';
      const ok = downloadText(text, `${title}-阅读笔记.md`);
      if (!ok) await ui.copy(text, '已复制，请粘贴保存');
      else ui.toast('已导出 Markdown', 'ok');
    } catch (error) {
      ui.reportError(error, true);
      ui.toast('导出失败', 'error');
    }
  };

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'qmr-panel-head' },
      h(IconHighlight, { width: 16, height: 16 }),
      h('span', { className: 'qmr-panel-title' }, '划线与笔记'),
      h(
        'span',
        { className: 'qmr-seg', role: 'group', 'aria-label': '面板视图' },
        h('button', {
          type: 'button',
          className: mode === 'list' ? 'is-active' : '',
          'aria-pressed': mode === 'list',
          onClick: () => ui.store.set({ notesMode: 'list' }),
        }, '划线'),
        h('button', {
          type: 'button',
          className: mode === 'notes' ? 'is-active' : '',
          'aria-pressed': mode === 'notes',
          onClick: () => ui.store.set({ notesMode: 'notes' }),
        }, '阅读笔记'),
      ),
      h('button', {
        type: 'button',
        className: 'qmr-icon-btn',
        'aria-label': '导出 Markdown',
        onClick: exportMarkdown,
      }, h(IconExport, { width: 16, height: 16 })),
      h('button', {
        type: 'button',
        className: 'qmr-icon-btn',
        'aria-label': '关闭面板',
        onClick: () => ui.setPanel(null),
      }, h(IconClose, { width: 16, height: 16 })),
    ),
    h(
      'div',
      { className: 'qmr-panel-body' },
      mode === 'notes'
        ? h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'qmr-hl-tools', style: { marginBottom: 8 } },
            h('button', { type: 'button', className: 'qmr-btn qmr-btn-sm', onClick: copyMarkdown },
              h(IconCopy, { width: 14, height: 14 }), '复制 Markdown'),
            h('button', { type: 'button', className: 'qmr-btn qmr-btn-sm', onClick: exportMarkdown },
              h(IconExport, { width: 14, height: 14 }), '导出 .md'),
          ),
          h('div', { className: 'qmr-md-preview' },
            h('h3', null, `《${book?.title || '未命名'}》阅读笔记`),
            highlights.length ? groups.map((group) => h('section', { key: String(group.index) },
              h('h4', null, group.index === Number.MAX_SAFE_INTEGER ? '其他位置' : labels.get(group.index) || `第 ${group.index + 1} 章`),
              group.items.map((highlight) => h('div', { key: highlight.id, className: 'qmr-md-quote' },
                h('blockquote', null, highlight.text),
                highlight.note ? h('p', null, highlight.note) : null,
                h('a', { href: highlightLink(bookId, highlight.id), className: 'qmr-md-backlink' }, '↩ 回到原文')),
            ))) : h('p', null, '暂无划线。')),
        )
        : (highlights.length
          ? h(
            React.Fragment,
            null,
            h('div', { className: 'qmr-group-title' },
              `共 ${highlights.length} 条划线 · ${noteCount} 条批注`),
            groups.map((group) => h(
              'div',
              { key: String(group.index) },
              h('div', { className: 'qmr-group-title' },
                group.index === Number.MAX_SAFE_INTEGER
                  ? '其他位置'
                  : labels.get(group.index) || `第 ${group.index + 1} 章`),
              group.items.map((highlight) => h(HighlightItem, {
                key: highlight.id,
                ui,
                highlight,
                bookId,
                editing: editingId === highlight.id,
              })),
            )),
          )
          : h(
            'div',
            { className: 'qmr-empty' },
            h('div', { className: 'qmr-empty-title' }, '还没有划线'),
            h('p', null, '在正文里选中文字，点「划线」或「写批注」，这里就会汇总。'),
          )),
    ),
  );
}
