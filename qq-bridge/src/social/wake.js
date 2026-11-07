// wake.js — reserved2 的唤醒调度与投递：什么时候叫醒 AI、以及叫醒后怎么排队。
//
// 一条唤醒要走完四道闸门，顺序不能换：
//   1) 模式/暂停闸门（currentMode === 'reserved2' 且未暂停）；
//   2) 防重入：会话已有在途 turn 或排队投递 → 只记 pendingWakeReasons，不投递；
//   3) 限频：超限则**延后重试**而不是丢弃（丢弃会让有限潜水永久停在静默态）；
//   4) 串行队列：同一会话的 prompt 严格按顺序进 DSH，避免两轮交织。
//
// 为什么把这些放在一起：这四道闸门读写的状态是同一组（collectors / pendingWakeKeys /
// promptQueues / v2TurnStartAt）。拆开就变成「三处各判一次忙」，必然判不一致 ——
// 历史上 busyReasonV2 与 isConversationBusyV2 分裂就是这类 bug 的来源。
//
// 可变状态：currentMode / dshReady 是 let，走取值函数注入。传值会让模块永远看到
// 启动那一刻的模式与「DSH 还没起」的结论，切模式或 DSH 重启后行为全错。
import { text } from '@snowluma/sdk';
import { mdToPlain } from '../md-to-plain.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { acknowledgeMessagesV2, noteModelMessagesV2, readThroughSeqV2 } from './v2-read.js';
import { openActiveWindow } from '../lite-chat.js';
import { withTimeContext } from '../prompt-time.js';

