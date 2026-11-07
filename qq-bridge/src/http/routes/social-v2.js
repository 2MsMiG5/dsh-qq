// social-v2 域的 HTTP 端点。

import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from '../../md-to-plain.js';
import { describeAudio, inspectAudio, listAudioFiles } from '../../voice-core.js';
import { LITE_THINKING_LEVELS, activeWindowLeftMs } from '../../lite-chat.js';

/**
 * 把配置对象里的一组数字字段归一成非负整数。
 * 非法值退回 `fallbackOf(key)`——注意**不取整也不夹取**，与原逻辑一致：
 * 兜底值来自已落盘配置，信任它比二次加工更安全。
 */
function clampNonNegativeFields(target, keys, fallbackOf) {
  for (const key of keys) {
    if (target[key] === undefined) continue;
    const n = Number(target[key]);
    target[key] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallbackOf(key);
  }
}

/** 概率字段：非法值退回当前配置，最终一律夹到 [0,1]（不取整，否则永远只剩 0/1）。 */
function clampProbabilityField(target, key, fallback) {
  if (target[key] === undefined) return;
  const n = Number(target[key]);
  const base = Number.isFinite(n) ? n : (Number(fallback) || 0);
  target[key] = Math.min(1, Math.max(0, base));
}

export function createSocialV2Routes(deps) {
      const {
    FEEDBACK_FILE, ROOT, SOCIAL_V2_FILE, agentTokenOk, api, appendActivity, appendFeedbackEntry,
    atomicWriteJson, buildWakePromptLite, canonicalV2Key, cfg, clearAllPendingWakeLeases,
    clearAllSocialV2Timers, clearTimeout, collectors, computeWakeSafetyV2, drainAllPromptQueues, feedbackTimes,
    forgetAgentToken, getSocialV2State, initialPromptMaxChars, initialPrompts, log, modeAllowed,
    modelAppliedSessions, pendingSendToolCalls, pendingWakeKeys, readConfigObject, readFeedbackEntries,
    readRoleState, reconcileSessionPolicies, refreshAllDefaultWakeConfigsV2, retireSession, reverse,
    saveSocialV2State, saveState, scheduleProactiveCheckV2, seenForwardIds, sendToolSucceededSessions,
    sendWakePromptV2, sessionModels, sessionPromises, setInitialPrompt, setupSleepTimerV2, socialV2, state,
    stopRetiredSessionWork, synthesizeVoiceFile, toolCallNames, ttsServiceJson, turnLeaseNoted,
    v2SessionAllowed, v2TurnStartAt, voiceCfg, voiceTtsCfg, proactivePrivateSvc,
  } = deps;

  /**
   * 解析并校验目标 key：格式 → 正整数 id → 当前模式是否允许。
   * 校验失败时就地回复并返回 null，调用方 `if (!target) return;` 即可。
   */
  function v2TargetOrReject(key, currentMode, sendJson, denyMessage = '目标不在当前模式允许范围内') {
    const match = /^(group|private):(\d+)$/.exec(key);
    if (!match) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return null;
    }
    const kind = match[1];
    const id = Number(match[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: denyMessage }, 403);
      return null;
    }
    return { kind, id };
  }

  // 初始提示词：读（GET）与写/删（POST）共用同一段逻辑，由两条路由各自声明 method。
  const initialPromptRoute = async ({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) => {
    if (req.method === 'GET') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) {
        const entries = [...initialPrompts.entries()]
          .map(([entryKey, entry]) => ({
            key: entryKey,
            chars: entry.text.length,
            createdAt: entry.createdAt || 0,
            updatedAt: entry.updatedAt || 0,
            preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
          }))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
        return;
      }
      const canonical = canonicalV2Key(key);
      if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const entry = initialPrompts.get(canonical) ?? null;
      sendJson({
        ok: true,
        key: canonical,
        exists: !!entry,
        text: entry?.text ?? '',
        createdAt: entry?.createdAt || 0,
        updatedAt: entry?.updatedAt || 0,
        maxChars: initialPromptMaxChars(),
        writable: initialPromptsWritable
      });
      return;
    }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const explicitDelete = body.delete === true;
    // 只接受 { key, text: string } 或 { key, delete: true }：
    // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
    if (!explicitDelete && typeof body.text !== 'string') {
      sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
      return;
    }
    const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
    log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
    sendJson({
      ok: true,
      key: result.key,
      deleted: result.deleted,
      chars: result.chars,
      exists: !!result.entry,
      updatedAt: result.entry?.updatedAt || 0,
      maxChars: initialPromptMaxChars()
    });
    return;
  };

  return [
    {
      method: 'GET',
      path: '/api/socialV2/config',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        sendJson({ ok: true, config: cfg.socialV2 ?? {} });
        return;
      }
    },
    {
      // 主动私聊的只读排期视图。单独一个 GET 而不是塞进 /states：
      // /states 是「会话台账」（未读/唤醒/花费），15 秒轮询一次；这份是「AI 下一步会不会
      // 主动找人」，只在打开配置面板时看，混进去会让两个不同节奏的视图互相拖累。
      method: 'GET',
      path: '/api/socialV2/proactive-private',
      async handler({ req, res, url, sendJson }) {
        if (!proactivePrivateSvc) { sendJson({ ok: false, error: '主动私聊调度未装配' }, 503); return; }
        try {
          const snap = proactivePrivateSvc.listSchedules();
          sendJson({ ok: true, ...snap });
        } catch (error) {
          sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/config',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const body = await readBody();
        const configFile = path.join(ROOT, 'config.json');
        const file = readConfigObject(configFile);
        // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
        //
        // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
        // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。cfg.socialV2 是
        // 「文件 + 默认值」深度合并后的运行时配置，用它兜底才和真正生效的设置一致。
        const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
          ? file.socialV2
          : null;
        const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
        const merged = { ...current, ...body };
        // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值，这里直接保留当前值。
        for (const sub of ['wake', 'send', 'wait', 'proactive', 'proactivePrivate', 'sticker', 'feedback', 'context', 'liteChat']) {
          if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
            merged[sub] = current[sub] ?? {};
          }
        }
        if (merged.autoReplyCheckMs !== undefined) {
          const n = Number(merged.autoReplyCheckMs);
          merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
        }
        // liteChat：轻量聊天路径（Track 2）开关。enabled 翻转会改变会话预设，
        // reconcileSessionPolicies() 在下一轮把旧会话温和退役，无需重启桥接。
        if (body.liteChat && typeof body.liteChat === 'object' && !Array.isArray(body.liteChat)) {
          merged.liteChat = { ...(current.liteChat ?? {}), ...body.liteChat };
          merged.liteChat.enabled = merged.liteChat.enabled === true;
          if (merged.liteChat.preset !== undefined) merged.liteChat.preset = String(merged.liteChat.preset ?? 'qq-chat-lite');
          const prob = Number(merged.liteChat.groupWakeProbability);
          merged.liteChat.groupWakeProbability = Number.isFinite(prob) ? Math.min(1, Math.max(0, prob)) : 0.05;
          const maxMsg = Number(merged.liteChat.maxMessages);
          merged.liteChat.maxMessages = Number.isFinite(maxMsg) ? Math.min(8, Math.max(1, Math.round(maxMsg))) : 2;
          const histAge = Number(merged.liteChat.historyMaxAgeMs);
          merged.liteChat.historyMaxAgeMs = Number.isFinite(histAge)
            ? Math.min(24 * 3600000, Math.max(5 * 60000, Math.round(histAge)))
            : 2700000;
          // 媒体预处理 / 表情 / 历史 / 引擎：都只接受已知取值，防止手滑写坏导致静默降级。
          for (const [name, fallback, min, max] of [
            ['maxImagesPerWake', 1, 0, 3],
            ['maxVoicesPerWake', 1, 0, 3],
            ['maxVideosPerWake', 1, 0, 2],
            // maxImagesPerReply 上限与 parseLiteReply 的 clamp(5) 对齐：控制台保存会把
            // liteChat 整段重写进 config，这里还卡 2 的话，手改的 5 会被静默打回 2。
            ['maxImagesPerReply', 5, 0, 5],
            ['maxPokesPerReply', 1, 0, 2],
            ['maxVoicesPerReply', 1, 0, 2],
            ['historyMessages', 12, 0, 40],
            ['historyMaxChars', 2400, 200, 8000],
            ['summaryEveryTurns', 8, 2, 50],
            ['summaryMaxChars', 300, 40, 2000],
            ['summaryMaxInputMessages', 40, 8, 80],
            ['stickerMax', 6, 0, 12],
            ['maxStickers', 2, 0, 4]
          ]) {
            const n = Number(merged.liteChat[name] ?? fallback);
            merged.liteChat[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
          }
          const engine = String(merged.liteChat.engine ?? 'auto');
          merged.liteChat.engine = ['auto', 'direct', 'dsh'].includes(engine) ? engine : 'auto';
          // 思考档位：'disabled' | 'low' | 'high' | 'max'，或 { private, group } 分开配。
          // 写错的档位一律落成 'disabled'，与运行时 liteThinkingForKey 的取舍一致——
          // 所见即所得：控制台刷新后能看到"其实没开"，而不是以为开了却在烧钱。
          const levels = new Set(LITE_THINKING_LEVELS);
          const sanitizeLevel = (v) => {
            const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
            return levels.has(s) ? s : 'disabled';
          };
          if (merged.liteChat.thinking !== undefined) {
            const rawThinking = merged.liteChat.thinking;
            merged.liteChat.thinking = (rawThinking && typeof rawThinking === 'object' && !Array.isArray(rawThinking))
              ? {
                private: sanitizeLevel(rawThinking.private),
                group: sanitizeLevel(rawThinking.group)
              }
              : sanitizeLevel(rawThinking);
          }
          // maxTokens：0 = 交给引擎自动（开思考 4096 / 关思考 2048）。
          if (merged.liteChat.maxTokens !== undefined) {
            const n = Number(merged.liteChat.maxTokens);
            merged.liteChat.maxTokens = Number.isFinite(n) ? Math.min(8192, Math.max(0, Math.round(n))) : 0;
          }
          if (merged.liteChat.nativeImages !== undefined) merged.liteChat.nativeImages = merged.liteChat.nativeImages !== false;
          if (merged.liteChat.summaryEnabled !== undefined) merged.liteChat.summaryEnabled = merged.liteChat.summaryEnabled !== false;
          // 灰度名单：空数组 = 全部会话；否则只允许合法 key（防止手滑写成中文/空串导致整个开关失效）。
          if (merged.liteChat.keys !== undefined) {
            const keys = Array.isArray(merged.liteChat.keys) ? merged.liteChat.keys : [];
            merged.liteChat.keys = keys
              .map((k) => String(k ?? '').trim())
              .filter((k) => /^(group|private):\d+$/.test(k))
              .slice(0, 50);
          } else {
            merged.liteChat.keys = [];
          }
        }
        if (body.wake && typeof body.wake === 'object') {
          merged.wake = { ...(current.wake ?? {}), ...body.wake };
          // 毫秒/次数类字段统一非负取整；概率字段单独夹取。
          clampNonNegativeFields(merged.wake, [
            'sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'batchWindowMs', 'maxDirectWakePerMinute', 'maxDirectWakePerHour',
            'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit',
            'maxWakeConfigReminders', 'preSleepWaitMs'
          ], (k) => current.wake?.[k] ?? 0);
          clampProbabilityField(merged.wake, 'recommendedProbability', current.wake?.recommendedProbability);
          if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
          if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
          if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
          if (merged.wake.recommendedKeywords !== undefined) {
            merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
          }
          if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
          if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
        }
        if (body.send && typeof body.send === 'object') {
          merged.send = { ...(current.send ?? {}), ...body.send };
          clampNonNegativeFields(merged.send, [
            'burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs',
            'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour',
            'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs'
          ], (k) => current.send?.[k] ?? 0);
          clampProbabilityField(merged.send, 'longGapProbability', current.send?.longGapProbability);
          if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
          if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
        }
        if (body.wait && typeof body.wait === 'object') {
          merged.wait = { ...(current.wait ?? {}), ...body.wait };
          clampNonNegativeFields(
            merged.wait,
            ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs'],
            (k) => current.wait?.[k] ?? 5000
          );
        }
        if (body.proactive && typeof body.proactive === 'object') {
          merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
          clampNonNegativeFields(
            merged.proactive,
            ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs'],
            (k) => current.proactive?.[k] ?? 0
          );
          clampProbabilityField(merged.proactive, 'probability', current.proactive?.probability);
          if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
        }
        // 主动私聊：与上面的群聊 proactive 完全独立的一段配置（见 src/social/proactive.js）。
        // 这里要挡的主要是三类脏值：quota 写成负数（等于永不开嘴）、
        // activeHours 写成乱序/相等（窗口长度为 0，永远排不出落点）、以及 backoff 被整体替换。
        if (body.proactivePrivate && typeof body.proactivePrivate === 'object' && !Array.isArray(body.proactivePrivate)) {
          const curPP = (current.proactivePrivate && typeof current.proactivePrivate === 'object') ? current.proactivePrivate : {};
          merged.proactivePrivate = { ...curPP, ...body.proactivePrivate };
          const pp = merged.proactivePrivate;

          if (pp.enabled !== undefined) pp.enabled = pp.enabled === true;
          if (pp.onlyKnownContacts !== undefined) pp.onlyKnownContacts = pp.onlyKnownContacts === true;

          const quota = Number(pp.dailyQuota);
          pp.dailyQuota = Number.isFinite(quota)
            ? Math.min(6, Math.max(0, Math.round(quota)))
            : (Number.isFinite(Number(curPP.dailyQuota)) ? Math.round(Number(curPP.dailyQuota)) : 2);

          for (const k of ['minIntervalMs', 'idleThresholdMs', 'tickMs']) {
            const n = Number(pp[k]);
            pp[k] = Number.isFinite(n) ? Math.max(60 * 1000, Math.round(n)) : curPP[k] ?? 0;
          }
          if (Number.isFinite(pp.tickMs)) pp.tickMs = Math.min(60 * 60 * 1000, pp.tickMs);
          if (Number.isFinite(pp.idleThresholdMs)) pp.idleThresholdMs = Math.min(7 * 24 * 60 * 60 * 1000, pp.idleThresholdMs);
          if (Number.isFinite(pp.minIntervalMs)) pp.minIntervalMs = Math.min(7 * 24 * 60 * 60 * 1000, pp.minIntervalMs);

          // 清醒时段：必须是两个整数小时，且不能相等（零长度窗口 = 永远不开口）。
          const hours = Array.isArray(pp.activeHours) ? pp.activeHours.map(Number) : null;
          const validHours = hours && hours.length === 2
            && Number.isFinite(hours[0]) && Number.isFinite(hours[1])
            && hours[0] >= 0 && hours[0] <= 23 && hours[1] >= 0 && hours[1] <= 24
            && hours[0] !== hours[1];
          pp.activeHours = validHours
            ? [Math.round(hours[0]), Math.round(hours[1])]
            : (Array.isArray(curPP.activeHours) ? curPP.activeHours : [9, 23]);

          const curBackoff = (curPP.backoff && typeof curPP.backoff === 'object') ? curPP.backoff : {};
          if (body.proactivePrivate.backoff && typeof body.proactivePrivate.backoff === 'object') {
            pp.backoff = { ...curBackoff, ...body.proactivePrivate.backoff };
            if (pp.backoff.enabled !== undefined) pp.backoff.enabled = pp.backoff.enabled === true;
            const mult = Number(pp.backoff.maxMultiplier);
            pp.backoff.maxMultiplier = Number.isFinite(mult)
              ? Math.min(32, Math.max(1, Math.round(mult)))
              : (curBackoff.maxMultiplier ?? 8);
          } else {
            pp.backoff = { ...curBackoff };
          }
        }
        if (body.sticker && typeof body.sticker === 'object') {
          merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
          if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
          clampNonNegativeFields(
            merged.sticker,
            ['syncTtlMs', 'maxListCount', 'promptMaxStickers'],
            (k) => current.sticker?.[k] ?? 0
          );
          if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
          if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
          if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
          if (body.sticker.collect && typeof body.sticker.collect === 'object') {
            merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
            if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
            clampNonNegativeFields(
              merged.sticker.collect,
              ['maxPerMinute', 'maxPerHour', 'maxRemarkChars'],
              (k) => current.sticker?.collect?.[k] ?? 0
            );
          }
        }
        if (body.feedback && typeof body.feedback === 'object') {
          merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
          if (merged.feedback.maxLength !== undefined) {
            const n = Number(merged.feedback.maxLength);
            merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
          }
          if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
        }
        if (body.context && typeof body.context === 'object') {
          merged.context = { ...(current.context ?? {}), ...body.context };
          for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
            if (merged.context[k] !== undefined) {
              const n = Number(merged.context[k]);
              merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
            }
          }
          for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
            const n = Number(merged.context[name] ?? fallback);
            merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
          }
          if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          // 会话轮换（方案 A）的开关与阈值：0 = 该维度不设限。
          if (merged.context.rotateEnabled !== undefined) merged.context.rotateEnabled = merged.context.rotateEnabled === true;
          for (const [name, fallback, min, max] of [
            ['rotateContextTokens', 80000, 0, 2000000],
            ['rotateAfterSteps', 60, 0, 1000],
            ['handoffMessages', 8, 0, 20],
            ['rotateMinIntervalMs', 600000, 0, 86400000]
          ]) {
            const n = Number(merged.context[name] ?? fallback);
            merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
          }
        }
        if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
        if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
        if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
        file.socialV2 = merged;
        atomicWriteJson(configFile, file);
        cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
        // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
        // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
        const WAKE_DEFAULT_KEYS = [
          'defaultMode', 'recommendedDefaultInfinite',
          'recommendedSleepMinMs', 'recommendedSleepMaxMs',
          'recommendedProbability', 'recommendedKeywords',
          'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
          'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
        ];
        const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
          WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
        if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
        // 主动私聊策略变了 → 立即重排所有候选会话。
        // 不这么做的话，旧落点是按旧时段/旧配额算的，而 tick 只看 `now < nextAt`，
        // 会把「改了配置但时间没变」一直挂到落点自然撞上时段检查为止，控制台显示的时间也是错的。
        if (body.proactivePrivate && typeof body.proactivePrivate === 'object' && !Array.isArray(body.proactivePrivate)) {
          try {
            const n = proactivePrivateSvc?.replanAll?.() ?? 0;
            if (n > 0) log(`控制台：主动私聊策略已更新，${n} 个会话重新排期`);
          } catch (error) {
            log(`控制台：主动私聊重排失败（配置已保存）：${error?.message ?? error}`);
          }
        }
        log('控制台：聊天行为配置已更新');
        sendJson({ ok: true, config: cfg.socialV2 });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/socialV2/activity',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        sendJson({ ok: true, paused: socialV2.paused });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/activity',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const body = await readBody();
        const paused = body.paused === true;
        socialV2.paused = paused;
        if (paused) {
          clearAllSocialV2Timers();
          log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
        } else {
          log('控制台：二代 AI 已恢复');
          for (const key of socialV2.conversations.keys()) {
          setupSleepTimerV2(key);
          scheduleProactiveCheckV2(key);
        }
        }
        saveSocialV2State();
        sendJson({ ok: true, paused: socialV2.paused });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/reset',
      async handler({ req, res, url, sendJson, readBody, bumpSessionEpoch, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        bumpSessionEpoch();
        sessionPromises.clear();
        clearAllSocialV2Timers();
        drainAllPromptQueues('二代状态已重置');
        for (const key of [...socialV2.conversations.keys()]) {
          const sid = state.sessions[key];
          if (sid) {
            delete state.sessions[key];
            // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
            // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
            // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它再发什么都会 403）。
            stopRetiredSessionWork(sid, key);
            sessionModels.delete(sid);
            modelAppliedSessions.delete(sid);
            reverse.delete(sid);
            collectors.delete(sid);
            v2TurnStartAt.delete(sid);
            turnLeaseNoted.delete(sid);
            toolCallNames.delete(sid);
            pendingSendToolCalls.delete(sid);
            sendToolSucceededSessions.delete(sid);
            // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
            api.events.forget?.(sid);
          }
          delete state.sessionPolicies[key];
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
        }
        saveState();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        socialV2.paused = false;
        try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败', error?.message ?? error); }
        log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
        sendJson({ ok: true });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/socialV2/state',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
        if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        const st = getSocialV2State(key);
        sendJson({
          ok: true,
          key,
          wakeConfig: st.wakeConfig,
          wakeSafety: computeWakeSafetyV2(st.wakeConfig),
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          // 群聊「唤醒后保持活跃」窗口：控制台/排障时能直接看到还剩多久、名片缓存对不对。
          activeWindow: {
            active: activeWindowLeftMs(st) > 0,
            leftMs: activeWindowLeftMs(st),
            until: Number(st.activeUntil) || 0,
            windowMs: Number(cfg.socialV2?.wake?.postWakeActiveMs) || 0
          },
          selfGroupCard: st.selfGroupCard || ''
        });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/socialV2/states',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const list = [];
        for (const [key, st] of socialV2.conversations) {
          list.push({
            key,
            wakeConfig: st.wakeConfig,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt,
            noActionCount: st.wakeConfig.noActionCount || 0
          });
        }
        sendJson({ ok: true, conversations: list });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/wake',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const reason = String(body.reason ?? 'admin').trim() || 'admin';
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
        const target = v2TargetOrReject(key, currentMode, sendJson);
        if (!target) return;
        const { kind, id } = target;
        const st = getSocialV2State(key);
        if (st.pendingWakeTimer) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
        }
        // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「操作者为这个会话预写的初始提示词
        // （群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
        // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
        const firstWake = !st.bootstrapSent;
        if (firstWake) st.bootstrapSent = true;
        const effectiveReason = firstWake ? 'bootstrap' : reason;
        saveSocialV2State();
        // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
        // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
        // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
        // 表面上"唤醒成功"，实际上谁也不知道它失败了。
        void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
        log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
        sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
        return;
        // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
        // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptLite。
      }
    },
    {
      // GET 读、POST 写/删。原先只声明了 GET，但 handler 里一直有 POST 分支 ——
      // 控制台的「保存」「删除初始提示词」因此恒 404（声明缺失，不是逻辑问题）。
      method: 'GET',
      path: '/api/socialV2/initial-prompt',
      handler: initialPromptRoute
    },
    {
      method: 'POST',
      path: '/api/socialV2/initial-prompt',
      handler: initialPromptRoute
    },
    // 语音库列表。两条通道共用：
    //   - 带 agent token（AI 侧语音调用）→ 必须带 key，校验会话白名单；
    //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
    // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
    {
      method: 'GET',
      paths: ['/api/socialV2/voices', '/api/voice/list'],
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const voice = voiceCfg();
        const agentCall = Boolean(req.headers['x-agent-token']);
        // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
        if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
        if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
        if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        const wantProbe = url.searchParams.get('probe') !== '0';
        try {
          const files = listAudioFiles(voice.dir);
          const items = [];
          for (const f of files.slice(0, 100)) {
            const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
            if (wantProbe) {
              const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              entry.ok = info.ok;
              entry.bytes = info.size;
              entry.detail = info.ok ? describeAudio(info) : null;
              entry.seconds = info.duration ?? null;
              if (!info.ok) entry.error = info.error;
            }
            items.push(entry);
          }
          sendJson({
            ok: true,
            key: key || null,
            dir: agentCall ? undefined : voice.dir,
            count: items.length,
            voices: items,
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
            // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
            // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
            hint: items.length
              ? '把 name 传进来即可用其中一个音色发送语音'
              : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
          });
        } catch (error) {
          sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
        }
        return;

        // ── TTS 音色（控制台专用：列出 / 切换 / 试听）────────────────────────────
        // 音色的真实来源是本地 TTS 服务的音色仓库（ref/voices/<id>/），桥接只做代理 + 缓存。
        // 「当前音色」同步进 config.json，好让唤醒 prompt 里的音色名保持一致。
      }
    },
    {
      method: 'GET',
      path: '/api/socialV2/tts-voices',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const tc = voiceTtsCfg();
        if (!tc.enabled) { sendJson({ ok: false, enabled: false, error: '文字转语音未开启（socialV2.voice.tts.enabled 为 false）' }); return; }
        const data = await ttsServiceJson(tc, 'GET', '/voices');
        if (!data.ok) { sendJson({ ok: false, enabled: true, error: data.error, baseUrl: tc.baseUrl }, 502); return; }
        // 音色归属说明：人格设过就显示人格的，没设就显示全局默认。
        // 服务端 /voices 的 current 只是「服务进程当前选中的音色」，不等于本项目此刻生效的音色。
        const role = readRoleState().role || null;
        sendJson({
          ok: true,
          enabled: true,
          current: tc.voice,
          voiceName: tc.voiceName,
          voiceFromRole: tc.voiceFromRole === true,
          role,
          voices: Array.isArray(data.body?.voices) ? data.body.voices : [],
          baseUrl: tc.baseUrl
        });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/tts-preview',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const body = await readBody();
        const baseTc = voiceTtsCfg();
        if (!baseTc.enabled) { sendJson({ ok: false, error: '文字转语音未开启（socialV2.voice.tts.enabled 为 false）' }, 403); return; }
        const text = String(body.text ?? '').trim();
        if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
        if (text.length > baseTc.maxChars) { sendJson({ ok: false, error: `文本过长（最多 ${baseTc.maxChars} 字，当前 ${text.length} 字）` }, 400); return; }
        // 试听可以指定音色（控制台在保存前先听一下）。只影响这一次合成，不改任何配置。
        const wantVoice = String(body.voice ?? '').trim();
        let tc = baseTc;
        if (wantVoice && wantVoice !== baseTc.voice) {
          const listed = await ttsServiceJson(baseTc, 'GET', '/voices');
          if (!listed.ok) { sendJson({ ok: false, error: listed.error }, 502); return; }
          const voices = Array.isArray(listed.body?.voices) ? listed.body.voices : [];
          const found = voices.find((v) => String(v?.id) === wantVoice);
          if (!found) { sendJson({ ok: false, error: `没有这个音色：${wantVoice}` }, 400); return; }
          tc = { ...baseTc, voice: wantVoice, voiceName: String(found.name || wantVoice) };
        }
        const started = Date.now();
        try {
          const synth = await synthesizeVoiceFile(text, tc);
          try {
            const buf = fs.readFileSync(synth.file);
            sendJson({
              ok: true,
              voice: tc.voice,
              voiceName: tc.voiceName,
              mime: 'audio/wav',
              bytes: buf.length,
              ms: Date.now() - started,
              // 试听走 base64 内联：控制台（≤100）不必跨域去请求 TTS 服务（127.0.0.1:3210），
              // 也不开 3210 的 CORS 头——那个端口只该给本机桥接用。
              audio: buf.toString('base64')
            });
          } finally {
            try { fs.unlinkSync(synth.file); } catch {}
          }
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 502);
        }
        return;

      }
    },
    {
      method: 'GET',
      path: '/api/socialV2/feedback',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        sendJson({ ok: true, entries: readFeedbackEntries() });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/feedback-clear',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
        atomicWriteJson(FEEDBACK_FILE, []);
        log('控制台：清空 AI 反馈');
        sendJson({ ok: true });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/socialV2/feedback',
      async handler({ req, res, url, sendJson, readBody, currentMode, initialPromptsWritable, lastForcedAgentStickerSync, selfDisplayName, selfUserId, sessionEpoch, stickerEntries, stickerSyncedAt }) {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
        const rawMessage = String(body.message ?? '').trim();
        if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
        if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
        const fNow = Date.now();
        const fTimes = feedbackTimes.get(key) || [];
        const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
        const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
        if (fRecentMinute >= 5 || fRecentHour >= 20) {
          sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
          return;
        }
        fTimes.push(fNow);
        feedbackTimes.set(key, fTimes.slice(-100));
        const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
        const message = truncateText(rawMessage, maxLength);
        appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
        log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
        appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
        if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
          log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
        }
        sendJson({ ok: true, key, level, message });
        return;
      }
    },
  ];
}
