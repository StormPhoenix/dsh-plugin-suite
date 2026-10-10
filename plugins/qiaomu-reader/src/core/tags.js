/** Pure tag catalog and book-assignment helpers; mutations return detached models. */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROLS = /\p{Cc}/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && id.length > 0 && id === id.trim() && !CONTROLS.test(id) && !RESERVED_IDS.has(id);
function requireId(id) {
  if (!validId(id)) throw new Error('Invalid ID');
  return id;
}
function requireList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function ids(value, label) {
  return [...new Set(requireList(value, label).map(requireId))];
}
function requireTag(model, id) {
  requireId(id);
  if (!model.tags.some(tag => tag.id === id)) throw new Error('Unknown tag ID');
}

/** Normalize an NFC tag name; reject controls and lengths outside 1–40 code points. */
export function normalizeTagName(name) {
  if (typeof name !== 'string' || CONTROLS.test(name)) throw new Error('Invalid tag name');
  const normalized = name.normalize('NFC').trim();
  if ([...normalized].length < 1 || [...normalized].length > 40) throw new Error('Tag name must contain 1–40 characters');
  return normalized;
}

/** Return the case-insensitive NFC comparison key of a valid name. */
export function tagNameKey(name) {
  return normalizeTagName(name).toLowerCase().normalize('NFC');
}

/** Drop malformed data, preserving first IDs and remapping duplicate names to them. */
export function normalizeTagModel(raw) {
  const source = isObject(raw) ? raw : {};
  const tags = [], names = new Map(), aliases = new Map();
  for (const tag of Array.isArray(source.tags) ? source.tags : []) {
    if (!isObject(tag) || !validId(tag.id) || aliases.has(tag.id)) continue;
    let name;
    try { name = normalizeTagName(tag.name); }
    catch (error) { continue; /* Persisted malformed names are omitted. */ }
    const key = tagNameKey(name);
    const id = names.get(key) ?? tag.id;
    aliases.set(tag.id, id);
    if (!names.has(key)) { names.set(key, id); tags.push({ id, name }); }
  }
  const bookTags = {};
  if (isObject(source.bookTags)) {
    for (const [id, assigned] of Object.entries(source.bookTags)) {
      if (!validId(id) || !Array.isArray(assigned)) continue;
      const clean = [...new Set(assigned.filter(validId).map(tagId => aliases.get(tagId)).filter(Boolean))];
      if (clean.length) bookTags[id] = clean;
    }
  }
  return { tags, bookTags };
}

/** Create a unique tag; reject duplicate IDs or case-insensitive names. */
export function createTag(model, { id, name }) {
  const result = normalizeTagModel(model);
  requireId(id);
  name = normalizeTagName(name);
  if (result.tags.some(tag => tag.id === id)) throw new Error('Duplicate tag ID');
  if (result.tags.some(tag => tagNameKey(tag.name) === tagNameKey(name))) throw new Error('Duplicate tag name');
  result.tags.push({ id, name });
  return result;
}

/** Rename an existing tag without changing its ID or assignments. */
export function renameTag(model, { tagId, name }) {
  const result = normalizeTagModel(model);
  requireTag(result, tagId);
  name = normalizeTagName(name);
  if (result.tags.some(tag => tag.id !== tagId && tagNameKey(tag.name) === tagNameKey(name))) throw new Error('Duplicate tag name');
  result.tags = result.tags.map(tag => tag.id === tagId ? { id: tagId, name } : tag);
  return result;
}

/** Delete an existing tag and remove every assignment to it. */
export function deleteTag(model, { tagId }) {
  const result = normalizeTagModel(model);
  requireTag(result, tagId);
  result.tags = result.tags.filter(tag => tag.id !== tagId);
  for (const [id, assigned] of Object.entries(result.bookTags)) {
    const remaining = assigned.filter(id => id !== tagId);
    if (remaining.length) result.bookTags[id] = remaining;
    else delete result.bookTags[id];
  }
  return result;
}

/** Atomically add/remove tags on books, or replace one book's tags; names resolve on add/replace. */
export function updateBookTags(model, { bookIds, tagIds = [], newTagNames = [], operation }, createId) {
  const result = normalizeTagModel(model);
  if (!['add', 'remove', 'replace'].includes(operation)) throw new Error('Invalid tag operation');
  const books = ids(bookIds, 'bookIds');
  if (!books.length || (operation === 'replace' && books.length !== 1)) throw new Error('Invalid book selection');
  const selected = ids(tagIds, 'tagIds');
  selected.forEach(id => requireTag(result, id));
  const names = requireList(newTagNames, 'newTagNames').map(normalizeTagName);
  if (operation === 'remove' && names.length) throw new Error('New tag names require add or replace');
  const byName = new Map(result.tags.map(tag => [tagNameKey(tag.name), tag.id]));
  for (const name of names) {
    const key = tagNameKey(name);
    let id = byName.get(key);
    if (!id) {
      if (typeof createId !== 'function') throw new Error('A tag ID factory is required');
      id = requireId(createId());
      if (result.tags.some(tag => tag.id === id)) throw new Error('Duplicate tag ID');
      result.tags.push({ id, name });
      byName.set(key, id);
    }
    if (!selected.includes(id)) selected.push(id);
  }
  for (const bookId of books) {
    const assigned = result.bookTags[bookId] ?? [];
    const next = operation === 'replace' ? [...selected] : operation === 'add'
      ? [...new Set([...assigned, ...selected])]
      : assigned.filter(id => !selected.includes(id));
    if (next.length) result.bookTags[bookId] = next;
    else delete result.bookTags[bookId];
  }
  return result;
}

/** Move a book's assignments into a destination, merging existing destination tags. */
export function migrateBookTags(model, { fromId, toId }) {
  const result = normalizeTagModel(model);
  requireId(fromId); requireId(toId);
  if (fromId === toId) return result;
  const merged = [...new Set([...(result.bookTags[toId] ?? []), ...(result.bookTags[fromId] ?? [])])];
  if (merged.length) result.bookTags[toId] = merged;
  delete result.bookTags[fromId];
  return result;
}

/** Filter books in input order; empty any/all selections leave the list unfiltered. */
export function filterBooksByTags(books, model, selectedIds = [], mode = 'any') {
  if (!['any', 'all', 'untagged'].includes(mode)) throw new Error('Invalid tag filter mode');
  requireList(books, 'books');
  const selected = ids(selectedIds, 'ids');
  const normalized = normalizeTagModel(model);
  return books.filter(book => {
    const assigned = validId(book?.id) ? normalized.bookTags[book.id] ?? [] : [];
    if (mode === 'untagged') return assigned.length === 0;
    if (!selected.length) return true;
    return mode === 'all' ? selected.every(id => assigned.includes(id)) : selected.some(id => assigned.includes(id));
  });
}
