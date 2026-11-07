// ingest.js — QQ 入站：消息/戳一戳/审批回包进来之后怎么落到 DSH 与仿真状态。
//
// 为什么单独成文件：`handleIncoming` 有 345 行、阅读 28 个闭包状态，是整个桥接里
// 分支最多的一段——私聊/群聊、@ 与回复、好友申请、视频链接、媒体、黑名单模式、
// 唤醒触发、排队与退避全在这里分叉。它和装配代码缠在同一个 6000 行闭包里时，
// 「改一个分支会不会影响另一个」完全只能靠人脑记。
//
// 状态归属：**容器留在桥接侧按引用交出**（pending / messageMediaStore / queued /
// sessionPromises / videoHintCache / seenForwardIds / modelAppliedSessions 等引用恒定）；
// 三个 `let` 走取值函数，否则模块看到的是启动那一刻的值：
//   · currentMode  —— 切模式后入站规则必须立刻跟着变；
//   · dshReady     —— DSH 未就绪时不能投递；
//   · sessionEpoch —— 每次重置自增，用于丢弃上一代回合的迟到回包。
//
// 依赖方向：入站 → 社交/发送/媒体，不反向；sendSvc 与 wakeSvc 都不 import 本模块。

import { mdToPlain } from '../md-to-plain.js';
import { activeWindowLeftMs } from '../lite-chat.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { describeVideo } from '../video-link.js';
import { extractForwardIds } from '../forward.js';
import { withTimeContext } from '../prompt-time.js';

