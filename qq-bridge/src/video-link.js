// 视频链接理解：把群友发来的「视频链接 / QQ 分享卡片」变成模型能读的文字。
//
// 数据流（2026-10-26 本机实测，见 docs/design/VIDEO_LINKS_SPEC.md §0）：
//   extractVideoLinks(text) / parseShareCard(json)      ← 桥接从消息文本/卡片里取链接
//     → describeVideo(url, { config, mode, transcribe }) ← 本模块
//        ├ bilibili：b23 短链 → view 元数据（匿名可用）
//        │            → wbi 签名的 player/wbi/v2 字幕（需登录）→ 字幕 JSON
//        │            → view/conclusion/get AI 总结（需登录）
//        │            → x/v2/reply 热评（匿名）、dm/list.so 弹幕（匿名）
//        │            → playurl dash 最低码率音频 → 本机 ffmpeg 转 16k wav
//        │              → 注入的 transcribe() 分片 ASR（SenseVoice）
//        └ 其它平台：safeFetch 页面 → og/title/description（只有标题简介）
//     → formatVideoCard（消息里的短卡片）/ formatVideoReport（工具返回的完整文本）
//
// 硬约束：
// - 只依赖 node:*、./safe-fetch.js；**不 import bridge.js**，外部能力（转写/抓取）用注入。
// - 登录 cookie 只出现在请求头里：不写返回值、不写日志、不写缓存（缓存的是最终结果）。
// - 每一段网络/转码失败都只落到 errors/notes，元数据照常返回；describeVideo 永不抛异常。
// - 本模块假设 url 来自 extractVideoLinks/parseShareCard（调用方保证来源），但仍做 scheme/
//   长度/凭据校验 + 短链逐跳 SSRF 校验 + 音频 Host 白名单，避免被当成任意 URL 抓取器。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeFetch, safeFetchBinary, validateFetchUrl } from './safe-fetch.js';
import { clampInt } from './util/num.js';

/** 桌面 UA：B 站接口对默认 UA/无 Referer 的请求会更容易风控。 */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const API_BASE = 'https://api.bilibili.com';
/** 本机实测可用的 ffmpeg（spec §1.6 的兜底顺序最后一项）。 */
const FFMPEG_FALLBACK = 'C:\\Program Files\\Krita (x64)\\bin\\ffmpeg.exe';
/** 音频下载只允许 B 站自家 CDN 域名（后缀匹配，界必须带点或完全相等）。 */
const MEDIA_HOST_SUFFIXES = Object.freeze(['bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'szbdyd.com', 'bilibili.com']);
/** wbi 签名的重排表（bilibili-API-collect 公开常量，§4）。 */
const WBI_MIXIN_KEY_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]);

/** 视频理解的默认配置（config.json 的 video 段，缺省值在这里）。 */
export const VIDEO_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerMinute: 4,
  maxPerHour: 20,
  metaTimeoutMs: 3500,
  fetchTimeoutMs: 20000,
  maxDurationSeconds: 1800,
  asrMaxSeconds: 300,
  asrChunkSeconds: 120,
  maxAudioBytes: 32 * 1024 * 1024,
  ffmpegPath: '',
  transcriptMaxChars: 6000,
  commentLimit: 8,
  commentMaxChars: 120,
  danmakuSample: 30,
  includeComments: true,
  includeDanmaku: true,
  cacheTtlMs: 600000,
  cacheMaxEntries: 50,
  asr: Object.freeze({ enabled: true }),
  bilibili: Object.freeze({ cookie: '', fetchSubtitles: true, fetchAiSummary: true }),
});

const WBI_TTL_MS = 10 * 60 * 1000;

// ── 小工具 ───────────────────────────────────────────────────────────────────

function messageOf(error) {
  if (typeof error === 'string') return error.slice(0, 300);
  return String(error?.message ?? error ?? '未知错误').slice(0, 300);
}

function clampText(value, maxLen, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLen) : fallback;
}

/** 整数计数 → 人类可读：10194 → 1万，8000 → 8千，320 → 320。 */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 100000000) return `${trimZero((n / 100000000).toFixed(1))}亿`;
  if (n >= 10000) return `${trimZero((n / 10000).toFixed(1))}万`;
  if (n >= 1000) return `${trimZero((n / 1000).toFixed(1))}千`;
  return String(Math.round(n));
}

function trimZero(text) {
  return String(text).replace(/\.0$/, '');
}

