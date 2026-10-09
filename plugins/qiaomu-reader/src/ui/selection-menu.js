/**
 * 选中文字后的小工具条：四色划线 / 复制 / 写批注 / 取消。
 * 用 getBoundingClientRect() 的坐标定位（position: fixed），超出视口自动翻转/收拢。
 */
import * as React from 'react';
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_LABELS, highlightPaint } from './theme.js';
import { IconClose, IconCopy, IconHighlight, IconNote, IconSparkles } from './icons.js';

const h = React.createElement;

/**
 * 计算工具条位置（考虑视口翻转与左右收拢）。
 * @param {{top:number,left:number,width:number,height:number,bottom:number}} anchor 选区的视口坐标
 * @param {{width:number,height:number}} [size] 工具条自身尺寸
 * @returns {{left:number,top:number}}
 */
export function computeMenuPosition(anchor, size) {
  const width = Math.max(80, (size && size.width) || 250);
  const height = Math.max(28, (size && size.height) || 42);
  const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800;
  const center = (anchor.left || 0) + (anchor.width || 0) / 2;
  let left = center - width / 2;
  left = Math.min(Math.max(8, left), Math.max(8, viewportWidth - width - 8));
  let top = (anchor.top || 0) - height - 10;
  if (top < 8) top = (anchor.bottom || anchor.top || 0) + 10;
  if (top + height > viewportHeight - 8) top = Math.max(8, (anchor.top || 0) - height - 10);
  return { left, top };
}

/**
 * 选中小工具条。
 * @param {object} props
 * @param {object} props.ui 控制器
 * @param {{text:string,anchor:object,chapterHref:string,percent:number}} props.selection 选区信息
 * @param {(color:string)=>void} props.onHighlight 划线
 * @param {()=>void} props.onNote 写批注
 * @returns {React.ReactElement|null}
 */
export function SelectionMenu({ ui, selection, onHighlight, onNote, onAsk }) {
  const elementRef = React.useRef(null);
  const [position, setPosition] = React.useState(() => computeMenuPosition(selection.anchor));
  const themeId = ui.settingsOf(ui.useSel((state) => state.bookId)).theme;

  React.useLayoutEffect(() => {
    const element = elementRef.current;
    const size = element ? { width: element.offsetWidth, height: element.offsetHeight } : undefined;
    setPosition(computeMenuPosition(selection.anchor, size));
  }, [selection.anchor, selection.text]);

  if (!selection || !selection.anchor) return null;

  const swatches = HIGHLIGHT_COLORS.map((color) =>
    h('button', {
      key: color,
      type: 'button',
      className: 'qmr-swatch',
      style: { background: highlightPaint(themeId, color) },
      'aria-label': `${HIGHLIGHT_COLOR_LABELS[color]}色划线`,
      onClick: () => onHighlight(color),
    }));

  return h(
    'div',
    {
      ref: elementRef,
      className: 'qmr-selmenu',
      style: { left: position.left, top: position.top },
      role: 'toolbar',
      'aria-label': '选中文字操作',
      onMouseDown: (event) => event.preventDefault(),
    },
    h('span', { className: 'qmr-swatches', 'aria-label': '划线颜色' }, swatches),
    h('span', { className: 'qmr-selmenu-sep', 'aria-hidden': 'true' }),
    h('button', {
      type: 'button',
      className: 'qmr-selmenu-btn',
      'aria-label': '复制',
      onClick: () => ui.copy(selection.text),
    }, h(IconCopy, { width: 16, height: 16 })),
    h('button', {
      type: 'button',
      className: 'qmr-selmenu-btn',
      'aria-label': '写批注',
      onClick: () => onNote(),
    }, h(IconNote, { width: 16, height: 16 })),
    h('button', {
      type: 'button', className: 'qmr-selmenu-btn', 'aria-label': '问 AI',
      onClick: () => onAsk?.(),
    }, h(IconSparkles, { width: 16, height: 16 })),
    h('button', {
      type: 'button',
      className: 'qmr-selmenu-btn',
      'aria-label': '取消选中',
      onClick: () => ui.clearSelection(),
    }, h(IconClose, { width: 16, height: 16 })),
  );
}

/** 供阅读器复用的划线图标按钮（保持图标一致） */
export const HighlightActionIcon = IconHighlight;
