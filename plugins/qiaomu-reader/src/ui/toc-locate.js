export function splitHref(href) {
  const value = String(href || '');
  const hash = value.indexOf('#');
  const path = hash < 0 ? value : value.slice(0, hash);
  let fragment = hash < 0 ? '' : value.slice(hash + 1);
  try { fragment = decodeURIComponent(fragment); } catch (_error) {}
  return { path, fragment };
}

export function chapterIndexForHref(engine, href) {
  const chapters = engine?.book?.chapters || [];
  const target = splitHref(href).path;
  if (!target || !Array.isArray(chapters)) return -1;
  const exact = chapters.findIndex((chapter) => splitHref(chapter?.href).path === target);
  if (exact >= 0) return exact;
  const base = target.split('/').pop();
  if (!base) return -1;
  return chapters.findIndex((chapter) => splitHref(chapter?.href).path.split('/').pop() === base);
}

export function flattenToc(entries, engine) {
  const flat = [];
  const walk = (list, depth, ancestors, parentIndex) => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, i) => {
      if (!entry) return;
      const href = String(entry.href || '');
      const localKey = `${depth}-${i}-${href}`;
      const key = ancestors.length ? `${ancestors[ancestors.length - 1]}/${localKey}` : localKey;
      const { fragment } = splitHref(href);
      let chapterIndex = chapterIndexForHref(engine, href);
      if (chapterIndex < 0 && href && engine?.resolveLink) {
        try {
          const resolved = engine.resolveLink(parentIndex >= 0 ? parentIndex : 0, href);
          const index = typeof resolved === 'number' ? resolved : resolved?.chapterIndex;
          if (Number.isInteger(index) && index >= 0) chapterIndex = index;
        } catch (_error) {}
      }
      flat.push({ key, depth, ancestors, chapterIndex, fragment, entry });
      walk(entry.children, depth + 1, [...ancestors, key], chapterIndex);
    });
  };
  walk(entries, 0, [], -1);
  return flat;
}

export function locateTocEntry({ flat, chapterIndex, anchor }) {
  const candidates = (flat || []).filter((item) => item.chapterIndex >= 0 && item.chapterIndex === chapterIndex);
  const match = (anchor?.fragment && candidates.find((item) => item.fragment === anchor.fragment)) ||
    candidates.find((item) => !item.fragment) || candidates[0];
  return match ? { key: match.key, ancestors: match.ancestors } : null;
}

export function detectSectionAnchor({ flow, viewport, fragments, mode }) {
  if (!flow || !viewport || !fragments?.length) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const threshold = viewportRect.top + viewport.clientHeight * 0.3;
  let current = null;
  for (const fragment of new Set(fragments)) {
    if (!fragment) continue;
    try {
      const escaped = String(fragment).replace(/[\\"\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
      const node = flow.querySelector(`[id="${escaped}"],[name="${escaped}"]`);
      if (!node) continue;
      const rect = node.getClientRects ? node.getClientRects()[0] : node.getBoundingClientRect();
      if (!rect) continue;
      if (mode === 'scroll' ? rect.top <= threshold : rect.left < viewportRect.right) current = fragment;
    } catch (_error) {}
  }
  return current;
}
