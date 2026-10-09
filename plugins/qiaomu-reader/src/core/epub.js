/**
 * EPUB 解析 —— 从 zip 字节构造出可供阅读器使用的书对象。
 *
 * 完全不使用 `DOMParser`（Node 里没有），而是自带一个宽松的标记扫描器：
 * 只关心标签、属性与文本，能容忍未闭合标签、单双引号、命名空间前缀、
 * 注释、CDATA 与 XML 声明，足够解析 container.xml / OPF / nav / NCX。
 *
 * 路径坐标系：所有对外的 href 都是 **zip 根路径**（如 `EPUB/text/ch1.xhtml`），
 * 已展开 `../`、已做 URL 解码，便于 reader 层与 chapters 对齐。
 *
 * @module core/epub
 */

import { openZip } from "./zip.js";

/** 需要自动闭合的标签（宽松容错，主要针对不太规范的 nav/XHTML）。 */
const AUTO_CLOSE = new Set(["li", "p", "td", "th", "tr", "dt", "dd", "option"]);

/** XML 里常见的空元素。 */
const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "input", "area", "base", "col", "embed", "source", "track", "wbr"]);

/** 实体表：数值实体另外处理。 */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00b7",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  laquo: "\u00ab", raquo: "\u00bb", copy: "\u00a9", reg: "\u00ae", deg: "\u00b0",
  times: "\u00d7", divide: "\u00f7", shy: "\u00ad", emsp: "\u2003", ensp: "\u2002",
  thinsp: "\u2009", bull: "\u2022", sect: "\u00a7", para: "\u00b6",
};

/**
 * 把码点安全地转成字符（非法码点返回 U+FFFD）。
 * @param {number} code 码点
 * @returns {string} 字符
 */
function fromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(code);
}

/**
 * 解码 XML 实体（`&amp;` `&#39;` `&#xNN;` 等）。
 * @param {string} text 含实体的文本
 * @returns {string} 解码结果
 */
function decodeEntities(text) {
  if (!text || text.indexOf("&") < 0) return text;
  return String(text).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const value = NAMED_ENTITIES[body];
    return value === undefined ? match : value;
  });
}

/**
 * 取标签/属性的本地名（去掉命名空间前缀）。
 * @param {string} name 原始名
 * @returns {string} 本地名（小写）
 */
function localName(name) {
  const value = String(name);
  const at = value.indexOf(":");
  return (at >= 0 ? value.slice(at + 1) : value).toLowerCase();
}

/**
 * 从一个 `<` 之后找到配对的 `>`，跳过引号内的 `>`。
 * @param {string} text 源串
 * @param {number} from 起始下标
 * @returns {number} `>` 的下标，找不到返回 -1
 */
function findTagEnd(text, from) {
  let quote = "";
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

/**
 * 解析标签内的属性（单双引号与无引号都支持，值先解实体）。
 * @param {string} source 属性区原文
 * @returns {Record<string, string>} 属性名 -> 值（同名保留第一个）
 */
function parseAttrs(source) {
  const out = Object.create(null);
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1];
    if (!name || name in out) continue;
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    out[name] = raw === undefined ? "" : decodeEntities(raw);
  }
  return out;
}

/**
 * 宽松标记扫描：把 XML/HTML 文本变成一棵节点树。
 * 文本节点形如 `{ name: '#text', text }`，元素节点形如 `{ name, attrs, children }`。
 * @param {string} source 源文本
 * @returns {object} 根节点（name 为 `#root`）
 */
