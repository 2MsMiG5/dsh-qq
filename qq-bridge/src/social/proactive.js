// proactive.js — 主动私聊：AI 什么时候自己找上门。
//
// 为什么和群聊的 proactiveCheck（social/wake.js）分开，不复用那一套：
//   · 语义相反。群聊是「凑热闹」——有人在聊，沉默是常态，主动是例外；
//     私聊是「找人」——没人在说话，每一句都是打扰，必须有由头、有节制。
//   · 混在一起会让两边的参数互相污染：想私聊多主动一点，就得同时调高群聊的插话率。
//
// 设计上的四个决定（都有代价，这里写清楚为什么）：
//
// 1. **一个全局 tick，不是每个会话一个 setTimeout。**
//    前者只在内存里维护一个句柄，重启后靠持久化的 nextAt 自然恢复；后者要开 N 个定时器，
//    且新建会话时还得记得补排程。代价是落点精度只有 tickMs（默认 5 分钟）——够用。
//
// 2. **落点用「每日配额 + 窗口内随机」，不是「每小时掷骰子」。**
//    掷骰子的期望值是「一天零次或好几次」，体验上完全不像真人；配额把总量钉死，
//    窗口内随机化让时间点不可预测。两者分开调，改总量不动分布。
//
// 3. **沉默退避靠「读 lastIncomingAt」推导，不靠回调。**
//    对方在我开口之后说过话，就等于「回过了」——只需要比较两个时间戳，
//    不需要在 appendSocialV2Message 里插 hook。少一个耦合点，就少一处忘改。
//
// 4. **对方的沉默只降低频率，不彻底停手。**
//    连续 3 次没回 → 间隔翻到 8 天。仍保留最低频率，是因为「不聊了」和「最近忙」
//    在数据上无法区分，而彻底停手会让关系真的断掉。
//
// 状态归属：tick 句柄由本模块独占；每个会话的 st.proactivePrivate 是**持久化**状态
//（跟着 social-v2.json 走），本模块只读写、不另行落盘。

import { clampInt, clampNumber } from '../util/num.js';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_ACTIVE_HOURS = Object.freeze([9, 23]);
const MAX_SILENT_STREAK = 8;  // 退避倍数的指数上限
const LOOKAHEAD_DAYS = 40;    // 逐日找落点的防呆上限（正常退避最多 8 天就命中）

/** 数字兜底：非有限值一律归零。 */
const num = (value) => Number(value) || 0;
/** 非负数字兜底：计数类字段不该出现负数。 */
const posNum = (value) => Math.max(0, num(value));

/**
 * 清醒时段归一化。约定：`[开始小时, 结束小时]`，结束小时可以写 24 表示当天零点前。
 * 结束 <= 开始时视为**跨夜**窗口（例如 [22, 2] 表示 22:00 到次日 02:00）。
 * 两端相等（零长度窗口）视为无效配置，退回默认值——它几乎一定是手滑写出来的。
 */
export function normalizeActiveHours(raw) {
  const [rawStart, rawEnd] = Array.isArray(raw) ? raw : [];
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [...DEFAULT_ACTIVE_HOURS];
  const startHour = clampInt(start, 0, 23, DEFAULT_ACTIVE_HOURS[0]);
  const endHour = clampInt(end, 0, 24, DEFAULT_ACTIVE_HOURS[1]);
  return startHour === endHour ? [...DEFAULT_ACTIVE_HOURS] : [startHour, endHour];
}

