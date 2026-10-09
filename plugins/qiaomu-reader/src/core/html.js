/**
 * 电子书 HTML/XHTML 处理 —— 提取、清洗、纯文本化、高亮与资源路径改写。
 *
 * 这里全部是纯字符串/正则运算，不依赖 `DOMParser`，也不引用
 * `window` / `document` / `navigator`，因此 Node 与浏览器行为完全一致。
 * 页面注入 DOM 之前必须经过 `sanitizeHtml`：书是外部输入，脚本、事件属性、
 * `javascript:` 链接一律不能进宿主页面。
 *
 * 路径坐标系：所有「绝对」路径都是 **zip 根路径**（如 `OEBPS/text/ch1.xhtml`），
 * 不含前导 `/`、无 `../`、已完成 URL 解码；片段（`#frag`）保留在末尾。
 *
 * @module core/html
 */

/** 允许保留的标签白名单。 */
const ALLOWED_TAGS = new Set([
  "p", "div", "span", "br", "hr", "em", "strong", "i", "b", "u", "s", "sub", "sup",
  "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "img", "figure", "figcaption", "a", "section", "article", "aside", "nav",
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "defs", "use", "symbol", "desc", "clippath", "mask",
  "lineargradient", "radialgradient", "stop",
]);

/** 允许保留的属性白名单（`aria-*` 单独放行）。 */
const ALLOWED_ATTRS = new Set([
  "class", "id", "style", "title", "alt", "src", "href", "width", "height",
  "colspan", "rowspan", "srcset", "epub:type", "role",
]);

/** SVG 需要保留的表现/几何属性，否则图形画不出来。 */
const SVG_ATTRS = new Set([
  "viewbox", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "fill-rule", "clip-rule", "opacity", "transform", "points", "cx", "cy", "r", "rx", "ry",
  "x", "y", "x1", "y1", "x2", "y2", "xmlns", "preserveaspectratio", "gradientunits",
  "offset", "stop-color", "stop-opacity", "text-anchor", "font-size", "font-family",
  "font-weight", "clip-path", "mask", "xlink:href", "aria-hidden",
]);

/** 标签本身要删掉、连内容一起删的容器。 */
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template",
  "head", "title", "link", "meta", "base", "form", "input", "textarea", "select",
  "button", "canvas", "audio", "video", "source", "track", "frame", "frameset",
  "applet", "param", "foreignobject",
]);

/** 自闭合（空）标签。 */
const VOID_TAGS = new Set(["br", "hr", "img", "wbr", "col", "area", "base", "input", "meta", "link", "source", "track", "embed"]);

/** 实体表：数值实体另外处理。 */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00b7",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  laquo: "\u00ab", raquo: "\u00bb", copy: "\u00a9", reg: "\u00ae", deg: "\u00b0",
  times: "\u00d7", divide: "\u00f7", shy: "\u00ad", emsp: "\u2003", ensp: "\u2002",
  thinsp: "\u2009", bull: "\u2022", sect: "\u00a7", para: "\u00b6", dagger: "\u2020",
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
 * 解码 XML/HTML 实体。
 * @param {string} text 含实体的文本
 * @returns {string} 解码后的文本
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
 * 转义文本节点（`&` 先转，避免二次转义）。
 * @param {string} text 原始文本
 * @returns {string} 可安全插入 HTML 的文本
 */
function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 转义属性值。
 * @param {string} value 原始值
 * @returns {string} 可安全放进双引号属性的值
 */
function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 转义正则表达式里的特殊字符。
 * @param {string} text 原串
 * @returns {string} 可放进 RegExp 的字面量
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从一个 `<` 之后找到配对的 `>`，跳过引号内的 `>`。
 * @param {string} html 源串
 * @param {number} from 起始下标
 * @returns {number} `>` 的下标，找不到返回 -1
 */
