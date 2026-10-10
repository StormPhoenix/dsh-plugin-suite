/** Plugin-owned, single-worker import queue. Files survive page switches, not reloads. */
export function createImportQueue({ importBook, publish }) {
  let items = [];
  let mode = 'idle';
  let disposed = false;
  let worker = null;
  let sequence = 0;
  const retained = new Map();
  const terminal = (status) => !['waiting', 'processing'].includes(status);
  const snapshot = () => ({ mode, items: items.map((item) => ({ ...item })) });
  const emit = () => { if (!disposed) publish(snapshot()); };

  async function run() {
    while (!disposed && mode === 'running') {
      const item = items.find((entry) => entry.status === 'waiting');
      if (!item) { mode = 'idle'; break; }
      item.status = 'processing';
      item.attempts += 1;
      emit();
      let result;
      try { result = await importBook(retained.get(item.id)); }
      catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      if (disposed) return;
      if (!result?.ok) {
        item.status = 'failed';
        item.error = result?.error || 'Import failed';
      } else {
        item.status = result.storage === 'browser' ? 'browser' : 'host';
        item.bookId = result.book?.id;
        item.title = result.book?.title;
        item.existing = result.existing === true;
        item.warning = result.warning || result.hostError || '';
        item.error = '';
        if (item.status === 'host') retained.delete(item.id);
      }
      if (mode === 'stopping') mode = 'paused';
      emit();
    }
  }

  function start() {
    if (disposed || worker || mode !== 'running') return;
    // Schedule before executing so reentrant commands cannot start another worker.
    worker = Promise.resolve().then(run).finally(() => {
      worker = null;
      if (disposed) return;
      if (mode === 'running' && items.some((item) => item.status === 'waiting')) start();
      else if (mode === 'running') mode = 'idle';
      emit();
    });
  }

  function enqueue(files) {
    if (disposed) return;
    for (const file of files) {
      const id = `import-${++sequence}`;
      items.push({ id, filename: file.name, size: file.size, status: 'waiting', attempts: 0, error: '', warning: '' });
      retained.set(id, file);
    }
    if (mode === 'idle' && items.some((item) => item.status === 'waiting')) mode = 'running';
    emit();
    start();
  }

  function retry(ids) {
    if (disposed) return;
    const selected = new Set(ids);
    const retrying = items.filter((item) => selected.has(item.id) && ['failed', 'browser'].includes(item.status) && retained.has(item.id));
    for (const item of retrying) {
      item.status = 'waiting'; item.error = ''; item.warning = '';
    }
    const moved = new Set(retrying.map((item) => item.id));
    items = [...items.filter((item) => !moved.has(item.id)), ...retrying];
    if (mode === 'idle' && retrying.length) mode = 'running';
    emit(); start();
  }

  return {
    enqueue,
    retry,
    retryFailed() { retry(items.filter((item) => item.status === 'failed').map((item) => item.id)); },
    stop() {
      if (disposed || mode !== 'running') return;
      mode = items.some((item) => item.status === 'processing') ? 'stopping' : 'paused';
      emit();
    },
    resume() {
      if (disposed || !['paused', 'stopping'].includes(mode)) return;
      mode = 'running'; emit(); start();
    },
    cancel(id) {
      if (disposed) return;
      const item = items.find((entry) => entry.id === id);
      if (item?.status !== 'waiting') return;
      item.status = 'cancelled'; retained.delete(id); emit();
    },
    clear() {
      if (disposed) return;
      for (const item of items.filter((entry) => terminal(entry.status))) retained.delete(item.id);
      items = items.filter((item) => !terminal(item.status)); emit();
    },
    snapshot,
    hasPending() { return items.some((item) => ['waiting', 'processing'].includes(item.status)); },
    dispose() { disposed = true; mode = 'paused'; retained.clear(); items = []; },
    /** Wait for the current worker; primarily useful for deterministic consumers and tests. */
    async settled() { while (worker) await worker; },
  };
}