function parseMarkup(source) {
  const root = { name: "#root", attrs: Object.create(null), children: [] };
  const stack = [root];
  const text = String(source || "");
  const n = text.length;
  let i = 0;
  const current = () => stack[stack.length - 1];
  const addText = (value) => {
    if (value) current().children.push({ name: "#text", text: decodeEntities(value), attrs: null, children: [] });
  };
  const addRawText = (value) => {
    if (value) current().children.push({ name: "#text", text: value, attrs: null, children: [] });
  };
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      addText(text.slice(i));
      break;
    }
    if (lt > i) addText(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      addRawText(text.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j += 1) {
        const ch = text[j];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        else if (ch === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) {
      addText(text.slice(lt));
      break;
    }
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;
    if (!inner) continue;
    if (inner[0] === "/") {
      const name = inner.slice(1).trim().split(/\s/)[0];
      if (!name) continue;
      const want = localName(name);
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (localName(stack[k].name) === want) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClose = /\/\s*$/.test(inner);
    const body = selfClose ? inner.replace(/\/\s*$/, "") : inner;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const node = { name: m[1], attrs: parseAttrs(body.slice(m[0].length)), children: [] };
    current().children.push(node);
    const lower = localName(node.name);
    if (!selfClose && !VOID_TAGS.has(lower)) {
      if (AUTO_CLOSE.has(lower) && stack.length > 1 && localName(current().name) === lower) stack.pop();
      stack.push(node);
    }
  }
  return root;
}

/**
 * 取节点属性（先按原样匹配，再按本地名匹配，兼容命名空间前缀）。
 * @param {object} node 节点
 * @param {string} name 属性名
 * @returns {string | null} 属性值，没有则 null
 */
function attr(node, name) {
  if (!node || !node.attrs) return null;
  if (name in node.attrs) return node.attrs[name];
  const want = name.toLowerCase();
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === want) return node.attrs[key];
  }
  return null;
}

/**
 * 取直接子元素。
 * @param {object} node 父节点
 * @param {string} name 标签本地名
 * @returns {object[]} 子元素列表
 */
function childrenNamed(node, name) {
  if (!node || !node.children) return [];
  const want = name.toLowerCase();
  return node.children.filter((child) => child.name !== "#text" && localName(child.name) === want);
}

/**
 * 取第一个直接子元素。
 * @param {object} node 父节点
 * @param {string} name 标签本地名
 * @returns {object | null} 元素或 null
 */
function childNamed(node, name) {
  return childrenNamed(node, name)[0] || null;
}

/**
 * 深度优先找第一个后代元素（含自身）。
 * @param {object} node 起点
 * @param {string} name 标签本地名
 * @returns {object | null} 元素或 null
 */
function firstDescendant(node, name) {
  if (!node) return null;
  const want = name.toLowerCase();
  const walk = (current) => {
    if (current.name !== "#text" && localName(current.name) === want) return current;
    for (const child of current.children || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(node);
}

/**
 * 深度优先找所有后代元素（含自身）。
 * @param {object} node 起点
 * @param {string} name 标签本地名
 * @returns {object[]} 元素列表
 */
function descendantsNamed(node, name) {
  const out = [];
  const want = name.toLowerCase();
  const walk = (current) => {
    if (current.name !== "#text" && localName(current.name) === want) out.push(current);
    for (const child of current.children || []) walk(child);
  };
  if (node) walk(node);
  return out;
}

/**
 * 在 `li` 内找链接，但不进入嵌套列表（否则父项会抓到子项链接）。
 * @param {object} node 起点
 * @returns {object | null} `a` 元素或 null
 */
function findLinkOutsideNestedList(node) {
  for (const child of node.children || []) {
    if (child.name === "#text") continue;
    const lower = localName(child.name);
    if (lower === "ol" || lower === "ul") continue;
    if (lower === "a") return child;
    const found = findLinkOutsideNestedList(child);
    if (found) return found;
  }
  return null;
}

/**
 * 取节点下所有文本并解码压空白。
 * @param {object} node 节点
 * @returns {string} 文本
 */
function textOf(node) {
  if (!node) return "";
  if (node.name === "#text") return node.text || "";
  let out = "";
  for (const child of node.children || []) out += textOf(child);
  return out;
}

/**
 * 取节点文本并压缩空白（用于标题、目录项）。
 * @param {object} node 节点
 * @returns {string} 干净的文本
 */
function cleanTextOf(node) {
  return textOf(node).replace(/[\s\u00a0\u3000]+/g, " ").trim();
}

/**
 * 去掉标签与实体、压缩空白。
 * @param {string} html 源片段
 * @returns {string} 纯文本
 */
function stripToText(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))
    .replace(/[\s\u00a0\u3000]+/g, " ")
    .trim();
}

