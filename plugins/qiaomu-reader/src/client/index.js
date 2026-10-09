import { LIBRARY_MESSAGES } from '../ui/library-locale.js';
/**
 * 乔木阅读 · 客户端半入口（bootstrap）
 *
 * 这是 esbuild 的打包入口，产物被包成 DSH 的懒加载模块外壳后成为 `client.js`。
 * 它只做三件事：
 *   1. 创建数据面（书库 / 状态 / 阅读引擎）与 UI store；
 *   2. 把阅读主面板注册到 `main`，把入口按钮注册到 `sidebar.panellist`；
 *   3. 把一切资源登记成 `ctx.effect`，插件卸载时干净回收。
 *
 * 不 import 任何 DSH 客户端包：只依赖平台种子表里的 `react`。
 */
import * as React from 'react';

import { createDataLayer } from './bridge.js';
import { remoteHostApi } from './host-api.js';
import { createUiStore } from '../ui/store.js';
import * as ShellModule from '../ui/shell.js';
import { parseHighlightLink } from '../core/backlink.js';
import { nativeChatBridge, NativeConversation } from './native-chat.js';

/** 注册 id / 命名空间，slot 与 locale 都用它。 */
const ID = 'qiaomu-reader';
const NS = 'qiaomu-reader';
const remoteCodec = () => ({
  mode: 'strict', typeSymbol: 'qiaomu-reader-dsh#json',
  create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
});
const REMOTE = {
  package: 'qiaomu-reader-dsh',
  descriptors: ['info', 'library', 'importBook', 'removeBook', 'loadState', 'saveState', 'readBookBytes', 'highlights', 'exportNotes', 'setReadingContext'].map((method) => ({
    id: `qiaomu-reader-dsh#qiaomuReader/${method}`,
    service: 'qiaomuReader', namespace: 'qiaomuReader', method,
    invocation: { kind: 'direct' },
    parameters: ['info', 'library'].includes(method) ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: remoteCodec() }],
    result: { mode: 'src-json' }, cancellation: { parameter: 'signal' },
  })),
};

/** Slot 是必要服务；locale 在下方通过子上下文按需注入。 */
export const inject = ['slots', 'layout', 'remote'];

/**
 * 从 UI 模块里取组件，兼容几种常见导出名，
 * 取不到时返回一个「可读的诊断组件」而不是 undefined——绝不让 slot 崩掉。
 * @param {object} module - UI 模块导出对象。
 * @param {string[]} names - 候选导出名。
 * @param {string} label - 诊断文案里用的模块名。
 * @returns {Function} React 组件。
 */
