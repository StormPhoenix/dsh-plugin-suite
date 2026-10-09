/** Browser-to-host data API over Harness Typert Remote. */
export function remoteHostApi(ctx) {
  const call = async (name, request) => {
    const method = ctx.remote?.qiaomuReader?.[name];
    if (typeof method !== 'function') throw new Error('乔木阅读宿主书库未就绪');
    const result = request === undefined ? await method() : await method(request);
    if (result?.ok) return result.value;
    throw result?.error || new Error(`乔木阅读宿主调用失败：${name}`);
  };
  return {
    info: () => call('info'),
    library: () => call('library'),
    import: (request) => call('importBook', request),
    remove: (bookId) => call('removeBook', { bookId }),
    loadState: (bookId) => call('loadState', { bookId }),
    saveState: (bookId, state) => call('saveState', { bookId, state }),
    readBookBytes: (bookId) => call('readBookBytes', { bookId }),
    highlights: (bookId) => call('highlights', { bookId }),
    exportNotes: (bookId) => call('exportNotes', { bookId }),
  };
}
