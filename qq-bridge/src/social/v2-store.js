// v2-store.js — 二代仿真（reserved2）的状态层：唤醒配置归一化、social-v2.json 持久化、
// 初始提示词的格式化入口。全部从 src/bridge.js 迁出。
//
// 为什么单独成模块：这一层是「把内存态变成磁盘格式」的**唯一**出口。以前它散在 boot 里，
// 序列化字段清单与加载时的字段过滤分居两处，加一个字段要同时改两个方向、漏了不报错，
// 只是重启后悄悄丢数据。现在写与读在同一文件里，字段表一眼可见。
//
// 状态归属（三条，写错任何一条都会静默出错）：
//   · 模块独占：WAKE_TRIGGER_KEYS / EXPLICIT_END_RE / httpError / socialV2SaveHandle。
//     它们只被本模块使用，桥接侧不再持有副本，也就不存在「两处不一致」。
//   · 按引用注入：social / socialV2 / seenForwardIds / reverse / state 都是 const 容器，
//     全生命周期不整体替换 —— 交引用等于共享同一份，不会分叉。
//   · 可替换能力（log / atomicWriteJson / readJsonSafe）走 bind，不在这里 import：
//     测试通过注入同名实现来观察落盘与降级，直接 import 会绕过那个注入点（假绿）。
//
// 时序：本模块在 boot **中段**就被调用（loadSocialV2State 紧跟 bind 之后），
// 所以 bind 放在那里而不是像其它模块一样放尾部 —— 依赖里除容器外都是函数声明，提升后已可用。

import fs from 'node:fs';
import crypto from 'node:crypto';
import { sanitizeForwardId } from '../forward.js';
import { acknowledgeMessagesV2, readThroughSeqV2, requestedReadThroughSeqV2 } from './v2-read.js';