/** 时间戳 → mm:ss / h:mm:ss（0 也合法，用于字幕/弹幕时间轴）。 */
function formatClock(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/**
 * 时间码样式：494 → 08:14；3700 → 1:01:40；≤0/未知 → ''（卡片里不显示时长）。
 *
 * 与 voice-core 的 formatSpokenDuration 是**两个函数**，别合并：那个把时长读成口语
 * （494 → 「8分14秒」），用于「时长 8分14秒 超过上限」这类对用户说的话；
 * 这里给的是字幕时间轴和卡片角落的紧凑格式。历史上一度同名，差点被当成重复实现删掉。
 */
export function formatTimecode(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '';
  return formatClock(total);
}

function isoDate(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch { return ''; }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function isGzipBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZlibBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return false;
  if ((buf[0] & 0x0f) !== 8) return false;
  return ((buf[0] << 8) | buf[1]) % 31 === 0;
}

/** 解压（gzip/zlib 都可能；B 站弹幕接口有时会忽略我们没发 Accept-Encoding 这件事）。 */
function decodeMaybeCompressed(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return Buffer.alloc(0);
  if (isGzipBuffer(buf)) {
    try { return zlib.gunzipSync(buf); } catch { /* 落到原样 */ }
  }
  if (isZlibBuffer(buf)) {
    try { return zlib.inflateSync(buf); } catch { /* 落到原样 */ }
  }
  return buf;
}

/** Buffer → UTF-8 文本；必要时再试一次 raw deflate（无 zlib 头）。 */
function bufferToText(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  let text = decodeMaybeCompressed(buf).toString('utf8');
  if (!/^[\s{<[]/.test(text)) {
    try { text = zlib.inflateRawSync(buf).toString('utf8'); } catch { /* 保持原样 */ }
  }
  return text;
}

// ── 配置规整 ─────────────────────────────────────────────────────────────────

/**
 * 把 config.json 的 video 段规整成带默认值的对象（返回新对象，不修改入参）。
 * 为了兼容两种调用方式：传整个 config（读 cfg.video）或直接传 video 段（spec §1 的
 * options.config 就是 normalizeVideoConfig 的结果）。
 * @param {object} cfg
 */
export function normalizeVideoConfig(cfg) {
  const source = cfg && typeof cfg === 'object' && cfg.video && typeof cfg.video === 'object' && !Array.isArray(cfg.video)
    ? cfg.video
    : (cfg && typeof cfg === 'object' ? cfg : {});
  const D = VIDEO_DEFAULTS;
  const asr = source.asr && typeof source.asr === 'object' ? source.asr : {};
  const bili = source.bilibili && typeof source.bilibili === 'object' ? source.bilibili : {};
  return {
    enabled: source.enabled !== false,
    maxPerMinute: clampInt(source.maxPerMinute, 1, 60, D.maxPerMinute),
    maxPerHour: clampInt(source.maxPerHour, 1, 600, D.maxPerHour),
    metaTimeoutMs: clampInt(source.metaTimeoutMs, 500, 60000, D.metaTimeoutMs),
    fetchTimeoutMs: clampInt(source.fetchTimeoutMs, 3000, 120000, D.fetchTimeoutMs),
    maxDurationSeconds: clampInt(source.maxDurationSeconds, 0, 86400, D.maxDurationSeconds),
    asrMaxSeconds: clampInt(source.asrMaxSeconds, 10, 1800, D.asrMaxSeconds),
    asrChunkSeconds: clampInt(source.asrChunkSeconds, 15, 120, D.asrChunkSeconds),
    maxAudioBytes: clampInt(source.maxAudioBytes, 1024 * 1024, 128 * 1024 * 1024, D.maxAudioBytes),
    ffmpegPath: clampText(source.ffmpegPath, 512, ''),
    transcriptMaxChars: clampInt(source.transcriptMaxChars, 500, 40000, D.transcriptMaxChars),
    commentLimit: clampInt(source.commentLimit, 0, 50, D.commentLimit),
    commentMaxChars: clampInt(source.commentMaxChars, 20, 1000, D.commentMaxChars),
    danmakuSample: clampInt(source.danmakuSample, 0, 200, D.danmakuSample),
    includeComments: source.includeComments !== false,
    includeDanmaku: source.includeDanmaku !== false,
    cacheTtlMs: clampInt(source.cacheTtlMs, 0, 86400000, D.cacheTtlMs),
    cacheMaxEntries: clampInt(source.cacheMaxEntries, 1, 500, D.cacheMaxEntries),
    asr: { enabled: asr.enabled !== false },
    bilibili: {
      cookie: clampText(bili.cookie, 4096, ''),
      fetchSubtitles: bili.fetchSubtitles !== false,
      fetchAiSummary: bili.fetchAiSummary !== false,
    },
  };
}

// ── 链接抽取 ─────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"'`（）()【】\[\]{}，。；！？、：\u3000]+/gi;
const SCHEMELESS_RE = /(?<![A-Za-z0-9@._/-])((?:b23\.tv|bili2233\.cn|(?:[\w-]+\.)*bilibili\.com|(?:v|www)\.douyin\.com|(?:[\w-]+\.)*douyin\.com|(?:v|www)\.kuaishou\.com|(?:[\w-]+\.)*kuaishou\.com|xhslink\.com|(?:www\.)?xiaohongshu\.com|youtu\.be|(?:www\.|m\.)youtube\.com)(?:\/[^\s<>"'`（）()【】\[\]{}，。；！？、：\u3000]*)?)/gi;
const BARE_BV_RE = /(?<![A-Za-z0-9])[Bb][Vv]1[1-9A-HJ-NP-Za-km-z]{9}/g;
const BARE_AV_RE = /(?<![A-Za-z0-9])[Aa][Vv](\d{1,12})(?!\d)/g;
/** URL 末尾常粘着中文标点/括号，剪掉；不要剪掉 URL 自身的 / 与 =。 */
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、"'”’）)\]】》>…]+$/;
/** generic 平台里这些扩展名不是能读的页面/我们不支持的裸媒体文件，直接跳过。 */
const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|zip|rar|7z|tar|gz|apk|exe|msi|dmg|pdf|docx?|xlsx?|pptx?|mp3|wav|flac|aac|ogg|m4a|mp4|webm|mov|mkv|flv|avi|m3u8|m4s)$/i;

function trimUrlTail(raw) {
  let url = String(raw ?? '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = url.replace(TRAILING_PUNCT_RE, '');
    if (next === url) break;
    url = next;
  }
  return url;
}

function detectPlatform(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return 'generic';
  if (host === 'b23.tv' || host.endsWith('.b23.tv') || host === 'bili2233.cn' || host.endsWith('.bili2233.cn')) return 'bilibili';
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  if (host === 'douyin.com' || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com')) return 'douyin';
  if (host === 'kuaishou.com' || host.endsWith('.kuaishou.com') || host.endsWith('.gifshow.com') || host.endsWith('.chenzhongtech.com')) return 'kuaishou';
  if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'xhslink.com' || host.endsWith('.xhslink.com')) return 'xiaohongshu';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  return 'generic';
}

function shortToken(pathname) {
  const segment = String(pathname || '').split('/').filter(Boolean).pop() || '';
  return /^[\w.~-]{1,80}$/.test(segment) ? segment : '';
}

function extractBvid(url) {
  const source = `${url.pathname}${url.search}`;
  const match = /[Bb][Vv]1[1-9A-HJ-NP-Za-km-z]{9}/.exec(source);
  if (!match) return '';
  return `BV${match[0].slice(2)}`;
}

function extractAid(url) {
  const fromPath = /\/video\/[Aa][Vv](\d{1,12})/.exec(url.pathname);
  if (fromPath) return Number(fromPath[1]) || null;
  const fromQuery = url.searchParams.get('aid');
  if (fromQuery && /^\d{1,12}$/.test(fromQuery)) return Number(fromQuery);
  return null;
}

/**
 * 把一个候选 URL 归类；不属于视频链接的返回 null。
 * bilibili 只认「BV/av id、b23 短链、/video/ 路径」——番剧/直播/空间这类链接会退化成
 * generic（只读页面标题简介），避免调 view 接口拿到 -404 让模型以为视频没了。
 */
function classifyVideoUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const platform = detectPlatform(host);

  if (platform === 'bilibili') {
    const bvid = extractBvid(url);
    const aid = extractAid(url);
    const hostBili = host === 'bilibili.com' || host.endsWith('.bilibili.com');
    const isShort = host === 'b23.tv' || host.endsWith('.b23.tv') || host === 'bili2233.cn' || host.endsWith('.bili2233.cn');
    const isVideoPath = /^\/video\//.test(url.pathname);
    if (!hostBili && !isShort) return null;
    if (!bvid && !aid && !isShort && !isVideoPath) {
      // 不是视频链接（番剧/直播/专栏/空间…）：交给 generic 页面抓取
      return {
        platform: 'generic',
        url: url.toString(),
        id: shortToken(url.pathname) || host,
      };
    }
    const id = bvid || (aid ? `av${aid}` : (isShort ? `b23-${shortToken(url.pathname) || 'unknown'}` : (shortToken(url.pathname) || host)));
    const link = { platform: 'bilibili', url: url.toString(), id };
    if (bvid) link.bvid = bvid;
    if (aid) link.aid = aid;
    return link;
  }

  if (platform === 'generic' && BINARY_EXT_RE.test(url.pathname)) return null;

  let id = '';
  if (platform === 'douyin') {
    id = (/\/(?:video|note|slides)\/(\d+)/.exec(url.pathname) || [])[1] || shortToken(url.pathname);
  } else if (platform === 'kuaishou') {
    id = (/\/(?:short-video|video|photo)\/([\w-]+)/.exec(url.pathname) || [])[1] || shortToken(url.pathname);
  } else if (platform === 'xiaohongshu') {
    id = (/\/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]+)/.exec(url.pathname) || [])[1] || shortToken(url.pathname);
  } else if (platform === 'youtube') {
    id = url.searchParams.get('v') || (/\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(url.pathname) || [])[1] || shortToken(url.pathname);
  } else {
    id = shortToken(url.pathname);
  }
  if (!id) id = url.hostname;
  return { platform, url: url.toString(), id: String(id).slice(0, 200) };
}

/**
 * 从任意文本里抽出视频链接（顺序保持文本出现顺序，按 platform:id 去重）。
 * @param {string} text
 * @param {{max?: number}} [options]
 * @returns {{platform:string,url:string,id:string,bvid?:string,aid?:number}[]}
 */
export function extractVideoLinks(text, { max = 3 } = {}) {
  const source = String(text ?? '');
  const limit = Math.min(10, Math.max(1, Number(max) || 3));
  /** @type {{index:number, kind:'url'|'bare', value:string}[]} */
  const found = [];

  for (const match of source.matchAll(URL_RE)) {
    const url = trimUrlTail(match[0]);
    if (!url) continue;
    found.push({ index: match.index ?? 0, kind: 'url', value: url });
  }
  for (const match of source.matchAll(SCHEMELESS_RE)) {
    if (!match[1]) continue;
    const url = trimUrlTail(match[1]);
    if (!url) continue;
    // 只有域名（如单说一句 www.bilibili.com）不算视频链接
    if (!/[/?#]/.test(url)) continue;
    const offset = match.index ?? 0;
    found.push({ index: offset + match[0].indexOf(match[1]), kind: 'url', value: `https://${url}` });
  }
  for (const match of source.matchAll(BARE_BV_RE)) {
    found.push({ index: match.index ?? 0, kind: 'bare', value: `BV${match[0].slice(2)}` });
  }
  for (const match of source.matchAll(BARE_AV_RE)) {
    found.push({ index: match.index ?? 0, kind: 'bare', value: `av${match[1]}` });
  }

  found.sort((a, b) => a.index - b.index);
  /** @type {ReturnType<typeof classifyVideoUrl>[]} */
  const out = [];
  const seen = new Set();
  for (const item of found) {
    let link = null;
    if (item.kind === 'bare') {
      const bare = item.value.startsWith('BV')
        ? { platform: 'bilibili', url: `https://www.bilibili.com/video/${item.value}`, id: item.value, bvid: item.value }
        : { platform: 'bilibili', url: `https://www.bilibili.com/video/${item.value}`, id: item.value, aid: Number(item.value.slice(2)) };
      link = bare;
    } else {
      link = classifyVideoUrl(item.value);
    }
    if (!link) continue;
    const key = `${link.platform}:${link.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
    if (out.length >= limit) break;
  }
  return out;
}

// ── QQ 分享卡片 ──────────────────────────────────────────────────────────────

const CARD_URL_KEY_PRIORITY = Object.freeze({
  jumpurl: 5, jump_url: 5,
  qqdocurl: 5, qqdocurl_raw: 4,
  shareurl: 4, share_url: 4,
  targeturl: 3, target_url: 3, content_url: 3, contenturl: 3, ugcurl: 3,
  url: 1,
});
const CARD_TEXT_KEY_PRIORITY = Object.freeze({
  title: 3,
  desc: 3, description: 3,
  summary: 2, sub_title: 2, subtitle: 2,
  content: 1, prompt: 1, name: 1,
});
const APP_NAME_TITLES = new Set(['哔哩哔哩', 'bilibili', '抖音', '快手', '小红书', 'youtube', '微博', '腾讯视频', '西瓜视频', '今日头条', 'qq', 'b站']);

function walkCard(root) {
  const urls = [];
  const texts = [];
  const stack = [{ value: root, depth: 0 }];
  let order = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || node.depth > 10) continue;
    const value = node.value;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push({ value: value[i], depth: node.depth + 1 });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const entries = Object.entries(value);
    const baseOrder = order;
    order += entries.length;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [rawKey, child] = entries[i];
      const key = String(rawKey || '').toLowerCase();
      const entryOrder = baseOrder + i;
      if (typeof child === 'string') {
        const trimmed = child.trim();
        const urlPriority = CARD_URL_KEY_PRIORITY[key];
        if (urlPriority && /^https?:\/\//i.test(trimmed)) {
          urls.push({ url: trimUrlTail(trimmed), priority: urlPriority, order: entryOrder });
          continue;
        }
        const textPriority = CARD_TEXT_KEY_PRIORITY[key];
        if (textPriority && trimmed && !/^https?:\/\//i.test(trimmed)) {
          texts.push({ key, text: trimmed, priority: textPriority, order: entryOrder });
        }
        // 一些卡片把子 JSON 再序列化一层（如 meta 的 data 字段）
        if (trimmed.length > 2 && trimmed.length < 20000 && (trimmed[0] === '{' || trimmed[0] === '[')) {
          try { stack.push({ value: JSON.parse(trimmed), depth: node.depth + 1 }); } catch { /* 忽略 */ }
        }
        continue;
      }
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: node.depth + 1 });
      }
    }
  }
  return { urls, texts };
}

/**
 * 解析 QQ 分享卡片 JSON 文本（OneBot json 段的 data.data），抽出 { title, desc, url, platform }。
 * 兼容 com.tencent.structmsg（meta.news.jumpUrl）、com.tencent.miniapp_01
 * （meta.detail_1.qqdocurl）以及任意嵌套里的 jumpUrl/qqdocurl/url/shareUrl。
 * 解析失败/没有可用 URL 返回 null（不抛）。
 * @param {string|object} jsonText
 * @returns {{title:string,desc:string,url:string,platform:string}|null}
 */
export function parseShareCard(jsonText) {
  let root = jsonText;
  if (typeof root === 'string') {
    const source = root.trim();
    if (!source || (source[0] !== '{' && source[0] !== '[')) return null;
    try { root = JSON.parse(source); } catch { return null; }
  }
  if (!root || typeof root !== 'object') return null;

  let urls;
  let texts;
  try { ({ urls, texts } = walkCard(root)); } catch { return null; }
  if (!urls.length) return null;

  const scoreUrl = (item) => {
    const platform = detectPlatform((() => {
      try { return new URL(item.url).hostname; } catch { return ''; }
    })());
    return item.priority * 10 + (platform !== 'generic' ? 5 : 0);
  };
  const best = urls.slice().sort((a, b) => (scoreUrl(b) - scoreUrl(a)) || (a.order - b.order))[0];
  const finalUrl = best?.url;
  if (!finalUrl || !/^https?:\/\//i.test(finalUrl)) return null;

  const pickText = (keys) => texts
    .filter((item) => keys.includes(item.key))
    .sort((a, b) => (b.priority - a.priority) || (a.order - b.order))[0]?.text || '';

  let title = pickText(['title', 'name']);
  let desc = pickText(['desc', 'description', 'summary', 'sub_title', 'subtitle', 'content', 'prompt']);
  if (title && APP_NAME_TITLES.has(title.toLowerCase()) && desc) {
    // 小程序卡片常把 App 名放 title、真正的标题放 desc
    title = desc;
    desc = '';
  }
  if (!title && desc) {
    title = desc;
    desc = '';
  }
  if (title && desc === title) desc = '';

  return {
    title: clampText(title, 200, ''),
    desc: clampText(desc, 300, ''),
    url: finalUrl,
    platform: classifyVideoUrl(finalUrl)?.platform ?? 'generic',
  };
}

// ── wbi 签名（§4） ───────────────────────────────────────────────────────────

/**
 * B 站 wbi 签名（纯函数，便于单测）。
 * imgKey/subKey 来自 nav 的 wbi_img.img_url/sub_url（取文件名去扩展名）。
 * 规则：两段拼接 → mixinKeyEncTab 重排取前 32 → 参数按键排序 + wts → md5(query + mixinKey)。
 * @param {Record<string, string|number>} params 已有 wts 时沿用（便于固定向量测试）
 * @param {string} imgKey
 * @param {string} subKey
 * @returns {{wts:number, w_rid:string, query:string, mixinKey:string}}
 */
export function wbiSign(params = {}, imgKey = '', subKey = '') {
  const original = `${imgKey ?? ''}${subKey ?? ''}`;
  const mixinKey = WBI_MIXIN_KEY_TAB.map((index) => original[index] ?? '').join('').slice(0, 32);
  const providedWts = Number(params?.wts);
  const wts = Number.isSafeInteger(providedWts) && providedWts > 0 ? providedWts : Math.floor(Date.now() / 1000);
  const merged = { ...(params ?? {}), wts };
  const query = Object.keys(merged)
    .filter((key) => key !== 'w_rid' && merged[key] != null)
    .sort()
    .map((key) => {
      // 官方实现会剔除值里的 !'()* 这几个字符
      const value = String(merged[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const w_rid = crypto.createHash('md5').update(`${query}${mixinKey}`).digest('hex');
  return { wts, w_rid, query, mixinKey };
}

function wbiKeyFromUrl(urlString) {
  const name = String(urlString || '').split('/').pop() || '';
  return name.replace(/\.\w+$/, '');
}

// ── 字幕 / 弹幕解析 ──────────────────────────────────────────────────────────

/**
 * 解析 B 站字幕 JSON（`{ body: [{ from, to, content }] }`）成带时间戳的文本。
 * @param {string|object} input
 * @param {{maxChars?: number}} [options]
 * @returns {{ok:true,text:string,chars:number,lines:number,truncated:boolean}|{ok:false,error:string}}
 */
export function parseSubtitleJson(input, { maxChars = VIDEO_DEFAULTS.transcriptMaxChars } = {}) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return { ok: false, error: '字幕 JSON 解析失败' }; }
  }
  const body = Array.isArray(data?.body) ? data.body : [];
  if (!body.length) return { ok: false, error: '字幕内容为空' };
  const limit = Math.max(200, Number(maxChars) || VIDEO_DEFAULTS.transcriptMaxChars);
  const lines = [];
  let chars = 0;
  let truncated = false;
  for (const item of body) {
    const text = String(item?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `[${formatClock(item?.from)}] ${text}`;
    if (chars + line.length + 1 > limit) { truncated = true; break; }
    lines.push(line);
    chars += line.length + 1;
  }
  if (!lines.length) return { ok: false, error: '字幕没有可用文本' };
  const text = lines.join('\n');
  return { ok: true, text, chars: text.length, lines: lines.length, truncated };
}

/**
 * 解析 B 站弹幕 XML（`<d p="...">text</d>`）成文本数组。
 * @param {string} xml
 * @returns {string[]}
 */
export function parseDanmakuXml(xml) {
  const source = String(xml ?? '');
  if (!source) return [];
  const out = [];
  const re = /<d\b[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = re.exec(source))) {
    const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

/** 等距抽样（确定性，便于测试）：长度 ≤ n 时全取。 */
function sampleEvenly(list, count) {
  const items = Array.isArray(list) ? list : [];
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (!items.length || n <= 0) return [];
  if (items.length <= n) return items.slice();
  const out = [];
  const step = items.length / n;
  for (let i = 0; i < n; i += 1) out.push(items[Math.min(items.length - 1, Math.floor(i * step))]);
  return out;
}

// ── 进程内缓存（TTL + LRU） ──────────────────────────────────────────────────

/** @type {Map<string, {at:number, value:object}>} */
const videoCache = new Map();

function cacheGet(key, ttlMs) {
  if (!(ttlMs > 0)) return null;
  const hit = videoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    videoCache.delete(key);
    return null;
  }
  // 触达即刷新 LRU 位置
  videoCache.delete(key);
  videoCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value, maxEntries) {
  videoCache.delete(key);
  videoCache.set(key, { at: Date.now(), value });
  const capacity = Math.max(1, Math.round(Number(maxEntries) || 1));
  while (videoCache.size > capacity) {
    const oldest = videoCache.keys().next().value;
    if (oldest === undefined) break;
    videoCache.delete(oldest);
  }
}

/** 清空视频缓存（测试/调试用）。 */
export function clearVideoCache() {
  videoCache.clear();
}

// ── HTTP 辅助 ────────────────────────────────────────────────────────────────

function createContext(options = {}) {
  const config = normalizeVideoConfig(options.config ?? {});
  const mode = ['meta', 'auto', 'full'].includes(options.mode) ? options.mode : 'auto';
  return {
    config,
    mode,
    cookie: config.bilibili.cookie,
    transcribe: typeof options.transcribe === 'function' ? options.transcribe : null,
    fetchBinary: typeof options.fetchBinary === 'function' ? options.fetchBinary : safeFetchBinary,
    fetchText: typeof options.fetchText === 'function' ? options.fetchText : safeFetch,
    validateUrl: typeof options.validateUrl === 'function' ? options.validateUrl : validateFetchUrl,
    ffmpegPathOverride: typeof options.ffmpegPath === 'string' ? options.ffmpegPath : '',
    // 不给默认语言：留空时由调用方（桥接的 voice.asr.language）决定，避免覆盖用户配置
    language: typeof options.language === 'string' ? options.language : '',
    log: typeof options.log === 'function' ? options.log : null,
    signal: options.signal,
  };
}

/** API 请求头：带 Referer/桌面 UA/Cookie（cookie 只在这里出现，绝不进日志与返回值）。 */
function apiHeaders(ctx) {
  const headers = {
    'user-agent': DESKTOP_UA,
    referer: 'https://www.bilibili.com',
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
  };
  if (ctx.cookie) headers.cookie = ctx.cookie;
  return headers;
}

/** 媒体（音频/字幕 CDN）请求头：不带 cookie（CDN 用签名 URL，不需要登录态）。 */
function mediaHeaders() {
  return {
    'user-agent': DESKTOP_UA,
    referer: 'https://www.bilibili.com',
    origin: 'https://www.bilibili.com',
    accept: '*/*',
  };
}

async function fetchJson(ctx, url, { timeoutMs = ctx.config.fetchTimeoutMs, maxBytes = 8 * 1024 * 1024, headers } = {}) {
  const res = await ctx.fetchBinary(url, maxBytes, {
    headers: headers ?? apiHeaders(ctx),
    timeoutMs,
    signal: ctx.signal,
  });
  const buffer = Buffer.isBuffer(res?.buffer) ? res.buffer : Buffer.alloc(0);
  const text = bufferToText(buffer).trim();
  if (!text) throw new Error(`接口返回为空（HTTP ${res?.statusCode ?? '?'}）`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回不是 JSON（HTTP ${res?.statusCode ?? '?'}）：${text.slice(0, 100)}`);
  }
}

async function apiGet(ctx, endpoint, params = {}, opts) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return await fetchJson(ctx, url.toString(), opts);
}

// ── wbi 密钥（进程内缓存，匿名 nav 也带 wbi_img） ────────────────────────────

let wbiCache = { imgKey: '', subKey: '', at: 0 };

async function wbiKeys(ctx) {
  if (wbiCache.imgKey && wbiCache.subKey && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache;
  const nav = await apiGet(ctx, `${API_BASE}/x/web-interface/nav`);
  const imgKey = wbiKeyFromUrl(nav?.data?.wbi_img?.img_url);
  const subKey = wbiKeyFromUrl(nav?.data?.wbi_img?.sub_url);
  if (!imgKey || !subKey) throw new Error('拿不到 wbi 签名密钥（nav 没有返回 wbi_img）');
  wbiCache = { imgKey, subKey, at: Date.now() };
  return wbiCache;
}

async function signedGet(ctx, endpoint, params) {
  const { imgKey, subKey } = await wbiKeys(ctx);
  const { query, w_rid } = wbiSign(params, imgKey, subKey);
  const url = new URL(endpoint);
  url.search = query;
  url.searchParams.set('w_rid', w_rid);
  return await fetchJson(ctx, url.toString());
}

/** 测试用：清空 wbi 密钥缓存。 */
export function clearWbiKeyCache() {
  wbiCache = { imgKey: '', subKey: '', at: 0 };
}

// ── 非 bilibili：页面标题/简介 ───────────────────────────────────────────────

function pickTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

function metaTags(html) {
  const map = new Map();
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const tag = match[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content && !map.has(key.toLowerCase())) map.set(key.toLowerCase(), content);
  }
  return map;
}

function pickMeta(map, keys) {
  for (const key of keys) {
    const value = map.get(key.toLowerCase());
    if (value) return value;
  }
  return '';
}

const PLATFORM_LABELS = Object.freeze({
  bilibili: 'B站',
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  youtube: 'YouTube',
  generic: '网页',
});

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? '网页';
}

async function describeGenericPage(ctx, link) {
  let res;
  try {
    res = await ctx.fetchText(link.url, 400 * 1024);
  } catch (error) {
    return { ok: false, error: `打开页面失败：${messageOf(error)}` };
  }
  const html = String(res?.body ?? '');
  if (!html) return { ok: false, error: '页面内容为空（可能需要登录或被反爬拦截）' };
  const metas = metaTags(html);
  const title = pickMeta(metas, ['og:title', 'twitter:title']) || pickTitle(html) || link.url;
  const description = pickMeta(metas, ['og:description', 'description', 'twitter:description']);
  const siteName = pickMeta(metas, ['og:site_name']);
  return {
    ok: true,
    platform: link.platform,
    id: link.id,
    url: String(res?.url || link.url),
    title: clampText(decodeEntities(title), 200, link.url),
    owner: clampText(siteName, 80, ''),
    ownerId: null,
    durationSeconds: null,
    description: clampText(decodeEntities(description), 800, ''),
    tags: [],
    stats: null,
    parts: [],
    subtitle: null,
    aiSummary: null,
    comments: null,
    danmaku: null,
    transcript: null,
    notes: ['该平台只能读页面标题/简介，没有字幕或转写'],
    errors: [],
    fetchedAt: new Date().toISOString(),
  };
}

// ── bilibili：短链 / 元数据 ──────────────────────────────────────────────────

async function resolveShortLink(ctx, url) {
  const res = await ctx.fetchText(url, 12000);
  const finalUrl = String(res?.url || '');
  if (finalUrl && finalUrl !== url && /bilibili\.com/i.test(finalUrl)) {
    const bvid = extractBvid(new URL(finalUrl));
    return bvid ? `https://www.bilibili.com/video/${bvid}` : finalUrl;
  }
  const body = String(res?.body ?? '');
  const direct = /(https?:\/\/(?:www\.)?bilibili\.com\/video\/[Bb][Vv]1[1-9A-HJ-NP-Za-km-z]{9}[^\s"'<>]*)/.exec(body);
  if (direct) return direct[1].replace(/&amp;/g, '&');
  const assignment = /(?:location(?:\.href)?|url)\s*[=:]\s*["']([^"']*bilibili\.com[^"']*)["']/i.exec(body);
  if (assignment) return assignment[1].replace(/&amp;/g, '&');
  throw new Error('短链没有跳转到视频页');
}

function viewErrorText(code, message, bvid) {
  const id = bvid ? ` ${bvid}` : '';
  const detail = String(message ?? '').trim();
  if (code === -404) return `B 站上没有这个视频${id}（可能已删除或仅限登录查看）`;
  if (code === -403) return `B 站拒绝了访问${id}（可能需要登录或大会员）`;
  if (code === 62002) return `视频${id}不可见（审核中或私有）`;
  if (code === 62004) return `视频${id}还在审核中，暂时看不到`;
  if (code === 62012) return `视频${id}仅 UP 主自己可见`;
  return `B 站返回错误${Number.isFinite(Number(code)) ? `（${code}）` : ''}${detail ? `：${detail}` : ''}`;
}

// ── bilibili：字幕 / AI 总结 / 热评 / 弹幕 ───────────────────────────────────

function normalizeSubtitleUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('http://')) url = `https://${url.slice(7)}`;
  return /^https:\/\//i.test(url) ? url : '';
}

function mapSubtitleLanguages(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const lan = String(item?.lan ?? '');
      const lanDoc = String(item?.lan_doc ?? '');
      const ai = Number(item?.ai_type) > 0 || /^ai-/i.test(lan);
      return { lan, lanDoc, ai, url: normalizeSubtitleUrl(item?.subtitle_url ?? item?.subtitle_url_v2) };
    })
    .filter((item) => item.lan || item.url);
}

