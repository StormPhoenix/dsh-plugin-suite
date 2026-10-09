/** Reuse Harness's session, composer, model picker, tool and approval UI. */
export function nativeChatBridge(ctx) {
  let scope;
  let readingContextMethod;
  const watchers = new Set();
  ctx.inject(['sessions', 'uiSession', 'uiWorkspace'], (child) => {
    scope = child;
    for (const notify of watchers) notify();
    return () => { scope = undefined; for (const notify of watchers) notify(); };
  });
  return {
    bindReadingContext(method) { readingContextMethod = method; },
    async setReadingContext(request) {
      if (typeof readingContextMethod !== 'function') throw new Error('乔木阅读上下文服务尚未就绪');
      const result = await readingContextMethod(request);
      if (!result?.ok) throw result?.error || new Error('更新阅读上下文失败');
    },
    defaultWorkspace() {
      const items = scope?.uiWorkspace.workspaces.list.getSnapshot().items ?? [];
      const preferred = items.find((item) => item.title === 'default-workspace' || /(?:^|\/)default-workspace$/.test(item.path || ''));
      return (preferred ?? items[0])?.workspaceId;
    },
    watchWorkspaces(listener) {
      watchers.add(listener);
      const unsubscribe = scope?.uiWorkspace.workspaces.list.subscribe(listener) ?? (() => {});
      return () => { watchers.delete(listener); unsubscribe(); };
    },
    async openChat({ workspaceId, sessionId }) {
      if (!scope) throw new Error('Harness 对话服务尚未就绪');
      const active = scope;
      if (!active.uiWorkspace.workspaces.list.getSnapshot().items.some((item) => item.workspaceId === workspaceId)) throw new Error('请选择工作区');
      const id = sessionId || await active.sessions.create({ workspaceId });
      const reference = active.sessions.retain(id, { source: 'qiaomu-reader' });
      try {
        const source = active.uiSession.bindingSource(reference);
        const actions = source.value.props.inputActions;
        const input = source.value.hooks?.input;
        if (typeof actions?.setDraft !== 'function' || typeof actions.submit !== 'function' || typeof input?.getSnapshot !== 'function' || typeof input?.subscribe !== 'function') throw new Error('当前 Harness 版本不支持原生伴读');
        const ensurePlain = (allowedDraft = '') => {
          const state = input.getSnapshot();
          if (state.phase !== 'plain') throw new Error('对话正在处理消息，请稍后重试');
          if (state.attachmentIds?.length) throw new Error('输入框有待发送附件，请先处理');
          if (state.draft.trim() && state.draft.trim() !== allowedDraft.trim()) throw new Error('输入框已有草稿，请先发送或清空');
        };
        const setPrompt = async (prompt, allowedDraft = '') => {
          ensurePlain(allowedDraft);
          actions.setDraft(prompt);
          if (input.getSnapshot().draft !== prompt) await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { unsubscribe(); reject(new Error('提示词已放入输入框，请手动发送')); }, 1200);
            const unsubscribe = input.subscribe(() => {
              if (input.getSnapshot().draft === prompt) { clearTimeout(timeout); unsubscribe(); resolve(); }
            });
          });
        };
        return { sessionId: id, reference, release: () => reference.release(),
          setDraft: setPrompt,
          insertContext(prompt) {
            if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') throw new Error('当前 Harness 版本不支持插入引用');
            const span = actions.captureInsertion();
            if (!actions.insertText(prompt + '\n\n', span)) throw new Error('输入框正在发送，请稍后重试');
          },
          submitPrompt: async (prompt, allowedDraft = '') => { await setPrompt(prompt, allowedDraft); if (input.getSnapshot().phase !== 'plain') throw new Error('输入框正在处理消息'); actions.submit(); },
        };
      } catch (error) { reference.release(); throw error; }
    },
  };
}

function ChatView({ renderSlot }) { return renderSlot('conversation.session', { view: 'chat' }); }
export function NativeConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession((value) => value);
  const conversation = useConversation((value) => value);
  const blank = useSessions((value) => value.byId[sessionId]?.blank);
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running;
  const settling = !active && session.openState === 'loading' && blank !== true;
  const hero = !active && (session.openState === 'open' || blank === true);
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }, { slots: { views: ChatView } });
}
