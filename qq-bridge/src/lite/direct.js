// direct.js — lite 的直连引擎：不建 DSH 会话，直接打一次 chat/completions 出回复。
//
// 为什么要有这条路：DSH 轻量会话每次唤醒都要走 session/create + prompt + turn 轮询，
// 在群聊密集时这部分开销比模型本身还大。直连把「一条消息 → 一段回复」压成一次 HTTP。
//
// 回退策略（顺序不能乱）：
//   1) 没有 key 或 engine=dsh → 完全不走这里；
//   2) 连续失败 2 次 → 本进程内永久回退到 DSH（避免一晚的唤醒全堵在坏通道上）；
//   3) 原生附图被拒 → 本进程内改走视觉描述。
// 三个开关都只在内存里，重启即可重试——它们表达的是「这条路现在通不通」，不是配置。
//
// 能力全部走 bind：resolveDeepSeekKey 会去读宿主机 ~/.dsh/.credentials.yaml，
// chatCompletion 会真发网络请求。模块内直接 import 会让测试无法替换，
// 于是「默认走 DSH」的用例在开发机上会静默变成直连（R4 就这样红过一次）。
import { mdToPlain, truncateText } from '../md-to-plain.js';
import { parseLiteReply as parseLiteReplyPure, liteWakeConfig as liteWakeConfigPure, parsePersonDirective, liteThinkingForKey } from '../lite-chat.js';
import { cleanSummaryText, summaryDue, buildSummaryMessages, splitPersonNoteLines } from '../lite-context.js';
import { acknowledgeMessagesV2, noteModelMessagesV2, readThroughSeqV2 } from '../social/v2-read.js';

