#!/usr/bin/env node
// B 站登录态脚本（见 docs/design/VIDEO_LINKS_SPEC.md §4 / docs/guides/VIDEO_LINKS.md）。
//
// 用法（按推荐顺序）：
//   1) 从本机「噗哩噗哩 / Chiba」客户端导入（**不用扫码**）：
//        node scripts/bili-login.mjs --from-chiba
//      Chiba 把 B 站账号用 Windows DPAPI 加密存在
//      %LOCALAPPDATA%\Chiba\Bilibili\bilibili-accounts.dat；本脚本用**当前用户**身份解密、
//      取出 Web（或 TV）cookie，再用 nav 校验后写入 state/bilibili-auth.json。
//      （只在用户显式加 --from-chiba 时读取；文件本身不复制、不上传。）
//   2) 已有 cookie：
//        node scripts/bili-login.mjs --cookie "SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx"
//      → 用 x/web-interface/nav 校验（data.isLogin === true）→ 写 state/bilibili-auth.json。
//   3) 扫码登录（无参数）：
//        node scripts/bili-login.mjs [--timeout 180] [--no-open]
//      → qrcode/generate 拿登录 URL + qrcode_key，渲染成**真正能扫的二维码**：
//         · 写 state/bilibili-login-qr.png 并自动用默认看图程序打开（--no-open 可关）；
//         · 同时在终端打印半高块二维码（PNG 打不开或远程终端时用）；
//         · 登录 URL 另存 state/bilibili-login-url.txt（可发到手机打开）→ 轮询 qrcode/poll：
//           86101 待扫码 / 86090 已扫待确认 / 0 成功 / 86038 过期
//      → 成功后从返回的 url 查询串里取 SESSDATA / bili_jct / DedeUserID / DedeUserID__ckMd5 / sid。
//
// 约束：
// - 不装 npm 依赖：二维码用 vendored 的 qrcode-generator（scripts/vendor/，MIT），PNG 自己编码；
// - 写文件用「临时文件 + rename」，Windows 下 chmod 失败忽略；
// - **绝不打印 cookie**（只打 uname/mid 这类非敏感信息）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeFetchBinary } from '../src/safe-fetch.js';
// vendored 二维码编码器（.cjs：package.json 是 "type":"module"）
import qrcode from './vendor/qrcode-generator.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const AUTH_FILE = path.join(STATE_DIR, 'bilibili-auth.json');
const LOGIN_URL_FILE = path.join(STATE_DIR, 'bilibili-login-url.txt');
const QR_PNG_FILE = path.join(STATE_DIR, 'bilibili-login-qr.png');
// 噗哩噗哩（Chiba RelaxRoom）默认数据目录：%LOCALAPPDATA%\Chiba（见其 desktop-release.json 的 dataDirectory）
const CHIBA_ACCOUNT_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Chiba', 'Bilibili', 'bilibili-accounts.dat'
);

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const COOKIE_FIELDS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
const POLL_INTERVAL_MS = 2000;

export function parseArgs(argv) {
  const args = { cookie: '', timeout: 180, help: false, fromChiba: false, chibaFile: '', noOpen: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] ?? '');
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--cookie') {
      args.cookie = String(argv[i + 1] ?? '').trim();
      i += 1;
    } else if (token.startsWith('--cookie=')) {
      args.cookie = token.slice('--cookie='.length).trim();
    } else if (token === '--from-chiba') {
      args.fromChiba = true;
    } else if (token === '--chiba-file') {
      args.chibaFile = String(argv[i + 1] ?? '').trim();
      i += 1;
    } else if (token.startsWith('--chiba-file=')) {
      args.chibaFile = token.slice('--chiba-file='.length).trim();
    } else if (token === '--no-open') {
      args.noOpen = true;
    } else if (token === '--timeout') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.timeout = Math.min(600, Math.max(30, Math.round(value)));
      i += 1;
    } else if (token.startsWith('--timeout=')) {
      const value = Number(token.slice('--timeout='.length));
      if (Number.isFinite(value) && value > 0) args.timeout = Math.min(600, Math.max(30, Math.round(value)));
    }
  }
  return args;
}

