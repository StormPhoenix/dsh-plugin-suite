const KEY = 'qmr.quick-prompts.v1';

export const DEFAULT_PROMPTS = [
  { id: 'summary', title: '概括要点', body: '请概括当前章节的要点，并区分原文与推断。' },
  { id: 'explain', title: '解释选段', body: '请结合上下文，用通俗中文解释我选中的这段内容。' },
  { id: 'evidence', title: '追问证据', body: '当前章节的主要论断有哪些证据和可能的反例？' },
];

export function readQuickPrompts() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved)) return saved.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string').slice(0, 20);
  } catch { /* 损坏的个人设置不阻止阅读。 */ }
  return DEFAULT_PROMPTS;
}

export function saveQuickPrompts(items) {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event('qmr-prompts-changed'));
}
