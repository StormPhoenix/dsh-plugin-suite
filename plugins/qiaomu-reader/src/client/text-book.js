import { createReaderEngine } from '../core/reader.js';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function parseTextBook(bytes, title = '文本') {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('TXT 文件没有可读文字');
  const chunks = [];
  const lines = text.split('\n');
  let current = [];
  let size = 0;
  for (const line of lines) {
    if (size >= 12000 && current.length) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  const chapters = chunks.map((chunk, index) => ({
    href: `text/page-${index + 1}.xhtml`,
    label: chunks.length === 1 ? title : `第 ${index + 1} 部分`,
    xhtml: `<div class="qmr-txt-body">${chunk.split(/\n\s*\n/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')}</div>`,
  }));
  const book = { title, author: '', format: 'txt', chapters, toc: chapters.map((chapter) => ({ href: chapter.href, label: chapter.label })) };
  return { book, engine: createReaderEngine(book), bytes };
}