function pickComponent(module, names, label) {
  for (const name of names) {
    if (typeof module?.[name] === 'function') return module[name];
  }
  const Missing = () =>
    React.createElement(
      'div',
      { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #d33)' } },
      `乔木阅读：${label} 没有导出预期的组件（找过 ${names.join(' / ')}）。请检查构建产物。`,
    );
  Missing.displayName = `QmrMissing(${label})`;
  return Missing;
}

/**
 * 客户端插件主体。
 * @param {object} ctx - 客户端根上下文，至少含 slots / locale / effect。
 */
export function apply(ctx) {
  // 数据面：宿主半能连上就连，连不上退化为「内置书 + 浏览器缓存」。
  const data = createDataLayer();
  const chatApi = nativeChatBridge(ctx);

  // UI 状态容器：全屏浮层的可见性、当前书、当前面板都住在这里。
  const store = createUiStore({
    visible: false,
    view: 'library',
    bookId: null,
    panel: null,
    searchQuery: '',
    selection: null,
    notice: null,
    lastError: '',
    openSignal: 0,
  });

  /** 打开浮层的唯一入口：把可见性与打开信号一起推给 UI。 */
  function openReader(bookId = null) {
    ctx.layout.selectPanel(ID);
    const current = store.get();
    store.set({
      visible: true,
      openSignal: (current.openSignal ?? 0) + 1,
      bookId: bookId ?? current.bookId,
      view: bookId === null && current.bookId === null ? 'library' : current.view,
    });
  }

  /** 关闭浮层。 */
  function closeReader() {
    store.set({ visible: false, panel: null, selection: null });
    ctx.layout.selectPanel(null);
  }

  ctx.effect(() => {
    const onClick = (event) => {
      const anchor = event.target?.closest?.('a[href]');
      const target = parseHighlightLink(anchor?.getAttribute('href'));
      if (!target) return;
      event.preventDefault();
      ctx.layout.selectPanel(ID);
      store.set({ visible: true, jumpTarget: target });
    };
    globalThis.addEventListener?.('click', onClick, true);
    return () => globalThis.removeEventListener?.('click', onClick, true);
  }, 'qiaomu-reader: Markdown 划线回跳');

  /**
   * 供 UI 直接调用的一组动作。
   *
   * 形状与 `src/ui/shell.js` 期望的 `actions` 一致：全部 async，
   * 失败返回 `{ ok: false, error }` 而不是抛异常，UI 只要显示 error 即可。
   * @returns {object} 动作集合。
   */
  function createActions() {
    return {
      /** 重新拉取书库。 */
      async refreshLibrary() {
        try {
          await data.refreshLibrary();
          const status = data.getStatus();
          store.set({ lastError: status.error ?? '' });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          store.set({ lastError: message });
          return { ok: false, error: message };
        }
      },

      /** 打开一本书：解析 + 建引擎；成功后把 bookId 写进 store。 */
      async openBook(bookId) {
        store.set({ lastError: '' });
        try {
          await data.openBook(bookId);
          store.set({ bookId, view: 'reader', panel: null, selection: null });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          store.set({ lastError: message, view: 'library' });
          return { ok: false, error: message };
        }
      },

      /** 读取书籍字节（导入流程与「重新解析」用）。 */
      async readBook(bookId) {
        try {
          const record = await data.openBook(bookId);
          return { ok: true, bytes: record.bytes };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      /** 导入一个用户选择的文件。 */
      async importBook(file) {
        try {
          const result = await data.importBook(file);
          if (result.ok === true) {
            store.set({ lastError: '', notice: `已导入《${result.book.title}》` });
            return { ok: true, book: result.book };
          }
          store.set({ lastError: result.error ?? '导入失败' });
          return { ok: false, error: result.error ?? '导入失败' };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          store.set({ lastError: message });
          return { ok: false, error: message };
        }
      },

      /** 删除一本书。 */
      async removeBook(bookId) {
        try {
          const result = await data.removeBook(bookId);
          if (result.ok !== true) return { ok: false, error: result.error ?? '删除失败' };
          const current = store.get();
          if (current.bookId === bookId) store.set({ bookId: null, view: 'library' });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      /** 持久化阅读状态（进度 / 划线 / 设置都由它落盘）。 */
      async saveState(bookId, nextState) {
        try {
          data.persistState(bookId, nextState);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      /** 导出 Markdown 阅读笔记。 */
      async exportNotes(bookId) {
        try {
          const result = await data.exportNotes(bookId);
          return { ok: true, markdown: result.markdown };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      /** 关闭浮层。 */
      close() {
        closeReader();
        return { ok: true };
      },

      /** 打开浮层（侧栏按钮与快捷键共用）。 */
      open(bookId = null) {
        openReader(bookId);
        return { ok: true };
      },
    };
  }

  /* ---- 全屏阅读浮层 ---- */
  const Overlay = pickComponent(ShellModule, ['ReaderOverlay', 'Shell', 'default'], 'src/ui/shell.js');
  const actions = createActions();

  /** 取某本书的阅读状态；未加载时先按需加载。 */
  async function stateOf(bookId) {
    try {
      return await data.ensureState(bookId);
    } catch {
      return data.primeState(bookId);
    }
  }

  /** 取某本书的阅读引擎；没打开过则返回 undefined（UI 会显示加载态）。 */
  function engineOf(bookId) {
    return data.getEngine(bookId);
  }

  function ReaderPanel(props) {
    React.useEffect(() => {
      store.set({ visible: true });
      return () => store.set({ visible: false, panel: null, selection: null });
    }, []);
    return React.createElement(Overlay, { ...props, embedded: true });
  }

  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: ID,
            locale: NS,
            children: { 'qiaomu-reader.chat': { kind: 'single', scope: 'session' } },
            /*
             * store 必须走 inject，不能写进注册选项：DSH 的 slot 注册只接受
             * **store handle**（`defineStore()` 产出的 `{ spec, create() }`），
             * 普通对象会被 resolveStore 当成 handle 调用 `handle.create()` 而崩。
             * 我们的 store 是自带的 `{get,set,subscribe,select}`，shell.js 通过
             * props.store 使用它，因此作为 inject 字段传入即可。
             */
            inject: () => ({
              store,
              /**
               * 书库与状态都通过**函数**取用，而不是在注册时取一次快照：
               * slot 的 inject 只在挂载时调用一次，快照会让预载完成后
               * 书库永远停在空数组。UI 每次渲染调用这些函数即可。
               */
              getBooks: () => data.getLibrary().books,
              getStatus: () => data.getStatus(),
              engineOf,
              progressOf: (bookId) => data.progressOf(bookId),
              stateOf,
              actions,
              data,
              chatApi,
            }),
          },
          ReaderPanel,
        ),
      ),
    'qiaomu-reader: 全屏阅读浮层',
  );

  ctx.effect(
    () => ctx.slots.inject('qiaomu-reader.chat', () =>
      ctx.slots.register({ name: 'qiaomu-reader.chat' }, NativeConversation)),
    'qiaomu-reader: Harness 原生伴读会话',
  );

  /*
   * 数据变化（预载完成、导入、删除、翻页存进度）都要让浮层重渲染：
   * store 是 slot 的订阅源，所以把数据层事件桥接到 store 上。
   */
  ctx.effect(() => {
    const unsubscribe = data.subscribe(() => {
      const current = store.get();
      store.set({ dataRevision: (current.dataRevision ?? 0) + 1 });
    });
    return () => unsubscribe();
  }, 'qiaomu-reader: 数据→UI 桥');

  /* ---- 侧栏入口按钮 ---- */
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: ID,
            order: 40,
            label: () => '乔木阅读',
          },
          BookIcon,
        ),
      ),
    'qiaomu-reader: 侧栏入口',
  );

  /* ---- 键盘快捷键：Cmd/Ctrl + Shift + R ---- */
  ctx.effect(() => {
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key !== 'R' && event.key !== 'r') return;
      const target = event.target;
      const tag = target?.tagName?.toLowerCase?.();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      event.preventDefault();
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === ID) closeReader();
      else openReader(null);
    };
    globalThis.addEventListener?.('keydown', onKeyDown, true);
    return () => globalThis.removeEventListener?.('keydown', onKeyDown, true);
  }, 'qiaomu-reader: 快捷键');

  /* ---- 本地化字典 ---- */
  // Cordis 的服务代理在属性读取时检查 inject，`ctx.locale?.` 也会抛错。
  // 子上下文等待语言服务就绪，并在服务或本插件卸载时回收字典。
  ctx.inject(['locale'], (child) => {
    return child.locale.register(NS, {
      zh: { open: '乔木阅读', library: '书库', reader: '阅读', themeWhite: '纯白', ...LIBRARY_MESSAGES.zh },
      en: { open: 'Qiaomu Reader', library: 'Library', reader: 'Reader', themeWhite: 'Pure white', ...LIBRARY_MESSAGES.en },
    });
  });

  // The panel remains usable while the host service mounts; once mounted,
  // imports, progress and Markdown notes use the same library as Agent tools.
  if (typeof ctx.remote?.$mount === 'function') {
    void ctx.remote.$mount(REMOTE).then(() => {
      let connected = false;
      const pending = setTimeout(() => {
        if (!connected) store.set({ lastError: '阅读界面已就绪，宿主书库连接仍未建立；导入内容目前只在本机缓存。' });
      }, 4000);
      ctx.effect(() => () => clearTimeout(pending), 'qiaomu-reader: Remote 连接诊断');
      ctx.inject(['remote.qiaomuReader'], (ready) => {
        connected = true;
        clearTimeout(pending);
        chatApi.bindReadingContext((request) => ready.remote.qiaomuReader.setReadingContext(request));
        void data.setHost(remoteHostApi(ready)).then(() => {
          store.set({ lastError: '' });
        }).catch((error) => {
          store.set({ lastError: `宿主书库连接失败：${error?.message || error}` });
          console.warn('[乔木阅读] 宿主书库连接失败', error);
        });
        return () => chatApi.bindReadingContext(null);
      });
    }).catch((error) => {
      store.set({ lastError: `阅读服务挂载失败：${error?.message || error}` });
      console.warn('[乔木阅读] Remote 挂载失败，继续使用本地书库', error);
    });
  } else store.set({ lastError: 'Harness 未提供 Remote 服务，导入内容只保存在本机缓存。' });

  /* ---- 首次预载：让书库在用户点开前就绪 ---- */
  ctx.effect(() => {
    let disposed = false;
    data
      .refreshLibrary()
      .then(() => {
        if (disposed) return;
        store.set({ dataRevision: (store.get().dataRevision ?? 0) + 1 });
      })
      .catch((error) => {
        if (disposed) return;
        store.set({ lastError: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      disposed = true;
    };
  }, 'qiaomu-reader: 预载书库');
}

/** 内联书本图标，避免依赖 UI 层。 */
function BookIcon({ size = 18 }) {
  return React.createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false, style: { display: 'block', flexShrink: 0 } },
    React.createElement('path', {
      d: 'M12 6.5C10.2 5 7.6 4.4 4.6 4.7v13.6c3-.3 5.6.3 7.4 1.8 1.8-1.5 4.4-2.1 7.4-1.8V4.7c-3-.3-5.6.3-7.4 1.8Z',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinejoin: 'round',
    }),
    React.createElement('path', { d: 'M12 6.5v13.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  );
}
