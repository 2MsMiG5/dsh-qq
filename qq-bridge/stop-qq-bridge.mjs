// stop-qq-bridge.mjs — 彻底停掉 qq-bridge，并且**不让它复活**。
//
// 要处理三类进程：
//   1. start.bat / start-dsh-desktop.cmd 的守护循环（cmd.exe）——它会在 node 退出 5 秒后
//      把桥接重新拉起来，只杀 node 是停不掉的；
//   2. node src/bridge.js 本体；
//   3. 清掉 state/bridge.lock，避免下一次启动误判「已有实例在运行」。
//
// 为什么桥接本体要「先请它自己退」而不是直接 taskkill /F：
//   Windows 上没法给另一个进程投递可被捕获的信号——process.kill 与 taskkill 最终都是
//   TerminateProcess，Node 的 'exit' / SIGTERM 处理器一个都不会跑。而桥接的两个收尾动作
//   正好挂在 'exit' 上：flushSocialV2State()（social-v2.json 最后一次落盘）和
//   closeBridgeDb()（SQLite checkpoint）。强杀的后果是 state/bridge.db-wal 留在盘上——
//   真实数据全在 WAL 里（主库只有 1 页/4 KB），之后只拷 bridge.db 的备份就是个空壳。
//   所以这里改成：先 POST /api/shutdown 请它体面退出，等进程真的消失，再强杀守护循环；
//   端点不可用（没令牌、端口不通）才退回强杀，并明确告警。
//
// 顺序不能颠倒：守护循环是 cmd.exe 起的 node，对它用 taskkill /T 会把还没退完的桥接
// 一起强杀，等于白等。所以必须「先停桥接、再杀守护」。
//
// 用法：node stop-qq-bridge.mjs   （或双击 stop-qq-bridge.cmd）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(ROOT, 'state', 'bridge.lock');
const TOKEN_FILE = path.join(ROOT, 'state', 'console-token');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const WAL_FILE = path.join(ROOT, 'state', 'bridge.db-wal');

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  });
}

/** 找出守护循环和桥接本体（按命令行匹配，不依赖进程名）。 */
function findTargets() {
  const script = [
    '$out = @();',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.Name -in @("node.exe","cmd.exe") } |',
    '  ForEach-Object {',
    '    $c = [string]$_.CommandLine;',
    '    if ($c -match "start-dsh-desktop\\.cmd|start\\.bat|restart\\.bat|src[\\\\/]bridge\\.js") {',
    '      $out += [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; cmd = $c }',
    '    }',
    '  };',
    '$out | ConvertTo-Json -Compress -Depth 3'
  ].join(' ');
  const raw = String(powershell(script) ?? '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((item) => ({ pid: Number(item.pid), name: String(item.name ?? ''), cmd: String(item.cmd ?? '') }))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0);
}

function kill(pid, what) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    console.log(`  已结束 ${what}（pid ${pid}）`);
    return true;
  } catch {
    console.log(`  ⚠️ 结束失败 ${what}（pid ${pid}）——可能已经退出`);
    return false;
  }
}

/** 进程是否还活着。信号 0 只做存在性检查，不真的投递。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在，但没权限发信号；这种情况按「活着」处理，交给后面的强杀兜底。
    return error?.code === 'EPERM';
  }
}

/** 控制台端口：配置里没有就按 3100（config.example.json 的默认值）。 */
function consolePort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const port = Number(cfg?.consolePort);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {}
  return 3100;
}

