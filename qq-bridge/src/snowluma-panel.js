// SnowLuma 只读面板数据（桥接控制台「SnowLuma 上游」卡片用）。
//
// 边界（不要越线）：SnowLuma 是**独立进程 + 闭源专有组件**（自带 node.exe 与 native
// .node/.dll），EULA §5.4 禁止「将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署」；
// 仓库的安全基线（L6）同样是「只探测、不部署」。所以本模块**只读**：
//   · 读 SnowLuma 自己的 config/runtime.json（网页端口 / hookAutoLoad）
//   · 读它自己写的 logs/snowluma-*.log 尾部
//   · 探测 WebUI 端口是否在监听（TCP connect），调它已有的 OneBot HTTP API 探活
// 这里没有任何启动/停止/改配置的路径，也不读 webui.json（那里面有口令哈希）。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** 默认日志尾部行数。 */
export const SNOWLUMA_LOG_TAIL_DEFAULT = 40;

/** 读日志时最多回看的字节数（只读尾部，别把几百 MB 日志整个读进内存）。 */
export const SNOWLUMA_LOG_TAIL_MAX_BYTES = 256 * 1024;

/** 去掉终端颜色控制符（SnowLuma 的日志有 chalk 着色）。 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * 取文本尾部若干行。
 * @param {string} text
 * @param {number} maxLines
 * @returns {{lines: string[], truncated: boolean}}
 */
export function tailText(text, maxLines) {
  const limit = Math.max(1, Number(maxLines) || SNOWLUMA_LOG_TAIL_DEFAULT);
  const lines = stripAnsi(text).split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const truncated = lines.length > limit;
  return { lines: truncated ? lines.slice(-limit) : lines, truncated };
}

/** 从 homeDir 推出 SnowLuma 的关键路径（只读，不创建任何东西）。 */
export function snowlumaPaths(homeDir) {
  const home = String(homeDir || '');
  return {
    home,
    runtimeFile: home ? path.join(home, 'config', 'runtime.json') : '',
    logsDir: home ? path.join(home, 'logs') : '',
  };
}

/**
 * 读 SnowLuma 的 config/runtime.json，只挑面板需要的字段。
 * @returns {{ok: boolean, file: string, config: {webuiPort: number|null, webuiHost: string|null, webuiTls: boolean|null, hookAutoLoad: boolean|null}, error: string|null}}
 */
export function readSnowlumaRuntime(homeDir) {
  const { home, runtimeFile } = snowlumaPaths(homeDir);
  const empty = { ok: false, file: runtimeFile, config: { webuiPort: null, webuiHost: null, webuiTls: null, hookAutoLoad: null }, error: null };
  if (!home) return { ...empty, error: '未配置 snowluma.homeDir / launcherPath' };
  try {
    let text = fs.readFileSync(runtimeFile, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    return {
      ok: true,
      file: runtimeFile,
      error: null,
      config: {
        webuiPort: Number.isFinite(Number(raw?.webuiPort)) ? Number(raw.webuiPort) : null,
        webuiHost: typeof raw?.webuiHost === 'string' && raw.webuiHost ? String(raw.webuiHost) : null,
        webuiTls: raw?.webuiTls?.enabled === true,
        hookAutoLoad: typeof raw?.hookAutoLoad === 'boolean' ? raw.hookAutoLoad : null,
      },
    };
  } catch (error) {
    return { ...empty, error: `读取 ${runtimeFile} 失败：${error?.message ?? error}` };
  }
}

/** 找出 SnowLuma 最新一份日志（logs/snowluma-*.log）。 */
export function findLatestSnowlumaLog(homeDir) {
  const { logsDir } = snowlumaPaths(homeDir);
  if (!logsDir) return null;
  let names;
  try {
    names = fs.readdirSync(logsDir).filter((name) => /^snowluma-.*\.log$/i.test(name));
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const file = path.join(logsDir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, name, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      // 单文件读不到就跳过，不影响整体
    }
  }
  return best;
}

/**
 * 读 SnowLuma 最新日志的尾部。
 * @returns {{ok: boolean, file: string|null, name: string|null, mtimeMs: number|null, lines: string[], truncated: boolean, error: string|null}}
 */
export function readSnowlumaLogTail(homeDir, maxLines = SNOWLUMA_LOG_TAIL_DEFAULT) {
  const latest = findLatestSnowlumaLog(homeDir);
  if (!latest) {
    return { ok: false, file: null, name: null, mtimeMs: null, lines: [], truncated: false, error: 'logs/ 下还没有 snowluma-*.log' };
  }
  let fd = null;
  try {
    const length = Math.min(latest.size, SNOWLUMA_LOG_TAIL_MAX_BYTES);
    const start = Math.max(0, latest.size - length);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(latest.file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    // 从文件中间开始读时，第一行大概率是被截断的半行：丢掉它（除非从头读的）。
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const { lines, truncated } = tailText(text, maxLines);
    return {
      ok: true,
      file: latest.file,
      name: latest.name,
      mtimeMs: latest.mtimeMs,
      lines,
      truncated: truncated || start > 0,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      file: latest.file,
      name: latest.name,
      mtimeMs: latest.mtimeMs,
      lines: [],
      truncated: false,
      error: `读取日志失败：${error?.message ?? error}`,
    };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * 探测端口是否在监听（只 connect，不发任何数据）。
 * @returns {Promise<boolean>}
 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0 || target > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: target });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(Math.max(100, Number(timeoutMs) || 800));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 调一次 SnowLuma 的 OneBot HTTP API（只读动作）。
 * @returns {Promise<{ok: boolean, status: number|null, data: unknown, error: string|null}>}
 */
export async function onebotCall(httpUrl, action, accessToken, fetchImpl, timeoutMs = 5000) {
  const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 5000)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.status !== 'ok' || (body?.retcode !== undefined && body.retcode !== 0)) {
      const wording = body?.wording ? ` ${body.wording}` : '';
      return { ok: false, status: res.status, data: body?.data ?? null, error: `HTTP ${res.status}${wording}` };
    }
    return { ok: true, status: res.status, data: body?.data ?? null, error: null };
  } catch (error) {
    return { ok: false, status: null, data: null, error: String(error?.message ?? error) };
  }
}

