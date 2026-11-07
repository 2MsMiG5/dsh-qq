// 图片来源：给桥接提供「本地图库随机图」与「Pixeval 插图预览」两种图源。
//
// ── 为什么要单独一层（2026-10-25）
//
// 「图从哪来」和「图怎么发」是两件事，混在 bridge.js 里会同时得罪可测性和权限边界：
//   · 本地图库（默认 C:\Users\<user>\Pictures\绘画参考）递归约 1900 张图、11.7 GB、
//     单文件最大 36 MB。直接 readFile 一张 36 MB 的图，既会压爆 DSH 的 base64 正则
//     （≈3.2 MiB 就炸栈，见 media-normalize.js 开头的实测），也会把 token 预算一次烧光。
//     所以**按体积过滤**是硬需求；v1 不做重编码——仓库没有 sharp，ffmpeg 只该服务语音/动图。
//   · Pixeval 桌面端自带 MCP server（Streamable HTTP、stateless），图片以 MCP **资源**形式暴露。
//     读字节必须走 resources/read，而且响应可能是 SSE 也可能是纯 JSON，两种都得解析；
//     这部分协议细节不该污染 bridge.js。
//
// 本模块因此保持**纯 Node + 零第三方依赖**：
//   · 四个导出各有明确契约：sniffImageMime / imageDimensions 是纯函数（可单测），
//     pickRandomLocalImage / fetchPixevalImage / readImageFile 只碰文件与本机 HTTP。
//   · **不做路径白名单**：只负责「这是不是能识别的图片」；允许读哪些目录由 bridge 层
//     （config 的图库目录）决定，避免模块自己长出一份会和 config 漂移的白名单。
//   · **不做缩放/重编码**：超限就换一张（本地）/报错（Pixeval），绝不假装能压。
//
// 单测：scripts/test-image-source.mjs（临时目录 + 本地假 MCP，不碰真实图库与 QQ）。

import fs from 'node:fs';
import path from 'node:path';
import { clampInt } from './util/num.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖（和 media-normalize.js 的 MEDIA_DEFAULTS 同一套路）。 */
export const IMAGE_DEFAULTS = Object.freeze({
  // 本地随机图的体积上限。默认 10 MiB：图库里 84% 的图 ≤10MB（≤4MB 只有 51%），
  // 用户要求「把发图上限调大」后按 10MB 取。出站不经过 DSH，没有入站那条 base64 炸栈线；
  // 真正的瓶颈变成网关转码上传 QQ（bridge.js 另有 socialV2.image.maxSendBytes 兜总上限）。
  maxBytes: 10 * 1024 * 1024,
  // Pixeval 拉图上限。not_cropped（原图比例 1200×900）实测 1.6 MB，8 MiB 留足余量；
  // 超过就明确报错，而不是把几十 MB 的字节塞进上下文。
  maxPixevalBytes: 8 * 1024 * 1024,
  // 只认这几种扩展名：先按扩展名粗筛，再用魔数复核（扩展名是可以骗人的）。
  exts: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  // 「最近发过的」记忆条数：太多会让小图库随机不出东西，太少会连续发同一张。
  recentLimit: 20,
  // 扫描上限：图库是递归扫的，有人把目录指到 C:\ 时这里必须有个闸门，否则一次随机能把桥接卡死。
  maxScanFiles: 20000,
  // Pixeval MCP server 的默认地址（桌面端默认端口）。
  pixevalMcpUrl: 'http://127.0.0.1:52163/mcp',
  // 默认取 not_cropped：Pixeval 里网页端展示的裁剪图在 QQ 里常常裁掉关键构图。
  pixevalSize: 'not_cropped',
  // 拉图硬超时：MCP server 在本地，正常几十毫秒；30 s 是「进程卡死就别等了」的兜底。
  pixevalTimeoutMs: 30000
});

/** Pixeval MCP 资源路径支持的尺寸（拼进 pixeval://<workType>/<id>/thumbnail/<size>）。 */
const PIXEVAL_SIZES = Object.freeze(['square_medium', 'medium', 'large', 'not_cropped']);
const PIXEVAL_WORK_TYPES = Object.freeze(['illust', 'novel']);
/** 解析尺寸时最多读多少字节头：JPEG 的 SOF 可能被 EXIF（APP1）推到几十 KB 之后。 */
const DIM_HEAD_BYTES = 512 * 1024;
const OCTET = 'application/octet-stream';

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 路径比较用的规范键。
 * Windows 文件系统大小写不敏感，recentPaths 里若大小写不同（配置/回写来源不同）必须仍能命中，
 * 所以只在 win32 下折叠大小写。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32';
function pathKey(p) {
  const abs = path.resolve(p);
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
}

/** 错误信息里引用远端文本时统一截断，避免把整段 HTML/日志塞进异常。 */
function truncateForError(text, limit = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** 读文件头若干字节；打开失败直接抛（调用方决定是跳过还是报错）。 */
async function readHead(filePath, capBytes) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size === 0) return Buffer.alloc(0);
    const len = Math.min(capBytes, stat.size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 扫描期的单次探测：一次 open 同时拿到体积和前 16 字节魔数。
 * 为什么不用 stat + readFile：图库里有 36 MB 的图，为了嗅格式把整文件读进内存是纯浪费；
 * 也不该为每个文件 stat 一次再 open 一次（1900 个文件就是 3800 次系统调用）。
 * 文件读不了（权限/被删/正被占用）时抛错，调用方静默跳过。
 */
async function probeImageFile(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size === 0) return null;
    const len = Math.min(16, stat.size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return { bytes: stat.size, head: buf.subarray(0, bytesRead) };
  } finally {
    await fh.close().catch(() => {});
  }
}