/** 优先人工中文字幕，其次 AI 中文字幕，最后列表第一条。 */
function pickSubtitleTrack(languages) {
  const order = ['zh-Hans', 'zh-CN', 'zh-Hans-CN', 'ai-zh'];
  for (const lan of order) {
    const hit = languages.find((item) => item.lan === lan && item.url);
    if (hit) return hit;
  }
  const chinese = languages.find((item) => /^zh|^ai-zh/i.test(item.lan) && item.url);
  return chinese || languages.find((item) => item.url) || null;
}

async function fetchSubtitleList(ctx, bvid, cid) {
  // 先走 wbi 签名版本（登录态下才会返回 AI 字幕），失败再退回无签名版本
  try {
    const signed = await signedGet(ctx, `${API_BASE}/x/player/wbi/v2`, { bvid, cid });
    if (Number(signed?.code) === 0) {
      const list = mapSubtitleLanguages(signed?.data?.subtitle?.subtitles);
      if (list.length) return { list, code: 0, message: '' };
      return { list: [], code: 0, message: '' };
    }
    const plain = await apiGet(ctx, `${API_BASE}/x/player/v2`, { bvid, cid });
    return {
      list: Number(plain?.code) === 0 ? mapSubtitleLanguages(plain?.data?.subtitle?.subtitles) : [],
      code: Number(signed?.code) || 0,
      message: String(signed?.message ?? ''),
    };
  } catch (error) {
    const plain = await apiGet(ctx, `${API_BASE}/x/player/v2`, { bvid, cid });
    if (Number(plain?.code) !== 0) throw new Error(`player/v2 ${plain?.code ?? '?'} ${plain?.message ?? ''}`.trim());
    return { list: mapSubtitleLanguages(plain?.data?.subtitle?.subtitles), code: 0, message: '' };
  }
}

