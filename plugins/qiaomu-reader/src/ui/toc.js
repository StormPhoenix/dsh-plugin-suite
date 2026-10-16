/**
 * 目录侧滑：递归渲染 TOC 树，可折叠，当前章高亮，点击跳转。
 */
import * as React from 'react';
import { chapterLabelMap, stripTags } from './format.js';
import { flattenToc, locateTocEntry } from './toc-locate.js';
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
  const engineVersion = ui.useSel((state) => state.engineVersion);
  const tocAnchor = ui.useSel((state) => state.tocAnchor);
  const [collapsed, setCollapsed] = React.useState({});
  const engine = ui.engineOf(bookId);
  const labels = React.useMemo(() => chapterLabelMap(engine), [engine, engineVersion]);
  const entries = React.useMemo(() => {
    const toc = engine && engine.book && Array.isArray(engine.book.toc) ? engine.book.toc : [];
    return toc;
  }, [engine, engineVersion]);
  const flat = React.useMemo(() => flattenToc(entries, engine), [entries, engine, engineVersion]);
  const byKey = React.useMemo(() => new Map(flat.map((item) => [item.key, item])), [flat]);
  const anchor = tocAnchor?.bookId === bookId && tocAnchor.chapterIndex === chapterIndex ? tocAnchor : null;
  const location = React.useMemo(() => locateTocEntry({ flat, chapterIndex, anchor }), [flat, chapterIndex, anchor]);
  const currentKey = location?.key;
  const currentVisible = !!location && location.ancestors.every((key) => !collapsed[key]);

  React.useLayoutEffect(() => {
    if (!location) return;
    setCollapsed((previous) => {
      if (!location.ancestors.some((key) => previous[key])) return previous;
      const next = { ...previous };
      for (const key of location.ancestors) delete next[key];
      return next;
    });
  }, [location]);

  const jump = (key) => {
    const index = byKey.get(key)?.chapterIndex ?? -1;
    if (index >= 0) {
      ui.goChapter(index);
    } else {
      ui.toast('无法定位该目录项', 'warn');
    }
  };

  const toggle = (key) => setCollapsed((previous) => ({ ...previous, [key]: !previous[key] }));

  /** 面板打开或当前小节变化时，仅滚动目录容器。 */
  const bodyRef = React.useRef(null);
  React.useLayoutEffect(() => {
    if (!currentKey || !currentVisible) return undefined;
    const center = () => {
      const body = bodyRef.current;
      const current = body?.querySelector('.qmr-toc-item.is-current');
      if (!body || !current || !body.clientHeight) return;
      const bodyRect = body.getBoundingClientRect();
      const itemRect = current.getBoundingClientRect();
      const offset = itemRect.top - bodyRect.top - (body.clientTop || 0) + body.scrollTop;
      body.scrollTop = Math.max(0, offset - (body.clientHeight - itemRect.height) / 2);
    };
    center();
    const frame = requestAnimationFrame(center);
    return () => cancelAnimationFrame(frame);
  }, [entries, currentKey, currentVisible]);

  const renderEntries = (list, depth, parentKey = '') => {
    if (!Array.isArray(list) || !list.length) return null;
    return h('div', { className: 'qmr-toc-tree' }, list.map((entry, i) => {
      if (!entry) return null;
      const href = String(entry.href || '');
      const localKey = `${depth}-${i}-${href}`;
      const key = parentKey ? `${parentKey}/${localKey}` : localKey;
      const children = Array.isArray(entry.children) ? entry.children : [];
      const isOpen = !collapsed[key];
      const isCurrent = key === currentKey;
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
            onClick: () => jump(key),
          }, stripTags(entry.label) || href || '未命名'),
        ),
        children.length && isOpen ? h('div', { className: 'qmr-toc-children' }, renderEntries(children, depth + 1, key)) : null,
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
      { className: 'qmr-panel-body', ref: bodyRef },
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