function findTagEnd(html, from) {
  let quote = "";
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

/**
 * 解析标签内的属性（单双引号都支持，值里的实体先解码）。
 * @param {string} source 属性区原文
 * @returns {[string, string][]} 属性键值对（同名只保留第一个）
 */
function parseAttrs(source) {
  const out = [];
  const seen = new Set();
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    out.push([name, raw === undefined ? "" : decodeEntities(raw)]);
  }
  return out;
}

/**
 * 把 HTML 拆成「标签」与「文本」两类 token；标签原样保留以便无损回写。
 * @param {string} html 源串
 * @returns {{type: string, raw?: string, name?: string, lower?: string, closing?: boolean, selfClose?: boolean, attrs?: [string, string][], value?: string}[]} token 列表
 */
function tokenize(html) {
  const tokens = [];
  const source = String(html);
  const n = source.length;
  let i = 0;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      tokens.push({ type: "text", value: source.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: "text", value: source.slice(i, lt) });
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      const stop = end < 0 ? n : end + 3;
      tokens.push({ type: "raw", raw: source.slice(lt, stop) });
      i = stop;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      const stop = end < 0 ? n : end;
      tokens.push({ type: "text", value: source.slice(lt + 9, stop) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt);
      const stop = end < 0 ? n : end + 1;
      tokens.push({ type: "raw", raw: source.slice(lt, stop) });
      i = stop;
      continue;
    }
    const gt = findTagEnd(source, lt + 1);
    if (gt < 0) {
      tokens.push({ type: "text", value: source.slice(lt) });
      break;
    }
    const raw = source.slice(lt, gt + 1);
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;
    const closing = inner[0] === "/";
    const selfClose = /\/\s*$/.test(inner);
    const body = closing ? inner.slice(1) : selfClose ? inner.replace(/\/\s*$/, "") : inner;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) {
      tokens.push({ type: "raw", raw });
      continue;
    }
    tokens.push({
      type: "tag",
      raw,
      name: m[1],
      lower: m[1].toLowerCase(),
      closing,
      selfClose,
      attrs: parseAttrs(body.slice(m[0].length)),
    });
  }
  return tokens;
}

/**
 * 判断 URL 是否危险（`javascript:` 等），忽略控制字符与空白混淆。
 * @param {string} url 原始 URL
 * @returns {boolean} 是否必须丢弃
 */
function isDangerousUrl(url) {
  const cleaned = String(url).replace(/[\u0000-\u0020\u00a0\u2028\u2029]/g, "").toLowerCase();
  return cleaned.startsWith("javascript:") || cleaned.startsWith("vbscript:") || cleaned.startsWith("data:text/html");
}

/**
 * 过滤 srcset 里的危险候选。
 * @param {string} value srcset 值
 * @returns {string} 过滤后的值
 */
function filterSrcset(value) {
  return String(value)
    .split(",")
    .filter((part) => part.trim() && !isDangerousUrl(part.trim().split(/\s+/)[0] || ""))
    .join(", ");
}

/**
 * 按白名单过滤属性并回写。
 * @param {[string, string][]} attrs 原始属性
 * @returns {string} 形如 ` class="x" href="y"` 的片段
 */