function parseAiSummary(data) {
  const model = data?.model_result ?? data ?? {};
  let summary = String(model?.summary ?? data?.summary ?? '').trim();
  if (!summary) summary = String(model?.conclusion ?? '').trim();
  const outline = [];
  for (const item of Array.isArray(model?.outline) ? model.outline : []) {
    const title = String(item?.title ?? '').trim();
    const points = [];
    for (const point of Array.isArray(item?.part_outline) ? item.part_outline : []) {
      const text = String(point?.content ?? point?.title ?? '').trim();
      if (!text) continue;
      const timestamp = Number(point?.timestamp);
      points.push(Number.isFinite(timestamp) && timestamp > 0 ? `[${formatTimecode(timestamp)}] ${text}` : text);
    }
    if (title || points.length) outline.push({ title, points });
  }
  if (!summary && !outline.length) return null;
  return { available: true, summary, outline };
}

async function fetchComments(ctx, aid) {
  const cfg = ctx.config;
  if (!cfg.includeComments || cfg.commentLimit <= 0) return null;
  const json = await apiGet(ctx, `${API_BASE}/x/v2/reply`, {
    type: 1,
    oid: aid,
    sort: 1,
    ps: cfg.commentLimit,
    pn: 1,
  });
  if (Number(json?.code) !== 0) throw new Error(`${json?.code ?? '?'} ${json?.message ?? ''}`.trim());
  const replies = Array.isArray(json?.data?.replies) ? json.data.replies : [];
  const out = [];
  for (const reply of replies) {
    const user = clampText(reply?.member?.uname, 40, '匿名用户');
    const text = clampText(String(reply?.content?.message ?? '').replace(/\s+/g, ' '), cfg.commentMaxChars, '');
    if (!text) continue;
    out.push({ user, text, likes: Number(reply?.like) || 0 });
    if (out.length >= cfg.commentLimit) break;
  }
  return out.length ? out : null;
}