/** 某个时刻是否落在清醒时段内（支持跨夜窗口）。 */
export function isWithinActiveHours(ts, hours) {
  const [start, end] = normalizeActiveHours(hours);
  const hour = new Date(ts).getHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 本地日期键 YYYY-MM-DD。配额是按「本地哪一天」算的，不能用 UTC。 */
export function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地当天 00:00 的时间戳。 */
export function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 按本地日历加天数（用 setDate 而不是 +n*86400000，避开夏令时地区的偏移漂移）。 */
export function addLocalDays(ts, days) {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** 某天某个整点的时间戳。hour=24 会自动进位到次日 00:00。 */
function atLocalHour(ts, hour) {
  const d = new Date(ts);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * 某一天的开口窗口 [start, end)。
 * 跨夜配置（如 [22, 2]）的结束点落到次日，这里显式补一天。
 */
export function windowOfDay(dayTs, hours) {
  const [startH, endH] = normalizeActiveHours(hours);
  const start = atLocalHour(dayTs, startH);
  const end = atLocalHour(dayTs, endH);
  return { start, end: end > start ? end : atLocalHour(addLocalDays(dayTs, 1), endH) };
}

/**
 * 算下一次该在什么时候开口。
 *
 * 输入是**持久化状态**（上次开口时间 / 那天用了几次配额 / 连续沉默次数），
 * 输出是一个时间戳；没有任何副作用，方便离线测试与复盘。
 *
 * @param {{ now:number, lastFiredAt?:number, lastFiredDay?:string, dayCount?:number, silentStreak?:number }} input
 * @param {object} policy 归一化后的策略（见 policyOf）
 * @param {() => number} rng 注入随机源，测试用固定值
 */
export function computeProactiveNextAt(input, policy, rng = Math.random) {
  const now = num(input?.now);
  const quota = Math.max(0, Math.round(num(policy?.dailyQuota)));
  if (quota <= 0) return 0; // 配额为 0 = 不主动，不需要落点

  const lastFiredAt = num(input?.lastFiredAt);
  const lastFiredDay = String(input?.lastFiredDay || '');
  const dayCount = posNum(input?.dayCount);
  const silentStreak = posNum(input?.silentStreak);
  const minIntervalMs = posNum(policy?.minIntervalMs);

  // 最早能开口的时刻：现在，或「上次开口 + 最小间隔」，取晚者。
  let earliest = lastFiredAt > 0 ? Math.max(now, lastFiredAt + minIntervalMs) : now;

  // 沉默退避：连续没回 → 把下一次整体往后推整天。倍数是 2 的幂（1→2→4→8），
  // 封顶 maxBackoffMultiplier；用整天而不是小时，因为「最近忙」的时间尺度本来就是天。
  if (policy?.backoffEnabled !== false && silentStreak > 0) {
    const maxMult = Math.max(1, num(policy?.maxBackoffMultiplier) || 8);
    const mult = Math.min(2 ** Math.min(silentStreak, MAX_SILENT_STREAK), maxMult);
    earliest += (mult - 1) * DAY_MS;
  }

  // 逐日找「还有配额、且窗口没完全过去」的第一天。
  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset += 1) {
    const dayStart = addLocalDays(startOfLocalDay(earliest), offset);
    const { start, end } = windowOfDay(dayStart, policy?.activeHours);
    const usedToday = localDayKey(dayStart) === lastFiredDay ? dayCount : 0;
    if (usedToday >= quota) continue; // 这天配额已用完
    const from = Math.max(earliest, start);
    if (from >= end) continue; // 窗口已过（或这天整个在 earliest 之前）
    // 窗口内均匀随机。**必须夹到 [0,1)**：rng 一旦返回 1（注入的假随机源很容易这么写），
    // from + 1*span 正好等于窗口终点，落点就跑到清醒时段之外了。
    const roll = Math.min(0.999999, Math.max(0, num(rng())));
    return Math.floor(from + roll * (end - from));
  }
  // 兜底：理论上到不了这里；真到了就一天后再试，绝不返回 0（0 会被当成「未排程」）。
  return addLocalDays(now, 1);
}

/**
 * 结算「上次开口对方到底回没回」，推进或清零沉默计数。
 *
 * 幂等：用 settledAt 记住已经结算过的 lastFiredAt，重复调用不会把同一次沉默数两遍。
 *
 * **minWaitMs 不是可选装饰，缺了它会立刻误判**：tick 是 5 分钟一次，如果不给回复留时间，
 * 第一次开口后 5 分钟就会被判成「对方没回」，退避直接翻倍——最后变成「主动一次就两年不理人」。
 *
 * 返回值表示是否发生了变化，调用方据此决定要不要落盘。
 */
export function settleSilentStreak(pp, lastIncomingAt, now = Date.now(), minWaitMs = 0) {
  if (!pp?.lastFiredAt || pp.settledAt === pp.lastFiredAt) return false;
  // 还没给够回复时间：保持「未结算」，下一轮再看。
  if (num(now) - pp.lastFiredAt < posNum(minWaitMs)) return false;
  pp.settledAt = pp.lastFiredAt;
  // 我开口之后对方说过话 = 回过了，退避清零；时间戳比较就够，不需要额外回调。
  pp.silentStreak = num(lastIncomingAt) > pp.lastFiredAt
    ? 0
    : Math.min(num(pp.silentStreak) + 1, MAX_SILENT_STREAK);
  return true;
}

const EMPTY_PP = Object.freeze({
  nextAt: 0,
  lastFiredAt: 0,
  lastFiredDay: '',
  dayCount: 0,
  silentStreak: 0,
  settledAt: 0
});

/** 会话里的主动私聊状态，惰性初始化（老状态文件里没有这个字段）。 */
export function proactivePrivateState(st) {
  if (!st || typeof st !== 'object') return null;
  if (!st.proactivePrivate || typeof st.proactivePrivate !== 'object') {
    st.proactivePrivate = { ...EMPTY_PP };
  }
  const pp = st.proactivePrivate;
  // 逐个字段兜底：状态文件可能被手改过，或来自更老的版本。
  pp.nextAt = num(pp.nextAt);
  pp.lastFiredAt = num(pp.lastFiredAt);
  pp.lastFiredDay = String(pp.lastFiredDay || '');
  pp.dayCount = posNum(pp.dayCount);
  pp.silentStreak = posNum(pp.silentStreak);
  pp.settledAt = num(pp.settledAt);
  return pp;
}

export function createProactivePrivate() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let allowed, cfg, getCurrentMode, getDshReady, getSocialV2State, isConversationBusyV2,
    isSessionAllowedInCurrentMode, liteDirectActive, log, saveSocialV2State, sendWakePromptV2, socialV2;

  // 域独占状态：tick 句柄只被本模块读写。
  let tickTimer = null;
  // 已经提醒过的 tag，避免每 5 分钟刷一次同样的日志。
  const warned = new Set();

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({
      allowed, cfg, getCurrentMode, getDshReady, getSocialV2State, isConversationBusyV2,
      isSessionAllowedInCurrentMode, liteDirectActive, log, saveSocialV2State, sendWakePromptV2, socialV2
    } = deps);
  }

  function unbound() {
    return !cfg || !socialV2 || typeof sendWakePromptV2 !== 'function';
  }

  /** 同一个 tag 只告警一次。 */
  function warnOnce(tag, message) {
    if (warned.has(tag)) return;
    warned.add(tag);
    log(`[proactive-private] ${message}`);
  }

  /** 把 config.json 里那段松散配置归一成计算用的策略对象。 */
  function policyOf() {
    const p = cfg.socialV2?.proactivePrivate ?? {};
    const backoff = p.backoff ?? {};
    return {
      enabled: p.enabled !== false,
      dailyQuota: clampInt(p.dailyQuota, 0, 6, 2),
      activeHours: normalizeActiveHours(p.activeHours),
      minIntervalMs: clampNumber(p.minIntervalMs, MIN_MS, 7 * DAY_MS, 4 * HOUR_MS),
      idleThresholdMs: clampNumber(p.idleThresholdMs, 0, 7 * DAY_MS, 2 * HOUR_MS),
      onlyKnownContacts: p.onlyKnownContacts !== false,
      backoffEnabled: backoff.enabled !== false,
      maxBackoffMultiplier: clampInt(backoff.maxMultiplier, 1, 32, 8),
      tickMs: clampNumber(p.tickMs, MIN_MS, HOUR_MS, 5 * MIN_MS),
      // 落点过期太久（桥接停了一整天）就当作重新排程，而不是一开机就连环找人。
      staleMs: 6 * HOUR_MS
    };
  }

  /** 按持久化状态算下一次落点（无副作用）。 */
  function nextAtOf(pp, policy, now) {
    return computeProactiveNextAt({
      now,
      lastFiredAt: pp.lastFiredAt,
      lastFiredDay: pp.lastFiredDay,
      dayCount: pp.dayCount,
      silentStreak: pp.silentStreak
    }, policy);
  }

  /**
   * 候选池：白名单里的私聊会话 ∩ 已经聊过的人。
   *
   * 只遍历 socialV2.conversations 而不是白名单全表，是刻意的：
   * 「从没说过一句话」的人被 AI 主动搭话，突兀感远大于惊喜。
   * 想找这种人也留了后路——先让他在白名单里发一条消息，会话自然就出现在这里。
   */
  function candidateKeys(policy = policyOf()) {
    const out = [];
    for (const [key, st] of socialV2.conversations) {
      if (!String(key).startsWith('private:')) continue;
      const qq = String(key).slice('private:'.length);
      try {
        if (typeof allowed === 'function' && !allowed('private', qq, cfg)) continue;
      } catch {
        continue;
      }
      if (policy.onlyKnownContacts && !(Array.isArray(st?.recentMessages) && st.recentMessages.length > 0)) continue;
      out.push(key);
    }
    return out;
  }

  /** 控制台展示用：这个会话的主动私聊安排。 */
  function describe(key) {
    const st = getSocialV2State(key);
    const pp = proactivePrivateState(st);
    const policy = policyOf();
    // dayCount 只在 tick 里跨天时归零，凌晨到第一次 tick 之间它会停在昨天的值。
    // 面板照抄就会显示「今日配额已用完」——实际今天一次都没发。这里按日期自己判一次。
    const today = localDayKey(Date.now());
    return {
      enabled: policy.enabled,
      quota: policy.dailyQuota,
      activeHours: policy.activeHours,
      nextAt: pp?.nextAt || 0,
      lastFiredAt: pp?.lastFiredAt || 0,
      lastFiredDay: pp?.lastFiredDay || '',
      dayCount: pp?.lastFiredDay === today ? pp.dayCount : 0,
      silentStreak: pp?.silentStreak || 0,
      lastIncomingAt: num(st?.lastIncomingAt)
    };
  }

  /** 手动清掉退避（控制台「重新联系」用）。 */
  function resetBackoff(key) {
    const pp = proactivePrivateState(getSocialV2State(key));
    if (!pp) return false;
    pp.silentStreak = 0;
    pp.settledAt = pp.lastFiredAt;
    pp.nextAt = 0; // 让下一轮 tick 重新排程
    saveSocialV2State();
    return true;
  }

  /**
   * 全部候选会话重排（控制台改完配置后调用）。
   *
   * 为什么需要这个：tick 只在 `now < nextAt` 时直接返回，**不会**因为策略变了就重算落点。
   * 所以把清醒时段从 [9,23] 改成 [14,18] 之后，旧落点可能落在新窗口外，
   * 要等它撞上 isWithinActiveHours 才重排——中间那段时间控制台上写着的时间是错的。
   * 返回重排的会话数，给接口回执用。
   */
  function replanAll() {
    if (unbound()) return 0;
    const policy = policyOf();
    let n = 0;
    for (const key of candidateKeys(policy)) {
      try {
        replan(key);
        n += 1;
      } catch (error) {
        warnOnce(`replan:${key}`, `${key} 重排失败：${error?.message ?? error}`);
      }
    }
    return n;
  }

  /**
   * 控制台「排期」面板：当前策略 + 每个候选会话的下一步安排。
   *
   * 只读，不改任何状态——面板刷新时不能顺手把落点算掉。
   * 按 nextAt 升序，最先开口的人排最上面（控制台使用者关心的就是这个顺序）。
   */
  function listSchedules() {
    const policy = policyOf();
    if (unbound()) return { policy, rows: [], mode: '', paused: false };
    const rows = candidateKeys(policy).map((key) => {
      try {
        return { key, ...describe(key) };
      } catch (error) {
        return { key, error: String(error?.message ?? error) };
      }
    });
    rows.sort((a, b) => num(a.nextAt) - num(b.nextAt));
    return { policy, rows, mode: getCurrentMode(), paused: !!socialV2.paused };
  }

  /** 给某个会话重新排程（策略变化后调用）。 */
  function replan(key) {
    const pp = proactivePrivateState(getSocialV2State(key));
    if (!pp) return 0;
    pp.nextAt = nextAtOf(pp, policyOf(), Date.now());
    saveSocialV2State();
    return pp.nextAt;
  }

  /**
   * 单个会话的一次判定。抽成函数是为了让 tick 对每个会话独立 try/catch——
   * 一个人算错不该拖住其他人的安排。
   */
  function maybeFire(key, now, policy) {
    const st = getSocialV2State(key);
    const pp = proactivePrivateState(st);
    if (!pp) return;

    // 两个收尾动作：重算落点 / 往后推一小段。所有闸门都走这两个出口。
    const reschedule = () => {
      pp.nextAt = nextAtOf(pp, policy, now);
      saveSocialV2State();
    };
    const postpone = (ms) => {
      pp.nextAt = now + ms;
      saveSocialV2State();
    };

    // 结算上一次的沉默（对方回没回），这一步必须在算落点之前。
    // 观察窗口取「最小间隔」和 2 小时的较大者：给对方留出真正回复的时间，
    // 否则 5 分钟一 tick 会把「刚发出去还没人回」直接判成沉默。
    settleSilentStreak(pp, st.lastIncomingAt, now, Math.max(2 * HOUR_MS, policy.minIntervalMs));

    // 没排过 / 已经过期太久 → 重新算，本轮不发。
    if (!pp.nextAt || now - pp.nextAt > policy.staleMs) return reschedule();
    if (now < pp.nextAt) return;

    // 到点了，逐条闸门。任何一条不满足都只「推迟」，不丢弃——
    // 丢弃会让 nextAt 停在过去，下一次 tick 立刻又撞进来。
    if (!isWithinActiveHours(now, policy.activeHours)) return reschedule();

    // 配额：跨天了就重新计数。
    const today = localDayKey(now);
    if (pp.lastFiredDay !== today) {
      pp.lastFiredDay = today;
      pp.dayCount = 0;
    }
    if (pp.dayCount >= policy.dailyQuota) return reschedule();

    // 对方刚刚还在说话：现在插一句等于打断，等一会儿再看。
    if (now - num(st.lastIncomingAt) < policy.idleThresholdMs) {
      return postpone(Math.min(10 * MIN_MS, policy.idleThresholdMs));
    }

    // 正在思考/正在回别人：等它收尾。sendWakePromptV2 自己也会拦，但先拦能省一次日志。
    if (isConversationBusyV2(key, st)) return postpone(5 * MIN_MS);

    if (!isSessionAllowedInCurrentMode(key)) {
      // 白名单被改掉了：把落点清空，等它重新进白名单再排。
      pp.nextAt = 0;
      saveSocialV2State();
      return;
    }

    // 引擎不可用就别扣配额。这一步放在最后、也必须在扣配额之前：
    // DSH 没起来、或者 DeepSeek key 失效（且没有直连兜底）时，sendWakePromptV2 必然投递失败，
    // 但 lastFiredAt / dayCount 已经加过了——等于「今天这两次机会白白烧掉，对方什么也没收到」。
    const engineReady = (typeof liteDirectActive === 'function' && liteDirectActive(key))
      || (typeof getDshReady === 'function' && getDshReady());
    if (!engineReady) {
      pp.nextAt = Math.max(pp.nextAt, now + 5 * MIN_MS);
      saveSocialV2State();
      return;
    }

    // ── 放行 ────────────────────────────────────────────────────────────────
    pp.lastFiredAt = now;
    pp.lastFiredDay = today;
    pp.dayCount += 1;
    pp.settledAt = 0; // 新的一次开口，等它结束后再结算沉默
    // 先写一个粗略的落点，防止 sendWakePromptV2 卡住时状态里留着过去的 nextAt。
    pp.nextAt = now + policy.minIntervalMs;
    saveSocialV2State();

    log(`[proactive-private] ${key} 主动开口（今日第 ${pp.dayCount}/${policy.dailyQuota} 次，连续沉默 ${pp.silentStreak}）`);
    void sendWakePromptV2(key, 'proactivePrivate').catch((error) => {
      log(`[proactive-private] ${key} 投递失败：${error?.message ?? error}`);
    });
  }

  /** 一轮扫描。所有会话共用同一个 tick，各自独立判定。 */
  function tick() {
    if (unbound()) return;
    const policy = policyOf();
    if (!policy.enabled || policy.dailyQuota <= 0) return;
    if (getCurrentMode() !== 'reserved2' || socialV2.paused) return;

    const now = Date.now();
    for (const key of candidateKeys(policy)) {
      try {
        maybeFire(key, now, policy);
      } catch (error) {
        warnOnce(key, `${key} 判定异常（只会报一次）：${error?.message ?? error}`);
      }
    }
  }

  /** 启动全局 tick。幂等：重复调用不会开第二个定时器。 */
  function start() {
    if (tickTimer) return;
    const { tickMs } = policyOf();
    tickTimer = setInterval(tick, tickMs);
    // 与 wake.js 里其它 per-conversation 定时器一致：绝不阻止进程退出。
    tickTimer.unref?.();
    log(`[proactive-private] 调度已启动（每 ${Math.round(tickMs / MIN_MS)} 分钟检查一次）`);
  }

  /** 停止 tick。模式切走、桥接关停时调用。 */
  function stop() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  return { bind, start, stop, tick, candidateKeys, describe, listSchedules, resetBackoff, replan, replanAll, policyOf };
}
