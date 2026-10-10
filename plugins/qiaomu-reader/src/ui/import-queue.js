/** Import progress and retained per-file outcomes for the current plugin instance. */
import * as React from 'react';
const h = React.createElement;
const text = (ui, key, values = {}) => ui.t(`catalog.queue.${key}`, key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

export function ImportQueueView({ ui, compact = false }) {
  const queue = ui.useSel((state) => state.importQueue);
  const [expanded, setExpanded] = React.useState(true);
  if (!queue?.items.length) return null;
  const counts = {};
  for (const item of queue.items) counts[item.status] = (counts[item.status] || 0) + 1;
  const active = queue.items.find((item) => item.status === 'processing');
  const done = queue.items.length - (counts.waiting || 0) - (counts.processing || 0);
  const summary = text(ui, 'summary', { done, total: queue.items.length, host: counts.host || 0, browser: counts.browser || 0, failed: counts.failed || 0, waiting: counts.waiting || 0, cancelled: counts.cancelled || 0 });
  const button = (key, onClick, disabled = false) => h('button', { type: 'button', className: 'qmr-btn qmr-btn-sm', onClick, disabled }, text(ui, key));
  if (compact) return h('div', { className: 'qmr-import-compact' },
    h('span', { role: 'status' }, text(ui, queue.mode), ' · ', summary), button('show', () => ui.backToLibrary()));
  return h('section', { className: 'qmr-import-queue', 'aria-label': text(ui, 'title') },
    h('div', { className: 'qmr-import-head' },
      h('button', { type: 'button', className: 'qmr-import-toggle', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, text(ui, 'title'), ' · ', text(ui, queue.mode)),
      h('div', { className: 'qmr-actions' },
        queue.mode === 'running' ? button('stop', () => ui.stopImports()) : null,
        ['paused', 'stopping'].includes(queue.mode) ? button('resume', () => ui.resumeImports()) : null,
        button('retryAll', () => ui.retryFailedImports(), !counts.failed),
        button('clear', () => ui.clearImports(), done === 0))),
    h('div', { className: 'qmr-import-summary', role: 'status', 'aria-live': 'polite' }, summary),
    h('progress', { className: 'qmr-import-progress', max: queue.items.length, value: done, 'aria-label': text(ui, 'progress') }),
    active ? h('div', { className: 'qmr-import-current', title: active.filename }, text(ui, 'current', { name: active.filename })) : null,
    h('div', { className: 'qmr-muted qmr-small' }, text(ui, 'lifetime')),
    expanded ? h('div', { className: 'qmr-import-list', role: 'list' }, queue.items.map((item) => h('div', { key: item.id, className: 'qmr-import-item', role: 'listitem' },
      h('div', { className: 'qmr-import-copy' },
        h('span', { className: 'qmr-import-filename', title: item.filename }, item.filename),
        h('span', { className: 'qmr-muted qmr-small' }, text(ui, item.status), item.existing ? ` · ${text(ui, 'existing')}` : '', item.attempts ? ` · ${text(ui, 'attempts', { count: item.attempts })}` : ''),
        item.error || item.warning ? h('span', { className: 'qmr-import-message' }, item.error || item.warning) : null),
      item.status === 'waiting' ? button('cancel', () => ui.cancelImport(item.id)) : null,
      item.status === 'failed' ? button('retry', () => ui.retryImport(item.id)) : null,
      item.status === 'browser' ? button('saveHost', () => ui.retryImport(item.id)) : null))) : null);
}