function printHelp() {
  console.log([
    'B 站登录态保存脚本（qq-bridge 视频理解用）',
    '',
    '用法（按推荐顺序）：',
    '  node scripts/bili-login.mjs --from-chiba              # 从本机「噗哩噗哩/Chiba」导入，不用扫码',
    '  node scripts/bili-login.mjs --from-chiba --chiba-file "D:\\...\\bilibili-accounts.dat"',
    '  node scripts/bili-login.mjs --cookie "SESSDATA=…; bili_jct=…; DedeUserID=…"',
    '  node scripts/bili-login.mjs [--timeout 180] [--no-open]   # 扫码登录（生成 PNG 二维码并自动打开）',
    '',
    '说明：',
    `  · 登录态写到 ${path.relative(ROOT, AUTH_FILE)}（含 cookie/uname/mid/savedAt）`,
    '  · --from-chiba 只在 Windows 有效：用当前用户身份解密 Chiba 的 DPAPI 账号文件，',
    '    取出已登录 cookie（文件不复制、不上传；不打印 cookie 本身）',
    '  · 扫码模式会把二维码写成 state/bilibili-login-qr.png 并自动打开；--no-open 只写不打开，',
    '    同时在终端打印半高块二维码（远程/无法看图时用）',
    '  · cookie 只在本机保存，不会打印；桥接启动时读取，用于取 B 站字幕与 AI 总结',
    '  · 匿名也能取元数据/热评/弹幕/本地转写，登录只是多出官方字幕与 AI 总结',
  ].join('\n'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bufferToText(buffer) {
  let buf = buffer;
  try {
    if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    else if (buf && buf.length > 2 && (buf[0] & 0x0f) === 8 && ((buf[0] << 8) | buf[1]) % 31 === 0) buf = zlib.inflateSync(buf);
  } catch { /* 原样解码 */ }
  return (buf ?? Buffer.alloc(0)).toString('utf8');
}

function requestHeaders(cookie = '') {
  const headers = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com',
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function fetchJson(url, cookie = '') {
  const res = await safeFetchBinary(url, 1024 * 1024, { headers: requestHeaders(cookie), timeoutMs: 15000 });
  const text = bufferToText(res?.buffer).trim();
  if (!text) throw new Error(`接口返回为空（HTTP ${res?.statusCode ?? '?'}）`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回不是 JSON（HTTP ${res?.statusCode ?? '?'}）：${text.slice(0, 120)}`);
  }
}

/** 用 nav 校验 cookie；返回 { ok, uname, mid } 或抛错。 */
async function checkLogin(cookie) {
  const nav = await fetchJson(`${API}/x/web-interface/nav`, cookie);
  const data = nav?.data ?? {};
  if (data.isLogin === true) {
    return { ok: true, uname: String(data.uname ?? ''), mid: Number(data.mid) || null };
  }
  const code = Number(nav?.code);
  if (code === -101) throw new Error('cookie 未生效（nav 返回 -101 账号未登录）：SESSDATA 可能过期或粘贴不完整');
  throw new Error(`nav 校验失败：${Number.isFinite(code) ? `${code} ` : ''}${String(nav?.message ?? '').trim()}`.trim());
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw error;
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows 上可能不支持，忽略 */ }
}

/**
 * 保存登录态（默认写 state/bilibili-auth.json）。先写临时文件再 rename，
 * 避免桥接在写入过程中读到半截 JSON；filePath 可指定（单测用）。
 */
export function saveAuth({ cookie, uname = '', mid = null }, filePath = AUTH_FILE) {
  const payload = {
    cookie,
    savedAt: new Date().toISOString(),
    uname: String(uname ?? ''),
    mid: mid != null ? Number(mid) : null,
  };
  writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/** 从扫码成功返回的 url 查询串里取 cookie（保留原始百分号编码，B 站按原样认）。 */
export function cookieFromLoginUrl(loginUrl) {
  const text = String(loginUrl ?? '');
  const queryIndex = text.indexOf('?');
  if (queryIndex < 0) return '';
  const query = text.slice(queryIndex + 1);
  const picked = new Map();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = decodeURIComponent(pair.slice(0, eq));
    if (!COOKIE_FIELDS.includes(key)) continue;
    // 值保持 B 站返回的原始形式（SESSDATA 里是 %2C 这种编码），与浏览器里复制的写法一致
    const value = pair.slice(eq + 1);
    if (!value) continue;
    picked.set(key, value);
  }
  return COOKIE_FIELDS.filter((key) => picked.has(key)).map((key) => `${key}=${picked.get(key)}`).join('; ');
}

// ── 从「噗哩噗哩 / Chiba」导入登录态（不用扫码） ───────────────────────────────
// Chiba 是参考实现（B 站陪看客户端），它把账号存在 %LOCALAPPDATA%\Chiba\Bilibili\
// bilibili-accounts.dat，内容是 Windows DPAPI（CurrentUser 范围）加密的 JSON：
//   { Web: { AccessToken, AccountId, Cookies, ExpiresAt }, Tv: { …同构… } }
// 同一台机器、同一个 Windows 用户可以直接解密 —— 但它毕竟是**另一个应用的凭据存储**，
// 所以只在用户显式传 --from-chiba 时才读；不复制文件、不打印 cookie、不上传任何东西。

/** 调 PowerShell（Windows 自带）解密 DPAPI 文件，返回明文 Buffer。非 Windows 直接报错。 */
export function decryptDpapiFile(filePath) {
  if (process.platform !== 'win32') {
    throw new Error('--from-chiba 只支持 Windows（DPAPI 只能由本机当前用户解密）');
  }
  const escaped = String(filePath).replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b = [IO.File]::ReadAllBytes('${escaped}')`,
    '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  const base64 = String(out).trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (!base64) throw new Error('DPAPI 解密没有输出（可能不是当前用户加密的文件）');
  return Buffer.from(base64, 'base64');
}

/**
 * 从 Chiba 账号 JSON 里挑出可用的 cookie。优先 Web（web 接口用），回退 Tv。
 * 纯函数，便于单测（不碰文件系统/DPAPI）。
 */
export function cookieFromChibaPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Chiba 账号文件内容不是 JSON 对象');
  }
  const candidates = [
    ['Web', payload.Web?.Cookies],
    ['Tv', payload.Tv?.Cookies],
  ];
  for (const [source, raw] of candidates) {
    const cookie = String(raw ?? '').trim().replace(/[\r\n]+/g, ' ');
    if (!cookie) continue;
    if (!/SESSDATA=/i.test(cookie)) continue;
    const accountId = Number(source === 'Web' ? payload.Web?.AccountId : payload.Tv?.AccountId) || null;
    return { cookie, source, accountId };
  }
  throw new Error('Chiba 账号文件里没有找到包含 SESSDATA 的 cookie（可能没在里面登录过）');
}

async function runFromChibaMode(chibaFile) {
  const filePath = String(chibaFile || '').trim() || CHIBA_ACCOUNT_FILE;
  if (!fs.existsSync(filePath)) {
    throw new Error([
      `找不到 Chiba 账号文件：${filePath}`,
      '  如果噗哩噗哩装在别的目录，用 --chiba-file "路径\\bilibili-accounts.dat" 指定；',
      '  或者改用 --cookie（浏览器 F12 复制）或直接扫码登录。',
    ].join('\n'));
  }
  console.log(`🔓 读取并解密 Chiba 登录态：${filePath}`);
  const plain = decryptDpapiFile(filePath);
  let payload;
  try {
    payload = JSON.parse(plain.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Chiba 账号文件解密后不是合法 JSON：${error?.message ?? error}`);
  }
  const picked = cookieFromChibaPayload(payload);
  console.log(`   取到 ${picked.source} 账号 cookie（mid ${picked.accountId ?? '未知'}），正在用 nav 校验…`);
  const me = await checkLogin(picked.cookie);
  if (picked.accountId && me.mid && Number(picked.accountId) !== Number(me.mid)) {
    console.log(`   ⚠️ 文件里的账号（${picked.accountId}）与 nav 返回的账号（${me.mid}）不一致，以 nav 为准`);
  }
  const saved = saveAuth({ cookie: picked.cookie, uname: me.uname, mid: me.mid });
  console.log(`✅ 登录态已保存：${saved.uname || '（未取到昵称）'}${saved.mid ? `（mid ${saved.mid}）` : ''}`);
  console.log(`   文件：${path.relative(ROOT, AUTH_FILE)}（savedAt ${saved.savedAt}）`);
  console.log('   重启桥接后生效：现在能取官方字幕与 B 站 AI 总结了。');
}

// ── 二维码渲染（vendored qrcode-generator + 自己写 PNG 编码） ────────────────
// 只把 URL 打印出来没法「扫码」，所以这里真的生成二维码：
//   · PNG（默认，黑块白底，扫得最稳）：写 state/bilibili-login-qr.png 并可自动打开；
//   · 终端半高块二维码（远程终端 / 不想开图时用）。
// 不引入 npm 依赖：编码器 vendored 在 scripts/vendor/qrcode-generator.cjs（MIT）。

/** 生成二维码矩阵（{ count, isDark(r,c) }）；typeNumber=0 由库自动选版本。 */
export function createQrMatrix(text, ecc = 'M') {
  const value = String(text ?? '');
  if (!value) throw new Error('二维码内容为空');
  // 让编码器按 UTF-8 处理字节（B 站登录 URL 是纯 ASCII，但这样对任意文本都正确）
  if (qrcode.stringToBytesFuncs?.['UTF-8']) qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, ecc);
  qr.addData(value, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  return { count, isDark: (row, col) => qr.isDark(row, col) === true };
}

const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * 把二维码矩阵渲染成 8-bit 灰度 PNG（暗块 #000、底色 #fff、带 quiet zone 静默区）。
 * scale = 每个模块多少像素（默认 8；二维码 50~60 模块时约 500px，手机很好扫）。
 */
export function renderQrPng(matrix, { scale = 8, quiet = 4 } = {}) {
  const count = matrix?.count;
  if (!Number.isFinite(count) || count <= 0) throw new Error('二维码矩阵无效');
  const moduleScale = Math.max(1, Math.round(scale));
  const quietZone = Math.max(0, Math.round(quiet));
  const side = (count + quietZone * 2) * moduleScale;
  // 每行 1 字节 filter(0) + side 个灰度像素；先全白
  const raw = Buffer.alloc((side + 1) * side, 0xff);
  for (let y = 0; y < side; y += 1) raw[y * (side + 1)] = 0;
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!matrix.isDark(row, col)) continue;
      const x0 = (col + quietZone) * moduleScale;
      const y0 = (row + quietZone) * moduleScale;
      for (let dy = 0; dy < moduleScale; dy += 1) {
        const rowStart = (y0 + dy) * (side + 1);
        raw.fill(0x00, rowStart + 1 + x0, rowStart + 1 + x0 + moduleScale);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 终端半高块二维码（行优先，两个模块一行；深色块用 █▀▄ 表示）。 */
export function renderQrTerminal(matrix, { quiet = 4 } = {}) {
  const count = matrix?.count;
  if (!Number.isFinite(count) || count <= 0) throw new Error('二维码矩阵无效');
  const quietZone = Math.max(0, Math.round(quiet));
  const side = count + quietZone * 2;
  const dark = (row, col) => {
    const r = row - quietZone;
    const c = col - quietZone;
    return r >= 0 && c >= 0 && r < count && c < count && matrix.isDark(r, c);
  };
  const lines = [];
  for (let y = 0; y < side; y += 2) {
    let line = '';
    for (let x = 0; x < side; x += 1) {
      const top = dark(y, x);
      const bottom = dark(y + 1, x);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 用系统默认程序打开文件（失败返回 false，不影响登录流程）。 */
export function openPath(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function runCookieMode(rawCookie) {
  const cookie = String(rawCookie ?? '').trim().replace(/[\r\n]+/g, ' ');
  if (!cookie) throw new Error('--cookie 后面没有内容');
  if (!/SESSDATA=/i.test(cookie)) throw new Error('cookie 里没有 SESSDATA，至少需要 SESSDATA（建议同时带 bili_jct 与 DedeUserID）');
  console.log('🔍 正在用 nav 校验 cookie…');
  const me = await checkLogin(cookie);
  const saved = saveAuth({ cookie, uname: me.uname, mid: me.mid });
  console.log(`✅ 登录态已保存：${saved.uname || '（未取到昵称）'}${saved.mid ? `（mid ${saved.mid}）` : ''}`);
  console.log(`   文件：${path.relative(ROOT, AUTH_FILE)}（savedAt ${saved.savedAt}）`);
  console.log('   重启桥接后生效：字幕与 B 站 AI 总结需要它，其它能力匿名也有。');
}

async function runQrMode(timeoutSeconds, { noOpen = false } = {}) {
  console.log('🔗 正在向 B 站申请扫码登录…');
  const generated = await fetchJson(`${PASSPORT}/x/passport-login/web/qrcode/generate`);
  if (Number(generated?.code) !== 0 || !generated?.data?.url || !generated?.data?.qrcode_key) {
    throw new Error(`申请扫码失败：${generated?.code ?? '?'} ${String(generated?.message ?? '').trim()}`.trim());
  }
  const loginUrl = String(generated.data.url);
  const qrcodeKey = String(generated.data.qrcode_key);

  console.log('');
  console.log('请用手机 B 站 App 扫码登录：');
  console.log('');
  // 1) 真二维码 PNG：写到 state/ 并可自动打开（这是「能扫」的主路径）
  let pngPath = '';
  try {
    const matrix = createQrMatrix(loginUrl);
    const png = renderQrPng(matrix, { scale: 8, quiet: 4 });
    pngPath = QR_PNG_FILE;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(pngPath, png);
    console.log(`  🖼️  二维码图片：${path.relative(ROOT, pngPath)}（${matrix.count}×${matrix.count} 模块）`);
    if (!noOpen) {
      const opened = openPath(pngPath);
      console.log(opened ? '      已用默认看图程序打开，直接拿手机扫屏幕上的二维码即可。' : '      自动打开失败：请手动双击上面的 PNG 文件。');
    }
  } catch (error) {
    pngPath = '';
    console.log(`  ⚠️  二维码 PNG 生成失败（${error?.message ?? error}），继续用终端二维码/链接登录。`);
  }
  // 2) 终端半高块二维码：远程终端、或不想开图时也能扫
  try {
    const matrix = createQrMatrix(loginUrl);
    console.log('');
    console.log(renderQrTerminal(matrix, { quiet: 4 }));
    console.log('');
  } catch { /* 终端二维码只是兜底 */ }
  console.log(`  登录链接：${loginUrl}`);
  console.log(`  qrcode_key：${qrcodeKey}`);
  console.log(`  有效期约 ${timeoutSeconds} 秒，成功后会自动保存登录态。`);
  try {
    writeFileAtomic(LOGIN_URL_FILE, `${loginUrl}\n`);
    console.log(`  （登录链接另存为 ${path.relative(ROOT, LOGIN_URL_FILE)}，可发到手机打开）`);
  } catch (error) {
    console.log(`  （登录链接写文件失败，忽略：${error?.message ?? error}）`);
  }
  console.log('');

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastState = null;
  let successData = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() > deadline) break;
    let poll;
    try {
      poll = await fetchJson(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`);
    } catch (error) {
      console.log(`⚠️  轮询出错，继续重试：${error?.message ?? error}`);
      continue;
    }
    // 真正的扫码状态在 data.code；外层 code 通常恒为 0
    const stateCode = Number(poll?.data?.code ?? poll?.code);
    if (stateCode === 86101) {
      if (lastState !== 86101) console.log('⌛ 等待手机扫码…');
      lastState = 86101;
      continue;
    }
    if (stateCode === 86090) {
      if (lastState !== 86090) console.log('📱 已扫码，请在手机上点「确认登录」');
      lastState = 86090;
      continue;
    }
    if (stateCode === 0) {
      successData = poll?.data ?? {};
      break;
    }
    if (stateCode === 86038) {
      throw new Error('二维码已过期（86038），请重新运行本脚本');
    }
    if (stateCode === -400 || stateCode === -412) {
      throw new Error(`B 站拒绝轮询（${stateCode}），稍后再试或改用 --cookie`);
    }
    console.log(`⚠️  未知扫码状态 ${Number.isFinite(stateCode) ? stateCode : '?'}，继续等待…`);
    lastState = stateCode;
  }

  if (!successData) throw new Error(`等待扫码超时（${timeoutSeconds}s），请重新运行`);

  const cookie = cookieFromLoginUrl(successData.url);
  if (!cookie) throw new Error('扫码成功但返回里没有找到 cookie（url 缺少 SESSDATA），请改用 --cookie 方式');

  console.log('✅ 扫码成功，正在确认登录态…');
  let uname = '';
  let mid = null;
  try {
    const me = await checkLogin(cookie);
    uname = me.uname;
    mid = me.mid;
    console.log(`   账号：${uname || '（未取到昵称）'}${mid ? `（mid ${mid}）` : ''}`);
  } catch (error) {
    console.log(`   ⚠️  nav 二次校验失败（仍然保存 cookie）：${error?.message ?? error}`);
  }
  const saved = saveAuth({ cookie, uname, mid });
  console.log(`✅ 登录态已保存：${path.relative(ROOT, AUTH_FILE)}（savedAt ${saved.savedAt}）`);
  console.log('   重启桥接后生效：现在能取官方字幕与 B 站 AI 总结了。');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.cookie) {
    await runCookieMode(args.cookie);
    return;
  }
  if (args.fromChiba) {
    await runFromChibaMode(args.chibaFile);
    return;
  }
  // 扫码模式：如果本机噗哩噗哩已登录，先提示更省事的导入方式
  if (fs.existsSync(CHIBA_ACCOUNT_FILE)) {
    console.log(`💡 检测到本机「噗哩噗哩」的登录态（${CHIBA_ACCOUNT_FILE}）：`);
    console.log('   不想扫码可以直接跑：node scripts/bili-login.mjs --from-chiba');
    console.log('   （下面仍会生成二维码，扫码可用于登录其它账号）');
    console.log('');
  }
  await runQrMode(args.timeout, { noOpen: args.noOpen });
}

/** 只有直接 `node scripts/bili-login.mjs` 才执行；被 import（单测）时只导出纯函数。 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.on('SIGINT', () => {
    console.log('\n已取消（未写入登录态）。');
    process.exit(130);
  });

  try {
    await main();
  } catch (error) {
    console.error(`❌ ${error?.message ?? error}`);
    process.exit(1);
  }
}