export function createWakeScheduler() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let TIMER_WAKE_REASONS, TURN_BUSY_LEASE_MS, WAKE_PRIORITY, api, auditAndSend, buildWakePromptLite, buildWakeSnapshotV2, canonicalV2Key, cfg, collectors, getCurrentMode, getDshReady, enqueueForRetry, ensureSession, ensureWakeableV2, getSocialV2State, isCurrentSession, isSessionAllowedInCurrentMode, liteDirectActive, liteSessionActive, log, messageMediaStore, pendingWakeKeys, promptQueues, pushQueued, resolveMediaList, runLiteDirectWake, saveSocialV2State, sendToQQ, shouldAuditKey, social, socialV2, state, takeRotateHandoffV2, turnLeaseNoted, v2TurnStartAt;

  // bind 之前依赖全是 undefined：v2-store 在 boot 中段（loadSocialV2State）就会调到
  // 这两个排程函数。原实现里它们那时能跑，但第一道闸门（模式还不是 reserved2 /
  // 会话未放行）必然 return —— 所以这里提前返回与原行为等价，且不会因 cfg 未注入而炸。
  // 真正的排程由 bridge 在模式确定后统一重排（见 checkDsh 的 reserved2 分支）。
  const notBound = () => !cfg;

  // 唤醒租约的定时器句柄：域独占，全生命周期不整体替换（arm/disarm/clear 都在本文件）。
  const pendingWakeLeaseTimers = new Map();

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ TIMER_WAKE_REASONS, TURN_BUSY_LEASE_MS, WAKE_PRIORITY, api, auditAndSend, buildWakePromptLite, buildWakeSnapshotV2, canonicalV2Key, cfg, collectors, getCurrentMode, getDshReady, enqueueForRetry, ensureSession, ensureWakeableV2, getSocialV2State, isCurrentSession, isSessionAllowedInCurrentMode, liteDirectActive, liteSessionActive, log, messageMediaStore, pendingWakeKeys, promptQueues, pushQueued, resolveMediaList, runLiteDirectWake, saveSocialV2State, sendToQQ, shouldAuditKey, social, socialV2, state, takeRotateHandoffV2, turnLeaseNoted, v2TurnStartAt } = deps);
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (getCurrentMode() !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!getDshReady()) {
      // 「满队列丢弃最旧」的内核在 src/send/retry-queue.js 的 pushQueued()，
      // 这里只保留本路径独有的语义：返回 queued 标记给上层分支判定。
      pushQueued(key, { promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      wakeSnapshot = buildWakeSnapshotV2(key);
      // 轻量路径是唯一路径：模型没有任何工具，快照由桥接渲染成短文本，发送/已读/唤醒全部由桥接负责。
      // 不在 lite 名单里的会话（保留 v2/一代模式的灰度口）直接跳过唤醒，不再走二代 prompt。
      if (!liteSessionActive(key)) return skipWake();
      // 轮换交接块在这里不渲染（lite 人设/记忆索引已经够用），但要消费掉一次性标记。
      takeRotateHandoffV2(key);
      promptText = await buildWakePromptLite(key, opts.wakeReason);
    }
    let content = [{ type: 'text', text: withTimeContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withTimeContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      // skippedSeqs：本轮按「最新优先」挤掉的旧未读，已明确告知模型不用回，
      // 必须一起记为已展示，否则已读水位会卡在它们前面，旧消息一轮轮反复出现。
      const skippedReceipts = Array.isArray(wakeSnapshot.skippedSeqs)
        ? wakeSnapshot.skippedSeqs.map((seq) => ({ seq }))
        : [];
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent, ...skippedReceipts]);
      if (liteSessionActive(key)) {
        // 轻量路径没有 qq_mark_read：发给模型的快照即视为已读，桥接自己推进水位。
        try {
          acknowledgeMessagesV2(wakeState, readThroughSeqV2(wakeState));
          saveSocialV2State();
        } catch (error) {
          log(`[lite] ${key} 已读水位更新失败: ${error?.message ?? error}`);
        }
      }
    }
    if (accepted.result.value.command?.text && !opts.silent && getCurrentMode() !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (getCurrentMode() !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      parkWakeReason(key, st, reason);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const direct = isDirectWakeReason(reason);
    const maxPerMinute = direct
      ? (Number(cfg.socialV2?.wake?.maxDirectWakePerMinute) || 10)
      : (Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0);
    const maxPerHour = direct
      ? (Number(cfg.socialV2?.wake?.maxDirectWakePerHour) || 60)
      : (Number(cfg.socialV2?.wake?.maxWakePerHour) || 0);
    // 一次遍历同时拿到「分钟窗/小时窗内的次数」和「各自最早的那次」。
    let recentMinute = 0;
    let recentHour = 0;
    let oldestInMinute = Infinity;
    let oldestInHour = Infinity;
    for (const t of st.wakeTimes || []) {
      const age = now - t;
      if (age < 60000) {
        recentMinute += 1;
        if (t < oldestInMinute) oldestInMinute = t;
      }
      if (age < 3600000) {
        recentHour += 1;
        if (t < oldestInHour) oldestInHour = t;
      }
    }
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute && oldestInMinute !== Infinity) {
        retryAfterMs = Math.max(retryAfterMs, 60000 - (now - oldestInMinute) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour && oldestInHour !== Infinity) {
        retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - oldestInHour) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 群聊「唤醒后保持活跃」：被叫醒就开一个 postWakeActiveMs 的窗口（默认 5 分钟）。
    // 窗口内普通群消息也会唤醒（唤醒原因 activeWindow），群友继续说话就续期；
    // 没人说话到点自动失效，回到「一直潜水」——不需要额外定时器，读的时候判断即可。
    const postWakeActiveMs = Number(cfg.socialV2?.wake?.postWakeActiveMs) || 0;
    if (postWakeActiveMs > 0 && String(key).startsWith('group:')) {
      openActiveWindow(st, postWakeActiveMs, now);
      log(`[active-window] ${key} 开活跃窗口 ${Math.round(postWakeActiveMs / 60000)} 分钟（唤醒原因 ${reason}）`);
    }
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    // Track 3：lite 用直连引擎时完全不走 DSH——不建会话、不发 prompt，直接一次
    // chat/completions 出结果。失败会自动回退到 DSH 轻量会话（见 liteDirectBroken）。
    if (liteDirectActive(key)) {
      log(`[lite-direct] 唤醒 ${key}（${reason}）`);
      void runLiteDirectWake(key, reason).catch((error) => log(`[lite-direct] ${key} 唤醒异常：${error?.message ?? error}`));
      return;
    }
    // 具体 prompt 由 deliverPromptNow 按轻量路径生成（见 buildWakePromptLite）；
    // 这里传空串只是占位，排队补投时也会重新生成。
    const promptText = '';
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递时再由 lite 收尾删除。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  /**
   * 会话繁忙时把这次唤醒原因暂存起来，等回合结束由 replayPendingWakeReasonsV2 补发。
   *
   * 同一 (原因, seq) 只存一份：消息洪峰下同一批未读会被反复触发，去重能让队列
   * 只记录「确实需要再跑一轮」的意图。队列有界 20 条，防止无限增长。
   * 无论是否重复都记一行日志——排障时"为什么没唤醒"通常要看到这一行。
   */
  function parkWakeReason(key, st, reason) {
    if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
    const seq = st.lastUnreadSeq || 0;
    if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
      st.pendingWakeReasons.push({ reason, seq });
      if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
    }
    log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
  }

  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  /**
   * 直接对话类唤醒：别人私聊/@/叫名字/提问/关键词/拍一拍。
   * 这类唤醒**必须回**，不能因为「每小时 N 次」的旧限频被拖一个小时；
   * 单独用 maxDirectWakePerMinute/Hour 做成本兜底（lite 每轮约 ¥0.0013）。
   *
   * proactivePrivate（AI 自己找人开口）也归这一类，但不是因为「必须回」：
   * 它已经被「每人每天配额 + 最小间隔」钉死，再叠一层 1 次/分钟只会让两个会话
   * 在同一 tick 撞车时，后一个被拖 60 秒——落点白算了，而且拖完还得重走一遍限频。
   */
  function isDirectWakeReason(reason) {
    const r = String(reason || '');
    return r === 'private' || r === 'anyMessage' || r === 'atMention' || r === 'nameMention'
      || r === 'question' || r === 'poke' || r === 'admin' || r === 'console'
      || r === 'proactivePrivate'
      || r.startsWith('keyword:') || r.startsWith('speaker:');
  }

  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  // 注：这里曾经有一个 scheduleUnreadCatchupV2（重启/启动后就给「有未读」的会话
  // 补一次 catchup 唤醒）。已按操作者要求取消：重启不再主动叫醒任何会话，
  // 未读等新消息/@/关键词等正常触发点再处理，或由有限潜水定时器 / 主动机会兜底。

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      parkWakeReason(key, st, reason);
      return;
    }
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck' || item.reason === 'proactiveCheck') {
        // 回复检查轮询与主动机会都已不再补排（前者随 lite 删除，后者有周期性重排）。
        log(`[reserved2] ${key} 繁忙期间的定时唤醒已过期，跳过补发（${item.reason}）`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stillRelevant) {
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  function setupSleepTimerV2(key) {
    if (notBound()) return;
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (notBound()) return;
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || getCurrentMode() !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    clearAllPendingWakeLeases();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // 唤醒「防卡死」租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了
  // 却一直没有回合结束，30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  //
  // 为什么放在这里而不是桥接侧：定时器句柄（pendingWakeLeaseTimers）只在「arm/收尾」
  // 这一对里被读写，是最典型的域独占状态——留在桥接等于让同一份状态有两个主人。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  return { bind, parkWakeReason, busyReasonV2, isConversationBusyV2, wakePriorityV2, isDirectWakeReason, isTimerWakeReason, scheduleWakeV2, replayPendingWakeReasonsV2, setupSleepTimerV2, cancelProactiveCheckV2, scheduleProactiveCheckV2, clearSocialV2Timers, clearAllSocialV2Timers, drainPromptQueue, drainAllPromptQueues, deliverPrompt, processPromptQueue, sendWakePromptV2, deliverPromptNow, armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases };
}