/** 控制台令牌：空则控制台本就拒绝启动，这里也拿不到，直接走强杀。 */
function consoleToken() {
  try {
    return String(fs.readFileSync(TOKEN_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * 请桥接自己体面退出。
 * 返回 true 只代表「请求被接受」，进程是否真的退了由 waitGone() 判断。
 */
async function requestShutdown(pid) {
  const token = consoleToken();
  if (!token) {
    console.log('  ⚠️ 读不到 state/console-token，无法请求优雅退出');
    return false;
  }
  const port = consolePort();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      // 必须带 JSON content-type：控制台的 CSRF 闸门对所有写操作强制这一条。
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: '{}',
      signal: AbortSignal.timeout(3000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`  ⚠️ 优雅退出被拒绝（HTTP ${res.status}）：${body?.error ?? '未知原因'}`);
      return false;
    }
    console.log(`  已请求优雅退出（pid ${pid}）：${body?.message ?? 'ok'}`);
    return true;
  } catch (error) {
    console.log(`  ⚠️ 优雅退出请求失败：${error?.message ?? error}`);
    return false;
  }
}

/** 等这批 pid 消失，返回仍然活着的那些。 */
async function waitGone(pids, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let left = pids.filter(alive);
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    left = left.filter(alive);
  }
  return left;
}

const targets = findTargets();
if (targets.length === 0) {
  console.log('[stop-qq-bridge] 没发现正在运行的桥接或守护进程。');
} else {
  const supervisors = targets.filter((t) => /start-dsh-desktop\.cmd|start\.bat|restart\.bat/.test(t.cmd));
  const bridges = targets.filter((t) => /src[\\/]bridge\.js/.test(t.cmd) && !supervisors.some((s) => s.pid === t.pid));
  console.log(`[stop-qq-bridge] 发现 ${supervisors.length} 个守护进程、${bridges.length} 个桥接进程`);

  // ① 先请桥接退：这一步决定 WAL 会不会被 checkpoint 掉。
  for (const t of bridges) {
    await requestShutdown(t.pid);
  }

  // ② 等它真的消失（正常约 0.5 秒）。这期间不能碰守护进程——/T 会连桥接一起强杀。
  let survivors = bridges.length ? await waitGone(bridges.map((t) => t.pid)) : [];
  if (bridges.length && !survivors.length) {
    console.log('  桥接已正常退出（WAL 已在关闭时 checkpoint）');
  }

  // ③ 再杀守护循环（它有「5 秒后重拉」的定时，所以必须在重拉之前杀掉）。
  for (const t of supervisors) kill(t.pid, '守护循环');

  // ④ 兜底：没退掉或刚被重拉起来的，强杀。
  let forceKilled = 0;
  if (survivors.length) {
    console.log(`  ⚠️ ${survivors.length} 个桥接进程没有响应优雅退出，改用强杀`);
    for (const pid of survivors) { kill(pid, '桥接'); forceKilled += 1; }
  }
  // ⑤ 守护的「5 秒后重拉」有可能已经触发：再查一次，有就强杀。
  if (bridges.length) {
    const respawned = findTargets().filter((t) => /src[\\/]bridge\.js/.test(t.cmd));
    for (const t of respawned) { kill(t.pid, '重拉起来的桥接'); forceKilled += 1; }
  }
  // 告警只看「有没有真的强杀」：优雅退出的请求失败但进程仍正常退出时，WAL 是干净的。
  if (forceKilled > 0) {
    console.log('  提示：本次有进程被强杀，state/bridge.db-wal 可能仍在；如需单文件备份请重启一次再正常停服。');
  }
}

try {
  if (fs.existsSync(LOCK_FILE)) {
    fs.rmSync(LOCK_FILE, { force: true });
    console.log('  已删除 state/bridge.lock');
  }
} catch (error) {
  console.log(`  ⚠️ 删除 bridge.lock 失败：${error?.message ?? error}`);
}

// 复核：2 秒后确认没被拉起。
await new Promise((resolve) => setTimeout(resolve, 2000));
const still = findTargets();
if (still.length > 0) {
  console.log(`[stop-qq-bridge] ⚠️ 仍有 ${still.length} 个相关进程存在，可能被别处拉起：`);
  for (const t of still) console.log(`  pid=${t.pid} ${t.name} ${t.cmd.slice(0, 120)}`);
  process.exitCode = 1;
} else {
  console.log('[stop-qq-bridge] 完成：桥接与守护进程都已退出，不会再自启。');
  // 顺手确认 WAL 已清理：留着的唯一坏处是「备份只拷 bridge.db 会拿到空壳」，
  // 这里直接把它指出来，省得下次有人踩。
  if (fs.existsSync(WAL_FILE)) {
    const size = (() => { try { return fs.statSync(WAL_FILE).size; } catch { return 0; } })();
    console.log(`  注意：state/bridge.db-wal 仍存在（${size} B）。备份 SQLite 时请把 -wal/-shm 一起拷，或先跑 npm run store:export。`);
  }
}
