import * as React from 'react';
import { IconClose, IconTrash } from './icons.js';
import { readQuickPrompts, saveQuickPrompts } from './quick-prompts.js';

const h = React.createElement;

export function PromptManager({ onClose }) {
  const [items, setItems] = React.useState(readQuickPrompts);
  const [editing, setEditing] = React.useState(null);
  const save = (event) => {
    event.preventDefault();
    const title = editing.title.trim();
    const body = editing.body.trim();
    if (!title || !body) return;
    const next = editing.id ? items.map((item) => item.id === editing.id ? { id: item.id, title, body } : item)
      : [...items, { id: crypto.randomUUID(), title, body }];
    saveQuickPrompts(next);
    setItems(next);
    setEditing(null);
  };
  return h('div', { className: 'qmr-prompt-backdrop', onClick: onClose },
    h('section', { className: 'qmr-prompt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '管理快捷提示词', onClick: (event) => event.stopPropagation(), onKeyDown: (event) => { if (event.key === 'Escape') onClose(); } },
      h('header', null, h('strong', null, '快捷提示词'), h('button', { type: 'button', className: 'qmr-icon-btn', 'aria-label': '关闭', onClick: onClose }, h(IconClose, { width: 16, height: 16 }))),
      h('p', null, '显示在伴读输入框上方。点击后直接发送；已有手写草稿时会保留草稿。'),
      h('div', { className: 'qmr-prompt-list' }, items.map((item) => h('div', { className: 'qmr-prompt-row', key: item.id },
        h('div', null, h('strong', null, item.title), h('span', null, item.body)),
        h('button', { type: 'button', 'aria-label': `编辑 ${item.title}`, onClick: () => setEditing(item) }, '编辑'),
        h('button', { type: 'button', 'aria-label': `删除 ${item.title}`, onClick: () => { const next = items.filter((prompt) => prompt.id !== item.id); saveQuickPrompts(next); setItems(next); } }, h(IconTrash, { width: 15, height: 15 }))))),
      editing ? h('form', { className: 'qmr-prompt-editor', onSubmit: save },
        h('label', null, '名称', h('input', { autoFocus: true, maxLength: 60, value: editing.title, onChange: (event) => setEditing({ ...editing, title: event.target.value }) })),
        h('label', null, '提示词', h('textarea', { rows: 5, maxLength: 5000, value: editing.body, onChange: (event) => setEditing({ ...editing, body: event.target.value }) })),
        h('div', null, h('button', { type: 'button', onClick: () => setEditing(null) }, '取消'), h('button', { type: 'submit', disabled: !editing.title.trim() || !editing.body.trim() }, '保存'))) :
        h('button', { type: 'button', className: 'qmr-prompt-new', disabled: items.length >= 20, onClick: () => setEditing({ title: '', body: '' }) }, '+ 新增提示词')));
}
