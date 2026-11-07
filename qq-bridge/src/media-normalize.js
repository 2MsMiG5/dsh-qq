// 媒体归一化：把「QQ 给我们的原始图片」压成「DSH 与模型真能吃下的形状」。
//
// ── 为什么需要这一层（2026-10-18 媒体与水印审计结论）
//
// ① 体积悬崖：DSH 的 MCP 图片入口会用正则校验 base64
//    （dsh-mcp-client 的 CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/）。
//    这条正则在长输入上会压爆 V8 的 regexp 回溯栈，实测：
//        base64 ≥ 4,474,880 字符（原始字节 ≥ 3.20 MiB）→ RangeError: Maximum call stack size exceeded
//    而 DSH 把这个异常原样降级成 `[image unavailable: image/gif; Maximum call stack size exceeded; …]`
//    —— 模型只看到一行错误，图一个字节都没进上下文。
//    桥接侧的抓取上限（socialV2.media.maxBytes，默认 8 MiB）远在这条线之上，
//    于是「3.2–8 MiB 的图」就成了「桥接认为合法、DSH 必然拒绝」的死区。
//
// ② 动图变单帧：DSH 的 canPassThroughNormalization() 显式排除 image/gif，
//    一律交给 sharp 归一化，而 sharp 默认只解 page 0 —— 一张 48 帧、4.8 MB 的动图，
//    模型最终只看到「第 1 帧压成的 12 KB 静态 JPEG」，而且上下文里没有任何「这是动图」的提示。
//    模型于是只能瞎猜（实测会话里它连着两次给出的解释都是错的）。
//
// ── 本模块的取舍
//
// · **只动喂给模型的那一份**。收集表情（add_custom_face）必须用原始字节，
//   所以归一化只接在 fetchMediaData / resolveMediaList / sticker-image 这些「给模型看」的出口，
//   不去改 fetchOneBotImage / fetchFaceMedia 的返回值。
// · **动图抽帧拼图**而不是发多张图：一条消息 5 张图 = 5 次 DSH admission + 5 份 token，
//   而 3×2 拼图信息密度更高、只算一张图（实测 4.83 MB / 200 帧 → 92 KB / 269 ms）。
// · **能不动就不动**：小图（≤ maxModelBytes 且长边够小）原样放行，零延迟。
// · **ffmpeg 缺失时先找系统兜底**：Windows 用 GDI+/System.Drawing（系统自带，无需安装）
//   做「降采样 + 重编码」，只有连系统解码器都不认（如 WebP）或压不进上限时，才回一句
//   「太大，看不了」—— 绝不发注定被 DSH 丢掉的字节（那样模型只会看到一行看不懂的错误）。
//   实测日志：没有 ffmpeg 时 3.67MB 的图直接被拒，模型一个字都看不到；有兜底后同类图压到
//   100–300KB 正常进上下文。
//
// 依赖：只用 node 内置 + voice-core 的 resolveFfmpeg（ffmpeg 定位的唯一实现）；
// 兜底走 Windows 自带的 PowerShell + System.Drawing，不新增 npm 依赖。
// 子进程一律 `stdio: 'ignore'` + 写文件：受限沙箱里 pipe 会 EPERM（见 voice-core.js 开头的说明）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './voice-core.js';
import { clampInt } from './util/num.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖（见 modelMediaLimits）。 */
export const MEDIA_DEFAULTS = Object.freeze({
  // 交给 DSH 的单张图片原始字节上限。DSH 的炸栈线是 ≈3.20 MiB，
  // 这里取 1 MiB：留 3 倍余量，顺带把 token 成本压一个数量级（1 MiB 图 ≈ 1.33 MB base64）。
  maxModelBytes: 1024 * 1024,
  // 长边上限：手机直出 4000×3000 缩到 1280 后约 150–250 KB，肉眼描述完全够用。
  maxLongEdge: 1280,
  // 动图抽几帧：6 帧正好 3×2，超过 9 帧拼图会小到看不清单帧。
  gifFrames: 6,
  // 每一格的目标宽度（px）：240 一格，3×2 拼图约 736×492，实测 92 KB。
  gifTile: 240,
  // 单张 ffmpeg 调用的硬超时。实测 200 帧 GIF 拼图 269 ms、4K 重编码 < 1 s，25 s 是兜底。
  timeoutMs: 25000
});

