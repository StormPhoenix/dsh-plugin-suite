import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// The plugin is one self-contained client bundle. PDF.js uses its in-process
// worker handler so it never requests a separate unserved worker URL.
globalThis.pdfjsWorker = { WorkerMessageHandler };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const escapeAttr = escapeHtml;

/**
 * Resolve display dimensions and a raster limited to DPR 2 and 16 million pixels.
 * @param {{width: number, height: number}} base Unscaled PDF viewport.
 * @param {number} width Requested CSS width in pixels.
 * @param {number} pixelRatio Requested raster pixels per CSS pixel.
 * @returns {{width: number, height: number, scale: number, canvasWidth: number, canvasHeight: number}} Display and raster sizes.
 */
export function pdfRenderSize(base, width, pixelRatio = 1) {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('PDF width must be positive and finite');
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new RangeError('PDF pixelRatio must be positive and finite');
  const height = width * base.height / base.width;
  const ratio = Math.min(pixelRatio, 2, Math.sqrt(16_000_000 / width / height), 16_000_000 / width, 16_000_000 / height);
  return { width, height, scale: width / base.width, canvasWidth: Math.max(1, Math.floor(width * ratio)), canvasHeight: Math.max(1, Math.floor(height * ratio)) };
}

function abortError() {
  return new DOMException('PDF rendering aborted', 'AbortError');
}

export async function parsePdfBook(bytes, title = 'PDF') {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  let document;
  try { document = await task.promise; }
  catch (error) { await task.destroy(); throw new Error(`PDF 解析失败：${error?.message || error}`); }
  if (!document.numPages) { await task.destroy(); throw new Error('PDF 没有页面'); }
  const chapters = Array.from({ length: document.numPages }, (_, index) => ({
    href: `pdf/page-${index + 1}`, label: `第 ${index + 1} 页`, xhtml: '',
  }));
  const book = { title, author: '', format: 'pdf', chapters, toc: chapters.map((chapter) => ({ href: chapter.href, label: chapter.label })) };
  const textCache = new Map();
  const activeRenders = new Set();
  let disposed = false;

  async function renderPage(index, options, legacy = false) {
    if (index < 0 || index >= chapters.length) return '';
    const { width, pixelRatio = 1, signal } = options;
    let canvas;
    let renderTask;
    let cancelled = disposed || Boolean(signal?.aborted);
    const done = Promise.withResolvers();
    const operation = { done: done.promise, cancel() { cancelled = true; renderTask?.cancel(); } };
    const checkAbort = () => { if (cancelled) throw abortError(); };
    activeRenders.add(operation);
    signal?.addEventListener('abort', operation.cancel, { once: true });
    try {
      checkAbort();
      const page = await document.getPage(index + 1);
      checkAbort();
      const base = page.getViewport({ scale: 1 });
      const legacyScale = Math.min(1.6, 1000 / Math.max(1, base.width));
      const size = pdfRenderSize(base, legacy ? base.width * legacyScale : width, pixelRatio);
      const viewport = page.getViewport({ scale: legacy ? legacyScale : size.scale });
      const content = await page.getTextContent();
      checkAbort();
      let image = '';
      if (typeof globalThis.document?.createElement === 'function') {
        canvas = globalThis.document.createElement('canvas');
        const legacyRaster = legacy && Math.ceil(viewport.width) * Math.ceil(viewport.height) <= 16_000_000;
        canvas.width = legacyRaster ? Math.ceil(viewport.width) : size.canvasWidth;
        canvas.height = legacyRaster ? Math.ceil(viewport.height) : size.canvasHeight;
        const transform = legacyRaster ? undefined : [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0];
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport, transform });
        if (cancelled) renderTask.cancel();
        await renderTask.promise;
        checkAbort();
        image = canvas.toDataURL('image/jpeg', 0.88);
        checkAbort();
      }
      const spans = content.items.filter((item) => item.str).map((item) => {
        const matrix = Util.transform(viewport.transform, item.transform);
        const fontSize = legacy ? Math.max(4, Math.hypot(matrix[2], matrix[3])) : Math.hypot(matrix[2], matrix[3]);
        const left = matrix[4];
        const top = matrix[5] - fontSize;
        const textWidth = legacy ? Math.max(1, item.width * viewport.scale) : item.width * viewport.scale;
        return `<span style="left:${left / viewport.width * 100}%;top:${top / viewport.height * 100}%;font-size:${fontSize / viewport.width * 100}cqw;min-width:${textWidth / viewport.width * 100}%">${escapeHtml(item.str)}</span>`;
      }).join('');
      checkAbort();
      const displayWidth = legacy ? viewport.width : size.width;
      const displayHeight = legacy ? viewport.height : size.height;
      return `<div class="qmr-pdf-sheet" style="width:${displayWidth}px;aspect-ratio:${displayWidth}/${displayHeight}">${image ? `<img src="${escapeAttr(image)}" alt="第 ${index + 1} 页">` : ''}<div class="qmr-pdf-text-layer">${spans}</div></div>`;
    } catch (error) {
      if (cancelled) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener('abort', operation.cancel);
      if (canvas) canvas.width = canvas.height = 0;
      activeRenders.delete(operation);
      done.resolve();
    }
  }

  const engine = {
    book,
    chapterCount: () => chapters.length,
    async plainTextOf(index) {
      if (index < 0 || index >= chapters.length) return '';
      if (textCache.has(index)) return textCache.get(index);
      const page = await document.getPage(index + 1);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || '').join(' ');
      textCache.set(index, text);
      return text;
    },
    /** Render the page at the legacy width, returning the selectable sheet HTML. */
    render(index) { return renderPage(index, {}, true); },
    /**
     * Render a page at an explicit CSS width with an independently capped raster.
     * @param {number} index Zero-based page index; out-of-range indices return an empty string.
     * @param {{width: number, pixelRatio?: number, signal?: AbortSignal}} options Positive CSS width and pixel ratio (default 1); cancellation rejects with AbortError.
     * @returns {Promise<string>} Sheet HTML with display-coordinate text and an optional JPEG image.
     */
    renderPage(index, options = {}) { return renderPage(index, options); },
    tocFor(index) { return index >= 0 && index < chapters.length ? [book.toc[index]] : []; },
    resolveLink(_from, href) {
      const index = chapters.findIndex((chapter) => chapter.href === href);
      return index < 0 ? null : { chapterIndex: index, fragment: '' };
    },
    async search(query, options = {}) {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return [];
      const hits = [];
      const limit = typeof options === 'number' ? options : options?.limit;
      for (let index = 0; index < chapters.length && hits.length < (limit || 80); index += 1) {
        const text = await this.plainTextOf(index);
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) hits.push({ chapterIndex: index, chapterHref: chapters[index].href, snippet: text.slice(Math.max(0, at - 35), at + needle.length + 45), percent: index / chapters.length });
      }
      return hits;
    },
    async dispose() {
      disposed = true;
      const pending = [...activeRenders];
      for (const operation of pending) operation.cancel();
      await Promise.all(pending.map((operation) => operation.done));
      textCache.clear();
      await task.destroy();
    },
  };
  return { book, engine, bytes };
}
