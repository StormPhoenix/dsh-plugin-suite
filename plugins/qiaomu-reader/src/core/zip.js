/**
 * ZIP 归档读取 —— EPUB 容器解析的底层。
 *
 * 目标是「零依赖、双端可跑」：只用标准 JS 与 Node/浏览器共有的全局
 * （`TextDecoder`、`Uint8Array`、`DecompressionStream`），不引用
 * `window` / `document` / `navigator`，也不 import 任何第三方包，
 * 因此既能在 Node 的 `node --test` 下直接单测，也能原样进浏览器。
 *
 * 处理能力：
 * - 压缩方式 stored(0) 与 deflate(8)（deflate 用 `deflate-raw`）；
 * - 中央目录定位从文件尾部向前扫描 EOCD，容忍 zip 注释；
 * - 数据描述符（通用标志 bit 3）：本地头里的尺寸为 0，一律以中央目录为准；
 * - UTF-8 文件名标志（bit 11），未置位时也先按 UTF-8 试解，失败再退回 latin1；
 * - zip64 扩展字段与 `0xFFFFFFFF` 哨兵（能解析就解析，不能就给可读错误）；
 * - 每个条目的 CRC32 校验，失败抛出含条目名的错误。
 *
 * 条目名统一归一化：去掉开头的 `./` 与 `/`；以 `/` 结尾的目录项不进 entries。
 *
 * @module core/zip
 */

/** EOCD（中央目录结尾记录）签名。 */
const EOCD_SIG = 0x06054b50;
/** ZIP64 EOCD 记录签名。 */
const EOCD64_SIG = 0x06064b50;
/** ZIP64 EOCD 定位器签名。 */
const EOCD64_LOCATOR_SIG = 0x07064b50;
/** 中央目录条目签名。 */
const CEN_SIG = 0x02014b50;
/** 本地文件头签名。 */
const LOC_SIG = 0x04034b50;
/** zip64 用的 32 位哨兵值。 */
const SENTINEL32 = 0xffffffff;
/** EOCD 定长部分（22 字节）+ 注释长度上限。 */
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** 只解 UTF-8、遇到非法字节就抛错的解码器（用于挑编码）。 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
/** 宽松 UTF-8（正常读取正文用，非法字节替换为 U+FFFD）。 */
const LOOSE_UTF8 = new TextDecoder("utf-8");
/** 单字节编码兜底。 */
const LATIN1 = new TextDecoder("latin1");

/** CRC32 查表，首次使用时惰性构建。 */
let crcTable = null;

/**
 * 构建（或复用）CRC32 查表。
 * @returns {Uint32Array} 256 项查表
 */
function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/**
 * 计算 CRC32（与 zip 条目里存储的值一致）。
 * @param {Uint8Array} bytes 待校验字节
 * @returns {number} 无符号 32 位 CRC 值
 */
function crc32(bytes) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 读小端 16 位。
 * @param {Uint8Array} b 缓冲区
 * @param {number} o 偏移
 * @returns {number} 0..65535
 */
function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

/**
 * 读小端 32 位（无符号）。
 * @param {Uint8Array} b 缓冲区
 * @param {number} o 偏移
 * @returns {number} 0..4294967295
 */
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * 读小端 64 位并转成安全整数。
 * @param {Uint8Array} b 缓冲区
 * @param {number} o 偏移
 * @returns {number} 数值
 * @throws {Error} 超出 Number.MAX_SAFE_INTEGER 时抛出
 */
function u64(b, o) {
  const value = u32(b, o + 4) * 4294967296 + u32(b, o);
  if (value > Number.MAX_SAFE_INTEGER) throw new Error("ZIP64 条目长度超出可表示范围");
  return value;
}

/**
 * 归一化条目名：去掉开头的 `./` 与 `/`。
 * @param {string} name 原始条目名
 * @returns {string} 归一化后的条目名
 */
function normalizeName(name) {
  let value = String(name == null ? "" : name).replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.startsWith("/")) value = value.slice(1);
  return value;
}

/**
 * 按 UTF-8 标志与字节合法性挑编码解码条目名。
 * @param {Uint8Array} bytes 文件名字节
 * @param {boolean} utf8Flag 是否置了 bit 11
 * @returns {string} 文件名
 */
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return LOOSE_UTF8.decode(bytes);
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return LATIN1.decode(bytes);
  }
}

/**
 * 解析中央目录条目里的 zip64 扩展字段。
 * @param {Uint8Array} extra 扩展字段区
 * @param {{size?: boolean, compressedSize?: boolean, localOffset?: boolean}} need 哪些字段是哨兵
 * @returns {{size?: number, compressedSize?: number, localOffset?: number}} 解析结果
 */