/** 硬上限：不管 config 怎么写，都不允许超过 DSH 的实测炸栈线下沿。 */
const HARD_MAX_MODEL_BYTES = Math.floor(3.0 * 1024 * 1024);

// ── 格式探测（纯函数，可单测） ────────────────────────────────────────────

/** GIF 子块链跳过：每个子块首字节是长度，0 结束。返回新游标（越界返回 -1）。 */
function skipGifSubBlocks(buf, pos) {
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
    if (++guard > 1_000_000) return -1;
  }
  return -1;
}

/**
 * 解析 GIF 的帧数与总时长（以及是否有透明帧）。
 *
 * 为什么不直接问 ffprobe：a) ffmpeg 可能没装，而「这是动图，N 帧」这句话就算没 ffmpeg
 * 也要能告诉模型；b) 每次看图都 spawn 一次 ffprobe 是白花的时间（这里纯内存解析）。
 * GIF 的块结构很实在：0x2C = 图像描述符（一帧），0x21 0xF9 = 图形控制扩展（带 delay）。
 */
function parseGif(buf) {
  if (buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 << (packed & 0x07)); // 全局颜色表
  let frames = 0;
  let durationCs = 0;
  let alpha = false;
  let delayCs = 0;
  let guard = 0;
  while (pos >= 0 && pos < buf.length) {
    if (++guard > 5_000_000) break;
    const block = buf[pos];
    pos += 1;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9 && pos + 4 <= buf.length) {
        // 块长(1) 打包位(1) delay(2) 透明色索引(1) 终结符(1)
        const size = buf[pos];
        if (size >= 4 && pos + 4 < buf.length) {
          const gcePacked = buf[pos + 1];
          delayCs = buf.readUInt16LE(pos + 2);
          if (gcePacked & 0x01) alpha = true;
        }
      }
      pos = skipGifSubBlocks(buf, pos);
      continue;
    }
    if (block === 0x2c) {
      if (pos + 9 > buf.length) break;
      const descPacked = buf[pos + 8];
      pos += 9;
      if (descPacked & 0x80) pos += 3 * (2 << (descPacked & 0x07)); // 局部颜色表
      pos += 1; // LZW 最小码长
      pos = skipGifSubBlocks(buf, pos);
      frames += 1;
      durationCs += delayCs || 0;
      delayCs = 0;
      continue;
    }
    break; // 解析不了就别硬猜
  }
  return {
    width,
    height,
    frames: Math.max(1, frames),
    durationMs: durationCs > 0 ? durationCs * 10 : 0,
    alpha
  };
}

/** WebP：解析尺寸，并识别动图（ANIM 块 / ANMF 帧块）。 */
function parseWebp(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (fourcc === 'VP8X') {
    width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
  } else if (fourcc === 'VP8L') {
    const b = [buf[21], buf[22], buf[23], buf[24]];
    width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
  } else if (fourcc === 'VP8 ') {
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else {
    return null;
  }
  // 动图：RIFF 里出现 ANIM（动画头）与若干个 ANMF（帧）。只数块头，不解析负载。
  let frames = 0;
  let pos = 12;
  let guard = 0;
  while (pos + 8 <= buf.length && ++guard < 1_000_000) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'ANMF') frames += 1;
    pos += 8 + size + (size & 1);
  }
  const alpha = fourcc === 'VP8X' ? (buf[20] & 0x10) !== 0 : true;
  return { width, height, frames: Math.max(1, frames), durationMs: 0, alpha };
}

function parsePng(buf) {
  if (buf.length < 26) return null;
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    frames: 1,
    durationMs: 0,
    alpha: colorType === 4 || colorType === 6
  };
}