async function fetchDanmaku(ctx, cid) {
  const cfg = ctx.config;
  if (!cfg.includeDanmaku || cfg.danmakuSample <= 0) return null;
  const res = await ctx.fetchBinary(`${API_BASE}/x/v1/dm/list.so?oid=${encodeURIComponent(String(cid))}`, 8 * 1024 * 1024, {
    headers: apiHeaders(ctx),
    timeoutMs: cfg.fetchTimeoutMs,
    signal: ctx.signal,
  });
  const xml = bufferToText(res?.buffer);
  const all = parseDanmakuXml(xml);
  if (!all.length) return null;
  return { count: all.length, samples: sampleEvenly(all, cfg.danmakuSample) };
}

// ── bilibili：音频 + ffmpeg + 分片 ASR ───────────────────────────────────────

/** ffmpeg 解析顺序：options.ffmpegPath → config.ffmpegPath → PATH 里的 ffmpeg → Krita 自带。 */
function resolveFfmpegPath(configPath, overridePath) {
  const candidates = [];
  if (overridePath) candidates.push(String(overridePath));
  if (configPath) candidates.push(String(configPath));
  candidates.push('ffmpeg');
  candidates.push(FFMPEG_FALLBACK);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) || /[\\/]/.test(candidate)) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* 忽略不可访问的路径 */ }
      continue;
    }
    const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const extension of extensions) {
        const full = path.join(dir, `${candidate}${extension}`);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
        } catch { /* 忽略 */ }
      }
    }
  }
  return '';
}

function isAllowedMediaHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 选音频流：只取码率最低的一条（省钱省时），但把它自己的备用地址也一起带出来——
 * B 站会下发多个 CDN（mcdn 调度节点 / 各区域 bilivideo.com），单个节点偶尔超时，
 * 有备用地址时可以换一个重试（仍然逐个过 Host 白名单与 SSRF 校验）。
 */
function pickAudioStream(data) {
  const list = [];
  const dashAudio = data?.dash?.audio;
  if (Array.isArray(dashAudio)) {
    for (const item of dashAudio) {
      const urls = [item?.baseUrl ?? item?.base_url, ...(Array.isArray(item?.backupUrl) ? item.backupUrl : []), ...(Array.isArray(item?.backup_url) ? item.backup_url : [])]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
      if (!urls.length) continue;
      list.push({ urls: [...new Set(urls)], bandwidth: Number(item?.bandwidth) || 0, id: item?.id ?? null });
    }
  }
  if (!list.length && Array.isArray(data?.durl)) {
    for (const item of data.durl) {
      if (!item?.url) continue;
      list.push({ urls: [String(item.url)], bandwidth: Number(item?.bandwidth) || 0, id: null });
    }
  }
  if (!list.length) return null;
  // 选码率最低的一条：SenseVoice 对 64k AAC 已经足够
  list.sort((a, b) => (a.bandwidth || Number.MAX_SAFE_INTEGER) - (b.bandwidth || Number.MAX_SAFE_INTEGER));
  return list[0];
}

function translateFetchError(message) {
  const text = String(message ?? '');
  if (/超过大小限制/.test(text)) return text.replace(/^图片/, '音频');
  return text;
}

/** 用 argv 数组调 ffmpeg（不经 shell），把音频流转成 16kHz 单声道 PCM16 WAV。 */
function transcodeToWav16k(ffmpegPath, input, { seconds = 0, timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];
    if (Number(seconds) > 0) args.push('-t', String(Math.ceil(Number(seconds))));
    args.push('-f', 'wav', 'pipe:1');

    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`启动 ffmpeg 失败：${messageOf(error)}`));
      return;
    }

    const chunks = [];
    const errChunks = [];
    let outBytes = 0;
    let settled = false;
    const maxOut = 32 * 1024 * 1024;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(buffer);
    };
    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`ffmpeg 转码超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    const onAbort = () => {
      kill();
      finish(new Error('请求已取消'));
    };
    if (signal) {
      if (signal.aborted) {
        kill();
        finish(new Error('请求已取消'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        kill();
        finish(new Error('ffmpeg 输出的 WAV 超过 32MB，已中止'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errChunks.length < 32) errChunks.push(chunk);
    });
    child.on('error', (error) => finish(new Error(`ffmpeg 无法执行：${messageOf(error)}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errChunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200);
        finish(new Error(`ffmpeg 转码失败（退出码 ${code}）${detail ? `：${detail}` : ''}`));
        return;
      }
      finish(null, Buffer.concat(chunks));
    });
    child.stdin.on('error', () => { /* 子进程提前退出时的 EPIPE，交给 close 处理 */ });
    child.stdin.end(input);
  });
}