/**
 * 容错的 URL 解码。
 * @param {string} value 已编码的片段
 * @returns {string} 解码结果（失败原样返回）
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 归一化为以 `/` 结尾的目录（根目录为 ""）。
 * @param {string} path 路径或目录
 * @returns {string} 目录
 */
function dirOf(path) {
  const value = String(path == null ? "" : path).replace(/\\/g, "/");
  const at = value.lastIndexOf("/");
  return at < 0 ? "" : value.slice(0, at + 1);
}

/**
 * 把 href 相对 `baseDir` 解析成 zip 根路径。
 * @param {string} baseDir 基目录（以 `/` 结尾的目录，或文件路径）
 * @param {string} href 相对路径（可带 `#frag`）
 * @returns {string | null} zip 根路径；外部链接/纯片段返回 null
 */
function resolveFrom(baseDir, href) {
  if (href == null) return null;
  const value = String(href).trim();
  if (!value) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
  if (value.startsWith("//") || value.startsWith("#")) return null;

  const hashAt = value.indexOf("#");
  const frag = hashAt >= 0 ? value.slice(hashAt) : "";
  let core = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = core.indexOf("?");
  if (queryAt >= 0) core = core.slice(0, queryAt);

  const decoded = safeDecode(core).replace(/\\/g, "/");
  const base = String(baseDir == null ? "" : baseDir).replace(/\\/g, "/");
  const root = base.endsWith("/") ? base : dirOf(base);
  const parts = decoded.startsWith("/") ? [] : root.split("/").filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (!parts.length) return null;
  return parts.join("/") + frag;
}

/**
 * 归一化一个已经是 zip 路径的字符串。
 * @param {string} value 路径
 * @returns {string | null} 归一化结果
 */
function normalizeZipPath(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const decoded = safeDecode(raw.split("#")[0]).replace(/\\/g, "/");
  const parts = decoded.split("/").filter((part) => part && part !== ".");
  return parts.length ? parts.join("/") : null;
}

/**
 * 从章节 XHTML 猜章节名：优先 `<title>`，其次首个 `<h1..h3>`。
 * @param {string} xhtml 章节原文
 * @returns {string} 章节名（猜不到返回 ""）
 */
function chapterLabel(xhtml) {
  const source = String(xhtml || "");
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
  if (title) {
    const value = stripToText(title[1]);
    if (value) return value;
  }
  const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i.exec(source);
  if (heading) {
    const value = stripToText(heading[1]);
    if (value) return value;
  }
  return "";
}

/**
 * 解析 EPUB3 nav 文档里的目录。
 * @param {string} text nav 文档原文
 * @param {string} navPath nav 文档的 zip 路径
 * @returns {object[]} 目录项
 */
function parseNavDoc(text, navPath) {
  const doc = parseMarkup(text);
  const navs = descendantsNamed(doc, "nav");
  let target = navs.find((node) => String(attr(node, "type") || "").toLowerCase() === "toc") || null;
  if (!target) target = navs[0] || null;
  if (!target) {
    // 有些 nav 文档干脆没有 <nav>，退而求其次找 ol。
    const ol = firstDescendant(doc, "ol");
    return ol ? navListItems(ol, navPath) : [];
  }
  const ol = childNamed(target, "ol") || firstDescendant(target, "ol");
  return ol ? navListItems(ol, navPath) : [];
}

/**
 * 递归解析 nav 的 `ol > li` 列表。
 * @param {object} listNode ol/ul 节点
 * @param {string} basePath 当前文档 zip 路径
 * @returns {object[]} 目录项
 */
function navListItems(listNode, basePath) {
  const dir = dirOf(basePath);
  const out = [];
  for (const li of childrenNamed(listNode, "li")) {
    const link = findLinkOutsideNestedList(li);
    const label = link ? cleanTextOf(link) : "";
    const href = link ? resolveFrom(dir, attr(link, "href")) : null;
    const sub = childNamed(li, "ol") || childNamed(li, "ul");
    const children = sub ? navListItems(sub, basePath) : [];
    if (!label && !href && !children.length) continue;
    out.push({ label: label || "未命名", href: href || null, children });
  }
  return out;
}

