/**
 * 解析核心单测：zip / epub / html 三个模块。
 *
 * 运行：node --test test/parser.test.mjs
 * 全部使用 node:test + node:assert/strict，不依赖任何第三方包。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 as zlibCrc32, deflateRawSync } from "node:zlib";

import { openZip } from "../src/core/zip.js";
import { parseEpub } from "../src/core/epub.js";
import {
  absolutize,
  extractBody,
  highlightTerms,
  rewriteResources,
  sanitizeHtml,
  toPlainText,
} from "../src/core/html.js";

const STARTER_BOOKS_PATH = new URL("../media/starter-books.js", import.meta.url);

// ── 测试用的极简 ZIP 打包器 ────────────────────────────────────────────────
// 故意不复用 src/core/zip.js 里的实现，这样「造包」与「读包」互为对照。

/**
 * 计算 CRC32（优先用 node 内置实现）。
 * @param {Buffer} buffer 字节
 * @returns {number} CRC32
 */
function crc32(buffer) {
  if (typeof zlibCrc32 === "function") return zlibCrc32(buffer) >>> 0;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 手搓一个最小 zip。
 * @param {{name: string, data?: string | Buffer, method?: 'store' | 'deflate'}[]} files 条目
 * @param {{comment?: string, dataDescriptor?: boolean, breakZip64?: boolean, badCrc?: boolean, localExtra?: number, utf8Flag?: boolean}} [options] 选项
 * @returns {Uint8Array} zip 字节
 */
function makeZip(files, options = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? "", "utf8");
    const method = file.method === "deflate" ? 8 : 0;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const flags = (options.utf8Flag === false ? 0 : 0x0800) | (options.dataDescriptor ? 0x0008 : 0);
    const crc = options.badCrc ? 0xdeadbeef : crc32(data);
    // 本地头可以带一段中央目录里没有的 extra，用来验证数据起点必须按本地头算。
    const localExtra = Buffer.alloc(options.localExtra ?? 0);
    if (localExtra.length >= 4) localExtra.writeUInt16LE(0x9999, 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    // bit 3 置位时，本地头里的 crc/尺寸按规范写 0，真实值只存在于中央目录。
    local.writeUInt32LE(options.dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(options.dataDescriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(options.dataDescriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localParts.push(local, name, localExtra, payload);
    let consumed = local.length + name.length + localExtra.length + payload.length;

    if (options.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
      localParts.push(descriptor);
      consumed += 16;
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    // 打开 zip64 哨兵开关时写 0xFFFFFFFF，且不给 zip64 扩展字段。
    central.writeUInt32LE(options.breakZip64 ? 0xffffffff : offset, 42);
    centralParts.push(central, name);

    offset += consumed;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return new Uint8Array(Buffer.concat([...localParts, centralBuffer, eocd, comment]));
}

// ── 1. zip ────────────────────────────────────────────────────────────────

test("zip：stored 与 deflate 都能读取，且 CRC 正确", async () => {
  const zip = await openZip(makeZip([
    { name: "mimetype", data: "application/epub+zip", method: "store" },
    { name: "OEBPS/text/ch1.xhtml", data: "<p>第一章 · 中文</p>".repeat(200), method: "deflate" },
    { name: "./OEBPS/text/ch2.xhtml", data: "<p>second</p>", method: "store" },
    { name: "META-INF/", data: "", method: "store" },
  ]));

  const names = zip.entries().map((entry) => entry.name);
  // 目录项不进 entries，`./` 前缀被归一化。
  assert.deepEqual(names.sort(), ["OEBPS/text/ch1.xhtml", "OEBPS/text/ch2.xhtml", "mimetype"]);
  assert.equal(zip.has("./OEBPS/text/ch2.xhtml"), true);
  assert.equal(zip.has("OEBPS/"), false);
  assert.equal(zip.has("nope.xhtml"), false);

  assert.equal(await zip.readText("mimetype"), "application/epub+zip");
  assert.equal(await zip.readText("OEBPS/text/ch1.xhtml"), "<p>第一章 · 中文</p>".repeat(200));
  assert.equal(await zip.readText("META-INF/"), undefined);
  assert.equal(await zip.read("nope.xhtml"), undefined);
  assert.ok((await zip.read("OEBPS/text/ch1.xhtml")) instanceof Uint8Array);

  const entry = zip.entries().find((item) => item.name === "mimetype");
  assert.equal(entry.size, "application/epub+zip".length);
  assert.ok(entry.compressedSize > 0);
});

test("zip：容忍注释、数据描述符（bit 3）与不支持的压缩方式", async () => {
  const withComment = await openZip(makeZip(
    [{ name: "a.txt", data: "hello", method: "store" }],
    { comment: "x".repeat(400) },
  ));
  assert.equal(await withComment.readText("a.txt"), "hello");

  // bit 3：本地头尺寸全为 0，必须回退到中央目录。
  const descriptor = await openZip(makeZip(
    [{ name: "b.txt", data: "descriptor payload", method: "deflate" }],
    { dataDescriptor: true },
  ));
  assert.equal(await descriptor.readText("b.txt"), "descriptor payload");

  // 压缩方式 12（bzip2）不在支持范围。
  const raw = makeZip([{ name: "c.txt", data: "c", method: "store" }]);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  view.setUint16(8, 12, true);
  view.setUint16(raw.length - 22 - 46 - "c.txt".length + 10, 12, true);
  const unsupported = await openZip(raw);
  await assert.rejects(unsupported.read("c.txt"), /不支持的压缩方式 12/);
});

test("zip：篡改数据后 read 抛 CRC32 错误并带条目名", async () => {
  const bytes = makeZip([
    { name: "ok.txt", data: "keep me", method: "store" },
    { name: "tamper.txt", data: "Hello CRC world", method: "store" },
  ]);
  const archive = await openZip(bytes);
  assert.equal(await archive.readText("ok.txt"), "keep me");

  const marker = Buffer.from("Hello CRC world", "utf8");
  const at = Buffer.from(bytes).indexOf(marker);
  assert.ok(at > 0, "应该能在归档里定位到原文");
  bytes[at + 4] ^= 0xff;

  await assert.rejects(archive.read("tamper.txt"), (error) => {
    assert.match(error.message, /CRC32/);
    assert.match(error.message, /tamper\.txt/);
    return true;
  });
  // 未受影响的条目仍可读。
  assert.equal(await archive.readText("ok.txt"), "keep me");
});

test("zip：UTF-8 文件名、本地头 extra 与中央目录不一致时按本地头定位", async () => {
  // 本地头多带 9 字节 extra（中央目录里是 0），且不置 UTF-8 标志（bit 11）。
  // 若数据起点按中央目录的 extra 长度算，这里必然 CRC 失败。
  const zip = await openZip(makeZip([
    { name: "中文/章节 一.xhtml", data: "<p>你好 &amp; 世界</p>", method: "deflate" },
    { name: "big.bin", data: Buffer.alloc(64, 0xab), method: "store" },
  ], { localExtra: 9, utf8Flag: false }));

  assert.deepEqual(zip.entries().map((entry) => entry.name).sort(), ["big.bin", "中文/章节 一.xhtml"]);
  assert.equal(await zip.readText("中文/章节 一.xhtml"), "<p>你好 &amp; 世界</p>");
  assert.equal((await zip.read("big.bin")).length, 64);

  // ArrayBuffer 输入同样支持。
  const asArrayBuffer = await openZip(makeZip([{ name: "a.txt", data: "ab" }]).buffer);
  assert.equal(await asArrayBuffer.readText("a.txt"), "ab");
});

test("zip：坏输入给出可读错误，zip64 哨兵能识别", async () => {
  await assert.rejects(openZip(new Uint8Array([1, 2, 3])), /文件太小/);
  await assert.rejects(openZip(new Uint8Array(64).fill(7)), /EOCD/);

  const zip64Sentinels = makeZip([{ name: "a.txt", data: "a" }], { breakZip64: true });
  await assert.rejects(openZip(zip64Sentinels), /ZIP64/);
});

// ── 2. 六本内置书 ─────────────────────────────────────────────────────────

test("epub：六本内置公版书全部能解析，目录与 spine 对齐", async () => {
  const { STARTER_BOOKS, decodeStarterBook } = await import(STARTER_BOOKS_PATH.href);
  assert.equal(STARTER_BOOKS.length, 6);

  for (const starter of STARTER_BOOKS) {
    const book = await parseEpub(decodeStarterBook(starter));

    assert.ok(book.title && book.title.trim(), `${starter.id} 应有标题`);
    assert.ok(book.chapters.length > 0, `${starter.id} 应有章节`);
    assert.ok(book.toc.length > 0, `${starter.id} 应有目录`);
    assert.ok(book.coverHref, `${starter.id} 应有封面`);
    assert.ok(typeof book.rootDir === "string", `${starter.id} 应有 rootDir`);
    assert.equal(book.rootDir, "EPUB/");

    // 章节字段完整、index 连续、坐标在 zip 内真实存在。
    book.chapters.forEach((chapter, index) => {
      assert.equal(chapter.index, index);
      assert.ok(chapter.href, "章节应有 href");
      assert.ok(!chapter.href.includes(".."), "章节 href 不应残留 ../");
      assert.ok(!chapter.href.startsWith("/"), "章节 href 应为 zip 根相对路径");
      assert.equal(typeof chapter.xhtml, "string");
      assert.ok(chapter.xhtml.length > 0);
      assert.equal(typeof chapter.linear, "boolean");
      assert.equal(typeof chapter.label, "string");
      assert.ok(book.resources[chapter.href], `资源表应包含 ${chapter.href}`);
      assert.ok(book.resources[chapter.href].mediaType);
    });

    // lead 要求：每个 toc 叶子节点都能在 chapters 里找到对应项（允许带 #frag）。
    const hrefs = new Set(book.chapters.map((chapter) => chapter.href));
    const leaves = [];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.children && node.children.length) walk(node.children);
        else leaves.push(node);
      }
    };
    walk(book.toc);
    assert.ok(leaves.length > 0, `${starter.id} 目录应有叶子节点`);
    for (const leaf of leaves) {
      assert.ok(leaf.href, `${starter.id} 目录叶子应有 href`);
      assert.ok(
        hrefs.has(leaf.href.split("#")[0]),
        `${starter.id} 目录 href ${leaf.href} 应对应某个 spine 章节`,
      );
    }

    // 封面必须是真实存在的图片字节。
    const coverBytes = await book.resourceBytes(book.coverHref);
    assert.ok(coverBytes && coverBytes.length > 0, `${starter.id} 封面字节可读`);
    assert.ok(/^image\//.test(book.resources[book.coverHref].mediaType) || book.coverHref.endsWith(".jpg"));
    assert.ok(starter.cover?.startsWith('data:image/'), `${starter.id} 书库元数据应包含真实封面`);
    assert.deepEqual(
      Buffer.from(starter.cover.split(',')[1], 'base64'),
      Buffer.from(coverBytes),
      `${starter.id} 书库封面应与 EPUB 内的图片一致`,
    );

    assert.equal(await book.resourceBytes("EPUB/不存在.png"), undefined);
  }
});

test("epub：内置书目录来自 nav 文档而非兜底，元数据正确", async () => {
  const { STARTER_BOOKS, decodeStarterBook } = await import(STARTER_BOOKS_PATH.href);
  const dao = STARTER_BOOKS.find((item) => item.id === "gutenberg-7337");
  assert.ok(dao, "应能找到道德经");
  const book = await parseEpub(decodeStarterBook(dao));

  assert.equal(book.title, "道德经");
  assert.equal(book.author, "老子");
  assert.equal(book.language, "zh");
  assert.equal(book.chapters.length, 82);
  assert.equal(book.toc.length, 82);
  // nav 里的真实标签，而不是兜底生成的「第 N 章」。
  assert.equal(book.toc[0].label, "第一章");
  assert.equal(book.toc[0].href, "EPUB/s0.xhtml");
  assert.deepEqual(book.toc[0].children, []);
  assert.equal(book.identifier, "urn:qbr:starter:7337");
});

test("html：真实章节跑完整管线（extractBody→sanitize→纯文本→高亮→absolutize）", async () => {
  const { STARTER_BOOKS, decodeStarterBook } = await import(STARTER_BOOKS_PATH.href);
  const starter = STARTER_BOOKS.find((item) => item.id === "gutenberg-11");
  const book = await parseEpub(decodeStarterBook(starter));

  let textTotal = 0;
  let aliceHits = 0;
  for (const chapter of book.chapters) {
    const clean = sanitizeHtml(extractBody(chapter.xhtml));
    assert.ok(clean.length > 0, `${chapter.href} 清洗后不应为空`);
    assert.ok(!/<\s*script/i.test(clean), `${chapter.href} 不应残留脚本`);
    assert.ok(!/javascript:/i.test(clean), `${chapter.href} 不应残留 javascript:`);

    const text = toPlainText(clean);
    assert.ok(text.length > 0, `${chapter.href} 应有纯文本`);
    textTotal += text.length;

    const hit = highlightTerms(clean, "Alice");
    aliceHits += hit.count;
    if (hit.count > 0) assert.ok(hit.html.includes('<mark class="qm-hit">Alice</mark>'));
    // 高亮不能改动标签数量。
    assert.equal((hit.html.match(/</g) || []).length, (clean.match(/</g) || []).length + hit.count * 2);

    const abs = absolutize(clean, book.rootDir);
    assert.ok(!/(?:src|href)="\.\./.test(abs), `${chapter.href} 不应残留 ../ 相对路径`);
  }
  assert.ok(textTotal > 10000, `全文纯文本应可观，实际 ${textTotal}`);
  assert.ok(aliceHits > 50, `“Alice” 应大量命中，实际 ${aliceHits}`);
});

// ── 3. 合成 EPUB：../ 与 %20 归一化 ────────────────────────────────────────

test("epub：目录 href 的 ../ 与 %20 归一化到 zip 根坐标系", async () => {
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-1</dc:identifier>
    <dc:title>测试书 &amp; 示例</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="../OEBPS/text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="img/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2" linear="no"/></spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href='../text/ch%201.xhtml#p1'>第一章 &quot;引号&quot;</a></li>
  <li><a href="../text/ch2.xhtml">第二章</a>
    <ol><li><a href="../text/ch2.xhtml#s1">第一节</a></li></ol>
  </li>
</ol></nav></body></html>`;

  const book = await parseEpub(makeZip([
    { name: "mimetype", data: "application/epub+zip", method: "store" },
    { name: "META-INF/", data: "" },
    { name: "META-INF/container.xml", data: container, method: "deflate" },
    { name: "OEBPS/", data: "" },
    { name: "OEBPS/package.opf", data: opf, method: "deflate" },
    { name: "OEBPS/nav/nav.xhtml", data: nav, method: "deflate" },
    { name: "OEBPS/text/ch 1.xhtml", data: "<html><body><h1>第一章</h1></body></html>", method: "deflate" },
    { name: "OEBPS/text/ch2.xhtml", data: "<html><body><h1>第二章</h1></body></html>", method: "deflate" },
    { name: "OEBPS/img/cover.jpg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), method: "store" },
  ]));

  assert.equal(book.title, "测试书 & 示例");
  assert.equal(book.author, "测试作者");
  assert.equal(book.rootDir, "OEBPS/");
  assert.equal(book.coverHref, "OEBPS/img/cover.jpg");

  // spine 顺序、../ 归一化、%20 解码、linear="no" 标记。
  assert.deepEqual(book.chapters.map((chapter) => chapter.href), [
    "OEBPS/text/ch 1.xhtml",
    "OEBPS/text/ch2.xhtml",
  ]);
  assert.equal(book.chapters[0].linear, true);
  assert.equal(book.chapters[1].linear, false);
  assert.equal(book.chapters[0].label, "第一章");

  // 目录 href 与 chapters 同一坐标系，片段保留。
  assert.equal(book.toc.length, 2);
  assert.equal(book.toc[0].label, '第一章 "引号"');
  assert.equal(book.toc[0].href, "OEBPS/text/ch 1.xhtml#p1");
  assert.equal(book.toc[0].children.length, 0);
  assert.equal(book.toc[1].label, "第二章");
  assert.equal(book.toc[1].href, "OEBPS/text/ch2.xhtml");
  assert.equal(book.toc[1].children.length, 1);
  assert.equal(book.toc[1].children[0].href, "OEBPS/text/ch2.xhtml#s1");

  const hrefs = new Set(book.chapters.map((chapter) => chapter.href));
  const leaves = [book.toc[0], ...book.toc[1].children];
  for (const leaf of leaves) assert.ok(hrefs.has(leaf.href.split("#")[0]), `${leaf.href} 应命中章节`);

  // 资源表与 resourceBytes 都以 zip 根路径为准。
  assert.deepEqual(book.resources["OEBPS/img/cover.jpg"], {
    mediaType: "image/jpeg",
    href: "OEBPS/img/cover.jpg",
  });
  assert.deepEqual(Array.from(await book.resourceBytes("OEBPS/img/cover.jpg")), [0xff, 0xd8, 0xff, 0xd9]);
  // 也接受相对 OPF 目录的写法。
  assert.deepEqual(Array.from(await book.resourceBytes("img/cover.jpg")), [0xff, 0xd8, 0xff, 0xd9]);
});

test("epub：EPUB2 的 NCX 目录与缺 spine 的报错", async () => {
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>NCX 书</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>第一章 &amp; 开端</text></navLabel><content src="text/ch1.xhtml"/>
      <navPoint id="n2"><navLabel><text>小节</text></navLabel><content src="text/ch1.xhtml#s"/></navPoint>
    </navPoint>
    <navPoint id="n3"><navLabel><text>第二章</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
  </navMap></ncx>`;

  const book = await parseEpub(makeZip([
    { name: "META-INF/container.xml", data: container, method: "deflate" },
    { name: "content.opf", data: opf, method: "deflate" },
    { name: "toc.ncx", data: ncx, method: "deflate" },
    { name: "text/ch1.xhtml", data: "<p>a</p>", method: "deflate" },
    { name: "text/ch2.xhtml", data: "<p>b</p>", method: "deflate" },
  ]));

  assert.equal(book.rootDir, "");
  assert.equal(book.title, "NCX 书");
  assert.equal(book.chapters.length, 2);
  assert.equal(book.toc[0].label, "第一章 & 开端");
  assert.equal(book.toc[0].href, "text/ch1.xhtml");
  assert.equal(book.toc[0].children.length, 1);
  assert.equal(book.toc[0].children[0].href, "text/ch1.xhtml#s");
  assert.equal(book.toc[1].href, "text/ch2.xhtml");
  // 没有声明封面时 coverHref 必须是 null，而不是 undefined。
  assert.equal(book.coverHref, null);

  // 缺少 container.xml。
  await assert.rejects(
    parseEpub(makeZip([{ name: "a.txt", data: "x" }])),
    /缺少 META-INF\/container\.xml/,
  );

  // OPF 里没有 spine。
  await assert.rejects(
    parseEpub(makeZip([
      { name: "META-INF/container.xml", data: container },
      { name: "content.opf", data: `<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="x">t</dc:title></metadata><manifest/></package>` },
    ])),
    /OPF 里找不到 spine/,
  );

  // 章节文件缺失。
  await assert.rejects(
    parseEpub(makeZip([
      { name: "META-INF/container.xml", data: container },
      { name: "content.opf", data: opf },
    ])),
    /spine 里没有可读取的章节/,
  );
});

// ── 4. html.js ────────────────────────────────────────────────────────────

test("html：sanitizeHtml 移除脚本、事件属性与 javascript: 链接", () => {
  const dirty = [
    '<p onclick="alert(1)" class="keep">hi<script>alert(2)</script></p>',
    '<style>p{color:red}</style>',
    '<a href="javascript:alert(3)">bad</a>',
    '<a href="http://example.com/ok">good</a>',
    '<a href="#note">anchor</a>',
    '<img src="x.png" onerror="alert(4)" alt="图">',
    '<iframe src="https://evil"></iframe>',
    '<span data-evil="1" aria-hidden="true">s</span>',
    '<div style="background:url(javascript:alert(5))">d</div>',
  ].join("");

  const clean = sanitizeHtml(dirty);
  assert.ok(!/script/i.test(clean), "不应残留 script");
  assert.ok(!/onclick|onerror|onload/i.test(clean), "不应残留事件属性");
  assert.ok(!/javascript:/i.test(clean), "不应残留 javascript: 协议");
  assert.ok(!/iframe|style>/i.test(clean), "不应残留 iframe/style");
  assert.ok(!/data-evil/.test(clean), "不应保留 data- 属性");
  assert.ok(clean.includes('<p class="keep">hi</p>'), `段落与 class 应保留：${clean}`);
  assert.ok(clean.includes('<a href="http://example.com/ok">good</a>'), "http 链接应保留");
  assert.ok(clean.includes('<a href="#note">anchor</a>'), "锚点应保留");
  assert.ok(clean.includes('<img src="x.png" alt="图">'), "img 的 src/alt 应保留");
  assert.ok(clean.includes('aria-hidden="true"'), "aria-* 应保留");
  assert.ok(clean.includes('<span aria-hidden="true">s</span>'), "span 应保留");
  assert.ok(clean.includes("<div>d</div>"), "style 被删后 div 保留");

  // 实体与标签语义不能被打乱。
  const entities = sanitizeHtml('<p title="a &amp; b">x &lt; y</p>');
  assert.equal(entities, '<p title="a &amp; b">x &lt; y</p>');

  // SVG 保留基础图形，删掉脚本。
  const svg = sanitizeHtml('<svg viewBox="0 0 10 10"><path d="M0 0L1 1" fill="red"/><script>alert(1)</script></svg>');
  assert.ok(svg.includes('<svg viewBox="0 0 10 10">'), svg);
  assert.ok(svg.includes('<path d="M0 0L1 1" fill="red">'), svg);
  assert.ok(!/script/i.test(svg), svg);
});

test("html：extractBody 取 body 内容，无 body 的片段原样返回", () => {
  const doc = '<html><head><title>t</title></head><body class="c"><p onclick="x()">hi</p><script>alert(1)</script></body></html>';
  assert.equal(extractBody(doc), "<p>hi</p>");

  // 没有 </body> 时取到结尾。
  assert.equal(extractBody("<html><body><p>tail</p>"), "<p>tail</p>");

  // 关键要求：没有 <body> 的片段返回原文。
  const fragment = '<p class="f">片段 &amp; 原样</p>';
  assert.equal(extractBody(fragment), fragment);
  assert.equal(extractBody("纯文本片段"), "纯文本片段");

  // 大小写不敏感。
  assert.equal(extractBody("<BODY><em>a</em></BODY>"), "<em>a</em>");
});

test("html：toPlainText 转块级换行、解实体、压空白", () => {
  const html = '<h1>标题</h1>\n<p>第一段 &amp; 第二句</p><p>  多余   空白  </p><div><span>行内</span></div>';
  const text = toPlainText(html);
  assert.equal(text, "标题\n第一段 & 第二句\n多余 空白\n行内");
  assert.equal(toPlainText("<p>a</p><p>b</p>"), "a\nb");
  assert.equal(toPlainText('<script>alert(1)</script><p>only</p>'), "only");
  assert.equal(toPlainText(""), "");
});

test("html：highlightTerms 大小写不敏感、中文子串、不破坏标签", () => {
  const one = highlightTerms("<p>Alice and alice and ALICE</p>", "alice");
  assert.equal(one.count, 3);
  assert.equal(
    one.html,
    '<p><mark class="qm-hit">Alice</mark> and <mark class="qm-hit">alice</mark> and <mark class="qm-hit">ALICE</mark></p>',
  );

  const zh = highlightTerms("<p>道可道，非常道。</p>", "道");
  assert.equal(zh.count, 3);
  assert.ok(zh.html.includes('<mark class="qm-hit">道</mark>'));

  // 属性里的命中不能被包裹，标签结构必须原样。
  const attr = highlightTerms('<a href="cat" title="cat">cat</a>', "cat");
  assert.equal(attr.count, 1);
  assert.equal(attr.html, '<a href="cat" title="cat"><mark class="qm-hit">cat</mark></a>');

  // 实体与正则特殊字符：`&amp;` 按 `&` 匹配且输出被转义。
  const ent = highlightTerms("<p>a &amp; b</p>", "&");
  assert.equal(ent.count, 1);
  assert.equal(ent.html, "<p>a <mark class=\"qm-hit\">&amp;</mark> b</p>");
  assert.equal(highlightTerms("<p>x</p>", ".*").count, 0);
  assert.deepEqual(highlightTerms("<p>x</p>", "   "), { html: "<p>x</p>", count: 0 });
});

test("html：absolutize 与 rewriteResources 按 baseDir 解析 zip 路径", () => {
  const html = '<img src="../img/a.png" alt="a"><a href="ch2.xhtml#x">n</a><a href="http://e.com/z">e</a><a href="#top">t</a><img src="data:image/png;base64,AA">';
  const abs = absolutize(html, "OEBPS/text/");
  assert.ok(abs.includes('src="OEBPS/img/a.png"'), abs);
  assert.ok(abs.includes('href="OEBPS/text/ch2.xhtml#x"'), abs);
  assert.ok(abs.includes('href="http://e.com/z"'), abs);
  assert.ok(abs.includes('href="#top"'), abs);
  assert.ok(abs.includes('src="data:image/png;base64,AA"'), abs);

  const seen = [];
  const rewritten = rewriteResources(
    '<img src="../img/a.png"><img src="../img/b.png"><a href="ch2.xhtml">n</a><img srcset="../img/a.png 1x, ../img/b.png 2x">',
    "OEBPS/text/",
    (zipPath) => {
      seen.push(zipPath);
      return zipPath.endsWith("a.png") ? "blob:a" : null;
    },
  );
  assert.ok(rewritten.includes('src="blob:a"'), rewritten);
  // resolve 返回 null 时保留原值，不丢信息。
  assert.ok(rewritten.includes('src="../img/b.png"'), rewritten);
  // <a href> 属于导航而不是资源，rewriteResources 不动它。
  assert.ok(rewritten.includes('<a href="ch2.xhtml">n</a>'), rewritten);
  assert.ok(rewritten.includes('srcset="blob:a 1x, ../img/b.png 2x"'), rewritten);
  assert.ok(seen.includes("OEBPS/img/b.png"));
  assert.ok(seen.includes("OEBPS/img/a.png"));

  // baseDir 传目录或文件路径都要能用。
  assert.equal(absolutize('<img src="a.png">', "OEBPS/text"), '<img src="OEBPS/text/a.png">');
  assert.equal(absolutize('<img src="a.png">', ""), '<img src="a.png">');
});
