// index.js — 从 src/bridge.js 抽取的函数簇（10 个函数）。
//
// 采用「延迟绑定」：工厂先返回可调用的函数，boot 装配完成后再 bind 一次依赖。
// 原因是这些函数依赖 bot / handles 等在 boot 尾部才创建的对象，在工厂创建时解构会撞 TDZ。
//
// 三条规则（违反任一条都会静默出错）：
//   1) 可变状态必须 bind **取值函数**，不能 bind 值快照——否则模块看到的是永久冻结的旧状态。
//   2) 函数体与原实现逐字一致，只把闭包引用改为 bind 进来的局部变量。
//   3) 凡是能被测试/调用方替换的能力（抓取、外部服务调用），一律走 bind，不要在这里 import。
//      原实现从 boot 外层作用域取这些名字，调用方通过注入同名绑定来替换；改成直接 import
//      会绕过那个注入点——调用方以为自己换了实现，实际跑的还是真模块（假绿）。
//      这条对本模块尤其要紧：测试 harness 把 fetch 桩成 fakeFetch、把 ffmpeg 相关能力
//      桩成「不转码」、把表情库桩成 fixture。模块里直接 import 就绕过了这些桩——
//      表现为测试真去 spawn ffmpeg（ENOENT）、真去打 127.0.0.1:3000，或者更糟：断言假绿。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { sendQueue } from './queue.js';
import { suggestQuietMsV2 } from '../v2-wait.js';