/**
 * 解析 EPUB2 NCX 的 navMap。
 * @param {string} text ncx 原文
 * @param {string} ncxPath ncx 的 zip 路径
 * @returns {object[]} 目录项
 */
function parseNcxDoc(text, ncxPath) {
  const doc = parseMarkup(text);
  const navMap = firstDescendant(doc, "navMap");
  if (!navMap) return [];
  const dir = dirOf(ncxPath);
  const walk = (node) =>
    childrenNamed(node, "navPoint").map((point) => {
      const labelNode = firstDescendant(point, "navLabel");
      const textNode = labelNode ? firstDescendant(labelNode, "text") : null;
      const label = textNode ? cleanTextOf(textNode) : "";
      const content = childNamed(point, "content");
      const src = content ? attr(content, "src") : null;
      return {
        label: label || "未命名",
        href: src ? resolveFrom(dir, src) : null,
        children: walk(point),
      };
    });
  return walk(navMap);
}

/**
 * 按优先级挑选封面：`<meta name="cover">` → `properties="cover-image"` →
 * id 为 cover 的图片 → 文件名含 cover 的图片。必须是 zip 里真实存在的条目。
 * @param {object[]} items 清单条目
 * @param {object} metadataNode metadata 节点
 * @param {object} zip zip 句柄
 * @returns {string | null} 封面 zip 路径
 */
function pickCoverHref(items, metadataNode, zip) {
  const exists = (path) => !!path && zip.has(path);
  const isImage = (item) => /^image\//i.test(item.mediaType || "");

  for (const meta of metadataNode ? childrenNamed(metadataNode, "meta") : []) {
    if (String(attr(meta, "name") || "").toLowerCase() !== "cover") continue;
    const id = attr(meta, "content");
    if (!id) continue;
    const item = items.find((entry) => entry.id === id);
    if (item && exists(item.href)) return item.href;
  }
  for (const item of items) {
    if (/\bcover-image\b/.test(item.properties || "") && exists(item.href)) return item.href;
  }
  for (const item of items) {
    if (item.id === "cover" && isImage(item) && exists(item.href)) return item.href;
  }
  for (const item of items) {
    if (!isImage(item)) continue;
    const base = item.href.split("/").pop().toLowerCase();
    if (/cover/.test(base) && exists(item.href)) return item.href;
  }
  return null;
}

/**
 * 解析 EPUB 字节为一本书。
 * @param {Uint8Array | ArrayBuffer} bytes EPUB 文件字节
 * @returns {Promise<object>} EpubBook（见 docs/ARCHITECTURE.md 4.2）
 * @throws {Error} 缺少 container.xml / OPF / spine 或缺章节文件时抛出可读错误
 */
