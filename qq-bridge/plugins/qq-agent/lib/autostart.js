// QQ 栈自启（qq-agent bundle 的第三个模块）：DSH 启动时确保本机 SnowLuma（OneBot 网关）、
// qq-bridge、以及「大肥鱼」本地 TTS 服务在跑，并让**桥接与 TTS 的生命周期跟着 DSH 走**：
// DSH 退出 ⇒ 桥接退出、TTS 退出（不给用户留一个常驻吃 5GB 显存的孤儿进程）。
//
// 2026-10-25 起本文件并入 qq-agent bundle（原独立插件 dsh-snowluma-autostart）。
// 同日晚些时候补了 dafiyu TTS：语音功能真正可用的前提是 127.0.0.1:3210 上那个
// IndexTTS-2 服务活着；让它跟 DSH 一起起停，用户就不必记得先跑 start-tts.bat。
// 好处不只是"少一个插件名"：SnowLuma 的安装目录、桥接仓库根、控制台端口、TTS 目录/端口
// 现在都从 qq-bridge/config.json 与自身位置推导，不再靠另一份硬编码默认值——两份配置漂移
// 正是「插件说拉起了、实际连的是另一份安装」这类问题的主要来源。
//
// 设计约束（重要，从原插件继承）：
//   1. apply() 必须**立刻返回**——绝不能在 DSH 启动路径上等 10 秒（TTS 要加载 ~60 秒，
//      更只能放后台，绝不能在启动路径上等它）。
//   2. 任何异常都必须吞掉——自启失败不能让 DSH 起不来。
//   3. 不修改 SnowLuma 的配置、不做部署/更新：只启动一份**用户自己已经装好**的副本。
//      这是本机便利性 hook，不是分发或部署（SnowLuma EULA 禁止的是后者）。
//   4. TTS 服务只在本机回环监听，参考音与模型都在本机，不涉及任何上传。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'qq-agent-autostart';