function renderAttrs(attrs) {
  let out = "";
  for (const [name, value] of attrs || []) {
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) continue;
    const allowed = ALLOWED_ATTRS.has(lower) || SVG_ATTRS.has(lower) || lower.startsWith("aria-");
    if (!allowed) continue;
    let final = value;
    if (lower === "href" || lower === "src" || lower.endsWith(":href")) {
      if (isDangerousUrl(final)) continue;
    } else if (lower === "srcset") {
      final = filterSrcset(final);
      if (!final) continue;
    } else if (lower === "style") {
      // style 里不允许 CSS 表达式与 javascript: 伪协议。
      if (/expression\s*\(|javascript\s*:|url\s*\(\s*['"]?\s*javascript/i.test(final)) continue;
    }
    out += ` ${name}="${escapeAttr(final)}"`;
  }
  return out;
}

/**
 * 归一化目录字符串：`OEBPS/text` 与 `OEBPS/text/` 等价。
 * @param {string} baseDir 目录
 * @returns {string} 以 `/` 结尾的目录（根目录为 ""）
 */
function dirOf(baseDir) {
  const value = String(baseDir == null ? "" : baseDir).replace(/\\/g, "/").trim();
  if (!value || value === ".") return "";
  return value.endsWith("/") ? value : `${value}/`;
}

/**
 * 容错的 URL 解码。
 * @param {string} value 已编码的片段
 * @returns {string} 解码结果（失败时原样返回）
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 把相对路径按 `dir` 解析成 zip 根路径（归一化 `../`）。
 * @param {string} dir 已归一化为以 `/` 结尾的目录
 * @param {string} href 相对路径（可带 `#frag`、`?query`）
 * @returns {string | null} zip 根路径；外部链接/纯片段返回 null
 */
function toZipPath(dir, href) {
  const value = String(href == null ? "" : href).trim();
  if (!value) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("#")) return null;
  if (value.startsWith("?")) return null;

  const hashAt = value.indexOf("#");
  const frag = hashAt >= 0 ? value.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = noHash.indexOf("?");
  const query = queryAt >= 0 ? noHash.slice(queryAt) : "";
  const noQuery = queryAt >= 0 ? noHash.slice(0, queryAt) : noHash;

  const decoded = safeDecode(noQuery).replace(/\\/g, "/");
  const parts = decoded.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (!parts.length) return null;
  return parts.join("/") + query + frag;
}

/**
 * 提取 body 内 HTML（无 `<body>` 则整段原样返回），
 * 并移除 script/style/link/iframe/object/embed 与事件属性。
 * @param {string} xhtml 章节 XHTML
 * @returns {string} body 内容（未做白名单清洗）
 */
export function extractBody(xhtml) {
  if (typeof xhtml !== "string") return "";
  const open = /<body\b[^>]*>/i.exec(xhtml);
  if (!open) return xhtml;
  const start = open.index + open[0].length;
  const rest = xhtml.slice(start);
  const close = /<\/body\s*>/i.exec(rest);
  const inner = close ? rest.slice(0, close.index) : rest;
  let out = inner;
  out = out.replace(/<\s*(script|style|iframe|object|noscript|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*(link|base|embed|meta|input)\b[^>]*>/gi, "");
  out = out.replace(/<\s*\/?\s*(script|style|iframe|object|noscript|template|link|base|embed)\b[^>]*>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return out;
}

/**
 * 深度清洗：白名单标签与属性，删除脚本类内容与危险 URL。
 * @param {string} html 待清洗的 HTML
 * @returns {string} 干净 HTML 字符串
 */
export function sanitizeHtml(html) {
  if (typeof html !== "string" || !html) return "";
  const out = [];
  const stack = [];
  let dropDepth = 0;
  for (const token of tokenize(html)) {
    if (token.type === "text") {
      // 文本节点可能已经含实体（`&amp;`），先解码再统一转义，避免二次转义。
      if (!dropDepth) out.push(escapeText(decodeEntities(token.value)));
      continue;
    }
    if (token.type === "raw") continue;
    const lower = token.lower;
    if (token.closing) {
      if (DROP_CONTENT.has(lower)) {
        if (dropDepth > 0) dropDepth -= 1;
        continue;
      }
      if (!ALLOWED_TAGS.has(lower)) continue;
      const at = stack.lastIndexOf(lower);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    if (DROP_CONTENT.has(lower)) {
      if (!token.selfClose && !VOID_TAGS.has(lower)) dropDepth += 1;
      continue;
    }
    if (dropDepth > 0) continue;
    if (!ALLOWED_TAGS.has(lower)) continue;
    const attrs = renderAttrs(token.attrs);
    if (VOID_TAGS.has(lower) || token.selfClose) {
      out.push(`<${lower}${attrs}>`);
      continue;
    }
    out.push(`<${lower}${attrs}>`);
    stack.push(lower);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

/**
 * 纯文本化：块级标签转换行、解实体、压缩空白（供搜索与 Agent 读取）。
 * @param {string} html 源 HTML
 * @returns {string} 纯文本
 */
export function toPlainText(html) {
  if (typeof html !== "string" || !html) return "";
  let text = html;
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, " ");
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|dd|dt|table|thead|tbody|figure|figcaption|header|footer|ul|ol|dl|nav|aside|main|td|th)\s*>/gi, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<[^>]*>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{2,}/g, "\n");
  return text.trim();
}

/**
 * 用 `<mark class="qm-hit">` 包裹匹配串做搜索高亮（大小写不敏感，中文按子串）。
 * 只在文本节点里匹配并转义，绝不改动原有标签。
 * @param {string} html 源 HTML
 * @param {string} query 查询串
 * @returns {{html: string, count: number}} 高亮后的 HTML 与命中数
 */
export function highlightTerms(html, query) {
  const source = typeof html === "string" ? html : "";
  const needle = typeof query === "string" ? query.trim() : "";
  if (!source || !needle) return { html: source, count: 0 };
  const re = new RegExp(escapeRegExp(needle), "gi");
  const out = [];
  let count = 0;
  for (const token of tokenize(source)) {
    if (token.type === "raw") {
      out.push(token.raw);
      continue;
    }
    if (token.type === "tag") {
      out.push(token.raw);
      continue;
    }
    const plain = decodeEntities(token.value);
    re.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = re.exec(plain))) {
      if (!m[0]) {
        re.lastIndex += 1;
        continue;
      }
      out.push(escapeText(plain.slice(last, m.index)));
      out.push(`<mark class="qm-hit">${escapeText(m[0])}</mark>`);
      last = m.index + m[0].length;
      count += 1;
    }
    out.push(escapeText(plain.slice(last)));
  }
  return { html: out.join(""), count };
}

/**
 * 给相对路径补基址：把 `src`/`href` 的相对值变成 zip 根路径。
 * @param {string} html 源 HTML
 * @param {string} baseDir 当前文档所在目录
 * @returns {string} 改写后的 HTML
 */
export function absolutize(html, baseDir) {
  if (typeof html !== "string" || !html) return "";
  const dir = dirOf(baseDir);
  return html.replace(/(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi, (match, pre, quote, value) => {
    const next = toZipPath(dir, value);
    return next == null ? match : `${pre}${quote}${next}${quote}`;
  });
}

/**
 * 把 `src` / `srcset` / `poster` / `xlink:href` 等资源引用交给 `resolve` 换成可注入 URL。
 * `resolve` 返回 null 时保留原值（信息不丢，交给上层决定）。
 * @param {string} html 源 HTML
 * @param {string} baseDir 当前文档所在目录
 * @param {(zipPath: string) => string | null} resolve 资源路径解析函数
 * @returns {string} 改写后的 HTML
 */
export function rewriteResources(html, baseDir, resolve) {
  if (typeof html !== "string" || !html) return "";
  const dir = dirOf(baseDir);
  const fn = typeof resolve === "function" ? resolve : () => null;
  let out = html.replace(/(\s(?:src|poster|xlink:href)\s*=\s*)(["'])([^"']*)\2/gi, (match, pre, quote, value) => {
    const zipPath = toZipPath(dir, value);
    if (zipPath == null) return match;
    const resolved = fn(zipPath);
    return typeof resolved === "string" && resolved ? `${pre}${quote}${resolved}${quote}` : match;
  });
  out = out.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (match, pre, quote, value) => {
    let changed = false;
    const next = value
      .split(",")
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return "";
        const spaceAt = trimmed.search(/\s/);
        const url = spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt);
        const descriptor = spaceAt < 0 ? "" : trimmed.slice(spaceAt);
        const zipPath = toZipPath(dir, url);
        if (zipPath == null) return trimmed;
        const resolved = fn(zipPath);
        if (typeof resolved === "string" && resolved) {
          changed = true;
          return `${resolved}${descriptor}`;
        }
        return trimmed;
      })
      .filter(Boolean)
      .join(", ");
    return changed ? `${pre}${quote}${next}${quote}` : match;
  });
  return out;
}