function parseJpeg(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    // SOF0–SOF15（排除 DHT C4 / JPG C8 / DAC CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), frames: 1, durationMs: 0, alpha: false };
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * 从字节里认出格式/尺寸/帧数。
 *
 * @returns null（认不出）或
 *   { format:'gif'|'png'|'jpeg'|'webp', width, height, frames, durationMs, animated, alpha }
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let format = null;
  let parsed = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    format = 'png'; parsed = parsePng(buf);
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    format = 'jpeg'; parsed = parseJpeg(buf);
  } else if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    format = 'gif'; parsed = parseGif(buf);
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp'; parsed = parseWebp(buf);
  }
  if (!parsed || !parsed.width || !parsed.height) return null;
  return {
    format,
    width: parsed.width,
    height: parsed.height,
    frames: Math.max(1, parsed.frames || 1),
    durationMs: parsed.durationMs || 0,
    animated: (parsed.frames || 1) > 1,
    alpha: !!parsed.alpha
  };
}

// ── 决策（纯函数，可单测） ────────────────────────────────────────────────

/**
 * 要不要动这张图？返回 null = 原样放行。
 *
 * @param info sniffImage() 的结果（null 表示认不出 → 一律放行，交给下游）
 * @param bytes 原始字节数
 * @param limits 归一化上限
 */
export function planNormalization(info, bytes, limits = {}) {
  const maxBytes = clampInt(limits.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
  const maxLongEdge = clampInt(limits.maxLongEdge, 256, 2048, MEDIA_DEFAULTS.maxLongEdge);
  if (!info) {
    // 认不出的格式：能放就放（下游 mimeFromBuffer 会兜底），太大就拒绝——绝不硬塞。
    return bytes > maxBytes ? { action: 'reject', reason: `未知图片格式且 ${bytes} 字节超过上限` } : null;
  }
  if (info.animated) {
    return { action: 'animate', maxBytes, maxLongEdge };
  }
  const longEdge = Math.max(info.width, info.height);
  if (bytes <= maxBytes && longEdge <= maxLongEdge) return null;
  return { action: 'shrink', maxBytes, maxLongEdge, bytes, longEdge };
}

/** 动图拼图布局：帧数 → { cols, rows, fps, sampleFrames }。纯函数。 */
export function planAnimation(info, limits = {}) {
  const wanted = clampInt(limits.gifFrames, 2, 12, MEDIA_DEFAULTS.gifFrames);
  const frames = Math.max(1, info?.frames || 1);
  // 帧比想要的多才有意思抽帧；帧本来就少就全用上（不重复填充没信息量的格子）。
  const sample = Math.min(wanted, frames);
  // 布局偏好：6→3×2、9→3×3、8→4×2（都填满），其余按接近正方形算。
  const layout = { 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3] }[sample]
    ?? [Math.ceil(Math.sqrt(sample)), Math.ceil(sample / Math.ceil(Math.sqrt(sample)))];
  const [cols, rows] = layout;
  // fps 必须让 ffmpeg 恰好产出 sample 帧；时长未知时按每帧 100 ms 估（QQ 表情的常见默认）。
  const durationMs = info?.durationMs > 0 ? info.durationMs : frames * 100;
  const seconds = Math.max(0.05, durationMs / 1000);
  const fps = Math.min(30, Math.max(0.05, Number((sample / seconds).toFixed(4))));
  return { cols, rows, fps, sampleFrames: sample, totalFrames: frames, durationMs };
}

// ── ffmpeg 调用 ──────────────────────────────────────────────────────────

/**
 * 跑一次 ffmpeg：输入/输出都走文件，stdio 全 ignore。
 *
 * 为什么不用管道：受限沙箱里 `spawn` + stdio:'pipe' 会直接 EPERM（voice-core.js 开头有同样记录）。
 * 代价是拿不到 ffmpeg 的 stderr —— 所以调用方只报「退出码 + 动作名」，不假装能诊断具体原因。
 */
