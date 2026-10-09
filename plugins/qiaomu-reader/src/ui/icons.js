/**
 * 内联 SVG 图标组件（stroke 风格，继承 currentColor）。
 * 全部图标 aria-hidden，无障碍名由调用方的 aria-label 提供（不使用 title，避免多余 tooltip）。
 */
import * as React from 'react';

const h = React.createElement;

/**
 * 生成一个图标组件。
 * @param {string} name 组件名后缀
 * @param {Array} children svg 子节点（带 key）
 * @param {object} [options] { viewBox, filled }
 * @returns {React.ComponentType<object>}
 */
function makeIcon(name, children, options = {}) {
  const viewBox = options.viewBox || '0 0 24 24';
  const filled = !!options.filled;
  function Icon(props) {
    return h(
      'svg',
      {
        width: 18,
        height: 18,
        viewBox,
        fill: filled ? 'currentColor' : 'none',
        stroke: filled ? 'none' : 'currentColor',
        strokeWidth: filled ? undefined : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        ...(props || {}),
      },
      children,
    );
  }
  Icon.displayName = `QmrIcon${name}`;
  return Icon;
}

const p = (d, key) => h('path', { d, key });

export const IconLibrary = makeIcon('Library', [
  p('M4 4h3v16H4z', 'a'),
  p('M10 4h3v16h-3z', 'b'),
  p('M16.1 5.4l2.8-.8 3.5 14.7-2.8.7z', 'c'),
]);

export const IconBook = makeIcon('Book', [
  p('M12 6.5C10.4 5 8.4 4.5 4 4.5v13c4.4 0 6.4.5 8 2 1.6-1.5 3.6-2 8-2v-13c-4.4 0-6.4.5-8 2z', 'a'),
  p('M12 6.5v13', 'b'),
]);

export const IconToc = makeIcon('Toc', [
  p('M4 6h16', 'a'),
  p('M4 12h11', 'b'),
  p('M4 18h7', 'c'),
]);

export const IconSearch = makeIcon('Search', [
  h('circle', { cx: 11, cy: 11, r: 6.5, key: 'a' }),
  p('M16 16l4.5 4.5', 'b'),
]);

export const IconHighlight = makeIcon('Highlight', [
  p('M4.5 20h5l9.7-9.7a2 2 0 0 0 0-2.8l-2.2-2.2a2 2 0 0 0-2.8 0L4.5 15z', 'a'),
  p('M13.2 7.4l4.3 4.3', 'b'),
]);

export const IconSparkles = makeIcon('Sparkles', [
  p('M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z', 'a'),
  p('M19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6z', 'b'),
]);

export const IconSettings = makeIcon('Settings', [
  h('circle', { cx: 12, cy: 12, r: 3, key: 'a' }),
  p(
    'M19.6 14.4a1.7 1.7 0 0 0 .33 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.33 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.12a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.12A1.7 1.7 0 0 0 4.68 8.8a1.7 1.7 0 0 0-.33-1.87l-.06-.06A2 2 0 1 1 7.12 4.04l.06.06a1.7 1.7 0 0 0 1.87.33H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.12a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.87v.05a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.12a1.7 1.7 0 0 0-1.28 1.21z',
    'b',
  ),
]);

export const IconBack = makeIcon('Back', [p('M19 12H5', 'a'), p('M11 6l-6 6 6 6', 'b')]);
export const IconPrev = makeIcon('Prev', [p('M14.5 5.5L8 12l6.5 6.5', 'a')]);
export const IconNext = makeIcon('Next', [p('M9.5 5.5L16 12l-6.5 6.5', 'a')]);
export const IconClose = makeIcon('Close', [p('M6 6l12 12', 'a'), p('M18 6L6 18', 'b')]);
export const IconPlus = makeIcon('Plus', [p('M12 5v14', 'a'), p('M5 12h14', 'b')]);
export const IconFullscreen = makeIcon('Fullscreen', [
  p('M4 9V4h5', 'a'),
  p('M20 15v5h-5', 'b'),
  p('M20 9V4h-5', 'c'),
  p('M4 15v5h5', 'd'),
]);
export const IconImport = makeIcon('Import', [
  p('M12 16V4', 'a'),
  p('M7 9l5-5 5 5', 'b'),
  p('M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17', 'c'),
]);
export const IconTrash = makeIcon('Trash', [
  p('M4 7h16', 'a'),
  p('M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'b'),
  p('M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7', 'c'),
  p('M10 11v6', 'd'),
  p('M14 11v6', 'e'),
]);
export const IconCopy = makeIcon('Copy', [
  p('M9.5 9.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'a'),
  p('M15 5.5V4.5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1', 'b'),
]);
export const IconCheck = makeIcon('Check', [p('M5 13l4 4L19 7', 'a')]);
export const IconNote = makeIcon('Note', [
  p('M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H11l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z', 'a'),
]);
export const IconExport = makeIcon('Export', [
  p('M12 4v12', 'a'),
  p('M7 11l5 5 5-5', 'b'),
  p('M4 19.5h16', 'c'),
]);
export const IconRefresh = makeIcon('Refresh', [
  p('M4.6 12a7.4 7.4 0 0 1 12.6-5.3L20 9.2', 'a'),
  p('M20 4.5v4.9h-4.9', 'b'),
  p('M19.4 12a7.4 7.4 0 0 1-12.6 5.3L4 14.8', 'c'),
  p('M4 19.5v-4.9h4.9', 'd'),
]);
export const IconRetry = IconRefresh;
export const IconArrowReturn = makeIcon('ArrowReturn', [
  p('M9.5 10L5.5 14l4 4', 'a'),
  p('M5.5 14h8.5a5 5 0 0 0 5-5V6.5', 'b'),
]);
export const IconFilter = makeIcon('Filter', [p('M4 6h16', 'a'), p('M7 12h10', 'b'), p('M10 18h4', 'c')]);
export const IconEdit = makeIcon('Edit', [p('M4 20h4l10.3-10.3-4-4L4 16z', 'a'), p('M13.6 6.4l4 4', 'b')]);
export const IconMore = makeIcon('More', [
  h('circle', { cx: 6, cy: 12, r: 1.6, key: 'a' }),
  h('circle', { cx: 12, cy: 12, r: 1.6, key: 'b' }),
  h('circle', { cx: 18, cy: 12, r: 1.6, key: 'c' }),
]);
export const IconBookmark = makeIcon('Bookmark', [p('M6.5 4h11v16l-5.5-4-5.5 4z', 'a')]);
export const IconSort = makeIcon('Sort', [
  p('M7 4v16', 'a'),
  p('M4 17l3 3 3-3', 'b'),
  p('M14 7h6', 'c'),
  p('M14 12h4', 'd'),
  p('M14 17h2', 'e'),
]);