function parseZip64Extra(extra, need) {
  let o = 0;
  while (o + 4 <= extra.length) {
    const id = u16(extra, o);
    const size = u16(extra, o + 2);
    o += 4;
    if (id === 0x0001) {
      let p = o;
      const out = {};
      if (need.size) {
        out.size = u64(extra, p);
        p += 8;
      }
      if (need.compressedSize) {
        out.compressedSize = u64(extra, p);
        p += 8;
      }
      if (need.localOffset) {
        out.localOffset = u64(extra, p);
        p += 8;
      }
      return out;
    }
    o += size;
  }
  return {};
}

/**
 * 从文件尾部向前找 EOCD。
 * @param {Uint8Array} bytes zip 字节
 * @returns {number} EOCD 起始偏移，找不到返回 -1
 */
function findEocd(bytes) {
  const min = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  for (let i = bytes.length - EOCD_MIN; i >= min; i -= 1) {
    if (u32(bytes, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 解析 zip64 EOCD（如果存在）。
 * @param {Uint8Array} bytes zip 字节
 * @param {number} eocdOffset EOCD 偏移
 * @returns {{totalEntries: number, cenSize: number, cenOffset: number} | null} zip64 记录
 */
function readZip64Eocd(bytes, eocdOffset) {
  const locator = eocdOffset - 20;
  if (locator < 0 || u32(bytes, locator) !== EOCD64_LOCATOR_SIG) return null;
  const offset = u64(bytes, locator + 8);
  if (offset + 56 > bytes.length || u32(bytes, offset) !== EOCD64_SIG) return null;
  return {
    totalEntries: u64(bytes, offset + 32),
    cenSize: u64(bytes, offset + 40),
    cenOffset: u64(bytes, offset + 48),
  };
}

/**
 * 解析中央目录，得到条目元数据表。
 * @param {Uint8Array} bytes zip 字节
 * @param {number} cenOffset 中央目录起始偏移
 * @param {number} totalEntries 条目数
 * @returns {Map<string, object>} 归一化条目名 -> 元数据
 */
function readCentralDirectory(bytes, cenOffset, totalEntries) {
  const map = new Map();
  let p = cenOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (p + 46 > bytes.length) throw new Error("ZIP 中央目录被截断");
    if (u32(bytes, p) !== CEN_SIG) throw new Error("ZIP 中央目录条目签名错误");
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    let compressedSize = u32(bytes, p + 20);
    let size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    let localOffset = u32(bytes, p + 42);
    const extraStart = p + 46 + nameLen;
    if (extraStart + extraLen > bytes.length) throw new Error("ZIP 中央目录扩展字段被截断");

    const need = {
      size: size === SENTINEL32,
      compressedSize: compressedSize === SENTINEL32,
      localOffset: localOffset === SENTINEL32,
    };
    if (need.size || need.compressedSize || need.localOffset) {
      const z64 = parseZip64Extra(bytes.subarray(extraStart, extraStart + extraLen), need);
      if (z64.size !== undefined) size = z64.size;
      if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
      if (z64.localOffset !== undefined) localOffset = z64.localOffset;
      if (size === SENTINEL32 || compressedSize === SENTINEL32 || localOffset === SENTINEL32) {
        throw new Error("ZIP64 条目的扩展字段缺少必要长度信息，暂不支持");
      }
    }

    const name = normalizeName(decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0));
    // 目录项不进 entries；但仍要推进游标。
    if (name && !name.endsWith("/")) {
      map.set(name, { name, size, compressedSize, method, flags, crc, localOffset });
    }
    p = extraStart + extraLen + commentLen;
  }
  return map;
}

/**
 * 用 DecompressionStream 做 raw deflate 解压。
 * 写入与读取必须并发，否则大条目的背压会让 write() 一直不 resolve。
 * @param {Uint8Array} input 压缩数据
 * @returns {Promise<Uint8Array>} 解压结果
 */
async function inflateRaw(input) {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const pending = writer.write(input).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await pending;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * ZIP 归档句柄。用 `openZip()` 创建，不要直接 new。
 */
class ZipArchive {
  /**
   * @param {Uint8Array} bytes 原始 zip 字节
   * @param {Map<string, object>} entries 中央目录条目表
   */
  constructor(bytes, entries) {
    this.bytes = bytes;
    this.entryMap = entries;
  }

  /**
   * 列出所有文件条目（不含目录）。
   * @returns {{name: string, size: number, compressedSize: number}[]} 条目摘要
   */
  entries() {
    return Array.from(this.entryMap.values(), (e) => ({
      name: e.name,
      size: e.size,
      compressedSize: e.compressedSize,
    }));
  }

  /**
   * 条目是否存在。
   * @param {string} name 条目名
   * @returns {boolean} 是否存在
   */
  has(name) {
    return this.entryMap.has(normalizeName(name));
  }

  /**
   * 读取并解压一个条目，带 CRC32 校验。
   * @param {string} name 条目名
   * @returns {Promise<Uint8Array | undefined>} 内容；不存在返回 undefined
   * @throws {Error} 加密、压缩方式不支持、解压失败或 CRC 不匹配时抛出
   */
  async read(name) {
    const entry = this.entryMap.get(normalizeName(name));
    if (!entry) return undefined;
    if (entry.flags & 0x0001) throw new Error(`zip 条目已加密，无法读取：${entry.name}`);
    if (entry.localOffset + 30 > this.bytes.length) throw new Error(`zip 本地头越界：${entry.name}`);
    if (u32(this.bytes, entry.localOffset) !== LOC_SIG) throw new Error(`zip 本地头签名错误：${entry.name}`);

    // 数据起点必须用本地头的 name/extra 长度：它与中央目录可能不一致。
    const nameLen = u16(this.bytes, entry.localOffset + 26);
    const extraLen = u16(this.bytes, entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (end > this.bytes.length) throw new Error(`zip 条目数据被截断：${entry.name}`);
    const raw = this.bytes.subarray(start, end);

    let data;
    if (entry.method === 0) data = raw.slice();
    else if (entry.method === 8) {
      try {
        data = await inflateRaw(raw);
      } catch (error) {
        throw new Error(`zip 条目解压失败：${entry.name}（${error && error.message ? error.message : "未知原因"}）`);
      }
    } else {
      throw new Error(`zip 条目使用了不支持的压缩方式 ${entry.method}：${entry.name}`);
    }

    if (data.length !== entry.size) {
      throw new Error(`zip 条目长度与中央目录不符：${entry.name}（期望 ${entry.size}，实际 ${data.length}）`);
    }
    const actual = crc32(data);
    if (actual !== entry.crc) {
      throw new Error(
        `zip 条目 CRC32 校验失败：${entry.name}（期望 0x${entry.crc.toString(16).padStart(8, "0")}，实际 0x${actual.toString(16).padStart(8, "0")}）`,
      );
    }
    return data;
  }

  /**
   * 读取并解压为 UTF-8 文本（自动去掉 BOM）。
   * @param {string} name 条目名
   * @returns {Promise<string | undefined>} 文本；不存在返回 undefined
   */
  async readText(name) {
    const data = await this.read(name);
    if (!data) return undefined;
    return LOOSE_UTF8.decode(data).replace(/^\uFEFF/, "");
  }
}

/**
 * 打开一个 zip（EPUB 就是 zip）。
 * @param {Uint8Array | ArrayBuffer | { buffer?: ArrayBuffer }} input zip 字节
 * @returns {Promise<ZipArchive>} 归档句柄
 * @throws {Error} 不是合法 zip、zip64 无法解析或中央目录损坏时抛出可读错误
 */
export async function openZip(input) {
  if (!input) throw new Error("zip 输入为空");
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw new Error("zip 输入必须是 Uint8Array 或 ArrayBuffer");
  if (bytes.length < EOCD_MIN) throw new Error("不是有效的 ZIP/EPUB：文件太小");

  const eocdOffset = findEocd(bytes);
  if (eocdOffset < 0) throw new Error("不是有效的 ZIP/EPUB：找不到中央目录结尾记录（EOCD）");

  let totalEntries = u16(bytes, eocdOffset + 10);
  let cenSize = u32(bytes, eocdOffset + 12);
  let cenOffset = u32(bytes, eocdOffset + 16);

  if (totalEntries === 0xffff || cenSize === SENTINEL32 || cenOffset === SENTINEL32) {
    const z64 = readZip64Eocd(bytes, eocdOffset);
    if (!z64) throw new Error("ZIP64 归档不受支持：缺少 ZIP64 EOCD 记录");
    totalEntries = z64.totalEntries;
    cenSize = z64.cenSize;
    cenOffset = z64.cenOffset;
  }

  if (cenOffset + cenSize > bytes.length) throw new Error("不是有效的 ZIP/EPUB：中央目录越界");
  const entries = readCentralDirectory(bytes, cenOffset, totalEntries);
  return new ZipArchive(bytes, entries);
}