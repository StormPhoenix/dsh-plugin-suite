/**
 * 全书搜索面板：输入即搜（防抖 250ms），结果显示章节名 + 高亮片段；
 * Enter 下一个 / Shift+Enter 上一个 / Esc 关闭并回到原位置。
 */
import * as React from 'react';
import { useDebounced } from './hooks.js';
import { IconClose, IconNext, IconPrev, IconSearch } from './icons.js';

const h = React.createElement;

/** 把片段里的查询词包成 <mark class="qm-hit"> */
function renderSnippet(snippet, query) {
  const text = String(snippet || '');
  const needle = String(query || '').trim();
  if (!needle || !text) return text;
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const at = lowerText.indexOf(lowerNeedle, cursor);
    if (at < 0 || !lowerNeedle) break;
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(h('mark', { className: 'qm-hit', key: `m${key++}` }, text.slice(at, at + needle.length)));
    cursor = at + needle.length;
    if (key > 40) break;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length ? parts : text;
}

/**
 * 搜索面板。
 * @param {object} props
 * @param {object} props.ui 控制器
 * @returns {React.ReactElement}
 */
export function SearchPanel({ ui }) {
  const bookId = ui.useSel((state) => state.bookId);
  const storeQuery = ui.useSel((state) => state.searchQuery);
  const results = ui.useSel((state) => state.searchResults) || [];
  const current = ui.useSel((state) => state.searchIndex);
  const busy = ui.useSel((state) => state.searchBusy);
  const error = ui.useSel((state) => state.searchError);
  const [text, setText] = React.useState(String(storeQuery || ''));
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);
  const debouncedSearch = useDebounced((value) => ui.search(bookId, value), 250);

  React.useEffect(() => {
    try {
      if (inputRef.current) inputRef.current.focus();
    } catch (_error) {
      /* 忽略 */
    }
  }, []);

  React.useEffect(() => {
    const element = listRef.current;
    if (!element || current < 0) return;
    try {
      const node = element.querySelector('.qmr-search-item.is-current');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    } catch (_error) {
      /* 忽略 */
    }
  }, [current, results.length]);

  const onChange = (event) => {
    const value = event.target.value;
    setText(value);
    debouncedSearch(value);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const pending = String(text || '') !== String(storeQuery || '');
      if (pending) {
        Promise.resolve(ui.search(bookId, text)).then(
          () => ui.searchNext(event.shiftKey ? -1 : 1),
          () => {},
        );
      } else {
        ui.searchNext(event.shiftKey ? -1 : 1);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      ui.closeSearch();
    }
  };

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'qmr-panel-head' },
      h(IconSearch, { width: 16, height: 16 }),
      h('span', { className: 'qmr-panel-title' }, '书内搜索'),
      h('button', {
        type: 'button',
        className: 'qmr-icon-btn',
        'aria-label': '关闭搜索',
        onClick: () => ui.closeSearch(),
      }, h(IconClose, { width: 16, height: 16 })),
    ),
    h(
      'div',
      { className: 'qmr-panel-body' },
      h('input', {
        ref: inputRef,
        className: 'qmr-input',
        style: { width: '100%' },
        type: 'search',
        value: text,
        placeholder: '搜索全书…',
        'aria-label': '搜索全书',
        onChange,
        onKeyDown,
      }),
      h(
        'div',
        { className: 'qmr-hl-tools', style: { marginTop: 8 } },
        h('button', {
          type: 'button',
          className: 'qmr-btn qmr-btn-sm',
          disabled: !results.length,
          onClick: () => ui.searchNext(-1),
        }, h(IconPrev, { width: 14, height: 14 }), '上一个'),
        h('button', {
          type: 'button',
          className: 'qmr-btn qmr-btn-sm',
          disabled: !results.length,
          onClick: () => ui.searchNext(1),
        }, h(IconNext, { width: 14, height: 14 }), '下一个'),
        h('span', { className: 'qmr-muted qmr-small' },
          results.length ? `${Math.max(1, current + 1)} / ${results.length}` : ''),
      ),
      busy ? h('div', { className: 'qmr-busy' }, '搜索中…') : null,
      error ? h('div', { className: 'qmr-errorbox-text', style: { marginTop: 8 } }, error) : null,
      !busy && !results.length
        ? h('div', { className: 'qmr-empty' },
          h('div', { className: 'qmr-empty-title' }, text.trim() ? '没有找到匹配' : '输入关键词开始搜索'),
          h('p', null, '支持中文单字与英文子串；Enter 下一个，Shift+Enter 上一个。'))
        : null,
      h('div', { ref: listRef, style: { marginTop: 8 } }, results.map((hit, index) =>
        h('button', {
          key: `${hit.chapterIndex}-${hit.offset}-${index}`,
          type: 'button',
          className: `qmr-search-item${index === current ? ' is-current' : ''}`,
          onClick: () => ui.focusSearchHit(index, true),
        },
        h('div', { className: 'qmr-search-chapter' },
          `${hit.chapterLabel || `第 ${Number(hit.chapterIndex) + 1} 章`} · ${Math.round(Number(hit.percent || 0) > 1 ? Number(hit.percent) : Number(hit.percent || 0) * 100)}%`),
        h('div', { className: 'qmr-search-snippet' }, renderSnippet(hit.snippet, storeQuery))))),
    ),
  );
}