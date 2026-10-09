/** Markdown note links are ordinary same-page fragments, handled by the Reader panel in Harness. */
export function highlightLink(bookId, highlightId) {
  if (!bookId || !highlightId) return '';
  return `#qmr-book=${encodeURIComponent(String(bookId))}&qmr-highlight=${encodeURIComponent(String(highlightId))}`;
}

export function parseHighlightLink(href) {
  if (typeof href !== 'string' || !href.startsWith('#qmr-book=')) return null;
  try {
    const params = new URLSearchParams(href.slice(1));
    const bookId = params.get('qmr-book');
    const highlightId = params.get('qmr-highlight');
    if (!bookId || !highlightId || bookId.length > 160 || highlightId.length > 160) return null;
    return { bookId, highlightId };
  } catch { return null; }
}
