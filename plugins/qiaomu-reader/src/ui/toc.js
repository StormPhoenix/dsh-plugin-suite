/**
 * 目录侧滑：递归渲染 TOC 树，可折叠，当前章高亮，点击跳转。
 */
import * as React from 'react';
import { chapterIndexForHref, chapterLabelMap, stripTags } from './format.js';
import { IconClose, IconNext, IconToc } from './icons.js';

const h = React.createElement;

/**
 * 目录面板。
 * @param {object} props
 * @param {object} props.ui 控制器
 * @returns {React.ReactElement}
 */
export function TocPanel({ ui }) {
  const bookId = ui.useSel((state) => state.bookId);
  const chapterIndex = ui.useSel((state) => state.chapterIndex);
  const chapterCount = ui.useSel((state) => state.chapterCount);
  ui.useSel((state) => state.engineVersion);
  const [collapsed, setCollapsed] = React.useState({});
  const engine = ui.engineOf(bookId);
  const labels = React.useMemo(() => chapterLabelMap(engine), [engine]);
  const entries = React.useMemo(() => {
    const toc = engine && engine.book && Array.isArray(engine.book.toc) ? engine.book.toc : [];
    return toc;
  }, [engine]);

  /** href -> 章节 index（TOC 自身优先，其次引擎的链接解析） */
  const indexOfHref = React.useCallback((href) => {
    const direct = chapterIndexForHref(engine, href);
    if (direct >= 0) return direct;
    try {
      const resolved = engine && engine.resolveLink ? engine.resolveLink(chapterIndex, href) : null;
      return typeof resolved === 'number' ? resolved : -1;
    } catch (_error) {
      return -1;
    }
  }, [engine, chapterIndex]);

  const jump = (href) => {
    const index = indexOfHref(href);
    if (index >= 0) {
      ui.goChapter(index);
    } else {
      ui.toast('无法定位该目录项', 'warn');
    }
  };

  const toggle = (key) => setCollapsed((previous) => ({ ...previous, [key]: !previous[key] }));

  const renderEntries = (list, depth) => {
    if (!Array.isArray(list) || !list.length) return null;
    return h('div', { className: 'qmr-toc-tree' }, list.map((entry, i) => {
      if (!entry) return null;
      const href = String(entry.href || '');
      const key = `${depth}-${i}-${href}`;
      const children = Array.isArray(entry.children) ? entry.children : [];
      const isOpen = !collapsed[key];
      const index = indexOfHref(href);
      const isCurrent = index >= 0 && index === chapterIndex;
      return h(
        'div',
        { key },
        h(
          'div',
          { className: 'qmr-toc-row' },
          children.length
            ? h('button', {
              type: 'button',
              className: `qmr-toc-toggle${isOpen ? ' is-open' : ''}`,
              'aria-label': isOpen ? '折叠' : '展开',
              'aria-expanded': isOpen,
              onClick: () => toggle(key),
            }, h(IconNext, { width: 14, height: 14 }))
            : h('span', { className: 'qmr-toc-toggle', 'aria-hidden': 'true' }),
          h('button', {
            type: 'button',
            className: `qmr-toc-item${isCurrent ? ' is-current' : ''}`,
            'aria-current': isCurrent ? 'true' : undefined,
            onClick: () => jump(href),
          }, stripTags(entry.label) || href || '未命名'),
        ),
        children.length && isOpen ? h('div', { className: 'qmr-toc-children' }, renderEntries(children, depth + 1)) : null,
      );
    }));
  };

  const chapterLabel = labels.get(chapterIndex) || `第 ${chapterIndex + 1} 章`;

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'qmr-panel-head' },
      h(IconToc, { width: 16, height: 16 }),
      h('span', { className: 'qmr-panel-title' }, '目录'),
      h('button', {
        type: 'button',
        className: 'qmr-icon-btn',
        'aria-label': '关闭目录',
        onClick: () => ui.setPanel(null),
      }, h(IconClose, { width: 16, height: 16 })),
    ),
    h(
      'div',
      { className: 'qmr-panel-body' },
      h('div', { className: 'qmr-group-title' },
        `第 ${chapterIndex + 1} / ${chapterCount || '?'} 章`,
        h('span', { className: 'qmr-muted' }, chapterLabel)),
      entries.length
        ? renderEntries(entries, 0)
        : h('div', { className: 'qmr-empty' },
          h('div', { className: 'qmr-empty-title' }, '这本书没有目录'),
          h('p', null, '可以直接用底部进度条或左右翻页浏览。')),
    ),
  );
}