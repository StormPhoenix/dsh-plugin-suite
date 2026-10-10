/** Tag filtering and staged library editors; writes occur only on explicit confirmation. */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { LIBRARY_MESSAGES } from './library-locale.js';
import { IconClose } from './icons.js';
const h = React.createElement;
export const tagText = (ui, key, values = {}) => ui.t(`catalog.tags.${key}`, LIBRARY_MESSAGES.zh.catalog.tags[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
export const catalogOf = ui => ui.tagCatalog?.() || { tags: [], bookTags: {} };
export const editableTags = ui => ui.canEditTags?.() === true;
export function matchesTags(ids, selected, mode, untagged) {
  return untagged ? ids.length === 0 : !selected.length || (mode === 'all' ? selected.every(id => ids.includes(id)) : selected.some(id => ids.includes(id)));
}
const toggle = (ids, id) => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
const normalizedName = value => value.trim().normalize('NFC');
const nameKey = value => normalizedName(value).toLowerCase();
const nameError = (ui, name) => /\p{Cc}/u.test(name) ? tagText(ui, 'nameControls') : !normalizedName(name) ? tagText(ui, 'nameRequired') : [...normalizedName(name)].length > 40 ? tagText(ui, 'nameLong') : '';
const button = (ui, key, onClick, disabled = false, primary = false) => h('button', { type: 'button', className: `qmr-btn${primary ? ' qmr-tag-primary' : ''}`, onClick, disabled }, tagText(ui, key));

/** Stable finite palette assignment; duplicate colours are allowed for large catalogues. */
export function tagColor(id) {
  let hash = 0;
  for (const character of String(id)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return ['brand', 'success', 'warn', 'error', 'idle'][hash % 5];
}
export function TagChip({ tag, onClick, disabled = false, remove = false, label }) {
  const props = { className: 'qmr-tag-badge', 'data-tone': tagColor(tag.id), title: tag.name };
  return onClick ? h('button', { ...props, type: 'button', onClick, disabled, 'aria-label': label || tag.name }, tag.name, remove ? h('span', { 'aria-hidden': true }, ' ×') : null) : h('span', props, tag.name);
}

/** Portal-backed, keyboard-contained dialog that restores the invoking control on dismissal. */
export function TagOverlay({ ui, title, onClose, children, busy = false }) {
  const ref = React.useRef(null);
  const options = React.useRef({ busy, onClose });
  options.current = { busy, onClose };
  React.useEffect(() => {
    const previous = document.activeElement;
    const controls = () => [...(ref.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])];
    const list = controls(); (list.find(control => control.tagName === 'INPUT') || list[0])?.focus();
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!options.current.busy) options.current.onClose(); }
      if (event.key === 'Tab') {
        const list = controls(); const first = list[0]; const last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, []);
  const node = h('div', { className: 'qmr-tag-backdrop qmr-overlay', onPointerDown: event => { if (event.target === event.currentTarget && !busy) onClose(); } },
    h('section', { ref, className: 'qmr-tag-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title },
      h('header', { className: 'qmr-tag-heading' }, h('h2', null, title), h('button', { type: 'button', className: 'qmr-icon-btn', onClick: onClose, disabled: busy, 'aria-label': tagText(ui, 'close'), title: tagText(ui, 'close') }, h(IconClose, { width: 18, height: 18 }))), children));
  return typeof document !== 'undefined' && typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal(node, document.body) : node;
}

function TagChoices({ ui, tags, ids, setIds }) {
  const [query, setQuery] = React.useState('');
  const visible = tags.filter(tag => nameKey(tag.name).includes(nameKey(query)));
  return h(React.Fragment, null,
    h('input', { type: 'search', className: 'qmr-input', value: query, placeholder: tagText(ui, 'search'), 'aria-label': tagText(ui, 'search'), onChange: event => setQuery(event.target.value) }),
    h('div', { className: 'qmr-tag-choices' }, visible.length ? visible.map(tag => h('button', { key: tag.id, type: 'button', className: 'qmr-tag-choice-button', 'aria-pressed': ids.includes(tag.id), onClick: () => setIds(toggle(ids, tag.id)) },
      h('span', { 'aria-hidden': true }, ids.includes(tag.id) ? '✓' : '+'), h(TagChip, { tag }))) : h('p', { className: 'qmr-muted' }, tagText(ui, 'noneFound'))));
}
export function TagFilter({ ui, ids, mode, untagged, onClose }) {
  const { tags } = catalogOf(ui);
  return h(TagOverlay, { ui, title: tagText(ui, 'filter'), onClose },
    h(TagChoices, { ui, tags, ids, setIds: values => ui.store.set({ libraryTagIds: values, libraryUntagged: false }) }),
    h('label', { className: 'qmr-tag-choice' }, h('input', { type: 'checkbox', checked: untagged, onChange: event => ui.store.set({ libraryUntagged: event.target.checked, libraryTagIds: [] }) }), tagText(ui, 'untagged')),
    h('label', { className: 'qmr-tag-choice' }, tagText(ui, 'match'), h('select', { className: 'qmr-select', value: mode, disabled: untagged, onChange: event => ui.store.set({ libraryTagMode: event.target.value }) },
      h('option', { value: 'any' }, tagText(ui, 'any')), h('option', { value: 'all' }, tagText(ui, 'all')))),
    h('footer', { className: 'qmr-actions' }, button(ui, 'clearTags', () => ui.store.set({ libraryTagIds: [], libraryUntagged: false })), button(ui, 'done', onClose)));
}
export function BookTagChips({ ui, bookId }) {
  const { tags, bookTags } = catalogOf(ui);
  const assigned = tags.filter(tag => (bookTags[bookId] || []).includes(tag.id));
  return assigned.length ? h('span', { className: 'qmr-book-tags', title: assigned.map(tag => tag.name).join(' · ') },
    assigned.slice(0, 2).map(tag => h(TagChip, { key: tag.id, tag })),
    assigned.length > 2 ? h('span', { className: 'qmr-tag-badge', 'aria-label': tagText(ui, 'moreTags', { count: assigned.length - 2 }) }, `+${assigned.length - 2}`) : null) : null;
}
export function BookTagEditor({ ui, bookIds, mode, onClose, onSuccess }) {
  const { tags, bookTags } = catalogOf(ui);
  const candidates = mode === 'remove' ? tags.filter(tag => bookIds.some(id => (bookTags[id] || []).includes(tag.id))) : tags;
  const [ids, setIds] = React.useState(mode === 'replace' ? [...(bookTags[bookIds[0]] || [])] : []);
  const [names, setNames] = React.useState([]);
  const [query, setQuery] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const composing = React.useRef(false);
  const editable = editableTags(ui);
  const selectedTags = tags.filter(tag => ids.includes(tag.id));
  const visible = candidates.filter(tag => !ids.includes(tag.id) && nameKey(tag.name).includes(nameKey(query)));
  const exact = candidates.find(tag => nameKey(tag.name) === nameKey(query));
  const enter = event => {
    if (event.key !== 'Enter' || event.isComposing || composing.current || event.keyCode === 229) return;
    event.preventDefault();
    if (!editable || busy) return;
    const problem = nameError(ui, query);
    if (problem) { setError(problem); return; }
    if (exact) setIds(ids.includes(exact.id) ? ids : [...ids, exact.id]);
    else if (mode !== 'remove' && !names.some(name => nameKey(name) === nameKey(query))) setNames([...names, normalizedName(query)]);
    else if (mode === 'remove') { setError(tagText(ui, 'noneFound')); return; }
    setQuery(''); setError('');
  };
  const save = async () => {
    if (!editable || busy) return;
    if (mode !== 'remove' && query.trim()) { setError(tagText(ui, 'enterFirst')); return; }
    setBusy(true); setError('');
    try {
      const result = await ui.updateBookTags({ bookIds, tagIds: ids.filter(id => candidates.some(tag => tag.id === id)), operation: mode, ...(mode !== 'remove' && names.length ? { newTagNames: names } : {}) });
      if (!result.ok) { setError(tagText(ui, result.error === 'TAG_OFFLINE' ? 'offline' : 'failed')); return; }
      if (result.warning) ui.toast?.(tagText(ui, 'cacheWarning'), 'warn');
      onSuccess?.(); onClose();
    } catch (_error) { setError(tagText(ui, 'failed')); }
    finally { setBusy(false); }
  };
  const disabled = busy || !editable;
  const title = tagText(ui, mode === 'replace' ? 'edit' : mode === 'add' ? 'addTitle' : 'removeTitle', { count: bookIds.length });
  return h(TagOverlay, { ui, title, onClose, busy },
    mode !== 'replace' ? h('p', { className: 'qmr-muted' }, tagText(ui, mode === 'add' ? 'keepExisting' : 'removeHint')) : null,
    !editable ? h('p', { className: 'qmr-muted', role: 'status' }, tagText(ui, 'offline')) : null,
    ids.length || names.length ? h('div', { className: 'qmr-tag-selected' },
      selectedTags.map(tag => h(TagChip, { key: tag.id, tag, remove: true, disabled, label: tagText(ui, 'removeSelected', { name: tag.name }), onClick: () => setIds(ids.filter(id => id !== tag.id)) })),
      names.map(name => h(TagChip, { key: `new:${name}`, tag: { id: `new:${name}`, name }, remove: true, disabled, label: tagText(ui, 'removeSelected', { name }), onClick: () => setNames(names.filter(value => value !== name)) }))) : null,
    h('input', { type: 'text', className: 'qmr-input', value: query, disabled, placeholder: tagText(ui, mode === 'remove' ? 'removeInput' : 'input'), 'aria-label': tagText(ui, mode === 'remove' ? 'removeInput' : 'input'), onChange: event => { setQuery(event.target.value); setError(''); }, onKeyDown: enter, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; } }),
    mode !== 'remove' && query.trim() && !exact && !names.some(name => nameKey(name) === nameKey(query)) && !nameError(ui, query) ? h('p', { className: 'qmr-muted qmr-small' }, tagText(ui, 'createHint', { name: normalizedName(query) })) : null,
    h('span', { className: 'qmr-muted qmr-small' }, tagText(ui, 'existing')),
    h('div', { className: 'qmr-tag-choices' }, visible.length ? visible.map(tag => h(TagChip, { key: tag.id, tag, disabled, onClick: () => { setIds([...ids, tag.id]); setQuery(''); setError(''); } })) : h('p', { className: 'qmr-muted qmr-small' }, tagText(ui, 'noneFound'))),
    error ? h('p', { className: 'qmr-tag-error', role: 'alert' }, error) : null,
    h('footer', { className: 'qmr-actions' }, button(ui, 'cancel', onClose, busy), button(ui, busy ? 'saving' : mode === 'add' ? 'confirmAdd' : mode === 'remove' ? 'confirmRemove' : 'save', save, disabled || (mode !== 'replace' && !ids.length && !names.length), true)));
}