// ── 格式探测（纯函数，可单测） ────────────────────────────────────────────

/**
 * 魔数嗅探：只看文件头，不信扩展名。
 *
 * @param {Buffer} buf 至少 12 字节的头（更短也不抛，按实际长度判断）
 * @returns {'image/jpeg'|'image/png'|'image/gif'|'image/webp'|'application/octet-stream'}
 */
export function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return OCTET;
  // PNG：8 字节固定签名，后面紧跟 IHDR。
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  // JPEG：SOI + 第一个段标记（FF D8 FF）。不带第三个 FF 也算：有些文件 SOI 后直接 0xFF 填充。
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF：87a/89a 两种版本头。
  if (buf.length >= 6) {
    const gifMagic = buf.toString('ascii', 0, 6);
    if (gifMagic === 'GIF87a' || gifMagic === 'GIF89a') return 'image/gif';
  }
  // WebP：RIFF 容器 + WEBP 标识（两个字段都在时才能确认，否则只是普通 RIFF/WAV）。
  if (buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return OCTET;
}

/** PNG：签名 8 + 长度 4 + 'IHDR' 4 + 宽 4 + 高 4 = 24 字节即可拿到尺寸。 */
function pngDimensions(buf) {
  if (buf.length < 24) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/** GIF：逻辑屏幕宽高在固定 6/8 偏移（小端）。 */
function gifDimensions(buf) {
  if (buf.length < 10) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * JPEG：逐段走到 SOFn（排除 DHT C4 / JPG C8 / DAC CC，它们不是 SOF）。
 *
 * 为什么必须逐段跳而不是搜 "FF C0"：段数据（EXIF、缩略图）里完全可能出现同样的字节，
 * 盲搜会读出垃圾尺寸。跳段用段头自带的长度字段，长度非法就返回 null——
 * 宁可返回 null，也不猜一个假尺寸。
 */
function jpegDimensions(buf) {
  let offset = 2; // 跳过 SOI（FF D8）
  let guard = 0;
  while (offset + 4 <= buf.length) {
    if (++guard > 1_000_000) return null; // 防御畸形文件造成死循环
    if (buf[offset] !== 0xff) { offset += 1; continue; } // 段间填充字节
    const marker = buf[offset + 1];
    if (marker === 0xff) { offset += 1; continue; } // 连续 FF 是填充
    // 无长度字段的标记：SOI/EOI/RSTn/TEM
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // 段内布局：精度(1) 高(2) 宽(2)
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    offset += 2 + len;
  }
  return null;
}

/** WebP：VP8X（含动图）/ VP8（有损）/ VP8L（无损）三种块头，尺寸算法各不相同。 */
function webpDimensions(buf) {
  if (buf.length < 16) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    if (buf.length < 30) return null;
    // 24 位小端 = 实际尺寸 - 1
    const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === 'VP8 ') {
    if (buf.length < 30) return null;
    // VP8 关键帧头：0x9d 0x01 0x2a 起始码后是 14 位宽高（低 2 位是缩放系数）。
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === 'VP8L') {
    if (buf.length < 25) return null;
    if (buf[20] !== 0x2f) return null; // VP8L 签名
    const b = [buf[21], buf[22], buf[23], buf[24]];
    const width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    const height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * PNG/JPEG/GIF/WebP 宽高。解析失败返回 null，**绝不抛**——
 * 尺寸只是给调用方的提示（日志/可选校验），一张能识别的图不该因为没有尺寸就不可用。
 *
 * @returns {{width:number, height:number}|null}
 */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  try {
    const mime = sniffImageMime(buf);
    if (mime === 'image/png') return pngDimensions(buf);
    if (mime === 'image/jpeg') return jpegDimensions(buf);
    if (mime === 'image/gif') return gifDimensions(buf);
    if (mime === 'image/webp') return webpDimensions(buf);
    return null;
  } catch {
    // 畸形文件（长度字段乱写、越界读）在这里统一吞掉：尺寸是可选信息，不能变成异常源。
    return null;
  }
}

// ── 本地图库随机图 ─────────────────────────────────────────────────────────

/** 扩展名归一化：允许配置写 'jpg' 或 '.JPG'，内部一律小写带点。 */
function normalizeExts(raw) {
  const list = Array.isArray(raw) && raw.length > 0 ? raw : IMAGE_DEFAULTS.exts;
  const out = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const ext = item.trim().toLowerCase();
    if (!ext) continue;
    out.add(ext.startsWith('.') ? ext : `.${ext}`);
  }
  return out.size > 0 ? out : new Set(IMAGE_DEFAULTS.exts);
}

/**
 * 递归扫描一棵目录树，把「扩展名符合 + 体积合格 + 魔数是图片」的文件塞进 state.pool。
 *
 * 为什么用显式栈而不是递归：目录深度理论无上限（指向 C:\ 时），递归会 stack overflow；
 * 显式栈还方便在 maxScanFiles 命中时立刻整体收手。
 */
async function scanTree(root, ctx, state) {
  const stack = [root];
  while (stack.length > 0) {
    if (state.limitHit) return;
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const reason = error?.code ?? error?.message ?? error;
      state.warnings.push(`读不了目录，已跳过：${dir}（${reason}）`);
      continue;
    }
    // readdir 顺序取决于文件系统；先按名字排序，让「随机」在不同机器上是可复现的。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs = [];
    for (const entry of entries) {
      if (state.limitHit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { subdirs.push(full); continue; }
      if (!entry.isFile()) continue; // 符号链接/设备文件一律不跟，避免绕出允许目录
      state.scanned += 1;
      if (state.scanned > ctx.maxScanFiles) {
        state.limitHit = true;
        state.warnings.push(`已到扫描上限 maxScanFiles=${ctx.maxScanFiles}，剩余文件未扫描`);
        break;
      }
      if (!ctx.exts.has(path.extname(entry.name).toLowerCase())) continue;
      let probe;
      try {
        probe = await probeImageFile(full);
      } catch {
        continue; // unreadable / 扫描瞬间被删：跳过，不打断整次随机
      }
      if (!probe) continue;
      if (probe.bytes > ctx.maxBytes) continue; // 超体积：跳过（v1 不压缩）
      const mimeType = sniffImageMime(probe.head);
      if (mimeType === OCTET) continue; // 扩展名骗人（.png 里是文本）——魔数说了算
      const key = pathKey(full);
      if (state.seen.has(key)) continue; // 同一张图被多个根目录覆盖时只算一次
      state.seen.add(key);
      state.pool.push({ filePath: full, bytes: probe.bytes, mimeType });
    }
    // 倒序压栈 → 出栈顺序仍是字典序（候选最终还会整体排序，这里只是让行为可预期）
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]);
  }
}