export function createSendService() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let MAX_MEDIA_BYTES, REPLY_INFO_TTL_MS, SEND_TIMEOUT_MS, REPLY_NEGATIVE_TTL_MS, api, appendActivity, assertOutboundAuditOk, bot, captureSendGuard, cfg, cleanupTemp, clampGapV2, describeAudio, escapeCqText, fetch, findSticker, getSocialV2State, getStickerEntries, inspectAudio, lastSendFailed, lastSendSucceeded, log, pruneReplyInfoCache, randInt, recordSentMessagesV2, recordVoiceSentV2, redactKnownTokensOnly, replyInfoCache, markStickerUsed, processAudioVolume, resolveGroupMemberName, saveStickerStoreSafe, segmentsToText, sendTextMessagesV2, setStickerEntries, sendToQQ, safeFetchBuffer, sendVoiceForV2, sleep, socialV2, syncStickerLibrary, synthesizeVoiceFile, text, ttsBudgetCheck, ttsBudgetCommit, verifyVoiceMessageSent, voiceBudgetCheck, voiceBudgetCommit, voiceCfg, voiceMarkerText, voiceTtsCfg, withTimeout;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ MAX_MEDIA_BYTES, REPLY_INFO_TTL_MS, SEND_TIMEOUT_MS, REPLY_NEGATIVE_TTL_MS, api, appendActivity, assertOutboundAuditOk, bot, captureSendGuard, cfg, cleanupTemp, clampGapV2, describeAudio, escapeCqText, fetch, findSticker, getSocialV2State, getStickerEntries, inspectAudio, lastSendFailed, lastSendSucceeded, log, pruneReplyInfoCache, randInt, recordSentMessagesV2, recordVoiceSentV2, redactKnownTokensOnly, replyInfoCache, markStickerUsed, processAudioVolume, resolveGroupMemberName, saveStickerStoreSafe, segmentsToText, sendTextMessagesV2, setStickerEntries, sendToQQ, safeFetchBuffer, sendVoiceForV2, sleep, socialV2, syncStickerLibrary, synthesizeVoiceFile, text, ttsBudgetCheck, ttsBudgetCommit, verifyVoiceMessageSent, voiceBudgetCheck, voiceBudgetCommit, voiceCfg, voiceMarkerText, voiceTtsCfg, withTimeout } = deps);
  }

  /**
   * 调 OneBot HTTP API 动作：统一拼接地址、鉴权头、超时与 retcode 校验。
   * 失败抛错（含 426 端口指错的提示），成功返回 `body.data`。
   */
  async function callOneBot(action, params, timeoutMs) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  /**
   * 文字 → 语音条（AI 通道）：合成一句 → 走 sendVoiceV2 的 record 段发出去。
   * 限额、审计、安全闸门全部复用语音库那条链路，失败原因直接抛给模型。
   */
  async function speakVoiceForV2(key, text, { label = '' } = {}) {
    const vc = voiceCfg();
    const tc = voiceTtsCfg();
    if (!tc.enabled) throw new Error('文字转语音未开启（socialV2.voice.enabled / voice.tts.enabled 未开启）');
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('语音文本不能为空');
    if (clean.length > tc.maxChars) {
      throw new Error(`语音文本过长（最多 ${tc.maxChars} 字，当前 ${clean.length} 字），请说短一点`);
    }
    // 可选的「只在被要求时开口」闸门，默认关闭：发不发语音由模型自己判断，
    // 桥接不再猜语义（猜错过太多次）。只有显式 requireAsk=true 时才拦。
    if (tc.requireAsk) {
      const st = getSocialV2State(key);
      const askAt = Number(st.voiceAskAt) || 0;
      const fresh = askAt > 0 && Date.now() - askAt <= tc.askWindowMs;
      if (!fresh) {
        throw new Error('对方这次没有要求语音（socialV2.voice.tts.requireAsk=true 已显式开启），请用文字回复；要发语音得等对方明确说要听/要语音');
      }
    }
    ttsBudgetCheck(key, tc);
    const synth = await synthesizeVoiceFile(clean, tc);
    let sent;
    try {
      voiceBudgetCheck(key, vc);
      sent = await sendVoiceV2(key, synth.file, { guard: true, audit: true });
      voiceBudgetCommit(key);
      ttsBudgetCommit(key);
    } catch (error) {
      try { fs.unlinkSync(synth.file); } catch {}
      throw error;
    }
    // 记成「[语音]正文」而不是调用方传的 label（lite / dsh 这类来源名）：
    // 历史是给模型看的，它需要知道自己上一句说了什么内容。
    recordVoiceSentV2(key, sent, clean ? `[语音]${clean}` : label);
    log(`[voice-tts] ${key} 已发送合成语音「${clean.slice(0, 40)}」（${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice-tts] 合成语音「${clean.slice(0, 40)}」（${sent.detail})`);
    let verification = null;
    if (vc.autoReadback) verification = await verifyVoiceMessageSent(sent.messageId);
    return { ...sent, key, text: clean, voice: tc.voiceName, voiceId: tc.voice, verification };
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // sendVoiceForV2 与控制台语音试发流程里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendQueue.tail = sendQueue.tail.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        resolveSend(await callOneBot(action, params, 60000));
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? getStickerEntries(), stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendQueue.tail = sendQueue.tail.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        sendResolve(await callOneBot(action, params, 15000));
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    const updated = markStickerUsed(getStickerEntries(), entry.id, 'sticker');
    setStickerEntries(updated.entries);
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 出站发图：图片字节已经在桥接侧解析好（见 image-source.js），这里只负责排队 + 发送。
  // 用与表情同一条 sendChain：保证「先文字后图」的真人顺序，也复用整套发送闸门与限频链。
  async function sendImageV2(key, image, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // OneBot 图片段：file 用 base64:// 是最稳的形态（sendStickerV2 已验证过同一条路径），
    // 不依赖网关能不能读到本地路径。
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    let sendResolve; let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendQueue.tail = sendQueue.tail.then(async () => {
      try {
        // 真人在「说完一句」和「掏图」之间会有个停顿，别让图文两条消息紧贴着弹出去。
        await sleep(randInt(600, 1600));
        assertSendAllowed();
        // 图片要经网关转码上传，比纯文本慢得多；4MB 的图给 60s 余量。
        sendResolve(await callOneBot(action, params, 60000));
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    return { messageId: data?.message_id ?? null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendQueue.tail = sendQueue.tail
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendQueue.tail = sendQueue.tail.then(() => sleep(delay));
      }
    }
    return sendQueue.tail.then(() => sent);
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  /**
   * 文字/语音混合发送：某条消息以「[语音]」开头时，把它改成 TTS 合成 + 语音条，
   * 其余消息照旧按文本发。两种片段都经过 sendChain，顺序与调用方给的顺序一致。
   *
   * 为什么在这里拦而不是在路由里：send-burst / send-message / reply 三个入口最后都走这里，
   * 只改一处就能保证「qq_send_message 里混一条语音」这种写法在每个工具上都成立。
   */
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const tc = voiceTtsCfg();
    if (!tc.enabled) return sendTextMessagesV2(key, messages, delays, replyToMessageId, atUserId);
    const parts = [];
    let run = [];
    let hasVoice = false;
    for (const msg of messages) {
      const spoken = voiceMarkerText(tc, msg);
      if (spoken) {
        if (run.length) { parts.push({ type: 'text', items: run }); run = []; }
        parts.push({ type: 'voice', text: spoken });
        hasVoice = true;
      } else {
        run.push(msg);
      }
    }
    if (run.length) parts.push({ type: 'text', items: run });
    if (!hasVoice) return sendTextMessagesV2(key, messages, delays, replyToMessageId, atUserId);
    return (async () => {
      const sent = [];
      const fallbacks = [];
      let delayCursor = 0;
      let firstOutgoingDone = false;
      for (const part of parts) {
        if (part.type === 'text') {
          const useReply = firstOutgoingDone ? null : replyToMessageId;
          const useAt = firstOutgoingDone ? null : atUserId;
          const span = Math.max(0, part.items.length - 1);
          const slice = delays.slice(delayCursor, delayCursor + span);
          delayCursor += span;
          const res = await sendTextMessagesV2(key, part.items, slice, useReply, useAt);
          sent.push(...res);
          firstOutgoingDone = true;
        } else {
          // 语音条本身不支持引用/@（record 段只有音频）：如果第一条就是语音，
          // 引用和 @ 会被丢掉——这是有意的取舍，宁可少一个引用也不要发出畸形消息。
          try {
            await speakVoiceForV2(key, part.text, {});
            // 返回值里保留占位（带标记），让上层能按「成功 N/M 条」正确计数；
            // recordSentMessagesV2 会跳过带标记的条目（语音那条已经在 sendVoiceV2 记过）。
            sent.push(`${tc.marker}${part.text}`);
          } catch (voiceError) {
            // 合成/发送失败不回退成语音，但也不该把这句话弄丢：降级成普通文字发出去。
            // 并在响应里告诉模型「这条本来想发语音、失败改文字了」，它才不会以为对方听到了声音。
            const reason = String(voiceError?.message ?? voiceError).slice(0, 160);
            log(`[voice-tts] ${key} 语音发送失败，降级为文字：${reason}`);
            appendActivity(`${key} [voice-tts] 语音失败，降级文字（${reason}）`);
            try {
              const res = await sendTextMessagesV2(key, [part.text], [], null, null);
              sent.push(...res);
            } catch (textError) {
              log(`[voice-tts] ${key} 降级文字也失败：${textError?.message ?? textError}`);
              voiceError.textFallbackFailed = true;
              throw voiceError;
            }
            fallbacks.push({ text: part.text.slice(0, 60), error: reason });
          }
          firstOutgoingDone = true;
        }
      }
      // 数组上挂元信息（不影响既有 length 计数），路由层会把它写进响应给模型看。
      sent.voiceFallbacks = fallbacks;
      return sent;
    })();
  }

  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st, cfg)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  return { bind, sendVoiceV2, sendStickerV2, sendImageV2, sendBurstToQQ, sendMessagesV2, resolveReplyInfo, resolveReplyTargetV2, computeGapsV2, speakVoiceForV2, replyTimingV2 };
}