export function createLiteDirect() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let LITE_DIRECT_SID_PREFIX, chatCompletion, normalizeModelConfig, resolveDeepSeekKey, usageToLedgerBuckets, appendActivity, applyPersonOps, armPendingWakeLease, buildWakePromptLite, buildWakeSnapshotV2, cfg, clearDeliveredConsoleNotes, defaultWakeConfigV2, disarmPendingWakeLease, ensureWakeableV2, getSocialV2State, isSilentMarker, lastSendSucceeded, liteDirectTurnCounters, liteSendImage, liteSendPoke, liteStickerChoices, liteSystemPrompt, log, onebotSend, pendingWakeKeys, personProfileForRead, randInt, recordLiteSentMessage, replayPendingWakeReasonsV2, saveSocialV2State, scheduleWakeV2, sendStickerV2, sendToQQ, setupSleepTimerV2, sleep, socialV2, speakVoiceForV2, state, tokenLedger;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ LITE_DIRECT_SID_PREFIX, chatCompletion, normalizeModelConfig, resolveDeepSeekKey, usageToLedgerBuckets, appendActivity, applyPersonOps, armPendingWakeLease, buildWakePromptLite, buildWakeSnapshotV2, cfg, clearDeliveredConsoleNotes, defaultWakeConfigV2, disarmPendingWakeLease, ensureWakeableV2, getSocialV2State, isSilentMarker, lastSendSucceeded, liteDirectTurnCounters, liteSendImage, liteSendPoke, liteStickerChoices, liteSystemPrompt, log, onebotSend, pendingWakeKeys, personProfileForRead, randInt, recordLiteSentMessage, replayPendingWakeReasonsV2, saveSocialV2State, scheduleWakeV2, sendStickerV2, sendToQQ, setupSleepTimerV2, sleep, socialV2, speakVoiceForV2, state, tokenLedger } = deps);
  }

  // ── 轻量聊天路径（Track 2）────────────────────────────────────────────────
  //
  // 为什么要这条路径：v2 的 agent 工具循环让每个回合跑 5–20 次模型请求，每次重读整段
  // 上下文（实测 11 轮对话 111 步、平均 45k 上下文、¥0.29；其中 25k 输出 token 全是
  // 每步的思考和工具参数）。而 QQ 聊天真正需要的只是「看快照 → 说一句话」。
  //
  // 做法：会话改用无工具预设 qq-chat-lite（模型看不到任何工具），桥接把未读渲染成
  // 短文本，模型只输出要发的消息（一行一条）；发送、已读水位、下一次唤醒全部由桥接做。
  // 每轮只有 1 次模型请求、上下文 ~4k，成本约为工具循环的 1/10。
  // 本进程内的降级开关：直连连挂两次就不再重试、原生附图被拒就改走视觉描述。
  // 它们只服务这个文件里的引擎路径，桥接侧只做展示（通过下面的读取口）。
  let liteModelKeyCache;
  let liteDirectFailures = 0;
  let liteNativeImagesBroken = false;
  let liteDirectBroken = false;

  /** 控制台展示用：连续失败次数（0 表示当前健康）。 */
  function getLiteDirectFailures() {
    return liteDirectFailures;
  }

  /** 控制台展示用：本进程是否已放弃直连、回退到 DSH 轻量会话。 */
  function getLiteDirectBroken() {
    return liteDirectBroken;
  }

  function liteChatEnabled() {
    return cfg.socialV2?.liteChat?.enabled === true;
  }

  /**
   * 灰度开关：`liteChat.keys` 为空表示全部会话；否则只有列出的 key 走轻量路径。
   * 首次上线建议只放一个私聊（owner），确认自动发送的分条/静默/唤醒都对，再全量。
   */
  function liteKeyEnabled(key) {
    const keys = cfg.socialV2?.liteChat?.keys;
    if (!Array.isArray(keys) || keys.length === 0) return true;
    return keys.map(String).includes(String(key));
  }

  /**
   * 当前会话是否真的跑在轻量预设上。
   *
   * 为什么不能只看开关：`liteChat.enabled` 打开后，要等 DSH 重启把 `qq-chat-lite`
   * 注册进来、`reconcileSessionPolicies()` 把旧会话退役，新会话才会真正切过去。
   * 在这之前会话仍是 qq-chat-v2（工具全在），如果 lite 逻辑此时介入，会把它当
   * "纯文本回复"去自动发送，等于把 agent 的思考过程发到群里。所以所有 lite 分支
   * 都必须同时满足「开关开 + 本会话的 sessionPolicy 里带 lite 预设」。
   */
  function liteSessionActive(key) {
    // 2026-10-28 起 qq-chat-lite 是唯一聊天预设：不再用 liteChat.enabled 做门：
    // 关了它只会让请求落到"v2 工具协议 prompt + 无工具会话"的坏状态；要暂停 AI 请用 pausing。
    if (!liteKeyEnabled(key)) return false;
    const preset = cfg.socialV2?.liteChat?.preset || 'qq-chat-lite';
    const policy = state.sessionPolicies?.[key];
    return typeof policy === 'string' && policy.includes(preset);
  }

  function liteWakeConfigV2(key) {
    return liteWakeConfigPure(key, defaultWakeConfigV2(), {
      groupWakeProbability: cfg.socialV2?.liteChat?.groupWakeProbability
    });
  }

  function parseLiteReply(text) {
    return parseLiteReplyPure(text, {
      toPlain: mdToPlain,
      isSilent: isSilentMarker,
      maxMessages: Math.max(1, Math.min(8, Number(cfg.socialV2?.liteChat?.maxMessages) || 2)),
      maxMessageChars: cfg.socialV2?.send?.maxMessageChars,
      maxStickers: cfg.socialV2?.liteChat?.maxStickers,
      maxImages: cfg.socialV2?.liteChat?.maxImagesPerReply,
      maxPokes: cfg.socialV2?.liteChat?.maxPokesPerReply,
      maxVoices: cfg.socialV2?.liteChat?.maxVoicesPerReply
    });
  }

  function liteModelKey() {
    if (liteModelKeyCache !== undefined) return liteModelKeyCache;
    try {
      liteModelKeyCache = resolveDeepSeekKey({ explicitKey: cfg.socialV2?.liteChat?.apiKey, env: process.env });
    } catch (error) {
      log(`[lite-direct] 解析 API Key 失败：${error?.message ?? error}`);
      liteModelKeyCache = null;
    }
    return liteModelKeyCache;
  }

  function liteEngine() {
    const engine = String(cfg.socialV2?.liteChat?.engine || 'auto');
    if (engine === 'dsh') return 'dsh';
    if (engine === 'direct') return 'direct';
    return liteModelKey() ? 'direct' : 'dsh';
  }

  function liteDirectActive(key) {
    if (liteDirectBroken) return false;
    return liteKeyEnabled(key) && liteEngine() === 'direct';
  }

  function recordLiteDirectUsage(key, usage, model, opts = {}) {
    try {
      const turn = (liteDirectTurnCounters.get(key) || 0) + 1;
      liteDirectTurnCounters.set(key, turn);
      const resolvedModel = model || cfg.socialV2?.liteChat?.model || cfg.dsh?.model || 'deepseek-flash';
      tokenLedger.ingestEvent({
        sessionId: (opts.sidPrefix || LITE_DIRECT_SID_PREFIX) + key,
        model: resolvedModel,
        provider: cfg.dsh?.provider || 'deepseek-official',
        at: Date.now(),
        event: {
          type: 'assistant/message',
          time: Date.now(),
          seq: turn,
          data: { usage: usageToLedgerBuckets(usage), turn, step: 1, model: resolvedModel }
        }
      });
    } catch (error) {
      log(`[lite-direct] 记账失败：${error?.message ?? error}`);
    }
  }

  /**
   * 滚动纪要：把更早的聊天压成 3–6 条短句，存进会话状态，之后每轮注入 【对话纪要】。
   * 触发：每 summaryEveryTurns 轮 / 新增消息过多 / 纪要过旧且有新消息；后台异步，不阻塞回复。
   */
  async function maybeSummarizeLite(key) {
    const lite = cfg.socialV2?.liteChat ?? {};
    if (lite.summaryEnabled === false) return;
    const st = getSocialV2State(key);
    if (!st || st.liteSummaryRunning) return;
    const now = Date.now();
    const sum = st.liteSummary || {};
    const recentCount = Array.isArray(st.recentMessages) ? st.recentMessages.length : 0;
    const msgCountAtUpdate = Number(sum.msgCountAtUpdate) || 0;
    const due = summaryDue({
      turnsSinceSummary: Number(sum.turnsSince) || 0,
      messagesSinceSummary: Math.max(0, recentCount - msgCountAtUpdate),
      lastSummaryAt: Number(sum.updatedAt) || 0,
      lastMessageAt: Number(st.lastIncomingAt) || 0,
      now,
      everyTurns: Number(lite.summaryEveryTurns) || 8,
      maxMessages: Math.max(8, Number(lite.summaryMaxInputMessages) || 40)
    });
    if (!due) return;
    if (st.liteSummaryRetryAt && now < Number(st.liteSummaryRetryAt)) return;
    const keyInfo = liteModelKey();
    if (!keyInfo) return;
    st.liteSummaryRunning = true;
    saveSocialV2State();
    try {
      const list = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
        .slice(-Math.max(8, Math.min(80, Number(lite.summaryMaxInputMessages) || 40)));
      const lines = list.map((m) => {
        if (!m) return '';
        const body = String(m.text || m.plain || '').replace(/\s+/g, ' ').trim();
        if (!body) return '';
        if (m.isSelf) return `我：${truncateText(body, 160)}`;
        // 昵称后面挂 QQ：档案指令要靠 QQ 落到 person-<QQ>，和「本轮说话人预取」用的是同一个 id。
        // 不挂的话模型只能写昵称，会另建一份 person-n-<hash>，之后永远没人预取到它。
        const sender = String(m.sender || '').trim() || '对方';
        const uid = String(m.userId || '').trim();
        const who = /^\d{5,12}$/.test(uid) ? `${sender}(QQ ${uid})` : sender;
        return `${who}：${truncateText(body, 160)}`;
      }).filter(Boolean);
      if (lines.length < 4) return;
      const model = lite.model || cfg.dsh?.model || 'deepseek-flash';
      const assetNotesOn = cfg.personMemory?.enabled !== false;
      // 已记过的事实 + 现有三段概况：交给模型做语义去重与归纳。
      // 字符级规则对中文措辞变化（「长东西」vs「长了个东西」）天生判不准，硬判只会漏判或误伤。
      const knownFacts = [];
      const knownProfiles = [];
      if (assetNotesOn) {
        const uids = [];
        for (const m of list) {
          const uid = String(m?.userId || '').trim();
          if (!m?.isSelf && /^\d{5,12}$/.test(uid) && !uids.includes(uid)) uids.push(uid);
        }
        for (const uid of uids.slice(0, 2)) {
          const profile = personProfileForRead(uid, key);
          if (!profile) continue;
          // 去重只看时间线最近几条；三段是概括，拿它去重会误伤。
          const facts = Array.isArray(profile.recentFacts) ? profile.recentFacts : [];
          if (facts.length) knownFacts.push(`${uid}：${facts.join('；').slice(0, 200)}`);
          knownProfiles.push({ id: profile.id, title: profile.title, sections: profile.sections });
        }
      }
      // 输出预算：纪要（≤300 字）+ 最多 2 条时间线 + 最多 2 人 × 3 段概况，
      // 按 summaryMaxChars 的 3 倍给（上限 1800），否则模型会把概况写一半就截断。
      const config = normalizeModelConfig({ model, maxTokens: Math.max(400, Math.min(1800, (Number(lite.summaryMaxChars) || 300) * 3)) });
      const result = await chatCompletion({
        messages: buildSummaryMessages({
          previousSummary: String(sum.text || ''),
          lines,
          maxChars: Number(lite.summaryMaxChars) || 300,
          withPersonNotes: assetNotesOn,
          knownFacts,
          knownProfiles
        }),
        key: keyInfo.key,
        config,
        log: (line) => log(`[lite-summary] ${line}`)
      });
      if (!result.ok) throw new Error(result.error?.message || '纪要调用失败');
      // 先剥指令行再清洗：否则 `[PERSON:note:...]` 会被压进纪要正文，
      // 下一轮以「对话纪要」的名义反复注入，模型就开始跟指令行聊天。
      const split = splitPersonNoteLines(result.text);
      // 档案先落盘、纪要后判定：纪要被判空是「纪要质量」问题，不该连累已经识别出的事实。
      if (assetNotesOn && split.notes.length) {
        const allowed = new Set(['note', 'who', 'traits', 'notes']);
        const ops = split.notes
          .map((line) => parsePersonDirective(line))
          .filter((op) => op && allowed.has(op.action));
        if (ops.length) {
          try { await applyPersonOps(key, ops); }
          catch (error) { log(`[person] ${key} 纪要期记档失败：${error?.message ?? error}`); }
        }
      }
      const text = cleanSummaryText(split.text, Number(lite.summaryMaxChars) || 300);
      if (text.length < 4) throw new Error('纪要内容为空');
      st.liteSummary = { text, updatedAt: Date.now(), turnsSince: 0, msgCountAtUpdate: recentCount };
      st.liteSummaryRetryAt = 0;
      recordLiteDirectUsage(key, result.usage, model, { sidPrefix: 'lite-summary:' });
      log(`[lite-summary] ${key} 纪要已更新：${text.length} 字（输入 ${result.usage?.promptTokens ?? '?'} tok / 输出 ${result.usage?.completionTokens ?? '?'} tok）`);
    } catch (error) {
      st.liteSummaryRetryAt = Date.now() + 10 * 60000;
      log(`[lite-summary] ${key} 纪要更新失败（10 分钟内重试）：${truncateText(String(error?.message ?? error), 120)}`);
    } finally {
      st.liteSummaryRunning = false;
      saveSocialV2State();
    }
  }

  function ackLiteSeen(key, seenSnap) {
    try {
      const st = getSocialV2State(key);
      // 默认用当前快照；成功路径必须传「本轮拼提示词时」的那份快照——
      // 模型调用要 1~3 秒，期间新到的消息不在提示词里，若在这里重建快照推进水位，
      // 它们会被当成「已展示过」永久吞掉。
      const snap = seenSnap || buildWakeSnapshotV2(key);
      if (!snap) return;
      // skippedSeqs 是本轮因「最新优先」被挤掉的旧未读：提示词里已明确说不用回，
      // 这里一并记为已展示，让已读水位能跨过它们，否则会卡住、旧消息反复出现。
      const skipped = Array.isArray(snap.skippedSeqs) ? snap.skippedSeqs.map((seq) => ({ seq })) : [];
      noteModelMessagesV2(st, [...(snap.messages || []), ...(snap.recent || []), ...skipped]);
      acknowledgeMessagesV2(st, readThroughSeqV2(st));
      saveSocialV2State();
    } catch (error) {
      log(`[lite-direct] ${key} 已读水位更新失败：${error?.message ?? error}`);
    }
  }

  async function runLiteDirectWake(key, reason) {
    pendingWakeKeys.add(key);
    armPendingWakeLease(key);
    let reply = '';
    // 这次调用到底成不成：决定本轮注入的后台提醒要不要消费掉（失败就留给下一轮重投）。
    let turnOk = false;
    const startedAt = Date.now();
    try {
      const keyInfo = liteModelKey();
      if (!keyInfo) throw new Error('没有可用的 DeepSeek API Key');
      const liteCfg = cfg.socialV2?.liteChat ?? {};
      const wantNativeImages = liteCfg.nativeImages !== false && !liteNativeImagesBroken;
      const inlineImages = [];
      // 先把本轮真正会展示给模型的快照固定下来；成功后才按这份快照推进已读水位。
      const turnSnapshot = buildWakeSnapshotV2(key);
      let promptText = await buildWakePromptLite(key, reason, { nativeImages: wantNativeImages, images: inlineImages });
      const model = liteCfg.model || cfg.dsh?.model || 'deepseek-flash';
      // 思考开关与强度（`liteChat.thinking`）：默认开、默认 low，按会话类型可分别配。
      // 开思考时 reasoning token 与正文**共用** max_tokens：2048 会被思考吃掉大半，
      // 极端情况下正文为空（model-client 会报 empty_content）。所以开思考时默认放宽到 4096；
      // `liteChat.maxTokens` 显式配了就以配置为准（normalizeModelConfig 上限 8192）。
      const think = liteThinkingForKey(key, liteCfg.thinking);
      const config = normalizeModelConfig({
        model,
        thinking: think.thinking,
        reasoningEffort: think.effort,
        maxTokens: Number(liteCfg.maxTokens) > 0
          ? Number(liteCfg.maxTokens)
          : (think.thinking === 'enabled' ? 4096 : undefined)
      });
      // 本轮的模型调用统一走这里：同一套 key/config/日志前缀，避免三处各写一遍。
      const ask = (messages, images) => chatCompletion({
        messages,
        ...(images ? { images } : {}),
        key: keyInfo.key,
        config,
        log: (line) => log(`[lite-direct] ${line}`)
      });
      const chatMessages = (userText) => [
        { role: 'system', content: liteSystemPrompt() },
        { role: 'user', content: userText }
      ];

      const sentImages = inlineImages.length;
      let result = await ask(chatMessages(promptText), inlineImages);
      // 原生附图被拒（模型/网关不支持 image_url）→ 本进程内永久回退视觉描述，并立即重试一次。
      if (!result.ok && inlineImages.length) {
        liteNativeImagesBroken = true;
        log(`[lite-direct] ${key} 附图调用失败（${result.error?.code || 'error'}），本进程内改用视觉描述重试：${truncateText(String(result.error?.message ?? ''), 120)}`);
        inlineImages.length = 0;
        promptText = await buildWakePromptLite(key, reason, { nativeImages: false });
        result = await ask(chatMessages(promptText));
      }
      if (!result.ok) {
        const err = new Error(result.error?.message || '调用失败');
        err.code = result.error?.code;
        throw err;
      }
      reply = result.text;
      turnOk = true;
      // 模型调用成功后才推进已读水位：失败时保留未读（下面会重排一次唤醒），
      // 不能让一次网络抖动把正在 @ 它的消息永久标成「已读」。
      ackLiteSeen(key, turnSnapshot);
      recordLiteDirectUsage(key, result.usage, result.model || model);
      liteDirectFailures = 0;
      // 模型要求读档案（[PERSON:read]）：补一次调用把正文交给它，再让它给最终回复。
      // 每轮最多读 1 份、正文截断到 readMaxChars（默认 3000 字），避免把提示词撑爆。
      try {
        const readOps = (parseLiteReply(reply).personOps || []).filter((op) => op.action === 'read');
        const profile = readOps.length ? personProfileForRead(readOps[0].ref, key) : null;
        if (profile) {
          const follow = await ask([
            { role: 'system', content: liteSystemPrompt() },
            { role: 'user', content: promptText },
            { role: 'assistant', content: reply },
            {
              role: 'user',
              content: `【人物档案】${profile.id} · ${profile.title}\n${profile.body || '（这份档案还没有正文）'}\n\n现在按输出协议写最终要发到 QQ 的消息（不要再写 [PERSON:read]）。`
            }
          ]);
          if (follow.ok) {
            reply = follow.text;
            recordLiteDirectUsage(key, follow.usage, follow.model || model, { sidPrefix: 'lite-person:' });
            log(`[lite-direct] ${key} 读档案 ${profile.id} 后补调用完成：输出 ${follow.usage?.completionTokens ?? '?'} tok`);
          } else {
            log(`[lite-direct] ${key} 读档案补调用失败：${follow.error?.message ?? 'error'}`);
          }
        }
      } catch (error) {
        log(`[lite-direct] ${key} 读档案处理失败：${error?.message ?? error}`);
      }
      // 日志带上思考状态：开思考后输出 token 会明显变多（reasoning 计入 completion），
      // 不标明的话看账本容易误以为「模型话变多了」。
      const flags = [think.thinking === 'enabled' ? `思考 ${think.effort}` : '', sentImages ? `附图 ${sentImages} 张` : '']
        .filter(Boolean).join('，');
      log(`[lite-direct] ${key} 一次调用完成：${Date.now() - startedAt}ms，输入 ${result.usage?.promptTokens ?? '?'} tok / 输出 ${result.usage?.completionTokens ?? '?'} tok${flags ? `（${flags}）` : ''}`);
      appendActivity(`${key} lite 直连：${truncateText(String(reply || ''), 60)}`);
    } catch (error) {
      liteDirectFailures += 1;
      if (liteDirectFailures >= 2 && !liteDirectBroken) {
        liteDirectBroken = true;
        log(`[lite-direct] 连续 ${liteDirectFailures} 次失败，本进程内回退到 DSH 轻量会话（重启桥接可恢复）`);
      }
      log(`[lite-direct] ${key} 调用失败（${error?.code || 'error'}）：${truncateText(String(error?.message ?? error), 160)}`);
      appendActivity(`${key} lite 直连失败：${truncateText(String(error?.message ?? error), 60)}`);
      reply = '';
      // 失败时没有推进已读水位，未读还在：把这次唤醒重排一次再试，避免 @/私聊
      // 被一次网络抖动永久吞掉。重排走正常唤醒调度（限频/暂停/模式闸门都生效）；
      // 连续失败两次会由上面的 liteDirectBroken 自动回退到 DSH 轻量会话。
      try {
        scheduleWakeV2(key, reason);
      } catch (retryError) {
        log(`[lite-direct] ${key} 失败后重排唤醒异常：${retryError?.message ?? retryError}`);
      }
    } finally {
      try {
        await handleLiteTurnEnd(key, reply || '[SILENT]', { turnOk });
      } catch (error) {
        log(`[lite] ${key} 收尾失败：${error?.message ?? error}`);
      }
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      replayPendingWakeReasonsV2(key);
    }
  }

  /**
   * lite 回合收尾：模型文本 → QQ 动作（文字/引用/表情包）→ 下一次唤醒配置。
   * 失败也要落一次唤醒配置，否则会话会"永眠"（没有工具路径的兜底提醒）。
   */
  async function handleLiteTurnEnd(key, text, opts = {}) {
    pendingWakeKeys.delete(key);
    disarmPendingWakeLease(key);
    // 这一轮正常跑完 = 本轮注入的后台提醒已经被模型看到并消化；失败轮不删，
    // 留着下一轮重新注入（模型调用挂了不代表提醒该丢）。
    if (opts.turnOk !== false) {
      try { clearDeliveredConsoleNotes(key); }
      catch (error) { log(`[lite] ${key} 清理后台提醒失败：${error?.message ?? error}`); }
    }
    let parsed = { silent: true, messages: [], items: [], wakeMs: null };
    try {
      parsed = parseLiteReply(text);
    } catch (error) {
      log(`[lite] ${key} 解析回复失败: ${error?.message ?? error}`);
    }
    // 人物档案写入（[PERSON:note/save]）：先落盘再发消息，写失败不影响回复。
    if (Array.isArray(parsed.personOps) && parsed.personOps.length) {
      try { await applyPersonOps(key, parsed.personOps); }
      catch (error) { log(`[person] ${key} 指令执行异常：${error?.message ?? error}`); }
    }
    const items = Array.isArray(parsed.items) && parsed.items.length
      ? parsed.items
      : (parsed.messages || []).map((t) => ({ type: 'text', text: t }));
    const stickerChoices = liteStickerChoices();
    // 本轮实际发出的动作计数：既用来插入打字间隔，也用来判断「到底说没说话」。
    const sent = { text: 0, sticker: 0, image: 0, poke: 0, voice: 0 };
    const sentTotal = () => sent.text + sent.sticker + sent.image + sent.poke + sent.voice;
    if (items.length) {
      // 引用只能落在近消息上：模型有时会挑一条十几分钟前的老图去引用，
      // 等于把话题拽回旧账。超过 quoteMaxAgeMs（默认 15 分钟）就当没引用、只发文字。
      const quoteMaxAgeMs = Math.max(60000, Number(cfg.socialV2?.wake?.quoteMaxAgeMs) || 15 * 60000);
      const lookupMessageId = (seq) => {
        const current = getSocialV2State(key);
        for (const pool of [current.unread, current.recentMessages]) {
          const hit = (Array.isArray(pool) ? pool : []).find((m) => m && Number(m.seq) === Number(seq));
          if (!hit) continue;
          const at = Number(hit.time) || 0;
          if (at > 0 && Date.now() - at > quoteMaxAgeMs) return '';
          return hit.messageId != null ? String(hit.messageId) : '';
        }
        return '';
      };
      const [kind, id] = key.split(':');
      for (const item of items) {
        try {
          // 每两个动作之间留出真人打字/挑表情/发图的间隔；表情包发送内部已有 0.8–2s 停顿。
          if (sentTotal() > 0) await sleep(randInt(700, 1800));
          if (item.type === 'sticker') {
            // 模型写的是索引里的短编号；也兼容直接写 emoji_id / md5。
            const idx = Number(item.ref);
            const target = Number.isSafeInteger(idx) && idx >= 1 && idx <= stickerChoices.length
              ? stickerChoices[idx - 1].id
              : item.ref;
            await sendStickerV2(key, target);
            sent.sticker += 1;
            appendActivity(`${key} lite 发表情：${truncateText(String(target), 40)}`);
            continue;
          }
          if (item.type === 'image') {
            await liteSendImage(key, String(item.query || ''));
            sent.image += 1;
            continue;
          }
          // [SELFIE]：自己的照片，只从形象库（默认 assets/）挑，不搜 Pixiv。
          if (item.type === 'selfie') {
            await liteSendImage(key, '', { source: 'self' });
            sent.image += 1;
            continue;
          }
          if (item.type === 'poke') {
            await liteSendPoke(key);
            sent.poke += 1;
            continue;
          }
          if (item.type === 'voice') {
            const spoken = String(item.text || '').trim();
            if (!spoken) continue;
            try {
              await speakVoiceForV2(key, spoken, { label: 'lite' });
              sent.voice += 1;
            } catch (error) {
              // 语音失败（TTS 没起/闸门拦）不能静默丢话：降级成文字发出去。
              log(`[lite] ${key} 语音发送失败，降级文字：${error?.message ?? error}`);
              await sendToQQ(key, spoken);
              sent.text += 1;
              recordLiteSentMessage(key, spoken);
            }
            continue;
          }
          const body = String(item.text || '').trim();
          if (!body) continue;
          const replyId = item.quoteSeq ? lookupMessageId(item.quoteSeq) : '';
          if (replyId) await onebotSend(kind, id, body, replyId);
          else await sendToQQ(key, body);
          sent.text += 1;
          // 发出去就记账：不记的话下一轮历史里没有这句话，模型会把它再说一遍。
          recordLiteSentMessage(key, body);
          appendActivity(`${key} lite 回复：${truncateText(body, 80)}${replyId ? '（引用）' : ''}`);
        } catch (error) {
          log(`[lite] ${key} 发送失败（${item.type}）：${error?.message ?? error}`);
        }
      }
      if (sentTotal() > 0 && lastSendSucceeded(key)) {
        const sentState = getSocialV2State(key);
        sentState.lastAiReplyAt = Date.now();
        sentState.lastActionAt = Date.now();
      }
    }
    const st = getSocialV2State(key);
    const wc = liteWakeConfigV2(key);
    // [WAKE:x] 只在 active（私聊）里生效。
    // 潜水模式一律忽略：否则模型一句 [WAKE:30m] 就能把「一直潜水」改回限时潜水，
    // 配置里关掉的普通消息唤醒也会被这条指令绕过。
    // 注意：liteWakeConfig 把群聊的 mode 硬编码成 'diving'，所以群里这条永远是死指令
    // ——提示词那边已经按会话类型分开注入（群聊不教 [WAKE]），不要只改一边。
    if (parsed.wakeMs && parsed.wakeMs > 0 && wc.mode !== 'diving') {
      wc.infinite = false;
      wc.sleepUntil = new Date(Date.now() + Math.min(parsed.wakeMs, 6 * 3600000)).toISOString();
    }
    st.wakeConfig = wc;
    st.lastWakeReason = '';
    ensureWakeableV2(st, { key });
    saveSocialV2State();
    setupSleepTimerV2(key);
    // 纪要触发计数：每回合 +1，轮到阈值/消息量时在后台压一次（不阻塞本轮回复）。
    try {
      const sum = st.liteSummary || (st.liteSummary = { text: '', updatedAt: 0, turnsSince: 0, msgCountAtUpdate: 0 });
      sum.turnsSince = (Number(sum.turnsSince) || 0) + 1;
      saveSocialV2State();
      void maybeSummarizeLite(key);
    } catch {}
    const nextWake = wc.infinite ? '触发条件' : `限时 ${Math.max(0, Math.round((Date.parse(wc.sleepUntil) - Date.now()) / 60000))} 分钟`;
    const actionSummary = parsed.silent
      ? '选择不发言'
      : `发送 ${sent.text} 条文字 / ${sent.sticker} 个表情 / ${sent.image} 张图 / ${sent.poke} 次拍一拍 / ${sent.voice} 条语音`;
    log(`[lite] ${key} ${actionSummary}；下次唤醒=${nextWake}`);
  }

  return { bind, getLiteDirectFailures, getLiteDirectBroken, liteChatEnabled, liteKeyEnabled, liteSessionActive, liteWakeConfigV2, liteDirectActive, liteModelKey, liteEngine, parseLiteReply, recordLiteDirectUsage, maybeSummarizeLite, ackLiteSeen, runLiteDirectWake, handleLiteTurnEnd };
}