export function createMuxIngest() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let     APPROVE_WORDS, DIRECTION_HINT, DSH_CONTROL_TIMEOUT_MS, MAX_MEDIA_STORE_PER_KEY, QUEUE_HINT_COOLDOWN_MS,
    REJECT_WORDS, ROOT, SILENT_MARKER, SPACE_SPLIT_HINT, allowed, api,
    appendActivity, appendSocialV2Message, appendSocialV2Poke, applyFriendDecision,
    auditAndSend, buildWakeSnapshotV2, cfg, clearSocialV2Timers,
    collectors, convKey, currentRoleHint, deliverPrompt, drainPromptQueue, enqueueForRetry,
    ensureSession, extractMediaFromSegments, forgetAgentToken,
    getCurrentMode, getDshReady, getSessionEpoch, getSelfNickname, getSocialV2State, isCurrentSession,
    isDirectedAtAi, isQuoteTargetSelf, isSessionAllowedInCurrentMode, log, mediaHintFor, messageMediaStore,
    modeAllowed, modelAppliedSessions, parseFriendDecision, pending, pendingSendToolCalls, pendingWakeKeys,
    prepareVideoHint, pushQueued, queued, queuedHintAt, readRoleState, resolveGroupMemberName, resolveMediaList,
    resolveReplyInfo, retireSession, reverse, roleExists, sanitizeRoleName, saveSocialV2State, saveState,
    scheduleWakeV2, seenForwardIds, segmentsToText, sendToQQ, sendToolSucceededSessions,
    sessionPromises, shouldAuditKey, social, socialV2,
    state, toolCallNames, turnLeaseNoted, v2TurnStartAt,
    videoHintCache, withTimeout, writeRoleState;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({
      APPROVE_WORDS, DIRECTION_HINT, DSH_CONTROL_TIMEOUT_MS, MAX_MEDIA_STORE_PER_KEY, QUEUE_HINT_COOLDOWN_MS,
      REJECT_WORDS, ROOT, SILENT_MARKER, SPACE_SPLIT_HINT, allowed, api,
      appendActivity, appendSocialV2Message, appendSocialV2Poke, applyFriendDecision,
      auditAndSend, buildWakeSnapshotV2, cfg, clearSocialV2Timers,
      collectors, convKey, currentRoleHint, deliverPrompt, drainPromptQueue, enqueueForRetry,
      ensureSession, extractMediaFromSegments, forgetAgentToken,
      getCurrentMode, getDshReady, getSessionEpoch, getSelfNickname, getSocialV2State, isCurrentSession,
      isDirectedAtAi, isQuoteTargetSelf, isSessionAllowedInCurrentMode, log, mediaHintFor, messageMediaStore,
      modeAllowed, modelAppliedSessions, parseFriendDecision, pending, pendingSendToolCalls, pendingWakeKeys,
      prepareVideoHint, pushQueued, queued, queuedHintAt, readRoleState, resolveGroupMemberName, resolveMediaList,
      resolveReplyInfo, retireSession, reverse, roleExists, sanitizeRoleName, saveSocialV2State, saveState,
      scheduleWakeV2, seenForwardIds, segmentsToText, sendToQQ, sendToolSucceededSessions,
      sessionPromises, shouldAuditKey, social, socialV2,
      state, toolCallNames, turnLeaseNoted, v2TurnStartAt,
      videoHintCache, withTimeout, writeRoleState
    } = deps);
  }

  /**
   * 判定这条消息触发了哪一种唤醒原因；都没命中返回 null。
   *
   * 只有本文件的 handleIncoming 用，所以住在这里而不是留在装配脚本里。
   * selfNickname 是 let（网关返回登录信息后才写），必须经 getSelfNickname() 取值——
   * 传值会让"被 @ 昵称"这条匹配永远停在启动时的默认值上。
   */
  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && getSelfNickname()) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      const nick = getSelfNickname().toLowerCase();
      if (lower.includes('@' + nick) || lower.includes(nick)) return 'nameMention';
      // 群里叫的是群名片（可能和账号昵称完全不同，例如昵称「祈愿冬不寒」、群名片「秋」）。
      // 只认昵称的话，「秋」怎么叫都触发不了；单字名片只认 @ 形式，避免「秋天」这种误命中。
      const card = String(st?.selfGroupCard || '').trim().toLowerCase();
      if (card && (lower.includes('@' + card) || (card.length >= 2 && lower.includes(card)))) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    // 群聊活跃窗口：刚被叫醒的这几分钟里群友还在接着聊，普通消息也算在聊，
    // 不必每条都 @ 它；窗口过期（没人说话）就自动回到潜水，不会再走到这里。
    if (kind === 'group' && activeWindowLeftMs(st) > 0) return 'activeWindow';
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  /**
   * 取出并消费「轮换交接」标记；没有则返回 null。
   *
   * 方案 A 的会话轮换已随二代工具协议删除（会话不再被主动轮换），这里只保留
   * 「一次性消费」语义：旧状态文件里可能残留 rotateHandoff，lite 唤醒时顺手消费掉，
   * 避免它永远留在磁盘上。
   */
  function takeRotateHandoffV2(key) {
    let st = null;
    try { st = getSocialV2State(key); } catch { return null; }
    if (!st.rotateHandoff) return null;
    const info = st.rotateHandoff;
    st.rotateHandoff = null;
    saveSocialV2State();
    return info;
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, getCurrentMode())) {
      log(`忽略未授权会话 ${key}（当前模式 ${getCurrentMode()}，来自 ${event.user_id}）`);
      return;
    }
    const selfIdText = event.self_id != null ? String(event.self_id) : '';
    const resolveAtName = async (qq) => {
      // @ 到自己时渲染成「@你」：模型不必再靠昵称/群名片字符串去猜这条是不是在叫它。
      // 群名片可能与账号昵称完全不同（昵称「祈愿冬不寒」、群名片「秋」），
      // 只把昵称写进身份段的话，@秋 在模型眼里就是另一个人。
      if (selfIdText && String(qq) === selfIdText) return '你';
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = async (messageId) => {
      const info = await resolveReplyInfo(kind, id, messageId, event.self_id);
      // 引用段解析到自己时同样标成「你」，让「[引用 你：…]」和「@你」一个口径。
      if (info && selfIdText && String(info.userId ?? '') === selfIdText) return { ...info, sender: '你' };
      return info;
    };
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 好友申请裁决：管理员私聊回「同意 <QQ号>」或「拒绝 <QQ号>」，桥接直接执行、不投给模型。
    // 放在审批/提问之后是为了让「通过」「拒绝」这类裸词仍然优先回答审批；
    // 好友申请必须带 QQ 号，避免和审批的裸词歧义。
    if (isOwner && kind === 'private') {
      const friendDecision = parseFriendDecision(plainContent);
      if (friendDecision) {
        await applyFriendDecision(friendDecision, key);
        return;
      }
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          getSessionEpoch()++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          turnLeaseNoted.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          messageMediaStore.delete(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          if (!roleExists(name)) {
            await sendToQQ(key, `角色「${name}」不存在。可在控制台「人格与角色」页新建，或先在 roles/ 放一张卡再迁移。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (getCurrentMode() === 'reserved2') {
      // 顺手把机器人在本群的群名片缓存进会话状态：群里 @ 它时显示的是群名片，
      // 不是账号昵称（见 selfIdentityTextV2 / evaluateWakeTriggerV2）。解析有 10 分钟缓存，
      // 失败（网关不支持）就沿用昵称，不阻塞消息入库。
      if (kind === 'group' && event.self_id != null) {
        void resolveGroupMemberName(event.group_id, event.self_id)
          .then((card) => {
            const name = String(card || '').trim();
            if (!name) return;
            const state = getSocialV2State(key);
            if (state.selfGroupCard === name) return;
            state.selfGroupCard = name;
            saveSocialV2State();
            log(`[identity] ${key} 群名片=${name}`);
          })
          .catch(() => {});
      }
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      // 看视频：异步预取一次元数据（**不 await**，绝不阻塞消息入库）。成功时把完整卡片写进
      // videoHintCache，下一次拼提示词（buildWakeSnapshotV2 的 videoHints / mediaHintFor）就会
      // 带上《标题》/UP/时长。暂停时不做无谓的网络请求。
      if (messageRef && cfg.socialV2?.enabled !== false) {
        void prepareVideoHint(key, messageRef, textContent).catch(() => {});
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);


    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!getDshReady()) {
      // 「满队列丢弃最旧」的内核在 src/send/retry-queue.js 的 pushQueued()，
      // 这里只保留本路径独有的副作用：给群里发一条「重启中」提示（带 30 秒冷却）。
      pushQueued(key, { promptText, media: mediaList });
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withTimeContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withTimeContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && getCurrentMode() !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, getCurrentMode())) return;
    if (getCurrentMode() !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (getCurrentMode() !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  return { bind, takeRotateHandoffV2, handleIncoming, cancelPendingEntry, handlePendingAnswer, handlePokeNotice, registerPending };
}
