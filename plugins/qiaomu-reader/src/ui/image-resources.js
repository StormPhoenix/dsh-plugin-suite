/** Image addresses and in-flight preparation belong to the parsed engine, not a mounted page. */
const resources = new WeakMap();

function dataUrl(bytes, type) {
  if (!bytes?.length) return null;
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  const encoded = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return `data:${type};base64,${encoded}`;
}

/** Prepare successful image addresses once; concurrent callers share work and failed resources may retry.
 * @param {object} engine Parsed reader engine.
 * @returns {Promise<void>} Completion, including individually failed images.
 */
export function prepareImageResources(engine) {
  const book = engine?.book;
  if (!book?.resources || typeof book.resourceBytes !== 'function') return Promise.resolve();
  let record = resources.get(engine);
  if (!record) {
    record = { addresses: new Map(), pending: null };
    resources.set(engine, record);
  }
  if (record.pending) return record.pending;
  const entries = Object.entries(book.resources).filter(([path, resource]) =>
    /^image\//i.test(String(resource?.mediaType || '')) && !record.addresses.has(path));
  const task = Promise.all(entries.map(async ([path, resource]) => {
    try {
      const address = dataUrl(await book.resourceBytes(path), resource.mediaType);
      if (address) record.addresses.set(path, address);
    } catch (_error) {
      // A missing image does not prevent text or other images from rendering.
    }
  })).then(() => undefined);
  record.pending = task;
  return task.finally(() => { if (record.pending === task) record.pending = null; });
}

/** Resolve an EPUB path against addresses belonging to this engine.
 * @param {object} engine Parsed reader engine.
 * @param {string} zipPath EPUB resource path.
 * @returns {string|null} Data URL, or null for an unavailable resource.
 */
export function resolveImageResource(engine, zipPath) {
  const cache = engine && resources.get(engine)?.addresses;
  if (!cache?.size) return null;
  const raw = String(zipPath || '');
  if (cache.has(raw)) return cache.get(raw);
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_error) { /* Keep malformed paths unchanged. */ }
  if (cache.has(decoded)) return cache.get(decoded);
  const base = decoded.split('/').pop();
  for (const [path, address] of cache) if (path.split('/').pop() === base) return address;
  return null;
}