/**
 * 递归扫描 dirs，随机挑一张合格图片。
 *
 * 「合格」= 扩展名在 exts 里 + 体积 ≤ maxBytes + 魔数确实是图片。
 * 不合格的一律静默跳过（图库里一定有 README.txt、.psd、36 MB 的巨图，报错只会让随机失效）。
 *
 * @param {string[]} dirs 允许的根目录（必须存在；不存在直接跳过并记 warnings）
 * @param {{maxBytes?:number, exts?:string[], recentPaths?:string[], recentLimit?:number, maxScanFiles?:number, random?:()=>number}} [opts]
 * @returns {Promise<{filePath:string, bytes:number, mimeType:string, width:number|null, height:number|null, poolSize:number, warnings:string[]}>}
 */
export async function pickRandomLocalImage(dirs, opts = {}) {
  if (!Array.isArray(dirs)) {
    throw new Error('pickRandomLocalImage 需要目录数组（string[]），例如 [\'C:/Users/me/Pictures\']');
  }
  const ctx = {
    maxBytes: clampInt(opts.maxBytes, 1, 1024 * 1024 * 1024, IMAGE_DEFAULTS.maxBytes),
    exts: normalizeExts(opts.exts),
    maxScanFiles: clampInt(opts.maxScanFiles, 1, 1_000_000, IMAGE_DEFAULTS.maxScanFiles)
  };
  const state = { pool: [], warnings: [], scanned: 0, limitHit: false, seen: new Set() };

  // 去重根目录：配置里重复写同一个目录时不该把候选池翻倍。
  const seenDirs = new Set();
  for (const raw of dirs) {
    if (typeof raw !== 'string' || !raw.trim()) {
      state.warnings.push(`忽略非法目录项：${String(raw)}`);
      continue;
    }
    const root = path.resolve(raw.trim());
    const key = pathKey(root);
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    let stat;
    try {
      stat = await fs.promises.stat(root);
    } catch (error) {
      state.warnings.push(`目录不存在或不可访问，已跳过：${root}（${error?.code ?? error?.message ?? error}）`);
      continue;
    }
    if (!stat.isDirectory()) {
      state.warnings.push(`不是目录，已跳过：${root}`);
      continue;
    }
    await scanTree(root, ctx, state);
    if (state.limitHit) break;
  }

  if (state.pool.length === 0) {
    const details = [`扫描了 ${state.scanned} 个文件`, `上限 ${ctx.maxBytes} 字节`, `扩展名 ${[...ctx.exts].join('/')}`];
    if (state.warnings.length > 0) details.push(`首个警告：${state.warnings[0]}`);
    throw new Error(`图库里没有可用图片（${details.join('；')}）`);
  }

  // 排序后再随机：随机性来自 random()，顺序来自 filePath，测试才能用固定 random 断言结果。
  const pool = state.pool.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));

  // recent 过滤：只记最近 recentLimit 张（recentPaths 由调用方按时间追加，末尾最新）。
  const recentList = Array.isArray(opts.recentPaths)
    ? opts.recentPaths.filter((p) => typeof p === 'string' && p.trim() !== '')
    : [];
  const recentLimit = clampInt(opts.recentLimit, 1, 100_000, IMAGE_DEFAULTS.recentLimit);
  const recentSet = new Set(recentList.slice(-recentLimit).map((p) => pathKey(p)));

  let usable = pool;
  if (recentSet.size > 0) {
    const filtered = pool.filter((c) => !recentSet.has(pathKey(c.filePath)));
    // 「最近都发过了」不是错误：宁可重复发一张，也不能让随机功能整个失效。
    if (filtered.length > 0) usable = filtered;
  }

  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  let roll = Number(random());
  if (!Number.isFinite(roll) || roll < 0) roll = 0;
  if (roll >= 1) roll = 0.999999999; // random() 返回 1 时 floor 会越界，夹一下
  const picked = usable[Math.min(usable.length - 1, Math.floor(roll * usable.length))];

  // 尺寸只在选中后解析：扫描期给 1900 张图都读头部算尺寸是白花 IO。
  let dim = null;
  try {
    dim = imageDimensions(await readHead(picked.filePath, DIM_HEAD_BYTES));
  } catch {
    dim = null; // 选中后文件刚好被删：尺寸退化为 null，不影响返回（调用方读文件时会再报错）
  }

  return {
    filePath: picked.filePath,
    bytes: picked.bytes,
    mimeType: picked.mimeType,
    width: dim?.width ?? null,
    height: dim?.height ?? null,
    // poolSize = 实际参与随机的候选数（recent 全被过滤时已回退成全池）
    poolSize: usable.length,
    warnings: [...state.warnings]
  };
}

