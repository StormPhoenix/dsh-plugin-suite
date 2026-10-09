/**
 * 浮层外壳：全屏 ReaderOverlay + ErrorBoundary + 主题样式注入 + 视图装配。
 *
 * 关键行为（对齐 lead 的最终契约）：
 * - store 由 lead 通过 slot 注入；本组件复用同一实例（读写一致），可见性读 store.visible。
 * - visible=false 时直接返回 null（浮层默认隐藏），但快捷键监听仍然生效。
 * - 任何渲染异常都被 ErrorBoundary 接住，渲染一行可读错误 + 「重试」。
 */
import * as React from 'react';
import { createUiStore } from './store.js';
import { useUiStore } from './hooks.js';
import { StyleSheet } from './theme.js';
import { createController } from './controller.js';
import { IconClose, IconRetry } from './icons.js';
import { setUiHost } from './format.js';
import { LibraryView } from './library.js';
import { ReaderView } from './reader.js';

const h = React.createElement;

/** 初始 UI 状态（lead 的 store 缺失时兜底） */
const INITIAL_STATE = Object.freeze({
  visible: false,
  view: 'library',
  bookId: null,
  panel: null,
  states: {},
});

/**
 * 错误边界：捕获子树渲染异常，显示可读错误行与重试按钮。
 */
export class ReaderErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    try {
      if (typeof this.props.onError === 'function') this.props.onError(error);
    } catch (_ignored) {
      /* 忽略 */
    }
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const error = this.state.error;
    if (error) {
      const text = String((error && error.message) || error || '未知错误');
      return h(
        'div',
        { className: 'qmr-root' },
        h(
          'div',
          { className: 'qmr-errorbox', role: 'alert' },
          h('div', { className: 'qmr-errorbox-title' }, '阅读器界面出错'),
          h('div', { className: 'qmr-errorbox-text' }, text),
          h(
            'div',
            { className: 'qmr-hl-tools' },
            h('button', {
              type: 'button',
              className: 'qmr-btn qmr-btn-primary qmr-btn-sm',
              onClick: this.reset,
            }, h(IconRetry, { width: 14, height: 14 }), '重试'),
            typeof this.props.onClose === 'function'
              ? h('button', {
                type: 'button',
                className: 'qmr-btn qmr-btn-sm',
                onClick: this.props.onClose,
              }, '关闭')
              : null,
          ),
        ),
      );
    }
    return this.props.children;
  }
}

/** 判断是否像 UI store */
function looksLikeStore(value) {
  return !!value
    && typeof value.get === 'function'
    && typeof value.set === 'function'
    && typeof value.subscribe === 'function';
}

/**
 * 全屏浮层组件（注册到 shell.overlay slot）。
 * @param {object} props slot 注入的 props（含 store / useStore / t / actions / getBooks / getStatus / stateOf / engineOf / progressOf）
 * @returns {React.ReactElement|null}
 */
