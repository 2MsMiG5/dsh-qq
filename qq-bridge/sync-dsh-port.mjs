// sync-dsh-port.mjs — 把 config.json 里的 dsh.baseUrl 对齐到「当前正在运行的
// DSH Desktop」Web API 实际监听的端口。
//
// 为什么需要它：DSH Desktop 用 `--port 0` 启动（见 dsh-desktop-host/lib/index.js），
// 每次启动都会随机拿一个空闲端口（本次是 49730）。而 qq-bridge 是**外部进程**，
// 只能按 config.json 的 dsh.baseUrl 去找 DSH —— 端口一变就连不上，日志里会一直
// 显示 DSH 不可用。这个脚本不修改仓库任何源码，只改 config.json 里的那一个字段。
//
// DSH 宿主进程同时会监听多个端口（Web API + 别的内部服务），所以这里要逐个探测：
// Web API 的 `/` 在未带 Cookie 时返回 401，内部服务返回 404 —— 用这个区别挑对端口。
//
// 用法：node sync-dsh-port.mjs      （start-dsh-desktop.cmd 会自动调用）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(ROOT, 'config.json');

/** DSH 宿主进程监听的全部本地端口（Windows）。 */
function candidatePorts() {
  const ps = [
    '$hostProc = Get-CimInstance Win32_Process -Filter "Name=\'DeepSeek Harness.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -like "*dsh-desktop-host*" };',
    'if (-not $hostProc) { exit 3 }',
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |',
    '  Where-Object { $hostProc.ProcessId -contains $_.OwningProcess } |',
    '  Where-Object { $_.LocalAddress -in @("127.0.0.1","::1","0.0.0.0") } |',
    '  Select-Object -ExpandProperty LocalPort -Unique',
  ].join(' ');
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (r.status === 3) return null;
  return String(r.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

/** 该端口是不是 DSH Web API：`/` 无 Cookie 时应答 401（而不是 404/拒绝连接）。 */
async function isDshWebApi(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: 'manual' });
    return res.status === 401 || res.status === 200 || (res.status >= 300 && res.status < 400 && res.status !== 404);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// DSH Desktop 启动时 Web 服务可能还没开始监听（插件在装配阶段就把桥接拉起来时尤其明显），
// 所以这里带重试：默认 15 次 × 3 秒 ≈ 45 秒。QQ_BRIDGE_PORT_WAIT_ATTEMPTS 可调。
const MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.QQ_BRIDGE_PORT_WAIT_ATTEMPTS ?? '15', 10) || 15);

let port = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !port; attempt += 1) {
  const ports = candidatePorts();
  if (ports) {
    for (const candidate of ports) {
      if (await isDshWebApi(candidate)) {
        port = candidate;
        break;
      }
    }
  }
  if (!port) {
    if (attempt < MAX_ATTEMPTS) {
      console.log(`[sync-dsh-port] DSH Web API 还没就绪（第 ${attempt}/${MAX_ATTEMPTS} 次），3 秒后重试…`);
      await sleep(3000);
    }
  }
}
if (!port) {
  console.error('[sync-dsh-port] 找不到可用的 DSH Web API。请确认 DeepSeek Harness 已打开；'
    + '桥接启动后会自己继续找（DSH 端口自动跟随），所以这不是致命错误。');
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
} catch (error) {
  console.error(`[sync-dsh-port] 读不了 ${CONFIG}：${error.message}`);
  process.exit(1);
}

const next = `http://127.0.0.1:${port}`;
if (cfg.dsh?.baseUrl === next) {
  console.log(`[sync-dsh-port] dsh.baseUrl 已是最新：${next}`);
} else {
  cfg.dsh = cfg.dsh ?? {};
  const previous = cfg.dsh.baseUrl;
  cfg.dsh.baseUrl = next;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`[sync-dsh-port] dsh.baseUrl：${previous ?? '(空)'} → ${next}`);
}