// ── Pixeval MCP 图源 ──────────────────────────────────────────────────────

/**
 * 解析 MCP 响应体：先按纯 JSON 试，再按 SSE（event:/data: 行）解。
 *
 * 为什么两种都要：Streamable HTTP 规范允许服务端对同一请求回 application/json 或 text/event-stream，
 * 实测 Pixeval 会按请求头/内部状态在两个之间摆动（同一个端点，前面的调用回 SSE、后面的回 JSON）。
 * 只认一种的实现会随机失败，且失败信息看起来像「服务端坏了」。
 */
function parseMcpResponse(text, uri) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Pixeval 返回空响应（uri=${uri}）`);

  // 纯 JSON 分支：以 { 或 [ 开头就先试整体解析（SSE 不会这样开头）。
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 落下去按 SSE 再试一次：有些实现会把 JSON 也包一层 event: message。
    }
  }

  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim(); // 'data:' 后可能没有空格
    if (data === '' || data === '[DONE]') continue;
    dataLines.push(data);
  }
  // 一条事件一行 JSON 是常态；多个事件时取第一个能解析的（resources/read 只会有一个结果）。
  for (const data of dataLines) {
    try {
      return JSON.parse(data);
    } catch {
      // 继续尝试下一行
    }
  }
  // SSE 规范允许多行 data 拼成一条事件（用换行连接），最后再试一次这种形状。
  if (dataLines.length > 1) {
    try {
      return JSON.parse(dataLines.join('\n'));
    } catch {
      // 落到下面统一报错
    }
  }
  throw new Error(`Pixeval 返回的响应无法解析为 JSON-RPC（uri=${uri}）：${truncateForError(raw)}`);
}

/** 严格 base64 形状校验后再解码：Buffer.from(x,'base64') 对垃圾输入会静默给出空/错字节。 */
function decodeBase64Strict(blob) {
  if (typeof blob !== 'string') return null;
  const compact = blob.replace(/\s+/g, ''); // 有些实现会按 76 列折行
  if (compact === '' || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const buf = Buffer.from(compact, 'base64');
  return buf.length > 0 ? buf : null;
}

/** 读响应体但设上限：Pixeval 若回一张 200 MB 的图，这里必须先刹车再谈「超体积」。 */
async function readTextWithCap(res, capBytes) {
  if (!res.body || typeof res.body[Symbol.asyncIterator] !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > capBytes) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    return text;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > capBytes) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 从 Pixeval MCP 取一张插图的预览图字节。
 *
 * 协议要点（实测 Pixeval 5.0.13，详见任务背景，不在代码里重复调研）：
 *   POST JSON-RPC resources/read，stateless（无 Mcp-Session-Id），无鉴权；
 *   `content-type: application/json` + `accept: application/json, text/event-stream` +
 *   `mcp-method: resources/read` 三个头缺一不可。
 *   成功时 result.contents[0].blob 是 **base64**（不是 URL）。
 *
 * @param {number|string} illustId
 * @param {{mcpUrl?:string, size?:'square_medium'|'medium'|'large'|'not_cropped', workType?:'illust'|'novel', maxBytes?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{buffer:Buffer, mimeType:string, uri:string, size:string, bytes:number, width:number|null, height:number|null}>}
 */
export async function fetchPixevalImage(illustId, opts = {}) {
  // id 必须是正整数：拼进 URI 之前校验，避免把 '12/../../etc' 之类的东西拼进资源路径。
  const id = Number(illustId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`插图 id 必须是正整数，收到 ${JSON.stringify(illustId)}`);
  }
  const mcpUrl = typeof opts.mcpUrl === 'string' && opts.mcpUrl.trim() ? opts.mcpUrl.trim() : IMAGE_DEFAULTS.pixevalMcpUrl;
  const size = opts.size ?? IMAGE_DEFAULTS.pixevalSize;
  if (!PIXEVAL_SIZES.includes(size)) {
    throw new Error(`Pixeval 图片尺寸不支持：${JSON.stringify(size)}（可选 ${PIXEVAL_SIZES.join(' / ')}）`);
  }
  const workType = opts.workType ?? 'illust';
  if (!PIXEVAL_WORK_TYPES.includes(workType)) {
    throw new Error(`Pixeval 作品类型不支持：${JSON.stringify(workType)}（可选 ${PIXEVAL_WORK_TYPES.join(' / ')}）`);
  }
  const maxBytes = clampInt(opts.maxBytes, 1, 1024 * 1024 * 1024, IMAGE_DEFAULTS.maxPixevalBytes);
  const timeoutMs = clampInt(opts.timeoutMs, 1000, 600_000, IMAGE_DEFAULTS.pixevalTimeoutMs);
  const uri = `pixeval://${workType}/${id}/thumbnail/${size}`;
  // base64 是 4/3 膨胀，再加 256 KB 给 JSON-RPC 信封；超了就直接判定「这张图超过上限」。
  const bodyCap = Math.ceil((maxBytes * 4) / 3) + 256 * 1024;

  let res;
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 少了 text/event-stream，服务端可能只肯回 JSON 或直接 406。
        accept: 'application/json, text/event-stream',
        // stateless 模式下没有 session 可路由，method 必须放在头上（实测少了这个头拿不到资源）。
        'mcp-method': 'resources/read'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const reason = timeout ? `超时（${timeoutMs}ms）` : (error?.cause?.message ?? error?.message ?? String(error));
    throw new Error(`Pixeval MCP 请求失败（${mcpUrl}，uri=${uri}）：${reason}`);
  }

  let text;
  try {
    text = await readTextWithCap(res, bodyCap);
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      throw new Error(`Pixeval 预览图过大：响应体超过 ${bodyCap} 字节读取上限（图片上限 ${maxBytes} 字节，uri=${uri}）`);
    }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Pixeval MCP 响应超时（${timeoutMs}ms，uri=${uri}）`);
    }
    throw new Error(`Pixeval MCP 响应读取失败（uri=${uri}）：${error?.message ?? error}`);
  }

  if (!res.ok) {
    throw new Error(`Pixeval MCP 返回 HTTP ${res.status}（uri=${uri}）：${truncateForError(text)}`);
  }

  const payload = parseMcpResponse(text, uri);
  if (payload?.error) {
    const err = payload.error;
    const reason = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
    throw new Error(`Pixeval MCP 报错（uri=${uri}）：${truncateForError(reason)}；响应：${truncateForError(text)}`);
  }

  const contents = payload?.result?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error(`Pixeval 返回的 contents 为空（uri=${uri}）：${truncateForError(text)}`);
  }
  const item = contents[0] ?? {};
  const blob = item.blob;
  if (typeof blob !== 'string' || blob === '') {
    // text 形态的资源（普通文本文件）没有 blob：这里要如实说明，而不是返回空 buffer。
    throw new Error(`Pixeval 返回里没有 blob（uri=${uri}）：${truncateForError(text)}`);
  }
  const buffer = decodeBase64Strict(blob);
  if (!buffer) {
    throw new Error(`Pixeval 返回的 blob 不是合法 base64（uri=${uri}，长度 ${blob.length}）`);
  }
  const bytes = buffer.length;
  if (bytes > maxBytes) {
    throw new Error(`Pixeval 预览图过大：${bytes} 字节 > 上限 ${maxBytes} 字节（uri=${uri}，size=${size}）`);
  }
  // 服务端声明的 mimeType 可信度高于魔数（Pixeval 一律 image/jpeg），但只信 image/* 前缀。
  const mimeType = typeof item.mimeType === 'string' && item.mimeType.toLowerCase().startsWith('image/')
    ? item.mimeType
    : sniffImageMime(buffer);
  const dim = imageDimensions(buffer);
  return {
    buffer,
    mimeType,
    // 返回**请求时用的** uri：调用方拿它记日志/复现，服务端回显的 uri 不应改写调用方的输入。
    uri,
    size,
    bytes,
    width: dim?.width ?? null,
    height: dim?.height ?? null
  };
}

// ── Pixeval 作品元数据（发图前的最低收藏数闸门用） ────────────────────────

/**
 * 从 Pixeval MCP 读一张作品的元数据（resources/read `pixeval://<workType>/<id>`）。
 *
 * 为什么必须单独读一次元数据：thumbnail 资源只给字节、不带收藏数；而「只发 1000 赞以上」
 * 这种要求必须在**发送前**判定——图已经发出去再发现不达标就来不及了。
 * 该资源返回的是 PixevalWorkDto JSON（text 形态），字段与 tools/call 的 works 一致。
 *
 * 「赞」的口径：Pixiv 的点赞是私有的，公开能拿到的是**收藏数**（totalBookmarks），
 * 所以这里用它当「赞数」——桥接与文档、错误文案都必须按这个口径说清楚，避免把
 * 「收藏」说成「点赞」让人以为查错了字段。
 *
 * @param {number|string} illustId
 * @param {{mcpUrl?:string, workType?:'illust'|'novel', timeoutMs?:number}} [opts]
 * @returns {Promise<{id:number, title:string, authorName:string|null, totalBookmarks:number, totalViews:number|null, xRestrict:unknown, pageCount:number, workType:string, uri:string}>}
 */