export async function parseEpub(bytes) {
  const zip = await openZip(bytes);

  if (!zip.has("META-INF/container.xml")) throw new Error("EPUB 解析失败：缺少 META-INF/container.xml");
  const containerText = await zip.readText("META-INF/container.xml");
  const container = parseMarkup(containerText);
  const rootfile = firstDescendant(container, "rootfile");
  // OCF 规定 full-path 相对容器（zip）根，而不是相对 META-INF/。
  const opfPath = rootfile ? resolveFrom("", attr(rootfile, "full-path")) : null;
  if (!opfPath) throw new Error("EPUB 解析失败：container.xml 里找不到 rootfile/@full-path");
  if (!zip.has(opfPath)) throw new Error(`EPUB 解析失败：OPF 文件不存在（${opfPath}）`);

  const opfText = await zip.readText(opfPath);
  const opf = parseMarkup(opfText);
  const pkg = firstDescendant(opf, "package") || opf;
  const rootDir = dirOf(opfPath);

  // ── metadata ───────────────────────────────────────────────────────────
  const metadataNode = firstDescendant(pkg, "metadata");
  const metadata = metadataNode || pkg;
  const title = cleanTextOf(firstDescendant(metadata, "title")) || "未命名书籍";
  const author = cleanTextOf(firstDescendant(metadata, "creator"));
  const language = cleanTextOf(firstDescendant(metadata, "language"));
  const publisher = cleanTextOf(firstDescendant(metadata, "publisher"));
  const description = cleanTextOf(firstDescendant(metadata, "description"));
  const identifier = cleanTextOf(firstDescendant(metadata, "identifier"));

  // ── manifest ───────────────────────────────────────────────────────────
  const manifestNode = firstDescendant(pkg, "manifest");
  const items = [];
  const resources = {};
  for (const item of childrenNamed(manifestNode, "item")) {
    const id = attr(item, "id") || "";
    const rawHref = attr(item, "href");
    const mediaType = attr(item, "media-type") || "";
    const properties = attr(item, "properties") || "";
    if (!rawHref) continue;
    const href = resolveFrom(rootDir, rawHref);
    if (!href) continue;
    items.push({ id, href, mediaType, properties });
    resources[href] = { mediaType, href };
  }

  // ── spine → chapters ───────────────────────────────────────────────────
  const spineNode = firstDescendant(pkg, "spine");
  if (!spineNode) throw new Error("EPUB 解析失败：OPF 里找不到 spine");
  const byId = new Map(items.map((item) => [item.id, item]));
  const chapters = [];
  for (const ref of childrenNamed(spineNode, "itemref")) {
    const idref = attr(ref, "idref");
    const item = idref ? byId.get(idref) : null;
    if (!item) continue;
    const xhtml = await zip.readText(item.href);
    if (xhtml == null) continue;
    chapters.push({
      index: chapters.length,
      href: item.href,
      id: item.id,
      mediaType: item.mediaType || "application/xhtml+xml",
      xhtml,
      linear: String(attr(ref, "linear") || "").toLowerCase() !== "no",
      label: chapterLabel(xhtml),
    });
  }
  if (!chapters.length) throw new Error("EPUB 解析失败：spine 里没有可读取的章节文件");

  // ── toc ────────────────────────────────────────────────────────────────
  let toc = [];
  const navItem = items.find((item) => /\bnav\b/.test(item.properties));
  if (navItem) {
    const navText = await zip.readText(navItem.href);
    if (navText) toc = parseNavDoc(navText, navItem.href);
  }
  if (!toc.length) {
    const ncxItem =
      items.find((item) => item.mediaType === "application/x-dtbncx+xml") ||
      items.find((item) => /\.ncx$/i.test(item.href)) ||
      byId.get(attr(spineNode, "toc") || "");
    if (ncxItem) {
      const ncxText = await zip.readText(ncxItem.href);
      if (ncxText) toc = parseNcxDoc(ncxText, ncxItem.href);
    }
  }
  if (!toc.length) {
    // 容错：没有任何目录文档时，用章节自身猜的名字兜底。
    toc = chapters.map((chapter) => ({
      label: chapter.label || `第 ${chapter.index + 1} 章`,
      href: chapter.href,
      children: [],
    }));
  }

  const coverHref = pickCoverHref(items, metadataNode, zip);

  return {
    title,
    author,
    language,
    publisher,
    description,
    identifier,
    chapters,
    toc,
    resources,
    coverHref,
    rootDir,
    /**
     * 读取原始资源（图片、CSS 等）。
     * @param {string} href zip 根路径或相对 OPF 目录的路径
     * @returns {Promise<Uint8Array | undefined>} 资源字节；找不到返回 undefined
     */
    async resourceBytes(href) {
      if (!href) return undefined;
      const candidates = [];
      const direct = normalizeZipPath(href);
      if (direct) candidates.push(direct);
      const relative = resolveFrom(rootDir, href);
      if (relative) candidates.push(relative);
      for (const candidate of new Set(candidates)) {
        if (zip.has(candidate)) return zip.read(candidate);
      }
      return undefined;
    },
  };
}