/**
 * 汇总控制台「SnowLuma 上游」卡片需要的全部只读信息。
 *
 * @param {object} options
 * @param {object} [options.cfg] 桥接 config.json 内容
 * @param {string} [options.homeDir] SnowLuma 安装目录（空 = 未配置）
 * @param {object|null} [options.upstream] 桥接自己的上游健康快照（snowlumaHealthSnapshot()）
 * @param {Function} [options.fetchImpl] fetch 实现（测试可注入）
 * @param {Function} [options.probe] 端口探测实现（测试可注入）
 * @param {number} [options.logLines] 日志尾部行数
 * @param {number} [options.now] 时间戳（测试可注入）
 * @returns {Promise<object>}
 */
export async function collectSnowlumaPanelInfo({
  cfg = {},
  homeDir = '',
  upstream = null,
  fetchImpl = fetch,
  probe = probePort,
  logLines = SNOWLUMA_LOG_TAIL_DEFAULT,
  now = Date.now(),
} = {}) {
  const sl = cfg?.snowluma ?? {};
  const home = String(homeDir || '');
  const runtime = readSnowlumaRuntime(home);
  const webuiPort = runtime.config.webuiPort ?? 5099;
  const webuiHost = runtime.config.webuiHost || '127.0.0.1';
  const webuiTls = runtime.config.webuiTls === true;
  const webuiScheme = webuiTls ? 'https' : 'http';
  const webuiHostForUrl = webuiHost.includes(':') ? `[${webuiHost}]` : webuiHost;
  const webuiUrl = `${webuiScheme}://${webuiHostForUrl}:${webuiPort}/`;

  const httpUrl = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const wsUrl = String(sl.wsUrl || 'ws://127.0.0.1:3001');
  const token = sl.accessToken ? String(sl.accessToken) : '';

  // 端口探测仅在"本机装好了"时才有意义：没配 homeDir 就不要去猜 5099 上有没有别的服务。
  const webuiReachable = home ? await probe(webuiPort, { host: webuiHost }) : null;

  const [statusResult, loginResult] = await Promise.all([
    onebotCall(httpUrl, 'get_status', token, fetchImpl),
    onebotCall(httpUrl, 'get_login_info', token, fetchImpl),
  ]);
  const online = typeof statusResult.data?.online === 'boolean' ? statusResult.data.online : null;
  const good = typeof statusResult.data?.good === 'boolean' ? statusResult.data.good : null;
  const userId = loginResult.data?.user_id ?? null;
  const nickname = loginResult.data?.nickname ?? null;

  const log = readSnowlumaLogTail(home, logLines);

  return {
    ok: true,
    generatedAt: Number(now) || Date.now(),
    note: 'SnowLuma 是独立运行的 QQ 网关（闭源专有组件），这里只读展示状态与日志；桥接不启停它。',
    home: {
      configured: home !== '',
      dir: home || null,
    },
    webui: {
      configured: runtime.ok,
      host: webuiHost,
      port: webuiPort,
      tls: webuiTls,
      scheme: webuiScheme,
      url: webuiUrl,
      reachable: webuiReachable,
      error: runtime.error,
    },
    onebot: {
      httpUrl,
      wsUrl,
      tokenConfigured: token !== '',
      reachable: statusResult.ok,
      online,
      good,
      goodError: statusResult.ok ? null : statusResult.error,
      userId,
      nickname,
      error: loginResult.ok ? null : loginResult.error,
    },
    hook: {
      autoLoad: runtime.config.hookAutoLoad,
    },
    logs: {
      ok: log.ok,
      file: log.name,
      path: log.file,
      mtimeMs: log.mtimeMs,
      lines: log.lines,
      truncated: log.truncated,
      error: log.error,
    },
    upstream,
  };
}