/** 仓库根：本文件在 <repo>/plugins/qq-agent/lib/autostart.js。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const LOG_FILE = process.env.QQ_AGENT_AUTOSTART_LOG
  ?? process.env.SNOWLUMA_AUTOSTART_LOG
  ?? path.join(os.tmpdir(), 'qq-agent-autostart.log');

/** 桥接仓库根（apply 时才知道，用于把日志同时写到 <bridgeDir>/state/autostart.log）。 */
let bridgeRoot = '';

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  // 写两份：系统临时目录（不依赖仓库可写）+ <bridgeDir>/state/（和桥接自己的日志放一起，
  // 排障时不用再猜临时目录在哪；state/ 已在 .gitignore 里）。任一失败都不影响主流程。
  const targets = [LOG_FILE];
  if (bridgeRoot) targets.push(path.join(bridgeRoot, 'state', 'autostart.log'));
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, line);
    } catch {
      // 日志写不了也不影响主流程
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读 qq-bridge/config.json（单一配置源；读不到就返回空对象）。 */
function readBridgeConfig(bridgeDir) {
  try {
    let text = fs.readFileSync(path.join(String(bridgeDir || REPO_ROOT), 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 桥接仓库根：插件 config.bridgeDir > 本文件所在仓库根。 */
function resolveBridgeDir(config = {}) {
  return config.bridgeDir ? String(config.bridgeDir) : REPO_ROOT;
}

/** SnowLuma 安装目录：插件 config > config.json 的 snowluma.homeDir / launcherPath > 空。 */
function resolveHomeDir(config = {}) {
  if (config.homeDir) return String(config.homeDir);
  const cfg = readBridgeConfig(resolveBridgeDir(config));
  const home = cfg.snowluma?.homeDir;
  if (home) return String(home);
  const launcher = cfg.snowluma?.launcherPath;
  if (launcher) return path.dirname(String(launcher));
  return '';
}

/** 桥接控制台端口：插件 config.bridgePort > config.json consolePort > 3100。 */
function resolveBridgePort(config = {}) {
  if (config.bridgePort) return Number(config.bridgePort) || 3100;
  const cfg = readBridgeConfig(resolveBridgeDir(config));
  return Number(cfg.consolePort) || 3100;
}

/** 端口上有没有人在监听（SnowLuma 的 WebUI 端口就是它的就绪信号）。 */
function isPortOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 优先用 SnowLuma 随包自带的 node.exe（版本钉死，避免受系统 Node 升级影响）。 */
function resolveNodeExecutable(homeDir) {
  if (!homeDir) return process.execPath;
  const bundled = path.join(homeDir, 'node.exe');
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

/** 系统 node（桥接要求 >= 22.13；DSH 自带的 Electron 进程不能直接当 node 用）。 */
function resolveSystemNode() {
  const systemNode = 'C:\\Program Files\\nodejs\\node.exe';
  return fs.existsSync(systemNode) ? systemNode : 'node.exe';
}

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

/** 模块级去重：同一个进程里重复 apply（profile 重载等）时不要拉两份。 */
let lastAttemptAt = 0;

export async function ensureSnowLuma({ homeDir, port, force = false } = {}) {
  const home = String(homeDir || '');
  const webuiPort = Number(port) || 5099;

  if (!home) {
    log('skip: 没有可用的 SnowLuma 安装目录（config.json 的 snowluma.homeDir/launcherPath 都为空，插件 config.homeDir 也没配）');
    return { ok: false, reason: 'missing-config' };
  }
  const entry = path.join(home, 'index.mjs');
  if (!fs.existsSync(entry)) {
    log(`skip: 找不到 ${entry}（SnowLuma 安装目录不对？可用插件 config.homeDir 覆盖）`);
    return { ok: false, reason: 'missing-install' };
  }
  if (await isPortOpen(webuiPort)) {
    log(`skip: 127.0.0.1:${webuiPort} 已在监听（SnowLuma 已在运行）`);
    return { ok: true, reason: 'already-running' };
  }
  if (!force && Date.now() - lastAttemptAt < 60_000) {
    log('skip: 60 秒内已经尝试过拉起了');
    return { ok: false, reason: 'throttled' };
  }
  lastAttemptAt = Date.now();

  try {
    const child = spawn(resolveNodeExecutable(home), ['index.mjs'], {
      cwd: home,
      detached: true,
      stdio: 'ignore',     // SnowLuma 自己写 logs/，这里不接管道（避免父进程退出时 SIGPIPE）
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    log(`spawn: pid=${child.pid} exe=${resolveNodeExecutable(home)} cwd=${home}`);
  } catch (error) {
    log(`spawn failed: ${error && error.message ? error.message : String(error)}`);
    return { ok: false, reason: 'spawn-failed' };
  }

  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    if (await isPortOpen(webuiPort)) {
      log(`ready: 127.0.0.1:${webuiPort} 已就绪（约 ${i + 1}s）`);
      return { ok: true, reason: 'started' };
    }
  }
  log('wait timeout: 60 秒内没等到 WebUI 端口就绪，请查看 SnowLuma 的 logs/');
  return { ok: false, reason: 'timeout' };
}

// ── 桥接：只在 DSH 活着期间运行 ─────────────────────────────────────────────
// 早先版本用 `cmd /c start-dsh-desktop.cmd` 拉起桥接，而那个脚本是 start.bat 的守护循环
// （节点崩了 5 秒自动重启）。带来两个毛病：
//   ① 关掉 DSH 之后，只要守护窗口还活着，桥接就会自己「复活」——用户以为关了 DSH
//      结果 QQ 还在被回复；
//   ② 进程树里多一层 cmd，杀掉 node 也停不干净。
// 现在改为：同步 DSH 端口后**直接 node src/bridge.js**（无守护循环），并记录 pid；
// DSH 正常退出时由 apply() 注册的 cleanup 杀掉，DSH 被硬杀时随进程树一起死。
// 想要「崩溃自动重启」的守护模式，请手动运行 qq-bridge\start-dsh-desktop.cmd。
let bridgeChild = null;
let bridgePid = 0;

/** 按命令行找出桥接本体和守护循环（含不是本插件拉起的那些）。 */
function findBridgeProcesses() {
  const ps = [
    '$out = @();',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.Name -in @("node.exe","cmd.exe") } |',
    '  ForEach-Object {',
    '    $c = [string]$_.CommandLine;',
    '    if ($c -match "start-dsh-desktop\\.cmd|start\\.bat|restart\\.bat|src[\\\\/]bridge\\.js") {',
    '      $out += [pscustomobject]@{ pid = $_.ProcessId; cmd = $c }',
    '    }',
    '  };',
    '$out | ConvertTo-Json -Compress -Depth 3'
  ].join(' ');
  try {
    const raw = String(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 15000, windowsHide: true
    }) ?? '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((x) => ({ pid: Number(x.pid), cmd: String(x.cmd ?? '') }))
      .filter((x) => Number.isInteger(x.pid) && x.pid > 0);
  } catch {
    return [];
  }
}

/**
 * DSH 退出（或插件被卸载）时停掉桥接，绝不留孤儿进程。
 *
 * 顺序很重要：先杀 start.bat / start-dsh-desktop.cmd 的守护循环，再杀 node ——
 * 反过来 node 会被 5 秒后重新拉起，看起来就像「关了 DSH 桥接还自己启动」。
 * 这里连**不是本插件拉起**的桥接一起停：DSH 都关了，桥接留着也没用。
 */
export function stopBridgeOwned() {
  const own = bridgePid || (bridgeChild && bridgeChild.pid) || 0;
  bridgeChild = null;
  bridgePid = 0;
  const found = findBridgeProcesses();
  const supervisors = found.filter((x) => /start-dsh-desktop\.cmd|start\.bat|restart\.bat/.test(x.cmd));
  const bridges = found.filter((x) => /src[\\/]bridge\.js/.test(x.cmd));
  const seen = new Set();
  for (const x of [...supervisors, ...bridges]) {
    if (seen.has(x.pid)) continue;
    seen.add(x.pid);
    killTree(x.pid);
  }
  if (own && !seen.has(own)) killTree(own);
  if (seen.size > 0) log(`stopped bridge: pids=${[...seen].join(',')}（DSH 退出，桥接不再自启）`);
}

export async function ensureBridge({ dir, port } = {}) {
  const bridgeDir = String(dir || REPO_ROOT);
  const consolePort = Number(port) || 3100;
  const entry = path.join(bridgeDir, 'src', 'bridge.js');

  if (!fs.existsSync(entry)) {
    log(`skip: 找不到 ${entry}（qq-bridge 目录不对？可用插件 config.bridgeDir 覆盖）`);
    return { ok: false, reason: 'missing-install' };
  }
  if (await isPortOpen(consolePort)) {
    log(`skip: 127.0.0.1:${consolePort} 已在监听（已有桥接在跑；DSH 退出时仍会一并停掉，见 cleanup）`);
    return { ok: true, reason: 'already-running' };
  }

  // 先把 DSH 的随机端口写进 config.json（失败也无妨：桥接自己会「DSH 端口自动跟随」）
  try {
    execFileSync(resolveSystemNode(), ['sync-dsh-port.mjs'], {
      cwd: bridgeDir,
      timeout: 70000,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, QQ_BRIDGE_PORT_WAIT_ATTEMPTS: '20' },
    });
  } catch {}

  try {
    const child = spawn(resolveSystemNode(), ['src/bridge.js'], {
      cwd: bridgeDir,
      detached: false,     // 留在 DSH 的进程树里：DSH 退出 ⇒ 桥接退出
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    bridgeChild = child;
    bridgePid = child.pid;
    child.on('exit', () => {
      if (bridgeChild === child) { bridgeChild = null; bridgePid = 0; }
    });
    log(`spawn bridge: pid=${child.pid} cwd=${bridgeDir}（无守护循环，随 DSH 退出）`);
  } catch (error) {
    log(`spawn bridge failed: ${error && error.message ? error.message : String(error)}`);
    return { ok: false, reason: 'spawn-failed' };
  }

  for (let i = 0; i < 45; i += 1) {
    await sleep(1000);
    if (await isPortOpen(consolePort)) {
      log(`bridge ready: 127.0.0.1:${consolePort} 已就绪（约 ${i + 1}s）`);
      return { ok: true, reason: 'started' };
    }
  }
  log('bridge wait timeout: 45 秒内控制台端口未就绪，请查看 qq-bridge/state/bridge.log');
  return { ok: false, reason: 'timeout' };
}

// ── 大肥鱼 TTS：只在 DSH 活着期间运行 ─────────────────────────────────────────
// 服务本体是 dafiyu-voice/server.py：POST /tts 合成一句、GET /health 探活，纯本地回环。
// 它加载 IndexTTS-2 要 ~60 秒、常驻约 3~5GB 显存，所以：
//   · 启动绝不能等（apply 里只挂后台任务，立刻返回）；
//   · DSH 退出必须收掉，否则关掉 DSH 后显存还被占着，用户开游戏就 OOM。
let ttsChild = null;
let ttsPid = 0;
let lastTtsAttemptAt = 0;

/** TTS 目录：插件 config.dafiyuTtsDir > config.json 的 socialV2.voice.tts.serviceDir > 环境变量 > 默认。 */
function resolveTtsDir(config = {}) {
  if (config.dafiyuTtsDir) return String(config.dafiyuTtsDir);
  const cfg = readBridgeConfig(resolveBridgeDir(config));
  const configured = cfg.socialV2?.voice?.tts?.serviceDir;
  if (configured) return String(configured);
  return String(process.env.DAFIYU_TTS_DIR || 'C:\\dsh-qq\\dafiyu-voice');
}

/** TTS 端口：从 config.json 的 baseUrl 取（默认 3210），保证「桥接连哪、插件就起哪」。 */
function resolveTtsPort(config = {}) {
  if (config.dafiyuTtsPort) return Number(config.dafiyuTtsPort) || 3210;
  const cfg = readBridgeConfig(resolveBridgeDir(config));
  try {
    const u = new URL(String(cfg.socialV2?.voice?.tts?.baseUrl || ''));
    return Number(u.port) || 3210;
  } catch {
    return 3210;
  }
}

/** 按命令行找 dafiyu-voice 的 server.py（含不是本插件拉起的那些）。 */
function findTtsProcesses(ttsDir) {
  const needles = ['dafiyu-voice', String(ttsDir || '').replace(/\\/g, '\\\\')].filter(Boolean);
  const match = needles.map((n) => `$c -like "*${n}*"`).join(' -or ');
  const ps = [
    '$out = @();',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.Name -in @("python.exe","pythonw.exe") } |',
    '  ForEach-Object {',
    '    $c = [string]$_.CommandLine;',
    `    if ((${match}) -and ($c -like "*server.py*")) { $out += $_.ProcessId }`,
    '  };',
    '$out | ConvertTo-Json -Compress'
  ].join(' ');
  try {
    const raw = String(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 15000, windowsHide: true
    }) ?? '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** 端口监听者 PID（兜底：命令行匹配不到时，按端口找）。 */
function findListeningPid(port) {
  try {
    const raw = String(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${Number(port) || 3210} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { [Console]::Write($c.OwningProcess) }`
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true }) ?? '').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * DSH 退出（或插件被卸载）时停掉 TTS，绝不留一个吃显存的孤儿进程。
 * 和桥接一样，连**不是本插件拉起**的实例也停：DSH 都关了，TTS 留着没人调，只会白占显存。
 */
export function stopDafiyuTtsOwned(ttsDir = '', port = 3210) {
  const own = ttsPid || (ttsChild && ttsChild.pid) || 0;
  ttsChild = null;
  ttsPid = 0;
  const found = findTtsProcesses(ttsDir);
  const listening = findListeningPid(port);
  if (listening) found.push(listening);
  const seen = new Set();
  for (const pid of found) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    killTree(pid);
  }
  if (own && !seen.has(own)) {
    seen.add(own);
    killTree(own);
  }
  if (seen.size > 0) log(`stopped dafiyu-tts: pids=${[...seen].join(',')}（DSH 退出，不再常驻占显存）`);
  try {
    const pidFile = path.join(ttsDir || defaultTtsDir(), 'logs', 'tts.pid');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {}
}

function defaultTtsDir() {
  return String(process.env.DAFIYU_TTS_DIR || 'C:\\dsh-qq\\dafiyu-voice');
}

export async function ensureDafiyuTts({ dir, port } = {}) {
  const ttsDir = String(dir || '');
  const ttsPort = Number(port) || 3210;
  const python = path.join(ttsDir, 'env', 'Scripts', 'python.exe');
  const entry = path.join(ttsDir, 'server.py');
  if (!ttsDir || !fs.existsSync(entry) || !fs.existsSync(python)) {
    log(`skip dafiyu-tts: 找不到 ${entry} 或 venv python（可用 config.socialV2.voice.tts.serviceDir 覆盖）`);
    return { ok: false, reason: 'missing-install' };
  }
  if (await isPortOpen(ttsPort)) {
    log(`skip dafiyu-tts: 127.0.0.1:${ttsPort} 已在监听（已有服务在跑；DSH 退出时仍会一并停掉，见 cleanup）`);
    return { ok: true, reason: 'already-running' };
  }
  // 端口没开不代表没实例：可能上一秒刚拉起、还在加载模型（约 60s）。
  // 这时再 spawn 一份会抢端口，第二份加载完就崩，日志里看起来像"自启随机失效"。
  const existing = findTtsProcesses(ttsDir);
  if (existing.length > 0) {
    log(`skip dafiyu-tts: 已有进程在加载/运行 pids=${existing.join(',')}（等它自己就绪）`);
    return { ok: true, reason: 'starting' };
  }
  if (lastTtsAttemptAt && Date.now() - lastTtsAttemptAt < 60_000) {
    log('skip dafiyu-tts: 60 秒内已经尝试过拉起了');
    return { ok: false, reason: 'throttled' };
  }
  lastTtsAttemptAt = Date.now();
  try {
    const child = spawn(python, ['server.py'], {
      cwd: ttsDir,
      detached: false,     // 留在 DSH 的进程树里：DSH 退出 ⇒ TTS 退出
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    ttsChild = child;
    ttsPid = child.pid;
    child.on('exit', () => {
      if (ttsChild === child) { ttsChild = null; ttsPid = 0; }
    });
    // 与 start-tts.bat 共用同一个 pid 文件：手动 stop-tts.bat 也能停掉插件拉起的实例。
    try {
      fs.mkdirSync(path.join(ttsDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(ttsDir, 'logs', 'tts.pid'), String(child.pid), 'ascii');
    } catch {}
    log(`spawn dafiyu-tts: pid=${child.pid} cwd=${ttsDir}（模型加载约 60s，期间语音请求会自动降级成文字）`);
  } catch (error) {
    log(`spawn dafiyu-tts failed: ${error && error.message ? error.message : String(error)}`);
    return { ok: false, reason: 'spawn-failed' };
  }
  // 后台等就绪：只为把「好了没有」写进日志，apply 早就返回了，不阻塞 DSH 启动。
  for (let i = 0; i < 180; i += 1) {
    await sleep(1000);
    if (await isPortOpen(ttsPort)) {
      log(`dafiyu-tts ready: 127.0.0.1:${ttsPort} 已就绪（约 ${i + 1}s）`);
      return { ok: true, reason: 'started' };
    }
  }
  log('dafiyu-tts wait timeout: 180 秒内端口未就绪，请查看 dafiyu-voice/logs/server.log');
  return { ok: false, reason: 'timeout' };
}

export function apply(ctx, config = {}) {
  bridgeRoot = resolveBridgeDir(config);
  const ttsDir = resolveTtsDir(config);
  const ttsPort = resolveTtsPort(config);
  log(`apply: bridgeDir=${bridgeRoot} homeDir=${resolveHomeDir(config) || '(未配置)'} webuiPort=${config.webuiPort ?? 5099} bridgePort=${resolveBridgePort(config)} ttsDir=${ttsDir} ttsPort=${ttsPort}`);
  // 后台执行，绝不在 DSH 启动路径上 await。
  ensureSnowLuma({
    homeDir: resolveHomeDir(config),
    port: config.webuiPort,
  }).catch(() => {});
  if (config.autoStartBridge !== false) {
    ensureBridge({
      dir: resolveBridgeDir(config),
      port: resolveBridgePort(config),
    }).catch(() => {});
  }
  if (config.autoStartDafiyuTts !== false) {
    ensureDafiyuTts({ dir: ttsDir, port: ttsPort }).catch(() => {});
  }
  // 反过来：DSH 正常退出时把桥接和 TTS 一起停掉（硬杀由进程树兜底）。
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        stopBridgeOwned();
        stopDafiyuTtsOwned(ttsDir, ttsPort);
      }, 'qq-agent.bridge-lifecycle');
    } catch (error) {
      log(`注册 bridge cleanup 失败: ${error && error.message ? error.message : String(error)}`);
    }
  }
}
