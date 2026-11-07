// monitor.js — 两条外部连接的存活探测：DSH Web API 的端口重发现、SnowLuma 上游的健康快照。
//
// 为什么放一起：两者都是「对面是活的吗」这一类周期性检查，且都靠**节流**避免刷屏
// （重发现端口有 THROTTLE，上游静默有 SILENCE_WARN）。分开写就会出现两个各自计时的
// 节流器，日志里同一次断线报两次。
//
// DSH 的端口问题值得单独说：Desktop 版用 `--port 0` 起进程，DSH 重启后端口会变。
// 只顾着报「不可用」而不重发现，桥接会永远卡在旧端口上直到人工重启。
//
// 状态由模块独占：rediscoveringDsh / lastRediscoverAt / dshCheckStarted / snowlumaWatchStarted
// 只描述「这个探测循环自己做到哪一步了」，桥接侧掺和只会造成两份不一致的判断。
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function createConnectionMonitor() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  // 域独占状态：抽取时这些 let 原本在 boot 作用域，迁出后必须补回模块内，
  // 否则写它们会落到未声明的全局上（严格模式下直接 ReferenceError）。
  let rediscoveringDsh = false;
  let lastRediscoverAt = 0;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false;

  // checkDsh 要读写的状态里有一半是 boot 独占的 let（dshReady / lastMode / currentMode /
  // dshPresetIds），所以一律走访问器：读用 getX()、写用 setX(v)。
  // 传值会冻结（module 永远拿到启动那一刻的快照），直接传变量本身又会把装配期的
  // 隐式共享搬进模块 —— 访问器是唯一既能反映最新值、又明确标出「这是别人的状态」的写法。
  let REDISCOVER_THROTTLE_MS, ROOT, SNOWLUMA_SILENCE_WARN_MS, SNOWLUMA_STATUS_POLL_MS, api, atomicWriteJson, bot, cfg, clearAllSocialV2Timers, drainAllPromptQueues, flushQueue, getCurrentMode, getDshPresetIds, getDshReady, getLastMode, log, readConfigObject, reconcileSessionPolicies, refreshMode, refreshPresetList, scheduleProactiveCheckV2, setDshReady, setLastMode, setupSleepTimerV2, snowlumaHealth, socialV2, startProactivePrivate, stopProactivePrivate;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ REDISCOVER_THROTTLE_MS, ROOT, SNOWLUMA_SILENCE_WARN_MS, SNOWLUMA_STATUS_POLL_MS, api, atomicWriteJson, bot, cfg, clearAllSocialV2Timers, drainAllPromptQueues, flushQueue, getCurrentMode, getDshPresetIds, getDshReady, getLastMode, log, readConfigObject, reconcileSessionPolicies, refreshMode, refreshPresetList, scheduleProactiveCheckV2, setDshReady, setLastMode, setupSleepTimerV2, snowlumaHealth, socialV2, startProactivePrivate, stopProactivePrivate } = deps);
  }

  async function isDshWebApiPort(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
      if (res.status === 401 || res.status === 200) return true;
      return res.status >= 300 && res.status < 400 && res.status !== 404;
    } catch {
      return false;
    }
  }

  async function findDshWebApiPort() {
    if (process.platform !== 'win32') return '';
    const ps = [
      '$hostProc = Get-CimInstance Win32_Process -Filter "Name=\'DeepSeek Harness.exe\'" -ErrorAction SilentlyContinue |',
      '  Where-Object { $_.CommandLine -like "*dsh-desktop-host*" };',
      'if (-not $hostProc) { exit 3 }',
      'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |',
      '  Where-Object { $hostProc.ProcessId -contains $_.OwningProcess } |',
      '  Select-Object -ExpandProperty LocalPort -Unique',
    ].join(' ');
    let out = '';
    try {
      out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true
      });
    } catch {
      return '';
    }
    const ports = String(out).split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
    for (const port of ports) {
      if (await isDshWebApiPort(port)) return port;
    }
    return '';
  }

  function rediscoverDshBaseUrl() {
    if (rediscoveringDsh) return;
    const now = Date.now();
    if (now - lastRediscoverAt < REDISCOVER_THROTTLE_MS) return;
    lastRediscoverAt = now;
    rediscoveringDsh = true;
    setTimeout(async () => {
      try {
        const port = await findDshWebApiPort();
        if (!port) return;
        const next = `http://127.0.0.1:${port}`;
        if (next === api.baseUrl) return;
        log(`🔄 发现 DSH 换了端口：${api.baseUrl} → ${next}，热切换（无需重启桥接）`);
        api.baseUrl = next;
        api.invalidateAuth();
        cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: next };
        try {
          const file = readConfigObject(path.join(ROOT, 'config.json'));
          file.dsh = { ...(file.dsh ?? {}), baseUrl: next };
          atomicWriteJson(path.join(ROOT, 'config.json'), file);
        } catch (error) {
          log('写回 dsh.baseUrl 失败:', error?.message ?? error);
        }
      } catch (error) {
        log('重新发现 DSH 端口失败:', error?.message ?? error);
      } finally {
        rediscoveringDsh = false;
      }
    }, 0);
  }

  /**
   * 探一次 DSH，并在「首次就绪 / 断线恢复 / 模式切换」三种边沿上做对应处理。
   * 由 startDshWatch() 每 5 秒驱动一次。
   *
   * ⚠️ 别把 getCurrentMode() 的结果缓存成局部变量：`await refreshMode()` **会改写**
   *    currentMode。边沿判断依赖的是"刷新之后"的模式，缓存成启动时的值会让整个模式判断失效。
   */
  async function checkDsh() {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!getDshReady() || getDshPresetIds().length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!getDshReady()) {
        setDshReady(true);
        setLastMode(getCurrentMode());
        log(`DSH 已就绪（模式: ${getCurrentMode()}）`);
        if (getCurrentMode() === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
          // 主动私聊的全局 tick 只在这个模式下有意义（模式切走会被 stop）。
          startProactivePrivate();
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
      } else if (getCurrentMode() !== getLastMode()) {
        if (getLastMode() === 'reserved2' && getCurrentMode() !== 'reserved2') {
          clearAllSocialV2Timers();
          stopProactivePrivate();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (getCurrentMode() === 'reserved2' && getLastMode() !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
          startProactivePrivate();
        }
        log(`桥接模式已切换为: ${getCurrentMode()}`);
        setLastMode(getCurrentMode());
      }
    } else {
      // DSH 不在：多半是它重启后换了随机端口（Desktop 用 --port 0）。
      // 必须先尝试重新发现端口再谈「不可用」，否则这里会永远卡在旧端口上。
      rediscoverDshBaseUrl();
      if (getDshReady()) {
        setDshReady(false);
        log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
      }
    }
  }

  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    void checkDsh();
    setInterval(() => { void checkDsh(); }, 5000);
  }

  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /**
   * SnowLuma 安装目录（只读观测用）：homeDir > launcherPath 的目录。
   * 找不到就返回空串 —— 面板会显示"未配置"，而不是去猜某个端口上有没有别的服务。
   */
  function snowlumaHomeDir() {
    const sl = cfg.snowluma ?? {};
    if (sl.homeDir) return String(sl.homeDir);
    if (sl.launcherPath) return path.dirname(String(sl.launcherPath));
    return '';
  }

  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 日志'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  return { bind, checkDsh, isDshWebApiPort, findDshWebApiPort, rediscoverDshBaseUrl, startDshWatch, noteUpstreamPacket, snowlumaHomeDir, noteReceiveHealth, snowlumaHealthSnapshot, reportSnowlumaHealth, pollSnowlumaStatus, startSnowlumaWatch };
}