export function ReaderOverlay(props) {
  const injectedStore = props && looksLikeStore(props.store) ? props.store : null;
  const fallbackStore = React.useMemo(() => createUiStore({ ...INITIAL_STATE }), []);
  const store = injectedStore || fallbackStore;

  const propsRef = React.useRef(props);
  propsRef.current = props;

  const ui = React.useMemo(() => createController(() => propsRef.current, store), [store]);

  // 读取：优先用 slot 注入的 useStore，否则用本地订阅 hook
  const injectedUseStore = props && typeof props.useStore === 'function' ? props.useStore : null;
  const useSel = React.useCallback(
    (selector) => (injectedUseStore ? injectedUseStore(selector) : useUiStore(store, selector)),
    [injectedUseStore, store],
  );
  // 子组件通过 ui.useSel 订阅 store（在各自组件内调用，hook 顺序稳定）
  ui.useSel = useSel;

  const visible = useSel((state) => state.visible);
  const view = useSel((state) => state.view) || 'library';
  const bookId = useSel((state) => state.bookId);
  const notice = useSel((state) => state.notice);
  const noticeKind = useSel((state) => state.noticeKind);
  const lastError = useSel((state) => state.lastError);
  const openSignal = useSel((state) => state.openSignal);
  const jumpTarget = useSel((state) => state.jumpTarget);

  const overlayRef = React.useRef(null);
  const lastSignalRef = React.useRef(openSignal);
  const handledBookRef = React.useRef(null);
  const initialHandledRef = React.useRef(false);

  // 把浮层根节点交给控制器（全屏用）与剪贴板/下载的临时宿主（避免写 document.body）。
  // 用 callback ref 而不是 useEffect：visible 从 false 变 true 时挂载/卸载都会立即同步。
  const setOverlayNode = React.useCallback((element) => {
    overlayRef.current = element;
    try {
      ui.attachOverlay(element);
      setUiHost(element);
    } catch (_error) {
      /* 忽略 */
    }
  }, [ui]);

  // openSignal：lead 请求打开阅读器
  React.useEffect(() => {
    if (openSignal === undefined || openSignal === null) return;
    if (lastSignalRef.current === openSignal) return;
    lastSignalRef.current = openSignal;
    const state = store.get();
    if (state.view === 'reader' && state.bookId != null && String(state.bookId) !== handledBookRef.current) {
      handledBookRef.current = String(state.bookId);
      ui.openBook(state.bookId);
      return;
    }
    handledBookRef.current = null;
    ui.openLibrary();
  }, [openSignal, store, ui]);

  // initialBookId：挂载时直接打开指定书
  React.useEffect(() => {
    if (initialHandledRef.current) return;
    const initialBookId = propsRef.current && propsRef.current.initialBookId;
    if (!initialBookId) {
      initialHandledRef.current = true;
      return;
    }
    initialHandledRef.current = true;
    handledBookRef.current = String(initialBookId);
    ui.openBook(initialBookId);
  }, [ui]);

  React.useEffect(() => {
    if (!jumpTarget) return undefined;
    let cancelled = false;
    (async () => {
      const ok = await ui.openBook(jumpTarget.bookId);
      if (!cancelled && ok) ui.focusHighlight(jumpTarget.bookId, jumpTarget.highlightId);
      if (!cancelled) store.set({ jumpTarget: null });
    })();
    return () => { cancelled = true; };
  }, [jumpTarget, store, ui]);

  // Esc：选中 → 面板 → 阅读器 → 浮层
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      const state = store.get();
      if (!state.visible) return;
      const target = event.target;
      // Let the catalogue menu consume Escape before closing the reader shell.
      if (target?.closest?.('.qmr-book-more')?.querySelector('[aria-expanded="true"]')) return;
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (inField && state.panel === 'search') return; // 搜索面板自己处理
      if (state.selection) {
        ui.clearSelection();
        return;
      }
      if (state.panel) {
        if (state.panel === 'search') ui.closeSearch();
        else ui.setPanel(null);
        return;
      }
      if (state.view === 'reader') {
        ui.backToLibrary();
        return;
      }
      ui.closeOverlay();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [store, ui]);

  if (!visible && !props.embedded) return null;

  const errorBar = lastError
    ? h(
      'div',
      { className: 'qmr-errorbar', role: 'alert' },
      h('span', null, String(lastError)),
      h('button', {
        type: 'button',
        className: 'qmr-icon-btn',
        'aria-label': '关闭错误提示',
        onClick: () => ui.clearError(),
      }, h(IconClose, { width: 14, height: 14 })),
    )
    : null;

  const content = view === 'reader' && bookId != null
    ? h(ReaderView, { ui, chatApi: props.chatApi, SessionProvider: props.SessionProvider, renderSlot: props.renderSlot })
    : h(LibraryView, { ui });

  return h(
    'div',
    {
      className: props.embedded ? 'qmr-overlay qmr-embedded' : 'qmr-overlay',
      ref: setOverlayNode,
      role: props.embedded ? 'region' : 'dialog',
      'aria-modal': props.embedded ? undefined : 'true',
      'aria-label': '乔木阅读',
      'data-qmr-view': view,
    },
    h(StyleSheet, null),
    errorBar,
    h(
      ReaderErrorBoundary,
      { onError: (error) => ui.reportError(error, true), onClose: () => ui.closeOverlay() },
      h('div', { className: 'qmr-root' }, content,
        notice ? h('div', { className: `qmr-toast is-${noticeKind || 'info'}` }, String(notice)) : null),
    ),
  );
}

export default ReaderOverlay;