/** 把 16kHz mono PCM16 WAV 按秒切片（每片带独立 WAV 头）。 */
function splitWavPcm16(wav, chunkSeconds) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) throw new Error('ffmpeg 输出的 WAV 太短');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('ffmpeg 输出不是 WAV');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') fmt = { offset: body, size };
    else if (id === 'data') {
      data = { offset: body, size: Math.min(size, wav.length - body) };
      break;
    }
    const step = 8 + size + (size % 2);
    if (step <= 0) break;
    offset += step;
  }
  if (!fmt || !data) throw new Error('ffmpeg 输出的 WAV 缺少 fmt/data 块');
  const audioFormat = wav.readUInt16LE(fmt.offset);
  const channels = wav.readUInt16LE(fmt.offset + 2);
  const sampleRate = wav.readUInt32LE(fmt.offset + 4);
  const bits = wav.readUInt16LE(fmt.offset + 14);
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(`ffmpeg 输出格式异常（format=${audioFormat} channels=${channels} rate=${sampleRate} bits=${bits}）`);
  }
  const bytesPerSecond = 32000;
  const chunkBytes = Math.max(bytesPerSecond, Math.round(Number(chunkSeconds) || 120) * bytesPerSecond);
  const out = [];
  for (let start = 0; start < data.size; start += chunkBytes) {
    const end = Math.min(data.size, start + chunkBytes);
    const pcm = wav.subarray(data.offset + start, data.offset + end);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    out.push({
      buffer: Buffer.concat([header, pcm]),
      seconds: Math.round((pcm.length / bytesPerSecond) * 10) / 10,
    });
  }
  return out;
}

async function attachAsr(ctx, result, { bvid, cid }) {
  const cfg = ctx.config;
  const ffmpegPath = resolveFfmpegPath(cfg.ffmpegPath, ctx.ffmpegPathOverride);
  if (!ffmpegPath) {
    result.notes.push('本机没有找到 ffmpeg，跳过本地语音转写');
    return;
  }
  const duration = Number(result.durationSeconds) || 0;
  const capSeconds = Math.max(10, Math.min(duration || cfg.asrMaxSeconds, cfg.asrMaxSeconds));

  let playurl;
  try {
    playurl = await apiGet(ctx, `${API_BASE}/x/player/playurl`, { bvid, cid, fnval: 16, fnver: 0, fourk: 1 });
  } catch (error) {
    result.errors.push(`取音频地址失败：${messageOf(error)}`);
    return;
  }
  if (Number(playurl?.code) !== 0) {
    result.errors.push(`取音频地址失败：${playurl?.code ?? '?'} ${playurl?.message ?? ''}`.trim());
    return;
  }
  const picked = pickAudioStream(playurl?.data);
  if (!picked) {
    result.errors.push('该视频没有可用的音频流（可能需要登录，或为互动/番剧视频）');
    return;
  }

  // 逐个候选地址过「https + Host 白名单 + SSRF 校验」；不合格的直接丢掉（B 站会下发
  // edge.mountaintoys.cn 这类不在白名单里的备用 CDN，不能因为它是官方下发的就放行）。
  const candidates = [];
  const skipped = [];
  for (const raw of picked.urls) {
    try {
      if (!/^https:\/\//i.test(raw)) throw new Error('不是 https');
      const parsed = new URL(raw);
      if (!isAllowedMediaHost(parsed.hostname)) throw new Error(`域名不在白名单内：${parsed.hostname}`);
      await ctx.validateUrl(raw); // SSRF：不许内网/本机地址
      candidates.push(parsed.toString());
    } catch (error) {
      skipped.push(messageOf(error));
    }
  }
  if (!candidates.length) {
    result.errors.push(`音频地址校验未通过：${skipped.join('；') || '没有可用地址'}`);
    return;
  }
  // 非 mcdn 的常规 CDN 优先（mcdn 是 P2P 调度节点，实测偶尔整段超时）
  candidates.sort((a, b) => Number(/mcdn/i.test(a)) - Number(/mcdn/i.test(b)));

  let audio = null;
  let lastError = '';
  for (const audioUrl of candidates.slice(0, 3)) {
    try {
      const res = await ctx.fetchBinary(audioUrl, cfg.maxAudioBytes, {
        headers: mediaHeaders(),
        timeoutMs: Math.max(cfg.fetchTimeoutMs, 30000),
        signal: ctx.signal,
      });
      const buffer = res?.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('下载到的音频为空');
      audio = buffer;
      break;
    } catch (error) {
      lastError = translateFetchError(messageOf(error));
      if (ctx.log) {
        let host = '';
        try { host = new URL(audioUrl).hostname; } catch { /* 忽略 */ }
        ctx.log(`[视频] 音频源失败（${host}）：${lastError}`);
      }
    }
  }
  if (!audio) {
    result.errors.push(`下载音频失败：${lastError || '所有音频地址都不可用'}`);
    return;
  }
  if (ctx.log) ctx.log(`[视频] 音频 ${Math.round(audio.length / 1024)}KB（码率 ${picked.bandwidth || '?'}）→ ffmpeg ${formatTimecode(capSeconds)}`);

  let wav;
  try {
    wav = await transcodeToWav16k(ffmpegPath, audio, { seconds: capSeconds, signal: ctx.signal });
  } catch (error) {
    result.errors.push(`ffmpeg 转码失败：${messageOf(error)}`);
    return;
  }

  let chunks;
  try {
    chunks = splitWavPcm16(wav, cfg.asrChunkSeconds);
  } catch (error) {
    result.errors.push(`音频切片失败：${messageOf(error)}`);
    return;
  }
  if (!chunks.length) {
    result.errors.push('音频切片为空，跳过转写');
    return;
  }

  const pieces = [];
  let seconds = 0;
  let okChunks = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (ctx.signal?.aborted) {
      result.errors.push('语音转写被取消');
      break;
    }
    const chunk = chunks[i];
    let transcription = null;
    try {
      transcription = await ctx.transcribe(chunk.buffer, { seconds: chunk.seconds, language: ctx.language || undefined });
    } catch (error) {
      result.errors.push(`第 ${i + 1}/${chunks.length} 段转写异常：${messageOf(error)}`);
      continue;
    }
    const text = String(transcription?.text ?? '').trim();
    if (transcription?.ok === true && text) {
      pieces.push(text);
      seconds += Number(chunk.seconds) || 0;
      okChunks += 1;
    } else {
      result.errors.push(`第 ${i + 1}/${chunks.length} 段转写失败：${messageOf(transcription?.error ?? '空结果')}`);
    }
  }
  if (!pieces.length) {
    result.errors.push('本地语音转写没有拿到任何文本');
    return;
  }
  const text = pieces.join('\n');
  const truncated = duration > capSeconds + 1;
  result.transcript = {
    source: 'asr',
    text,
    chars: text.length,
    truncated,
    seconds: Math.round(seconds),
    chunks: okChunks,
  };
  if (truncated) result.notes.push(`只转写了音频前 ${formatTimecode(capSeconds)}，后面的内容没听`);
}

// ── bilibili 主链路 ──────────────────────────────────────────────────────────

