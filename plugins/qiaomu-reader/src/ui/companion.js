import * as React from 'react';
import { createPortal } from 'react-dom';
import { IconClose, IconPlus } from './icons.js';
import { readQuickPrompts } from './quick-prompts.js';

const h = React.createElement;

export function CompanionPanel({ ui, bookId, chapterIndex, engine, chatApi, SessionProvider, renderSlot }) {
  const book = ui.bookOf(bookId);
  const selection = ui.useSel((state) => state.companionSelection);
  const [workspaceId, setWorkspaceId] = React.useState(() => chatApi?.defaultWorkspace?.());
  const [chat, setChat] = React.useState(null);
  const [chatBookId, setChatBookId] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [pageText, setPageText] = React.useState('');
  const [pageReady, setPageReady] = React.useState(false);
  const [attached, setAttached] = React.useState('');
  const [prompts, setPrompts] = React.useState(readQuickPrompts);
  const [promptMount, setPromptMount] = React.useState(null);
  const [sendingPrompt, setSendingPrompt] = React.useState(false);
  const generation = React.useRef(0);
  const owned = React.useRef(null);
  const chatRoot = React.useRef(null);
  const sending = React.useRef(false);
  const insertedQuote = React.useRef('');
  const insertedQuoteText = React.useRef('');
  const contextQueue = React.useRef(Promise.resolve());
  const shownChat = React.useRef(false);
  const chapter = engine?.book?.chapters?.[chapterIndex]?.label || `第 ${chapterIndex + 1} 章`;
  const sourceLabel = `${[book?.title || '未命名', chapter !== book?.title ? chapter : ''].filter(Boolean).join(' · ')}${selection?.text ? ' · 选段已关联' : ''}`;

  React.useEffect(() => {
    if (workspaceId || !chatApi) return undefined;
    return chatApi.watchWorkspaces?.(() => setWorkspaceId(chatApi.defaultWorkspace?.()));
  }, [workspaceId, chatApi]);
  React.useEffect(() => {
    let cancelled = false;
    setPageText('');
    setPageReady(false);
    Promise.resolve(engine?.plainTextOf?.(chapterIndex)).then((text) => { if (!cancelled) { setPageText(String(text || '')); setPageReady(true); } }).catch(() => { if (!cancelled) setPageReady(true); });
    return () => { cancelled = true; };
  }, [engine, chapterIndex]);
  React.useEffect(() => () => { generation.current += 1; owned.current?.release(); owned.current = null; }, []);
  React.useEffect(() => {
    const reload = () => setPrompts(readQuickPrompts());
    window.addEventListener('qmr-prompts-changed', reload);
    return () => window.removeEventListener('qmr-prompts-changed', reload);
  }, []);

  const start = React.useCallback(async (fresh = false) => {
    if (!workspaceId || !chatApi) return;
    const token = ++generation.current;
    setBusy(true);
    setError('');
    let acquired;
    try {
      const key = `qmr.chat.${workspaceId}.${bookId}`;
      const saved = fresh ? null : localStorage.getItem(key);
      try { acquired = await chatApi.openChat({ workspaceId, sessionId: saved || undefined }); }
      catch (cause) {
        if (!saved) throw cause;
        localStorage.removeItem(key);
        acquired = await chatApi.openChat({ workspaceId });
      }
      if (token !== generation.current) { acquired.release(); return; }
      owned.current?.release();
      owned.current = acquired;
      insertedQuote.current = '';
      insertedQuoteText.current = '';
      setAttached('');
      shownChat.current = false;
      setChatBookId(bookId);
      setChat(acquired);
      localStorage.setItem(key, acquired.sessionId);
      acquired = null;
    } catch (cause) {
      acquired?.release();
      if (token === generation.current) setError(cause?.message || String(cause));
    } finally { if (token === generation.current) setBusy(false); }
  }, [bookId, chatApi, workspaceId]);

  React.useEffect(() => { if (workspaceId) void start(); }, [workspaceId, bookId, start]);

  const contextKey = `${bookId}|${chapterIndex}|${selection?.text || ''}|${pageText}`;
  const chatVisible = !!chat && chatBookId === bookId && (shownChat.current || attached === contextKey);
  React.useEffect(() => {
    if (!chat || chatBookId !== bookId || !pageReady) return undefined;
    let cancelled = false;
    setAttached('');
    const request = {
      sessionId: chat.sessionId, title: book?.title || '', author: book?.author || '',
      chapter, page: pageText, selection: selection?.text || '',
    };
    contextQueue.current = contextQueue.current.catch(() => {}).then(async () => {
      if (cancelled) return;
      await chatApi.setReadingContext(request);
      if (!cancelled) { setAttached(contextKey); setError(''); }
    }).catch((cause) => { if (!cancelled) setError(`阅读上下文未关联：${cause?.message || String(cause)}`); });
    return () => { cancelled = true; };
  }, [chat, chatApi, chatBookId, contextKey, pageReady]);

  React.useEffect(() => {
    if (!chatVisible || attached !== contextKey || !selection?.text || !selection.id) return;
    const id = `${chat.sessionId}:${selection.id}`;
    if (insertedQuote.current === id) return;
    try {
      const excerpt = selection.text.replace(/\s+/g, ' ').trim();
      const preview = excerpt.length > 110 ? `${excerpt.slice(0, 110).trimEnd()}…` : excerpt;
      const quoteDraft = `引用选段：「${preview}」`;
      chat.insertContext(quoteDraft);
      insertedQuote.current = id;
      insertedQuoteText.current = quoteDraft;
    } catch (cause) { setError(`选文未加入输入框：${cause?.message || String(cause)}`); }
  }, [chat, chatVisible, selection, attached, contextKey]);

  React.useEffect(() => {
    if (!chat || !SessionProvider) return undefined;
    const root = chatRoot.current;
    if (!root) return undefined;
    const mount = document.createElement('div');
    mount.className = 'qmr-companion-prompt-anchor';
    let placed = false;
    const place = () => {
      const seat = root.querySelector('[data-composer-seat]');
      if (!seat?.parentNode) return;
      if (mount.nextSibling !== seat) seat.parentNode.insertBefore(mount, seat);
      if (!placed) { placed = true; setPromptMount(mount); }
    };
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    place();
    return () => { observer.disconnect(); mount.remove(); setPromptMount(null); };
  }, [chat, SessionProvider, chatVisible]);

  const quick = async (item) => {
    if (!chatVisible || busy || sending.current || attached !== contextKey) return;
    sending.current = true;
    setSendingPrompt(true);
    setError('');
    try { await chat.submitPrompt(item.body, insertedQuoteText.current); insertedQuoteText.current = ''; }
    catch (cause) { setError(`快捷发送失败：${cause?.message || String(cause)}`); }
    finally { sending.current = false; setSendingPrompt(false); }
  };
  if (chatVisible) shownChat.current = true;

  return h('div', { className: 'qmr-companion' },
    h('div', { className: 'qmr-panel-head' },
      h('strong', { className: 'qmr-panel-title' }, 'AI 伴读'),
      h('span', { className: 'qmr-companion-source', title: sourceLabel }, sourceLabel),
      h('button', { type: 'button', className: 'qmr-icon-btn', title: '新伴读对话', 'aria-label': '新伴读对话', disabled: busy || !workspaceId, onClick: () => void start(true) }, h(IconPlus, { width: 16, height: 16 })),
      h('button', { type: 'button', className: 'qmr-icon-btn', title: '关闭伴读', 'aria-label': '关闭伴读', onClick: () => ui.setPanel(null) }, h(IconClose, { width: 16, height: 16 }))),
    error ? h('div', { className: 'qmr-companion-error', role: 'alert' }, error,
      h('button', { type: 'button', onClick: () => void start() }, '重试')) : null,
    !chatVisible && !error ? h('div', { className: 'qmr-busy' }, !workspaceId ? '正在连接默认工作区…' : !chat || chatBookId !== bookId ? '正在打开对话…' : '正在关联阅读上下文…') : null,
    chatVisible && SessionProvider && renderSlot
      ? h('div', { className: 'qmr-native-chat', ref: chatRoot }, h(SessionProvider, { session: chat.reference }, renderSlot('qiaomu-reader.chat', {})))
      : null,
    promptMount ? createPortal(h('div', { className: 'qmr-companion-prompts', role: 'group', 'aria-label': '快捷提示词' },
      h('div', { className: 'qmr-companion-prompt-scroll' }, prompts.map((item) => h('button', {
        key: item.id, type: 'button', title: item.body, 'aria-label': `直接发送：${item.title}`,
        disabled: sendingPrompt || busy || attached !== contextKey, onClick: () => void quick(item),
      }, item.title))),
      h('button', { type: 'button', className: 'qmr-companion-add-prompt', title: '新增快捷提示词', 'aria-label': '新增快捷提示词', onClick: () => ui.store.set({ promptManagerOpen: true }) }, h(IconPlus, { width: 14, height: 14 }))), promptMount) : null,
  );
}
