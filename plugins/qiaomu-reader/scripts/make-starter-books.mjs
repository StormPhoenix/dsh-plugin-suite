#!/usr/bin/env node
/**
 * 生成 media/starter-books.js：把参考项目里六本公版 EPUB 内联为 base64。
 *
 * 只用 Node 内置模块（zlib 解压 zip 条目、正则提取 OPF 元数据），
 * 不联网、不依赖第三方包，可重复运行且结果确定。
 *
 * 用法：node scripts/make-starter-books.mjs [--source <dir>]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEpub } from '../src/core/epub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_SOURCE = process.env.QIAOMU_STARTER_BOOKS || path.resolve(ROOT, '../qiaomu-reader/assets/starter-books');

/** 解析 zip 中央目录，返回 name -> { method, offset, headerOffset }。 */
function readCentralDirectory(buf) {
  const eocd = buf.lastIndexOf(0x06054b50);
  if (eocd < 0) throw new Error('不是 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录项签名错误');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    out.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** 解出某个条目（只支持 stored / deflate，够 EPUB 用）。 */
function readEntry(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地头签名错误');
  const nameLength = buf.readUInt16LE(lo + 26);
  const extraLength = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的压缩方法 ${entry.method}`);
}

/** 从 XML 里取第一个 <tag ...>value</tag> 的文本。 */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 读出 EPUB 的 OPF 元数据。 */
function readEpubMetadata(buf) {
  const dir = readCentralDirectory(buf);
  const container = readEntry(buf, dir.get('META-INF/container.xml'));
  const rootfile = /full-path="([^"]+)"/i.exec(container.toString('utf8'));
  if (!rootfile) throw new Error('container.xml 缺少 rootfile');
  const opfPath = rootfile[1];
  const opf = readEntry(buf, dir.get(opfPath)).toString('utf8');
  const metadata = /<metadata[\s\S]*?<\/metadata>/i.exec(opf)?.[0] ?? opf;
  return {
    title: tagText(metadata, 'dc:title') || tagText(metadata, 'title'),
    author: tagText(metadata, 'dc:creator') || tagText(metadata, 'creator'),
    language: tagText(metadata, 'dc:language') || tagText(metadata, 'language'),
    identifier: tagText(metadata, 'dc:identifier') || tagText(metadata, 'identifier'),
    description: tagText(metadata, 'dc:description') || tagText(metadata, 'description'),
    chapterCount: (opf.match(/<itemref\b/gi) ?? []).length,
  };
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const source = argValue('--source') ?? DEFAULT_SOURCE;
  const catalog = JSON.parse(await readFile(path.join(source, 'catalog.json'), 'utf8'));

  const entries = [];
  for (const item of catalog) {
    const file = path.join(source, `${item.id}.epub`);
    const buf = await readFile(file);
    const meta = readEpubMetadata(buf);
    const parsed = await parseEpub(new Uint8Array(buf));
    const coverBytes = parsed.coverHref ? await parsed.resourceBytes(parsed.coverHref) : null;
    const coverType = parsed.coverHref ? parsed.resources[parsed.coverHref]?.mediaType : null;
    const cover = coverBytes && /^image\/(?:jpeg|png|webp|gif)$/i.test(coverType || '')
      ? `data:${coverType};base64,${Buffer.from(coverBytes).toString('base64')}`
      : null;
    entries.push({
      id: `gutenberg-${item.id}`,
      gid: item.id,
      title: meta.title || item.title,
      author: meta.author,
      language: meta.language,
      identifier: meta.identifier,
      bytes: buf.byteLength,
      chapterCount: meta.chapterCount,
      source: item.source,
      filename: `${meta.title || item.title}.epub`,
      sha256: item.sha256,
      cover,
      data: buf.toString('base64'),
    });
    process.stdout.write(`  ${item.id.padEnd(6)} ${meta.title}  ${buf.byteLength} bytes  ${meta.chapterCount} 章\n`);
  }

  const body = entries
    .map((book) => {
      const meta = (({ data, ...rest }) => rest)(book);
      return [
        '  {',
        `    id: ${JSON.stringify(meta.id)},`,
        `    gid: ${JSON.stringify(meta.gid)},`,
        `    title: ${JSON.stringify(meta.title)},`,
        `    author: ${JSON.stringify(meta.author)},`,
        `    language: ${JSON.stringify(meta.language)},`,
        `    identifier: ${JSON.stringify(meta.identifier)},`,
        `    bytes: ${meta.bytes},`,
        `    chapterCount: ${meta.chapterCount},`,
        `    source: ${JSON.stringify(meta.source)},`,
        `    filename: ${JSON.stringify(meta.filename)},`,
        `    sha256: ${JSON.stringify(meta.sha256)},`,
        `    cover: ${JSON.stringify(meta.cover)},`,
        `    data: ${JSON.stringify(book.data)},`,
        '  },',
      ].join('\n');
    })
    .join('\n');

  const header = `/**
 * 由 scripts/make-starter-books.mjs 生成，请勿手工修改。
 *
 * 六本公版书的 EPUB 原文以 base64 内联在这里：阅读器完全离线可用，
 * 不依赖网络、也不依赖宿主文件系统。每本保留 Project Gutenberg 完整许可，
 * 书籍许可与软件许可（GPL-3.0）相互独立。
 *
 * 载荷只在第一次打开某本书时解码，所以工厂函数的开销只有字符串常量。
 * 重新生成：node scripts/make-starter-books.mjs
 */

/** 内置公版书（含 base64 载荷）。 */
export const STARTER_BOOKS = [
${body}
];

/** 把内联 base64 解码为 Uint8Array。 */
export function decodeStarterBook(book) {
  const binary = atob(book.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 只带元数据、不带载荷的列表，供书库渲染使用。 */
export function starterCatalog() {
  return STARTER_BOOKS.map(({ data, ...meta }) => meta);
}
`;

  await mkdir(path.join(ROOT, 'media'), { recursive: true });
  await writeFile(path.join(ROOT, 'media', 'starter-books.js'), header, 'utf8');
  const total = entries.reduce((sum, book) => sum + book.bytes, 0);
  process.stdout.write(`\n共 ${entries.length} 本，EPUB 合计 ${total} bytes -> media/starter-books.js\n`);
}

main().catch((error) => {
  process.stderr.write(`生成内置书失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