async function describeBilibili(ctx, link) {
  const cfg = ctx.config;
  let url = link.url;
  let bvid = link.bvid || '';
  let aid = link.aid || null;

  if (!bvid && !aid) {
    try {
      url = await resolveShortLink(ctx, url);
    } catch (error) {
      return { ok: false, error: `短链解析失败：${messageOf(error)}` };
    }
    const resolved = classifyVideoUrl(url);
    if (!resolved || resolved.platform !== 'bilibili' || (!resolved.bvid && !resolved.aid)) {
      return { ok: false, error: '短链没有指向 B 站视频（可能已失效或指向专栏/直播）' };
    }
    bvid = resolved.bvid || '';
    aid = resolved.aid || null;
    url = resolved.url;
  }

  let view;
  try {
    view = await apiGet(ctx, `${API_BASE}/x/web-interface/view`, bvid ? { bvid } : { aid });
  } catch (error) {
    return { ok: false, error: `取视频信息失败：${messageOf(error)}` };
  }
  const code = Number(view?.code);
  const data = view?.data;
  if (code !== 0 || !data) return { ok: false, error: viewErrorText(code, view?.message, bvid) };

  const pages = Array.isArray(data.pages) ? data.pages : [];
  let pageNo = 1;
  try {
    const requested = Number(new URL(url).searchParams.get('p'));
    if (Number.isFinite(requested) && requested >= 1 && requested <= Math.max(1, pages.length)) pageNo = Math.floor(requested);
  } catch { /* 链接里的 p 参数无效就用第 1 P */ }
  const page = pages[pageNo - 1] ?? pages[0] ?? null;
  const cid = Number(page?.cid || data.cid) || null;
  const pageTitle = String(page?.part ?? '').trim();

  const stats = data.stat ?? {};
  const result = {
    ok: true,
    platform: 'bilibili',
    id: String(data.bvid || bvid || (data.aid ?? aid) || link.id),
    url,
    title: clampText(data.title, 300, '（无标题）'),
    owner: clampText(data.owner?.name, 80, ''),
    ownerId: Number(data.owner?.mid) || null,
    durationSeconds: Number(data.duration) || 0,
    description: clampText(data.desc, 1200, ''),
    tags: [],
    stats: {
      view: Number(stats.view) || 0,
      like: Number(stats.like) || 0,
      coin: Number(stats.coin) || 0,
      favorite: Number(stats.favorite) || 0,
      share: Number(stats.share) || 0,
      reply: Number(stats.reply) || 0,
      danmaku: Number(stats.danmaku) || 0,
    },
    parts: pages.map((item) => ({
      cid: Number(item?.cid) || 0,
      page: Number(item?.page) || 0,
      title: String(item?.part ?? '').trim(),
      durationSeconds: Number(item?.duration) || 0,
    })),
    page: pageNo,
    subtitle: null,
    aiSummary: null,
    comments: null,
    danmaku: null,
    transcript: null,
    notes: [],
    errors: [],
    // 回显本次实际使用的正文上限，formatVideoReport 没收到 maxChars 时沿用它（避免二次截断）
    transcriptMaxChars: cfg.transcriptMaxChars,
    fetchedAt: new Date().toISOString(),
  };

  if (pages.length > 1) {
    result.notes.push(`共 ${pages.length} P，已看第 ${pageNo} P${pageTitle ? `「${pageTitle}」` : ''}`);
  }
  if (ctx.mode === 'meta') return result;

  const realBvid = String(data.bvid || bvid || '');
  const realAid = Number(data.aid || aid) || null;

  // 标签（匿名可用；失败就只留分区名）
  try {
    const tags = await apiGet(ctx, `${API_BASE}/x/tag/archive/tags`, { bvid: realBvid });
    if (Number(tags?.code) === 0 && Array.isArray(tags.data)) {
      result.tags = tags.data.map((item) => String(item?.tag_name ?? '').trim()).filter(Boolean).slice(0, 12);
    }
  } catch (error) {
    if (ctx.log) ctx.log(`[视频] 标签获取失败：${messageOf(error)}`);
  }
  if (!result.tags.length && data.tname) result.tags = [String(data.tname)];

  // 字幕（需要登录才有 AI 字幕；没有就静默降级）
  let subtitleMeta = null;
  if (cfg.bilibili.fetchSubtitles && realBvid && cid) {
    try {
      const subs = await fetchSubtitleList(ctx, realBvid, cid);
      if (subs.list.length) {
        const track = pickSubtitleTrack(subs.list);
        if (track?.url) {
          const subtitleJson = await fetchJson(ctx, track.url, { maxBytes: 16 * 1024 * 1024, headers: mediaHeaders() });
          const parsed = parseSubtitleJson(subtitleJson, { maxChars: cfg.transcriptMaxChars });
          if (parsed.ok) {
            subtitleMeta = {
              languages: subs.list.map((item) => ({ lan: item.lan, lanDoc: item.lanDoc, ai: item.ai })),
              track,
              parsed,
            };
          } else {
            result.errors.push(`字幕解析失败：${parsed.error}`);
          }
        }
      }
    } catch (error) {
      result.errors.push(`字幕获取失败：${messageOf(error)}`);
    }
  } else if (!cfg.bilibili.fetchSubtitles) {
    result.notes.push('配置里关闭了字幕抓取');
  }

  if (subtitleMeta) {
    result.subtitle = {
      available: true,
      source: 'bilibili',
      languages: subtitleMeta.languages,
      text: subtitleMeta.parsed.text,
      chars: subtitleMeta.parsed.chars,
      truncated: subtitleMeta.parsed.truncated,
    };
    result.transcript = {
      source: 'subtitle',
      text: subtitleMeta.parsed.text,
      chars: subtitleMeta.parsed.chars,
      truncated: subtitleMeta.parsed.truncated,
      seconds: result.durationSeconds,
      chunks: 0,
    };
  } else if (cfg.bilibili.fetchSubtitles) {
    result.notes.push('没有取到 B 站字幕（AI 字幕通常需要登录 cookie）');
  }

  // B 站 AI 总结（需要登录，匿名返回 -403/-101）
  if (cfg.bilibili.fetchAiSummary && realBvid && cid) {
    try {
      const conclusion = await signedGet(ctx, `${API_BASE}/x/web-interface/view/conclusion/get`, {
        bvid: realBvid,
        cid,
        up_mid: result.ownerId ?? 0,
      });
      const summaryCode = Number(conclusion?.code);
      if (summaryCode === 0) {
        const parsed = parseAiSummary(conclusion?.data);
        if (parsed) result.aiSummary = parsed;
        else result.notes.push('B 站没有为这个视频生成 AI 总结');
      } else if (summaryCode === -101 || summaryCode === -403) {
        result.notes.push('B 站 AI 总结需要登录 cookie，本次没有拿到');
      } else {
        result.errors.push(`AI 总结不可用：${summaryCode} ${conclusion?.message ?? ''}`.trim());
      }
    } catch (error) {
      result.errors.push(`AI 总结获取失败：${messageOf(error)}`);
    }
  }

  // 热评（匿名可用）
  if (cfg.includeComments && realAid) {
    try {
      result.comments = await fetchComments(ctx, realAid);
      if (!result.comments) result.notes.push('这个视频没有取到热评');
    } catch (error) {
      result.errors.push(`热评获取失败：${messageOf(error)}`);
    }
  }

  // 弹幕（匿名可用）
  if (cfg.includeDanmaku && cid) {
    try {
      result.danmaku = await fetchDanmaku(ctx, cid);
    } catch (error) {
      result.errors.push(`弹幕获取失败：${messageOf(error)}`);
    }
  }

  // 本地语音转写：只在没有字幕、时长可控、且注入了 transcribe 时跑
  if (!result.transcript) {
    if (!cfg.asr.enabled) {
      result.notes.push('配置里关闭了本地语音转写');
    } else if (!ctx.transcribe) {
      result.notes.push('没有提供转写能力，跳过本地语音转写');
    } else if (!(result.durationSeconds > 0)) {
      result.notes.push('不知道视频时长，跳过本地语音转写');
    } else if (result.durationSeconds > cfg.maxDurationSeconds) {
      result.notes.push(`视频时长 ${formatTimecode(result.durationSeconds)} 超过上限 ${formatTimecode(cfg.maxDurationSeconds)}，不做本地语音转写`);
    } else if (!realBvid || !cid) {
      result.notes.push('缺少视频 cid，跳过本地语音转写');
    } else {
      await attachAsr(ctx, result, { bvid: realBvid, cid });
    }
  }

  if (ctx.log) ctx.log(`[视频] ${result.id} ${ctx.mode} 完成：标题=${result.title.slice(0, 24)} 错误 ${result.errors.length}`);
  return result;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

function validateInputUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('没有视频链接');
  if (text.length > 2048) throw new Error('链接太长（超过 2048 字符）');
  let url;
  try { url = new URL(text); } catch { throw new Error('链接不是合法的 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http/https 链接');
  if (url.username || url.password) throw new Error('链接不能带用户名/密码');
  return url.toString();
}

/**
 * 描述一个视频（bilibili 走完整链路；其它平台读页面标题/简介）。
 * 永不抛异常：失败返回 { ok:false, error:'给模型看的中文原因' }。
 * @param {string} url 来自 extractVideoLinks/parseShareCard 的链接
 * @param {object} [options] 见 spec §1
 */
export async function describeVideo(url, options = {}) {
  const ctx = createContext(options);
  try {
    const normalizedUrl = validateInputUrl(url);
    const link = classifyVideoUrl(normalizedUrl);
    if (!link) return { ok: false, error: '这个链接不是可识别的视频/网页地址' };

    const cacheKey = `${link.platform}:${link.id}:${ctx.mode}`;
    const cached = cacheGet(cacheKey, ctx.config.cacheTtlMs);
    if (cached) return { ...cached, cached: true };

    const result = link.platform === 'bilibili'
      ? await describeBilibili(ctx, link)
      : await describeGenericPage(ctx, link);

    if (result?.ok === true) cacheSet(cacheKey, result, ctx.config.cacheMaxEntries);
    return result;
  } catch (error) {
    return { ok: false, error: `视频描述失败：${messageOf(error)}` };
  }
}

// ── 格式化（注入 prompt 的短卡片 / 工具返回的完整文本） ──────────────────────

/**
 * 一行短卡片（≤200 字），注入 prompt 用。
 * 例：`《万重山河皆侠骨》｜UP:剑网3｜08:14｜播放 101.9万·评论 7186·点赞 1.8万`
 * @param {object} result describeVideo 的返回值
 */
export function formatVideoCard(result) {
  if (!result || result.ok !== true) return '';
  const pieces = [];
  const title = clampText(result.title, 60, '（无标题）');
  const prefix = result.platform && result.platform !== 'bilibili' ? `${platformLabel(result.platform)} ` : '';
  pieces.push(`${prefix}《${title}》`);
  if (result.owner) pieces.push(`${result.platform === 'bilibili' ? 'UP' : '站点'}:${clampText(result.owner, 20, '')}`);
  if (Number(result.durationSeconds) > 0) pieces.push(formatTimecode(result.durationSeconds));
  if (result.stats && typeof result.stats === 'object') {
    const bits = [];
    if (result.stats.view != null) bits.push(`播放 ${formatCount(result.stats.view)}`);
    if (result.stats.reply != null) bits.push(`评论 ${formatCount(result.stats.reply)}`);
    if (result.stats.like != null) bits.push(`点赞 ${formatCount(result.stats.like)}`);
    if (bits.length) pieces.push(bits.join('·'));
  }
  let card = pieces.join('｜');
  if (card.length > 200) card = `${card.slice(0, 199)}…`;
  return card;
}

function reportTranscriptSection(result) {
  const transcript = result.transcript;
  if (!transcript || !transcript.text) return '';
  const lines = [];
  if (transcript.source === 'subtitle') {
    const langs = Array.isArray(result.subtitle?.languages) ? result.subtitle.languages : [];
    const track = langs.find((item) => /^zh/i.test(item.lan)) || langs[0];
    const label = track ? `${track.lanDoc || track.lan}${track.ai ? '，AI 生成' : ''}` : 'B 站字幕';
    lines.push(`【字幕】来源：B 站官方字幕（${label}，${transcript.chars} 字${transcript.truncated ? '，已截断' : ''}）`);
  } else {
    lines.push(`【转写】来源：本机语音转写（SenseVoice，约 ${transcript.seconds || '?'} 秒，${transcript.chars} 字${transcript.truncated ? '，只覆盖前段' : ''}）`);
  }
  lines.push(transcript.text);
  return lines.join('\n');
}

function reportAiSummarySection(aiSummary) {
  if (!aiSummary || (!aiSummary.summary && !(aiSummary.outline ?? []).length)) return '';
  const lines = ['【B站 AI 总结】'];
  if (aiSummary.summary) lines.push(aiSummary.summary);
  for (const item of aiSummary.outline ?? []) {
    if (item.title) lines.push(`- ${item.title}`);
    for (const point of item.points ?? []) lines.push(`  · ${point}`);
  }
  return lines.join('\n');
}

function reportCommentsSection(comments) {
  if (!Array.isArray(comments) || !comments.length) return '';
  const lines = [`【热评（${comments.length} 条）】`];
  comments.forEach((comment, index) => {
    lines.push(`${index + 1}. ${comment.user}（${formatCount(comment.likes)} 赞）：${comment.text}`);
  });
  return lines.join('\n');
}

function reportDanmakuSection(danmaku) {
  if (!danmaku || !danmaku.count) return '';
  return `【弹幕气氛】共 ${danmaku.count} 条，抽样 ${(danmaku.samples ?? []).length} 条：${(danmaku.samples ?? []).join(' / ')}`;
}

/**
 * 给工具的完整文本报告：元信息 + 正文（字幕/转写，≤ maxChars）+ 来源与限制标注。
 * @param {object} result describeVideo 的返回值
 * @param {{maxChars?: number}} [options]
 */
export function formatVideoReport(result, { maxChars } = {}) {
  if (!result || result.ok !== true) {
    return `【视频】没能读到内容：${clampText(result?.error, 300, '未知原因')}`;
  }
  const explicitLimit = Number(maxChars) > 0 ? Math.round(Number(maxChars)) : 0;
  const echoedLimit = Number(result.transcriptMaxChars) > 0 ? Math.round(Number(result.transcriptMaxChars)) : 0;
  const limit = Math.max(200, explicitLimit || echoedLimit || VIDEO_DEFAULTS.transcriptMaxChars);

  const head = [`【视频】《${clampText(result.title, 200, '（无标题）')}》`];
  const metaBits = [`平台：${platformLabel(result.platform)}`];
  if (result.id) metaBits.push(`ID：${result.id}`);
  if (Number(result.durationSeconds) > 0) metaBits.push(`时长：${formatTimecode(result.durationSeconds)}`);
  head.push(metaBits.join(' ｜ '));
  if (result.owner) head.push(`${result.platform === 'bilibili' ? 'UP 主' : '站点'}：${result.owner}${result.ownerId ? `（uid ${result.ownerId}）` : ''}`);
  if (Array.isArray(result.parts) && result.parts.length > 1) {
    const watched = Number(result.page) > 0 ? Number(result.page) : 1;
    const partTitle = String(result.parts[watched - 1]?.title ?? '').trim();
    head.push(`分 P：共 ${result.parts.length} P，已看第 ${watched} P${partTitle ? `「${partTitle}」` : ''}`);
  }
  const publishBits = [];
  if (result.publishedAt) publishBits.push(`发布：${isoDate(Date.parse(result.publishedAt) / 1000)}`);
  if (Array.isArray(result.tags) && result.tags.length) publishBits.push(`标签：${result.tags.slice(0, 8).join(' / ')}`);
  if (publishBits.length) head.push(publishBits.join(' ｜ '));
  if (result.stats && typeof result.stats === 'object') {
    const statBits = [];
    const statNames = [['view', '播放'], ['danmaku', '弹幕'], ['reply', '评论'], ['like', '点赞'], ['coin', '投币'], ['favorite', '收藏'], ['share', '分享']];
    for (const [key, label] of statNames) {
      if (result.stats[key] != null) statBits.push(`${label} ${formatCount(result.stats[key])}`);
    }
    if (statBits.length) head.push(`数据：${statBits.join(' · ')}`);
  }
  if (result.description) head.push(`简介：${clampText(result.description, 400, '')}`);
  if (result.url) head.push(`页面：${result.url}`);

  const body = [
    reportTranscriptSection(result),
    reportAiSummarySection(result.aiSummary),
    reportCommentsSection(result.comments),
    reportDanmakuSection(result.danmaku),
  ].filter(Boolean).join('\n\n');
  let bodyText = body;
  if (bodyText.length > limit) bodyText = `${bodyText.slice(0, Math.max(0, limit - 14))}\n…（内容已截断）`;

  const tail = [];
  const sources = [];
  if (result.transcript?.source === 'subtitle') sources.push('B 站官方字幕');
  if (result.transcript?.source === 'asr') sources.push('本机语音转写（SenseVoice）');
  if (result.aiSummary) sources.push('B 站 AI 总结');
  if (result.comments) sources.push('B 站热评');
  if (result.danmaku) sources.push('B 站弹幕');
  tail.push(`正文来源：${sources.length ? sources.join(' / ') : '仅元数据（没有字幕/转写/AI 总结）'}`);
  if (Array.isArray(result.notes) && result.notes.length) tail.push(`补充：${result.notes.join('；')}`);
  if (Array.isArray(result.errors) && result.errors.length) tail.push(`未获取：${result.errors.join('；')}`);

  return [head.join('\n'), bodyText, tail.join('\n')].filter(Boolean).join('\n\n');
}