function runFfmpeg(ffmpeg, args, { timeoutMs = MEDIA_DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 ffmpeg（设置 FFMPEG_PATH 或 config.json 的 socialV2.voice.ffmpegPath）'
        : `ffmpeg 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }));
  });
}

// ── 无 ffmpeg 时的兜底：Windows 系统图像接口（GDI+ / System.Drawing） ──────
//
// 为什么值得写：很多机器上根本没装 ffmpeg（本机日志里连续几十次「找不到 ffmpeg」），
// 而 QQ 图绝大多数就是 JPEG/PNG/GIF —— 这些格式系统解码器本来就认。没有兜底时，
// 超限的图只能回「压不到」，模型看不到任何画面；有兜底后同样先压再给。
//
// 代价与边界：
//   · 每次调用要起一个 PowerShell（实测 200–500ms），所以只在「需要压 + ffmpeg 不可用」时才走；
//   · GIF 只能取首帧（GDI+ 不做抽帧拼图；拼图仍归 ffmpeg）；
//   · WebP 之类系统解码器不认的格式仍只能靠 ffmpeg。

/** 把任意字符串安全地写进 PowerShell 单引号字面量（单引号翻倍转义）。 */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 生成「缩放到 maxEdge 以内并重编码」的 PowerShell 脚本。
 * 整段脚本走 -EncodedCommand（UTF-16LE base64），因此路径里有空格/中文/引号都不会破坏命令行。
 */
function buildGdipScript({ inFile, outFile, maxEdge, quality, keepAlpha, format }) {
  const pixelFormat = keepAlpha ? 'Format32bppArgb' : 'Format24bppRgb';
  const clearColor = keepAlpha ? 'Transparent' : 'White';
  const saveLines = format === 'png'
    ? [`  $bitmap.Save(${psLiteral(outFile)}, [System.Drawing.Imaging.ImageFormat]::Png)`]
    : [
      "  $codec = @([System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' })[0]",
      '  $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)',
      `  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${Math.round(quality)})`,
      `  try { $bitmap.Save(${psLiteral(outFile)}, $codec, $encParams) } finally { $encParams.Dispose() }`
    ];
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile(${psLiteral(inFile)})`,
    'try {',
    '  $w = [int]$src.Width',
    '  $h = [int]$src.Height',
    '  $long = [Math]::Max($w, $h)',
    '  $scale = 1.0',
    `  if ($long -gt ${maxEdge}) { $scale = ${maxEdge} / $long }`,
    '  $nw = [Math]::Max(1, [int][Math]::Round($w * $scale))',
    '  $nh = [Math]::Max(1, [int][Math]::Round($h * $scale))',
    `  $bitmap = New-Object System.Drawing.Bitmap($nw, $nh, [System.Drawing.Imaging.PixelFormat]::${pixelFormat})`,
    '  try {',
    '    $g = [System.Drawing.Graphics]::FromImage($bitmap)',
    '    try {',
    '      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality',
    `      $g.Clear([System.Drawing.Color]::${clearColor})`,
    '      $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $nw, $nh)))',
    '    } finally { $g.Dispose() }',
    ...saveLines,
    '  } finally { $bitmap.Dispose() }',
    '} finally { $src.Dispose() }'
  ].join('\n');
}

/**
 * 跑一次 PowerShell 脚本（stdio 全 ignore，输出全走文件，理由同 runFfmpeg）。
 * 先试 Windows PowerShell 5.1，再试 PowerShell 7（pwsh）。
 */
