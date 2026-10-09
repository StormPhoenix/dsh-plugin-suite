const START = '<!-- qmr:highlights:start -->';
const END = '<!-- qmr:highlights:end -->';

/** Refresh generated highlights while preserving text the reader wrote around them. */
export function mergeManagedNotes(existing, generated) {
  const current = String(existing || '');
  const block = `${START}\n${String(generated || '').trimEnd()}\n${END}`;
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start >= 0 && end > start) return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
  return current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
}