export async function fetchPixevalWorkMeta(illustId, opts = {}) {
  const id = Number(illustId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`作品 id 必须是正整数，收到 ${JSON.stringify(illustId)}`);
  }
  const mcpUrl = typeof opts.mcpUrl === 'string' && opts.mcpUrl.trim() ? opts.mcpUrl.trim() : IMAGE_DEFAULTS.pixevalMcpUrl;
  const workType = opts.workType ?? 'illust';
  if (!PIXEVAL_WORK_TYPES.includes(workType)) {
    throw new Error(`Pixeval 作品类型不支持：${JSON.stringify(workType)}（可选 ${PIXEVAL_WORK_TYPES.join(' / ')}）`);
  }
  const timeoutMs = clampInt(opts.timeoutMs, 1000, 600_000, IMAGE_DEFAULTS.pixevalTimeoutMs);
  const uri = `pixeval://${workType}/${id}`;
  // 元数据只有几 KB；给 1 MB 足够，也挡住异常大响应。
  const bodyCap = 1024 * 1024;

  let res;
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': 'resources/read'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const reason = timeout ? `超时（${timeoutMs}ms）` : (error?.cause?.message ?? error?.message ?? String(error));
    throw new Error(`Pixeval MCP 请求失败（${mcpUrl}，uri=${uri}）：${reason}`);
  }

  let text;
  try {
    text = await readTextWithCap(res, bodyCap);
  } catch (error) {
    throw new Error(`Pixeval MCP 响应读取失败（uri=${uri}）：${error?.message ?? error}`);
  }
  if (!res.ok) {
    throw new Error(`Pixeval MCP 返回 HTTP ${res.status}（uri=${uri}）：${truncateForError(text)}`);
  }
  const payload = parseMcpResponse(text, uri);
  if (payload?.error) {
    const err = payload.error;
    const reason = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
    throw new Error(`Pixeval MCP 报错（uri=${uri}）：${truncateForError(reason)}`);
  }
  const contents = payload?.result?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error(`Pixeval 返回的 contents 为空（uri=${uri}）：${truncateForError(text)}`);
  }
  const item = contents[0] ?? {};
  // 作品元数据是 text 资源；兼容服务端把它塞进 blob 的形态。
  const raw = typeof item.text === 'string'
    ? item.text
    : (typeof item.blob === 'string' ? Buffer.from(item.blob, 'base64').toString('utf8') : '');
  if (!raw.trim()) {
    throw new Error(`Pixeval 返回的元数据是空的（uri=${uri}）`);
  }
  let dto;
  try {
    dto = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Pixeval 返回的元数据不是 JSON（uri=${uri}）：${truncateForError(raw)}`);
  }
  const totalBookmarks = Number(dto?.totalBookmarks);
  if (!Number.isFinite(totalBookmarks)) {
    // 读不到收藏数就 fail-closed：宁可不发，也不能把「无法确认」当成「达标」。
    throw new Error(`Pixeval 元数据里没有可用的 totalBookmarks（uri=${uri}）`);
  }
  const totalViews = Number(dto?.totalViews);
  const pageCount = Number(dto?.pageCount);
  return {
    id: Number(dto?.id) || id,
    title: typeof dto?.title === 'string' ? dto.title : '',
    authorName: typeof dto?.author?.name === 'string' ? dto.author.name : null,
    totalBookmarks,
    totalViews: Number.isFinite(totalViews) ? totalViews : null,
    // 年龄分级与页数：qq_send_image 走「模型指定 illustId」这条路，分级闸门也只能在这里判——
    // 没这两个字段，模型随手给一个 R-18 id 就能直发，前面搜索层的过滤全白做。
    xRestrict: dto?.xRestrict ?? dto?.safeRating ?? null,
    pageCount: Number.isFinite(pageCount) ? pageCount : 1,
    workType,
    uri
  };
}

// ── Pixiv 搜索（按关键词找高收藏作品） ──────────────────────────────────

/**
 * 判断作品的年龄分级是否为 R-18 / R-18G。
 *
 * 为什么单独抽出来：Pixeval 把 `xRestrict` 给成**字符串**（`"Ordinary"` / `"R18"` / `"R18G"`），
 * 而 `safeRating` 是个对象字符串（`SafeRating { SafeRatingValue = 40, IsR18 = True, ... }`）。
 * 两种形态在历史版本里都出现过，这里统一按「只要命中 R-18 字样就算不健康」处理——
 * 宁可错杀一张普通图，也不能把露骨的图发进群里。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isR18Restriction(value) {
  if (value === true) return true;
  if (value == null) return false;
  // Pixiv 原生 API 的 xRestrict 是数字：1 = R-18，2 = R-18G。
  if (typeof value === 'number') return value === 1 || value === 2;
  const text = String(value);
  if (!text) return false;
  // 结构化形态（Pixeval 把 SafeRating 序列化成一行）：必须先看布尔位，
  // 否则 "Ordinary" 的作品里那句 `IsR18 = False` 会被当成命中 R-18，把所有人都误杀。
  if (/Is(?:R18G?|Explicit|Guro|Questionable)\s*=\s*True/i.test(text)) return true;
  if (/Is(?:R18G?|Explicit|Guro|Questionable)\s*=\s*False/i.test(text)) return false;
  // 纯字符串形态：'R18' / 'R-18' / 'R18G'。\b 保证不会在 "IsR18" 这种词里误命中。
  return /^\s*r-?18g?\s*$/i.test(text) || /\bR-?18G?\b/i.test(text);
}

/**
 * 从搜索结果里挑一张要发的作品。
 *
 * 挑选顺序：先按硬闸门过滤，再取收藏数最高的一张。硬闸门有三条：
 *   1. 年龄分级（`allowR18=false` 时排除 R-18/R-18G）；
 *   2. 作品类型（`illustOnly` 时只要 `Illustration`，排掉动图 Ugoira 与漫画 Manga——
 *      动图只能发一帧，漫画分页只能发第一页，观感都很差）；
 *   3. 收藏数下限（`minBookmarks`）。
 * 单页优先单独作为**软**条件：有单页作品就只在单页里挑，没有才放宽到多页，
 * 这样不会因为「这个关键词全是多页」而一张都发不出去。
 *
 * @param {Array<{id:number, totalBookmarks:number, xRestrict?:unknown, type?:string, pageCount?:number}>} works
 * @param {{minBookmarks?:number, allowR18?:boolean, illustOnly?:boolean, preferSinglePage?:boolean}} [opts]
 * @returns {object|null} 选中的作品条目；没有候选时返回 null
 */
export function selectPixevalWork(works, opts = {}) {
  const minBookmarks = Math.max(0, Math.floor(Number(opts.minBookmarks) || 0));
  const allowR18 = opts.allowR18 === true;
  const illustOnly = opts.illustOnly !== false;
  const preferSinglePage = opts.preferSinglePage !== false;
  const candidates = (Array.isArray(works) ? works : []).filter((work) => {
    if (!work || !Number.isSafeInteger(Number(work.id))) return false;
    if (!allowR18 && isR18Restriction(work.xRestrict)) return false;
    // 类型字段缺失时放行（老版本 Pixeval 不带 type），只在明确是其它类型时才排除。
    if (illustOnly && typeof work.type === 'string' && work.type && work.type !== 'Illustration') return false;
    return Number(work.totalBookmarks) >= minBookmarks;
  });
  if (!candidates.length) return null;
  const singlePage = preferSinglePage ? candidates.filter((work) => !(Number(work.pageCount) > 1)) : [];
  const pool = singlePage.length ? singlePage : candidates;
  return pool.reduce((best, work) => (Number(work.totalBookmarks) > Number(best.totalBookmarks) ? work : best), pool[0]);
}

/**
 * 解析 Pixeval `search_illustrations` 的响应文本。
 *
 * 为什么做「兼容多形状」的解析：该工具是 Pixeval 桌面端自带的 MCP，不同小版本把结果
 * 放进 `works` / `illustrations` / `items` / `data`，外层也可能包成
 * `result.content[0].text`（JSON 字符串）或 `result.contents`。这里全部容忍，
 * 抽不出 id 的条目直接跳过——搜索失败本该降级到本地图库，而不是把整段原始 JSON 塞给模型。
 *
 * @param {string} text 响应体（JSON 或 SSE）
 * @returns {Array<{id:number, title:string, totalBookmarks:number}>}
 */
export function parsePixevalSearchPayload(text) {
  let payload;
  try {
    payload = parseMcpResponse(String(text ?? ''), 'pixeval://search');
  } catch {
    return [];
  }
  const chunks = payload?.result?.content ?? payload?.result?.contents ?? [];
  const texts = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (typeof chunk?.text === 'string') texts.push(chunk.text);
    else if (typeof chunk?.blob === 'string') {
      try { texts.push(Buffer.from(chunk.blob, 'base64').toString('utf8')); } catch {}
    }
  }
  const raw = texts.join('\n').trim();
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.works) ? data.works
      : Array.isArray(data?.illustrations) ? data.illustrations
        : Array.isArray(data?.items) ? data.items
          : Array.isArray(data?.data) ? data.data
            : [];
  const out = [];
  for (const entry of list) {
    const work = entry?.work ?? entry;
    const id = Number(work?.id ?? work?.illustId ?? work?.workId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const bookmarks = Number(work?.totalBookmarks ?? work?.bookmarkCount ?? work?.total_bookmarks);
    // xRestrict / type / pageCount / createDate 是选图闸门的依据（R-18、动图漫画、多页、创作时间），
    // 少解析一个就会让对应闸门静默失效——所以这里宁可留 null 也不省略字段。
    const pageCount = Number(work?.pageCount);
    out.push({
      id,
      title: typeof work?.title === 'string' ? work.title : '',
      totalBookmarks: Number.isFinite(bookmarks) ? bookmarks : 0,
      xRestrict: work?.xRestrict ?? work?.safeRating ?? null,
      type: typeof work?.type === 'string' ? work.type : '',
      pageCount: Number.isFinite(pageCount) ? pageCount : 1,
      createDate: typeof work?.createDate === 'string' ? work.createDate : null
    });
  }
  return out;
}

/**
 * 按关键词搜 Pixiv 作品（Pixeval MCP `tools/call: search_illustrations`）。
 *
 * 和 fetchPixevalImage 一样是 stateless JSON-RPC：内容类型 + accept + mcp-method 头缺一不可。
 *
 * 为什么要暴露这么多参数：Pixiv 默认是 `sort=date_desc`（最新发布）+ 宽匹配 + 含 AI 图 +
 * 含漫画/动图。最新发布的图收藏天然只有个位数，靠「收藏数」根本筛不出好图——实测同一关键词
 * 加一个历史时间窗后，收藏 top 从 1032 涨到 7442。所以调用方需要能把 match / contentType /
 * includeAi / startDate / endDate 一起传下去，而不是只给个 query。
 *
 * @param {string} query 1–60 字关键词
 * @param {{mcpUrl?:string, count?:number, timeoutMs?:number, match?:string, sort?:string,
 *          contentType?:string, includeAi?:boolean, ratioPattern?:string,
 *          startDate?:string|null, endDate?:string|null}} [opts]
 * @returns {Promise<Array<{id:number, title:string, totalBookmarks:number, xRestrict:unknown, type:string, pageCount:number, createDate:string|null}>>}
 */
export async function searchPixevalIllustrations(query, opts = {}) {
  const q = String(query ?? '').trim().replace(/\s+/g, ' ');
  if (!q) throw new Error('搜索关键词不能为空');
  if (q.length > 60) throw new Error(`搜索关键词过长（${q.length} 字，上限 60）`);
  const mcpUrl = typeof opts.mcpUrl === 'string' && opts.mcpUrl.trim() ? opts.mcpUrl.trim() : IMAGE_DEFAULTS.pixevalMcpUrl;
  const timeoutMs = clampInt(opts.timeoutMs, 1000, 600_000, IMAGE_DEFAULTS.pixevalTimeoutMs);
  // 上限跟着 MCP 走（它的 schema 写的是 clamped to 1..100）：以前这里卡在 30，是把「一次拉多少」当成了安全闸门，
  // 但真正的闸门是收藏数/分级过滤，样本越大只会挑得越准。
  const count = clampInt(opts.count, 1, 100, 12);
  const args = { query: q, count };
  // 只透传显式给了值的参数：缺省交给 Pixiv 自己的默认值，避免这里和远端默认值打架。
  for (const key of ['match', 'sort', 'contentType', 'ratioPattern']) {
    if (typeof opts[key] === 'string' && opts[key].trim()) args[key] = opts[key].trim();
  }
  if (typeof opts.includeAi === 'boolean') args.includeAi = opts.includeAi;
  for (const key of ['startDate', 'endDate']) {
    if (typeof opts[key] === 'string' && opts[key].trim()) args[key] = opts[key].trim();
  }
  let res;
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': 'tools/call'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_illustrations', arguments: args }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const reason = timeout ? `超时（${timeoutMs}ms）` : (error?.cause?.message ?? error?.message ?? String(error));
    throw new Error(`Pixeval 搜索请求失败（${mcpUrl}）：${reason}`);
  }
  let text;
  try {
    text = await readTextWithCap(res, 1024 * 1024);
  } catch (error) {
    throw new Error(`Pixeval 搜索响应读取失败：${error?.message ?? error}`);
  }
  if (!res.ok) throw new Error(`Pixeval 搜索返回 HTTP ${res.status}：${truncateForError(text)}`);
  const payload = parseMcpResponse(text, 'pixeval://search');
  if (payload?.error) {
    const reason = typeof payload.error === 'string' ? payload.error : (payload.error?.message ?? JSON.stringify(payload.error));
    throw new Error(`Pixeval 搜索报错：${truncateForError(reason)}`);
  }
  return parsePixevalSearchPayload(text);
}

// ── 本地单文件读取 ────────────────────────────────────────────────────────

/**
 * 读一个本地文件并校验是图片（给 bridge 内部/测试用，不做路径白名单——白名单在 bridge 层）。
 *
 * 为什么不做白名单：白名单属于权限策略（配置里允许哪些目录），放在这里会和 config 漂移；
 * 本函数只保证「读得到 + 是图片 + 不超限」，调用方必须自己决定这份文件能不能外发。
 *
 * @param {string} filePath
 * @param {{maxBytes?:number}} [opts]
 * @returns {Promise<{buffer:Buffer, mimeType:string, bytes:number, width:number|null, height:number|null}>}
 */
export async function readImageFile(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('readImageFile 需要一个文件路径');
  }
  const resolved = path.resolve(filePath.trim());
  const maxBytes = clampInt(opts.maxBytes, 1, 1024 * 1024 * 1024, IMAGE_DEFAULTS.maxBytes);
  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (error) {
    throw new Error(`读不了图片文件：${resolved}（${error?.code ?? error?.message ?? error}）`);
  }
  if (!stat.isFile()) throw new Error(`不是普通文件：${resolved}`);
  if (stat.size === 0) throw new Error(`文件是空的：${resolved}`);
  // 先按 stat 挡住巨文件：真去读一张 36 MB 的图再判断，内存/时间都白花。
  if (stat.size > maxBytes) throw new Error(`图片文件过大：${resolved} 有 ${stat.size} 字节，上限 ${maxBytes} 字节`);
  let buffer;
  try {
    buffer = await fs.promises.readFile(resolved);
  } catch (error) {
    throw new Error(`读不了图片文件：${resolved}（${error?.code ?? error?.message ?? error}）`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(`图片文件过大：${resolved} 实际读到 ${buffer.length} 字节，上限 ${maxBytes} 字节`);
  }
  const mimeType = sniffImageMime(buffer);
  if (mimeType === OCTET) {
    throw new Error(`不是可识别的图片：${resolved}（魔数不匹配 jpg/png/gif/webp）`);
  }
  const dim = imageDimensions(buffer);
  return {
    buffer,
    mimeType,
    bytes: buffer.length,
    width: dim?.width ?? null,
    height: dim?.height ?? null
  };
}