export function createSocialV2Store() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let SOCIAL_V2_FILE, atomicWriteJson, canonicalV2Key, cfg, currentRoleWakeKeywords, log, readJsonSafe, rememberAgentToken, reverse, scheduleProactiveCheckV2, seenForwardIds, setupSleepTimerV2, social, socialV2, startConsoleServer, state;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ SOCIAL_V2_FILE, atomicWriteJson, canonicalV2Key, cfg, currentRoleWakeKeywords, log, readJsonSafe, rememberAgentToken, reverse, scheduleProactiveCheckV2, seenForwardIds, setupSleepTimerV2, social, socialV2, startConsoleServer, state } = deps);
  }

  // ── 本模块独占的常量与状态 ────────────────────────────────────────────────
  // 这几项只被本模块的函数使用，搬进来以后桥接侧不再持有副本，也就没有「两处不一致」的可能。

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  // 落盘合并句柄：本 tick 的 setImmediate 排期。见 saveSocialV2State 的说明。
  let socialV2SaveHandle = null;

  // ── 唤醒配置落地（控制台唤醒配置页 / 自动潜水定时器共用）──
  // 抽成函数的原因：这条路径必须走**一模一样**的校验——归一化、防永眠、沉睡前闸门一条都不能少，
  // 否则「等完直接睡」就成了绕过闸门的后门。失败抛带 statusCode 的 Error，
  // 由调用方决定是回 4xx（HTTP 端点）还是塞进 wait 的返回里（模型看得懂就行，不用整轮重来）。
  function httpError(statusCode, message, extra) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (extra && typeof extra === 'object') error.extra = extra;
    return error;
  }

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    // 唤醒词跟着人格走：启用的人格设了自己的词表就用它，否则回落到全局推荐值。
    // 这样「小鲸鱼」与别的人格各自被自己的名字叫醒，不会互相串词。
    let roleKeywords = null;
    try { roleKeywords = typeof currentRoleWakeKeywords === 'function' ? currentRoleWakeKeywords() : null; } catch { roleKeywords = null; }
    const keywords = Array.isArray(roleKeywords) && roleKeywords.length
      ? roleKeywords.map(String)
      : (Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : []);
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords,
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐的默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function applyWakeConfigV2(key, body, opts = {}) {
    const isAgent = opts.isAgent === true;
    // 鉴权/会话范围由调用方负责（HTTP 端点与 wait 工具各自在自己的作用域里校验）：
    // 本函数住在模块作用域，看不到 startConsoleServer 内部的 agentTokenOk/v2SessionAllowed。
    if (!key) throw httpError(400, 'key 不能为空');
    const st = getSocialV2State(key);
    const throughSeq = requestedReadThroughSeqV2(st, body, isAgent);
    const acknowledgeOnClose = throughSeq !== null;
    const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
    const current = st.wakeConfig;
    const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
    const normalizeTriggerBool = (name, fallback) => {
      if (name in inputTriggers) return inputTriggers[name] === true;
      return fallback;
    };
    const rawKeywords = inputTriggers.keywords;
    const nextKeywords = rawKeywords !== undefined
      ? (Array.isArray(rawKeywords)
          ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
          : [])
      : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
    const next = {
      ...current,
      mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
      infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
      sleepUntil: current.sleepUntil,
      triggers: {
        // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
        ...pickWakeTriggersV2(inputTriggers, current.triggers),
        atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
        nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
        question: normalizeTriggerBool('question', current.triggers.question === true),
        anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
        poke: normalizeTriggerBool('poke', current.triggers.poke === true),
        keywords: nextKeywords
      },
      batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
        ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
        : current.batchWindowMs
    };
    // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
    if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
      next.triggers.anyMessage = false;
    }
    if (next.mode === 'active') {
      next.infinite = true;
      next.sleepUntil = null;
      next.triggers.anyMessage = true;
    }
    if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
    if (next.infinite) {
      next.sleepUntil = null;
    } else if (input.sleepUntil) {
      const d = new Date(String(input.sleepUntil));
      if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
    } else if (Number.isFinite(Number(input.sleepMs))) {
      let ms = Math.max(0, Math.round(Number(input.sleepMs)));
      const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
      const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
      if (ms < minMs) ms = minMs;
      if (maxMs > 0 && ms > maxMs) ms = maxMs;
      next.sleepUntil = new Date(Date.now() + ms).toISOString();
    } else if (!next.sleepUntil && !next.infinite) {
      const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
      const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
      const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
      next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
    }
    // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
    if (!next.infinite && next.sleepUntil) {
      const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
      const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
      let until = Date.parse(next.sleepUntil);
      if (Number.isFinite(until)) {
        if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
        if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
        next.sleepUntil = new Date(until).toISOString();
      }
    }
    if (next.triggers.probability !== undefined) {
      next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
    }
    // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
    if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
      next.triggers.poke = input.triggers.poke === true;
    }
    // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
    // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
    next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
    // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
    if (key.startsWith('private:')) {
      next.triggers.speakerIds = [];
    }
    // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
    if (next.infinite) {
      const tr = next.triggers ?? {};
      const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
      if (!hasTrigger) {
        throw httpError(400, '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠');
      }
    }
    // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
    if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      throw httpError(
        400,
        `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}, thenSleep=...) 一次完成“沉睡前观察+设唤醒”。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
        { preSleepWaitMs: preSleepMs, preSleepWaitRemainingMs: remaining }
      );
    }
    const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
    st.wakeConfig = next;
    st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
    st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
    st.wakeConfig.noActionCount = 0;
    st.wakeConfig.confirmedAt = Date.now();
    st.wakeConfig.confirmedBy = 'set_wake_config';
    st.lastActionAt = Date.now();
    // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走观察窗口。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    setupSleepTimerV2(key);
    log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
    return { ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) };
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        // 群聊唤醒后的活跃窗口截止时间（0 = 不在窗口内）与机器人的本群名片缓存。
        activeUntil: 0,
        selfGroupCard: '',
        modelSeenSeqs: new Set()
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            // 「对方这次要了语音」的时间戳：仅在显式开启 requireAsk 时使用（默认关闭，见 speakVoiceForV2）。
            voiceAskAt: Number(val.voiceAskAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            liteSummary: val.liteSummary && typeof val.liteSummary === 'object'
              ? {
                text: String(val.liteSummary.text || '').slice(0, 2000),
                updatedAt: Number(val.liteSummary.updatedAt) || 0,
                turnsSince: Number(val.liteSummary.turnsSince) || 0,
                msgCountAtUpdate: Number(val.liteSummary.msgCountAtUpdate) || 0
              }
              : null,
            liteSummaryRetryAt: Number(val.liteSummaryRetryAt) || 0,
            liteSummaryRunning: false,
            imageSendTimes: Array.isArray(val.imageSendTimes) ? val.imageSendTimes : [],
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            // 群聊「唤醒后保持活跃」窗口：重启后在窗口内就接着算活跃，过期就清掉（不需要定时器）。
            activeUntil: (() => {
              const until = Number(val.activeUntil) || 0;
              return until > Date.now() ? until : 0;
            })(),
            // 机器人在本群的群名片（入站消息解析后写入，身份提示词要用）。
            selfGroupCard: String(val.selfGroupCard || '').slice(0, 64),
            modelSeenSeqs: new Set()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    // 离线 harness 会在 vm 沙箱里跑这个文件，沙箱可能没有 setImmediate；
    // 那种环境退回同步写，语义不变（也避免为测试额外补桩）。
    if (typeof setImmediate !== 'function') {
      writeSocialV2StateNow();
      return;
    }
    if (socialV2SaveHandle) return; // 本 tick 已排期，最后一次写会覆盖前面所有变更
    socialV2SaveHandle = setImmediate(() => {
      socialV2SaveHandle = null;
      writeSocialV2StateNow();
    });
    // 与其它 per-conversation 定时器一致：别让一个待写盘把进程钉住不退出。
    socialV2SaveHandle.unref?.();
  }

  function flushSocialV2State() {
    if (socialV2SaveHandle) {
      try { clearImmediate(socialV2SaveHandle); } catch {}
      socialV2SaveHandle = null;
    }
    writeSocialV2StateNow();
  }

  function writeSocialV2StateNow() {
    try {
      const obj = {
        paused: socialV2.paused,
        conversations: Object.create(null)
      };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          voiceAskAt: Number(st.voiceAskAt) || 0,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeUntil: st.activeUntil || 0,
          selfGroupCard: st.selfGroupCard || '',
          // 滚动对话纪要：丢了会让重启后「断片」，必须持久化；running 标记不落盘（重启后重置）。
          liteSummary: st.liteSummary && typeof st.liteSummary === 'object'
            ? {
              text: String(st.liteSummary.text || '').slice(0, 2000),
              updatedAt: Number(st.liteSummary.updatedAt) || 0,
              turnsSince: Number(st.liteSummary.turnsSince) || 0,
              msgCountAtUpdate: Number(st.liteSummary.msgCountAtUpdate) || 0
            }
            : null,
          liteSummaryRetryAt: Number(st.liteSummaryRetryAt) || 0,
          imageSendTimes: Array.isArray(st.imageSendTimes) ? st.imageSendTimes.slice(-500) : [],
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      // 不缩进：这是全项目最热的落盘文件（每 tick 整份重写一次，实测 249 KB，
      // 其中 45% 是缩进空白），而它从不给人看、也不进 git。缩进关掉后约省 46%（→135 KB），
      // 每次重写的序列化 + 写盘成本同比减少，且 JSON 语义完全不变（读取端一律 JSON.parse）。
      atomicWriteJson(SOCIAL_V2_FILE, obj, { pretty: false });
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  return { bind, normalizeSpeakerIdsV2, pickWakeTriggersV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2, applyWakeConfigV2, preSleepWaitBlockedV2, computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, loadSocialV2State, saveSocialV2State, flushSocialV2State, writeSocialV2StateNow };
}
