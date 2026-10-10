import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTagName, tagNameKey, normalizeTagModel, createTag, renameTag,
  deleteTag, updateBookTags, migrateBookTags, filterBooksByTags,
} from '../src/core/tags.js';

const catalog = () => ({
  tags: [{ id: 'a', name: 'Café' }, { id: 'b', name: '投资' }],
  bookTags: { one: ['a'], two: ['a', 'b'], three: ['b'] },
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('names normalize NFC and trim with Unicode code-point length limits', () => {
  assert.equal(normalizeTagName('  Cafe\u0301  '), 'Café');
  assert.equal(tagNameKey(' CAFÉ '), 'café');
  assert.equal(normalizeTagName('😀'.repeat(40)), '😀'.repeat(40));
  for (const name of [null, 4, {}, '', '   ', '😀'.repeat(41), '\tbook', 'book\n', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
    assert.throws(() => normalizeTagName(name));
  }
});

test('malformed models normalize to empty detached catalogs', () => {
  for (const raw of [null, undefined, [], 'bad', 4, { tags: {}, bookTags: [] }]) {
    assert.deepEqual(normalizeTagModel(raw), { tags: [], bookTags: {} });
  }
});

test('normalization preserves first IDs and remaps duplicate-name assignments', () => {
  const raw = freeze({
    tags: [null, { id: 'a', name: ' Cafe\u0301 ' }, { id: 'a', name: 'Other' },
      { id: 'alias', name: 'CAFÉ' }, { id: 'b', name: '投资' },
      ...['', ' x ', '__proto__', 'constructor', 'prototype'].map(id => ({ id, name: id })),
      { id: 'invalid-name', name: '' }],
    bookTags: JSON.parse('{"one":["alias","a","b","b","unknown",null,"constructor"],"empty":[],"bad":"a","__proto__":["a"],"constructor":["a"],"prototype":["a"]}'),
  });
  assert.deepEqual(normalizeTagModel(raw), { tags: catalog().tags, bookTags: { one: ['a', 'b'] } });
  assert.deepEqual(normalizeTagModel(normalizeTagModel(raw)), normalizeTagModel(raw));
});

test('create and rename preserve stable IDs and reject duplicate names or IDs', () => {
  const model = freeze(catalog());
  const created = createTag(model, { id: 'c', name: ' Reading ' });
  assert.deepEqual(created.tags.at(-1), { id: 'c', name: 'Reading' });
  const renamed = renameTag(model, { tagId: 'a', name: ' CAFÉ ' });
  assert.deepEqual(renamed.tags[0], { id: 'a', name: 'CAFÉ' });
  assert.deepEqual(renamed.bookTags, model.bookTags);
  assert.throws(() => createTag(model, { id: 'c', name: 'Cafe\u0301' }), /Duplicate tag name/);
  assert.throws(() => createTag(model, { id: 'a', name: 'New' }), /Duplicate tag ID/);
  assert.throws(() => renameTag(model, { tagId: 'b', name: 'café' }), /Duplicate tag name/);
  assert.throws(() => renameTag(model, { tagId: 'missing', name: 'New' }), /Unknown tag ID/);
  for (const id of ['', '__proto__', 'constructor', 'prototype', null]) {
    assert.throws(() => createTag(model, { id, name: 'New' }), /Invalid ID/);
  }
  assert.deepEqual(model, catalog());
});

test('deleting a tag removes only its assignments and omits empty entries', () => {
  const model = freeze(catalog());
  assert.deepEqual(deleteTag(model, { tagId: 'a' }), {
    tags: [{ id: 'b', name: '投资' }], bookTags: { two: ['b'], three: ['b'] },
  });
  assert.throws(() => deleteTag(model, { tagId: 'missing' }), /Unknown tag ID/);
  assert.deepEqual(model, catalog());
});

test('batch add resolves existing and repeated new names once', () => {
  const model = freeze(catalog());
  let calls = 0;
  const result = updateBookTags(model, {
    bookIds: ['one', 'four', 'four'], tagIds: ['b', 'b'],
    newTagNames: ['CAFÉ', ' Read ', 'READ'], operation: 'add',
  }, () => { calls++; return 'c'; });
  assert.equal(calls, 1);
  assert.deepEqual(result.tags.at(-1), { id: 'c', name: 'Read' });
  assert.deepEqual(result.bookTags.one, ['a', 'b', 'c']);
  assert.deepEqual(result.bookTags.four, ['b', 'a', 'c']);
  assert.notEqual(result.bookTags.one, result.bookTags.four);
  assert.deepEqual(model, catalog());
});

test('replace sets exactly one book and permits empty selection to clear it', () => {
  const model = freeze(catalog());
  const replaced = updateBookTags(model, { bookIds: ['one'], newTagNames: ['投资'], operation: 'replace' });
  assert.deepEqual(replaced.bookTags.one, ['b']);
  assert.deepEqual(replaced.bookTags.two, ['a', 'b']);
  const cleared = updateBookTags(model, { bookIds: ['two'], operation: 'replace' });
  assert.equal(Object.hasOwn(cleared.bookTags, 'two'), false);
  assert.throws(() => updateBookTags(model, { bookIds: ['one', 'two'], operation: 'replace' }));
});

test('remove is a multi-book set difference and cannot create names', () => {
  const model = freeze(catalog());
  const result = updateBookTags(model, { bookIds: ['one', 'two', 'absent'], tagIds: ['a'], operation: 'remove' });
  assert.deepEqual(result.bookTags, { two: ['b'], three: ['b'] });
  assert.throws(() => updateBookTags(model, { bookIds: ['one'], newTagNames: ['New'], operation: 'remove' }));
});

test('update validates operation, book IDs, tag IDs and all names before generating IDs', () => {
  const model = freeze(catalog());
  let calls = 0;
  const makeId = () => { calls++; return 'c'; };
  for (const request of [
    { bookIds: ['one'], operation: 'other' },
    { bookIds: [], operation: 'add' },
    { bookIds: 'one', operation: 'add' },
    { bookIds: ['__proto__'], operation: 'add' },
    { bookIds: ['one'], tagIds: ['missing'], operation: 'add' },
    { bookIds: ['one'], tagIds: null, operation: 'add' },
    { bookIds: ['one'], newTagNames: null, operation: 'add' },
    { bookIds: ['one'], newTagNames: ['New', ''], operation: 'add' },
  ]) assert.throws(() => updateBookTags(model, request, makeId));
  assert.equal(calls, 0);
  assert.deepEqual(model, catalog());
});

test('generation collisions and later generation failures never change the input', () => {
  const model = freeze(catalog());
  const request = { bookIds: ['one'], newTagNames: ['New', 'Other'], operation: 'add' };
  for (const makeId of [() => 'a', () => '__proto__', () => 'c', () => { throw new Error('factory failed'); }]) {
    assert.throws(() => updateBookTags(model, request, makeId));
    assert.deepEqual(model, catalog());
  }
  assert.throws(() => updateBookTags(model, request), /factory/);
});

test('migration merges destination assignments, removes source, and preserves tag catalog', () => {
  const model = freeze(catalog());
  assert.deepEqual(migrateBookTags(model, { fromId: 'three', toId: 'one' }), {
    tags: model.tags, bookTags: { one: ['a', 'b'], two: ['a', 'b'] },
  });
  assert.deepEqual(migrateBookTags(model, { fromId: 'one', toId: 'one' }), model);
  assert.deepEqual(migrateBookTags(model, { fromId: 'absent', toId: 'other' }), model);
  assert.throws(() => migrateBookTags(model, { fromId: 'one', toId: 'constructor' }));
  assert.deepEqual(model, catalog());
});

test('any, all and untagged filtering preserve input order and book references', () => {
  const books = freeze(['four', 'three', 'two', 'one'].map(id => ({ id })));
  const model = freeze(catalog());
  assert.deepEqual(filterBooksByTags(books, model, ['a']), [books[2], books[3]]);
  assert.deepEqual(filterBooksByTags(books, model, ['a', 'b'], 'all'), [books[2]]);
  assert.deepEqual(filterBooksByTags(books, model, [], 'untagged'), [books[0]]);
  assert.deepEqual(filterBooksByTags(books, model), books);
  assert.deepEqual(filterBooksByTags(books, model, [], 'all'), books);
  assert.deepEqual(filterBooksByTags(books, model, ['missing']), []);
  assert.throws(() => filterBooksByTags(books, model, [], 'invalid'));
  assert.throws(() => filterBooksByTags(books, model, ['__proto__']));
});

test('returned model entries are detached from the input on successful mutations', () => {
  const model = catalog();
  const result = updateBookTags(model, { bookIds: ['one'], tagIds: ['b'], operation: 'add' });
  result.tags[0].name = 'Changed'; result.bookTags.two.push('c');
  assert.deepEqual(model, catalog());
});