function runPowerShell(script, { timeoutMs = MEDIA_DEFAULTS.timeoutMs } = {}) {
  const candidates = ['powershell.exe', 'pwsh'];
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const attempt = (index) => {
      if (index >= candidates.length) {
        resolve({ ok: false, error: '找不到 PowerShell（系统图像接口不可用）' });
        return;
      }
      let child;
      try {
        child = spawn(candidates[index],
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, stdio: 'ignore' });
      } catch {
        attempt(index + 1);
        return;
      }
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        settle({ ok: false, error: `图像压缩超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      child.on('error', (error) => {
        if (error?.code === 'ENOENT' && index + 1 < candidates.length) {
          settled = true;
          clearTimeout(timer);
          attempt(index + 1);
          return;
        }
        settle({
          ok: false,
          error: error?.code === 'ENOENT'
            ? '找不到 PowerShell（系统图像接口不可用）'
            : `PowerShell 不可用：${error?.message ?? error}`
        });
      });
      child.on('close', (code) => settle(code === 0
        ? { ok: true }
        : { ok: false, error: `系统图像接口退出码 ${code}` }));
    };
    attempt(0);
  });
}

/**
 * 压缩后端顺序：ffmpeg 优先（全格式 + 动图抽帧），Windows 上再加系统图像接口兜底。
 * `opts.encoders` 可显式指定（诊断/测试用），例如 ['gdip'] 强制走系统兜底。
 */
function resolveEncoders(opts = {}) {
  const allowed = new Set(['ffmpeg', 'gdip']);
  const requested = Array.isArray(opts.encoders) ? opts.encoders.filter((name) => allowed.has(name)) : [];
  const list = requested.length ? requested : ['ffmpeg', 'gdip'];
  return list.filter((name) => name !== 'gdip' || process.platform === 'win32');
}

/**
 * 用系统图像接口把静态图降采样并重编码到 maxBytes 以内。
 * 第 1 轮保留透明通道（PNG），之后铺白底转 JPEG —— PNG 几乎没有可调的压缩参数。
 */
async function shrinkWithGdip({ dir, inFile, info, maxLongEdge, maxBytes, timeoutMs }) {
  let edge = maxLongEdge;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const keepAlpha = !!info.alpha && attempt === 0;
    const format = keepAlpha ? 'png' : 'jpeg';
    const quality = Math.max(45, 85 - attempt * 15);
    const outFile = path.join(dir, `gdip-${attempt}.${format === 'png' ? 'png' : 'jpg'}`);
    const run = await runPowerShell(
      buildGdipScript({ inFile, outFile, maxEdge: edge, quality, keepAlpha, format }),
      { timeoutMs }
    );
    if (!run.ok) {
      lastError = run.error;
    } else {
      const out = readIfExists(outFile);
      if (out && out.length <= maxBytes) {
        const dims = sniffImage(out);
        return {
          ok: true,
          buffer: out,
          mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
          width: dims?.width ?? 0,
          height: dims?.height ?? 0
        };
      }
      lastError = '压缩后仍超限';
    }
    edge = Math.max(320, Math.round(edge * 0.7));
  }
  return { ok: false, error: lastError || '系统图像接口压缩失败' };
}

/** 用 ffmpeg 把静态图降采样 + 重编码（最多三轮，逐步缩小尺寸/降质量）。 */
async function shrinkWithFfmpeg({ ffmpeg, inFile, dir, info, maxBytes, maxLongEdge, timeoutMs }) {
  const outExt = pickOutputExt(info);
  let edge = maxLongEdge;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scale = Math.min(1, edge / Math.max(info.width, info.height));
    const width = Math.max(2, Math.round(info.width * scale) & ~1);
    const height = Math.max(2, Math.round(info.height * scale) & ~1);
    const outFile = path.join(dir, `out-${attempt}${outExt}`);
    const args = ['-v', 'error', '-y', '-i', inFile, '-vf', `scale=${width}:${height}:flags=lanczos`];
    if (outExt === '.jpg') args.push('-q:v', String(3 + attempt * 3));
    args.push(outFile);
    const run = await runFfmpeg(ffmpeg, args, { timeoutMs });
    if (!run.ok) {
      lastError = run.error;
    } else {
      const out = readIfExists(outFile);
      if (out && out.length <= maxBytes) {
        return {
          ok: true,
          buffer: out,
          mimeType: outExt === '.jpg' ? 'image/jpeg' : 'image/png',
          width,
          height
        };
      }
      lastError = '压缩后仍超限';
    }
    edge = Math.max(320, Math.round(edge * 0.7));
  }
  return { ok: false, error: lastError || 'ffmpeg 压缩失败' };
}

/** 用 ffmpeg 把动图抽帧拼成单张网格图（3×2 等布局见 planAnimation）。 */
async function animateWithFfmpeg({ ffmpeg, inFile, dir, info, opts, bytes, maxBytes, timeoutMs }) {
  const layout = planAnimation(info, opts);
  const tileWidth = clampInt(opts.gifTile, 64, 400, MEDIA_DEFAULTS.gifTile);
  const outFile = path.join(dir, 'strip.jpg');
  const vf = `fps=${layout.fps},scale=${tileWidth}:-1:flags=lanczos,` +
    `tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=white`;
  const run = await runFfmpeg(ffmpeg, [
    '-v', 'error', '-y', '-i', inFile,
    '-filter_complex', `[0:v]${vf}[out]`, '-map', '[out]',
    '-frames:v', '1', '-q:v', '4', outFile
  ], { timeoutMs });
  const out = run.ok ? readIfExists(outFile) : null;
  if (out && out.length <= maxBytes) {
    const seconds = (layout.durationMs / 1000).toFixed(1);
    return {
      ok: true,
      layout,
      buffer: out,
      // 这段文字会原样出现在工具结果里（外面还会再包一层括号），所以**不要用嵌套括号**。
      note: `动图 ${layout.totalFrames} 帧/${seconds}s，已抽 ${layout.sampleFrames} 帧拼成 ${layout.cols}×${layout.rows} 网格，行优先 左上→右下；原图 ${(bytes / 1024 / 1024).toFixed(2)}MB`
    };
  }
  return { ok: false, layout, error: run.ok ? '输出仍超限' : run.error };
}

/** 路径是否全是 ASCII（ffmpeg 的 Windows 构建按 ANSI 代码页解释 argv，非 ASCII 会变乱码）。 */
function isAsciiPath(value) {
  return !/[^\x00-\x7f]/.test(String(value ?? ''));
}

/**
 * 找一个可写的 ASCII 临时基目录。
 *
 * 为什么需要：ffmpeg 的 Windows 构建把命令行按 ANSI 代码页转成本地编码，临时 in/out 路径里
 * 一旦有中文（中文用户名机器上的 %TEMP% = C:\Users\张三\AppData\Local\Temp），ffmpeg 会把它
 * 当非法参数（实测退出码 -22/-5、stderr 里路径是乱码）→ 动图抽帧拼图与静态压缩整体失效，
 * 日志里只剩「退出码 -22」看不出原因。GDI+ 走 -EncodedCommand（UTF-16）不受影响，但仍统一
 * 走 ASCII 目录，避免两个后端行为不一致。
 */
function asciiTempBase() {
  const candidates = [];
  if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, 'qq-bridge-media'));
  if (process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, 'Temp', 'qq-bridge-media'));
  candidates.push('C:\\qq-bridge-media');
  for (const dir of candidates) {
    if (!isAsciiPath(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  return null;
}

function makeTempWorkspace(tmpDir) {
  let base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  if (!isAsciiPath(base)) base = asciiTempBase() || base;
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'qqb-media-'));
}

function cleanupWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** 按扩展名挑输出容器：有 alpha 用 PNG（保透明），否则 JPEG（体积小得多）。 */
function pickOutputExt(info) {
  return info?.alpha ? '.png' : '.jpg';
}

function readIfExists(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 把一张图整理成「可以安全交给 DSH / 模型」的形态。
 *
 * 压缩后端按 resolveEncoders() 的顺序尝试：ffmpeg → Windows 系统图像接口（GDI+）。
 * 任一后端成功即返回；都失败才按「小图原样、大图明确拒绝」收尾。
 *
 * @param buf       原始字节
 * @param mimeType  调用方已知的 MIME（可能与实际不符，以字节探测为准）
 * @param opts      { maxModelBytes, maxLongEdge, gifFrames, gifTile, enabled, ffmpegPath, tmpDir, label, timeoutMs, encoders }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string, skipped?:boolean}>}
 *   ok=false 只在「超大且压不动」时出现；调用方应把它变成一句可读的失败原因，而不是发空图。
 */
export async function normalizeImageForModel(buf, mimeType, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  if (opts.enabled === false) return { ok: true, buffer: buf, mimeType, note: '' };

  const info = sniffImage(buf);
  const plan = planNormalization(info, bytes, opts);
  if (!plan) {
    // 原样放行：这是绝大多数情况（小图），零额外延迟。
    return { ok: true, buffer: buf, mimeType: mimeType || (info ? `image/${info.format === 'jpeg' ? 'jpeg' : info.format}` : 'image/jpeg'), note: '' };
  }
  if (plan.action === 'reject') {
    return { ok: false, error: plan.reason, skipped: true };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const maxBytes = plan.maxBytes;
  const maxLongEdge = plan.maxLongEdge;
  const timeoutMs = opts.timeoutMs ?? MEDIA_DEFAULTS.timeoutMs;
  const encoders = resolveEncoders(opts);

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const inExt = info.format === 'jpeg' ? '.jpg' : `.${info.format}`;
    const inFile = path.join(dir, `in${inExt}`);
    fs.writeFileSync(inFile, buf);

    if (plan.action === 'animate') {
      let lastError = '';
      for (const encoder of encoders) {
        if (encoder === 'ffmpeg') {
          const grid = await animateWithFfmpeg({
            ffmpeg, inFile, dir, info, opts, bytes, maxBytes, timeoutMs
          });
          if (grid.ok) return { ok: true, buffer: grid.buffer, mimeType: 'image/jpeg', note: grid.note };
          lastError = grid.error;
        } else if (encoder === 'gdip' && bytes > maxBytes) {
          // 抽帧拼图做不到时，至少把首帧压小 —— DSH 对 GIF 本来也只取首帧，压小后还能进上下文。
          const first = await shrinkWithGdip({ dir, inFile, info, maxLongEdge, maxBytes, timeoutMs });
          if (first.ok) {
            return {
              ok: true,
              buffer: first.buffer,
              mimeType: first.mimeType,
              note: `动图 ${info.frames} 帧（ffmpeg 未成功：${lastError || '不可用'}，只把首帧压成图：${info.width}×${info.height} ${(bytes / 1024 / 1024).toFixed(2)}MB → ${first.width}×${first.height} ${(first.buffer.length / 1024).toFixed(0)}KB）`
            };
          }
          lastError = first.error;
        }
      }
      // 拼图失败（没 ffmpeg / 超时 / 还是太大）：退化到「能看多少算多少」。
      if (bytes <= maxBytes) {
        return {
          ok: true,
          buffer: buf,
          mimeType: mimeType || 'image/gif',
          note: `动图 ${info.frames} 帧（抽帧拼图失败：${lastError || 'ffmpeg 不可用'}，只提供首帧）`
        };
      }
      return { ok: false, error: `动图 ${(bytes / 1024 / 1024).toFixed(2)}MB 无法压缩（${lastError || 'ffmpeg 不可用'}）` };
    }

    // action === 'shrink'：静态图降采样 + 重编码；先 ffmpeg，再系统图像接口兜底。
    let lastError = '';
    for (const encoder of encoders) {
      const result = encoder === 'ffmpeg'
        ? await shrinkWithFfmpeg({ ffmpeg, inFile, dir, info, maxBytes, maxLongEdge, timeoutMs })
        : await shrinkWithGdip({ dir, inFile, info, maxLongEdge, maxBytes, timeoutMs });
      if (result.ok) {
        return {
          ok: true,
          buffer: result.buffer,
          mimeType: result.mimeType,
          note: `原图 ${info.width}×${info.height} ${(bytes / 1024).toFixed(0)}KB → ${result.width}×${result.height} ${(result.buffer.length / 1024).toFixed(0)}KB${encoder === 'gdip' ? '，系统图像接口' : ''}`
        };
      }
      lastError = result.error;
    }
    // 压不动：小图照发，大图明确拒绝（绝不发注定被 DSH 丢掉的东西）。
    if (bytes <= maxBytes) return { ok: true, buffer: buf, mimeType, note: `压缩失败（${lastError}），按原图提供` };
    return { ok: false, error: `${(bytes / 1024 / 1024).toFixed(2)}MB 压不到 ${(maxBytes / 1024).toFixed(0)}KB 以内（${lastError}）` };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 供日志/提示用的一句话摘要（不含 base64）。 */
export function describeImage(buf) {
  const info = sniffImage(buf);
  if (!info) return `未知格式 ${buf?.length ?? 0}B`;
  const parts = [`${info.format} ${info.width}×${info.height}`, `${(buf.length / 1024).toFixed(0)}KB`];
  if (info.animated) parts.push(`动图 ${info.frames} 帧${info.durationMs ? `/${(info.durationMs / 1000).toFixed(1)}s` : ''}`);
  return parts.join(' ');
}
