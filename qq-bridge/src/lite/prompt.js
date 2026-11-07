// prompt.js — lite 会话的输入组装：唤醒提示词、历史行、状态快照、控制台便签、人设注入。
//
// 为什么单独成一个文件：buildWakePromptLite 是整条 lite 链路里最长的一段（约 150 行），
// 而它读的东西几乎全是「只读快照 + 若干格式化片段」。把它和真正的引擎（runLiteDirectWake /
// handleLiteTurnEnd）拆开，改提示词时不必再翻几百行状态机，反之亦然。
//
// 输入必须**稳定且可复现**：同一份会话状态 + 同一时刻 → 逐字节相同的提示词。任何
// 随机性（时间、随机 id）都必须从外部传进来，否则「同一轮为什么会这么回」无法复盘。
//
// 状态归属：litePersonaCache（人格卡正文，按 mtime 失效）与 liteRoleInjectedCache
// （本轮已注入角色 key）由本模块独占。selfDisplayName / selfUserId 是 let 且会被改写，
// 走取值函数注入，不能按值传。
import fs from 'node:fs';
import path from 'node:path';
import { extractPresetPrefix } from '../preset-prompt.js';
import { GEN1_ROLE_LINE_RE } from '../role-card.js';
import { truncateText } from '../md-to-plain.js';
import { renderMessageLine as renderMessageLinePure, renderConsoleNotes as renderConsoleNotesPure, activeWindowLeftMs, clockStamp } from '../lite-chat.js';
import { trimHistoryLines } from '../lite-context.js';
import { compactModelMessage, describeAge } from '../qq-model-view.js';
import { readThroughSeqV2 } from '../social/v2-read.js';

// 唤醒原因 → 给模型看的自然语言。裸 token（atMention / activeWindow …）模型读不出
// 「这次为什么醒」，它会拿这个字符串去猜「该回谁」。
const WAKE_REASON_LABELS = Object.freeze({
  private: '对方私聊你',
  anyMessage: '群里又有新消息（全量唤醒）',
  atMention: '有人 @ 了你，或引用/回复了你的消息',
  activeWindow: '活跃窗口里群友还在接着聊',
  nameMention: '有人叫了你的名字',
  question: '有人像在问你问题',
  keyword: '消息命中了唤醒词',
  poke: '有人拍了拍你',
  bootstrap: '第一次唤醒，先看看这个会话',
  timeout: '潜水到点，睁眼看看',
  proactiveCheck: '主动看看大家在聊什么',
  proactivePrivate: '你自己想找 TA 说句话',
  console: '后台操作者写了提醒',
  admin: '管理端唤起',
  probability: '随机参与一下'
});

function wakeReasonLabel(reason) {
  const raw = String(reason ?? '');
  const base = raw.split(':')[0];
  return WAKE_REASON_LABELS[base] ? `${WAKE_REASON_LABELS[base]}（${raw}）` : raw;
}

export function createLitePrompt() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let CONSOLE_NOTE_MAX, CONSOLE_NOTE_MAX_CHARS, CONSOLE_NOTE_TTL_MS, LITE_RULES, ROOT, cfg, convertExampleSpacesToComma, fetchLiteInlineImages, getInitialPrompt, getSocialV2State, getSelfDisplayName, getSelfUserId, initialPromptMaxChars, isDirectedAtAi, liteCachedMediaNote, liteMessageMediaKind, liteStickerChoices, liteStickerIndexText, log, looksLikeVoiceAsk, mediaHintFor, pad2, personFocusProfiles, personFocusText, personMemorySummaryText, prefetchLiteMedia, prepareVideoHint, readRoleState, reverse, roleHintForMode, saveSocialV2State, socialV2, videoHintLine, voiceTtsCfg;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ CONSOLE_NOTE_MAX, CONSOLE_NOTE_MAX_CHARS, CONSOLE_NOTE_TTL_MS, LITE_RULES, ROOT, cfg, convertExampleSpacesToComma, fetchLiteInlineImages, getInitialPrompt, getSocialV2State, getSelfDisplayName, getSelfUserId, initialPromptMaxChars, isDirectedAtAi, liteCachedMediaNote, liteMessageMediaKind, liteStickerChoices, liteStickerIndexText, log, looksLikeVoiceAsk, mediaHintFor, pad2, personFocusProfiles, personFocusText, personMemorySummaryText, prefetchLiteMedia, prepareVideoHint, readRoleState, reverse, roleHintForMode, saveSocialV2State, socialV2, videoHintLine, voiceTtsCfg } = deps);
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  /**
   * lite 专用人格卡：保留角色卡正文（人设/语气/梗），但去掉一代专用指令
   * （[SILENT]/空格分条/自动转发——这些由 lite 系统提示词统一负责），
   * 并把「回复示例」里"空格代表分两条"的说明改写成 lite 的换行分条语义。
   */
  function currentRoleHintLite() {
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中一条消息一行；想发多条就换行）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) inExampleSection = false;
      if (inExampleSection) kept.push(convertExampleSpacesToComma(line));
      else if (!GEN1_ROLE_LINE_RE.test(line)) kept.push(line);
    }
    return kept.join('\n');
  }

  /**
   * 本地时间文本：`2026-10-29 周四 17:54`。
   *
   * 原来只给 `17:54`，模型于是只知道"几点"、不知道"哪一天"：
   * 档案里的时间线是绝对日期（`2026-10-26 …`），没有今天日期就没法换算成「三天前」，
   * 用户问「不是大前天吗」它答不上来；星期几也一并给，省得它自己推。
   */
  function localClockText(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${week} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 本模块独占的两个缓存：人格卡正文（按 mtime 失效）与「本轮已注入角色提示」的 key。
  // 只服务本文件的两条读取路径，桥接侧持有副本只会变成两份各自过期。
  let litePersonaCache = { mtimeMs: 0, text: '' };
  let liteRoleInjectedCache = { key: '' };

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 群聊刷屏时未读会积压成十几分钟的旧账。只把**最新**的 maxUnread 条交给模型：
    // 原来按队列头（最旧）取，醒来第一眼看到的都是二十几分钟前的消息，回的自然也是旧消息。
    // 更早的那部分记进 skippedSeqs：本轮不展示、也明确告诉模型不用回，收尾时按已读处理，
    // 否则已读水位会卡在它们前面，同一批旧消息会一轮一轮反复被端上来。
    const overflow = st.unread.length > maxUnread;
    const queue = overflow ? st.unread.slice(-maxUnread) : st.unread;
    const skippedSeqs = overflow
      ? st.unread.slice(0, st.unread.length - maxUnread).map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0)
      : [];
    // 一次快照只取一次 now：同一批消息的 ago 必须彼此可比。
    const now = Date.now();
    const newestIncoming = [...(Array.isArray(st.unread) ? st.unread : [])].reverse()
      .find((m) => m && !m.isSelf) || null;
    const newestAgo = newestIncoming ? describeAge(newestIncoming.time, now) : '';
    const packet = {
      messages: [],
      recent: [],
      // now / newestAgo 让模型不必自己换算：最新一条多旧，直接写在快照头上。
      now: localClockText(now),
      ...(newestAgo ? { newestAgo } : {}),
      unreadCount: st.unread.length,
      includedUnreadCount: 0,
      readThroughSeq: readThroughSeqV2(st),
      partial: st.unread.length > 0
    };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg, { now }));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    // 只喂最新的那批（内部仍按早→新渲染）；budget 截断时保留最靠前的几条，
    // 被截断的更新消息留在未读里下一轮再给，不会被误标已读。
    for (const msg of queue) if (!tryAdd('messages', msg)) break;
    if (maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    // 只给 seq：已读回执需要它，渲染时不需要（本轮不展示这些旧消息）。
    if (skippedSeqs.length) {
      packet.skippedSeqs = skippedSeqs;
      packet.skippedCount = skippedSeqs.length;
    }
    // 视频链接/分享卡片：把本批消息的视频提示附在快照上。
    // 二代模式不走 mediaHintFor 的提示链（它只服务一代/closed-agent 的即时投递），
    // 不补这一段的话模型在快照里只会看到一条带 URL 的文本，不知道可以调 qq_describe_video。
    // 这里**只读** 60s 缓存（元数据由入库后的 prepareVideoHint 预取），不发任何网络请求。
    if (cfg.video?.enabled !== false) {
      const hints = [];
      for (const msg of [...packet.messages, ...packet.recent]) {
        if (!msg || msg.messageId == null) continue;
        const line = videoHintLine(key, String(msg.text ?? ''), String(msg.messageId));
        if (line && !hints.includes(line)) hints.push(line);
        if (hints.length >= 3) break;
      }
      if (hints.length) packet.videoHints = hints;
    }
    return packet;
  }

  function consoleNoteList(st) {
    const raw = Array.isArray(st?.consoleNotes) ? st.consoleNotes : [];
    return raw.filter((n) => n && typeof n.text === 'string' && String(n.text).trim());
  }

  /**
   * 待注入的提醒：只看有没有过期。
   * `deliveredAt` **不参与过滤** —— 原生附图被拒时 runLiteDirectWake 会重建一次 prompt，
   * 那一次同样该带上提醒（否则模型最终还是没看到它，收尾却把它消费掉了）。
   * 这个字段只用来回答一个问题：本轮跑完之后，哪些可以删。
   */
  function pendingConsoleNotes(key, now = Date.now()) {
    const st = getSocialV2State(key);
    return consoleNoteList(st).filter((n) => !n.expiresAt || now < n.expiresAt);
  }

  function addConsoleNote(key, text) {
    const st = getSocialV2State(key);
    const clean = truncateText(String(text ?? '').replace(/\s+/g, ' ').trim(), CONSOLE_NOTE_MAX_CHARS);
    if (!clean) return null;
    const now = Date.now();
    const list = consoleNoteList(st).filter((n) => !n.expiresAt || now < n.expiresAt);
    if (list.some((n) => String(n.text) === clean)) return null;
    const note = {
      id: `note-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: clean,
      at: now,
      expiresAt: now + CONSOLE_NOTE_TTL_MS
    };
    st.consoleNotes = [...list, note].slice(-CONSOLE_NOTE_MAX);
    saveSocialV2State();
    return note;
  }

  /**
   * 记「这一轮已经把它塞进 prompt 了」，但**先不删**。
   * 模型调用失败时提醒要留着下一轮重投，所以消费推迟到 handleLiteTurnEnd。
   */
  function markConsoleNotesDelivered(key, notes, at = Date.now()) {
    if (!Array.isArray(notes) || notes.length === 0) return;
    const st = getSocialV2State(key);
    const ids = new Set(notes.map((n) => n.id));
    let touched = false;
    for (const note of consoleNoteList(st)) {
      if (ids.has(note.id) && !note.deliveredAt) {
        note.deliveredAt = at;
        touched = true;
      }
    }
    if (touched) saveSocialV2State();
  }

  function clearDeliveredConsoleNotes(key) {
    const st = getSocialV2State(key);
    const list = consoleNoteList(st);
    const now = Date.now();
    const next = list.filter((n) => !n.deliveredAt && (!n.expiresAt || now < n.expiresAt));
    if (next.length === list.length) return;
    st.consoleNotes = next;
    saveSocialV2State();
  }

  function liteHistoryLines(key, unreadSeqs, now, opts = {}) {
    const lite = cfg.socialV2?.liteChat ?? {};
    // 上限 20 → 40：这数字原来和存储层的 context.recentLimit(=15) 撞在一起——会话里只留 15 条，
    // 配置写多少都凑不满，再扣掉本轮未读，真正进 prompt 的历史常常只剩个位数，
    // 模型于是「记不住刚才聊了啥」，只能接着最新一句空泛接梗。
    // 存储侧同步放宽（recentLimit=60）、这里取 36，上限放到 40 只是防呆：配置写大了也不撑爆 prompt。
    const limit = Math.max(0, Math.min(40, Number(lite.historyMessages) || 8));
    if (limit === 0) return [];
    const st = getSocialV2State(key);
    const unreadSet = unreadSeqs instanceof Set ? unreadSeqs : new Set();
    // 只带近端历史：跨越几个小时的消息是另一段对话，硬接上来就是「反复提刚开始的话题」。
    const maxAgeMs = Math.max(5 * 60000, Math.min(24 * 3600000, Number(lite.historyMaxAgeMs) || 2700000));
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && !unreadSet.has(m.seq))
      .filter((m) => {
        const at = Number(m.time);
        return !Number.isFinite(at) || at <= 0 || now - at <= maxAgeMs;
      })
      .slice(-limit);
    // stableStamp：历史行用绝对时刻（23:40），不用「3分钟前」。
    // 历史是提示词里最长的一段，相对时间每轮都会漂一个字，整段就永远命中不了前缀缓存。
    const rawLines = recent.map((m) => renderMessageLinePure(m, { now, describeAge, truncateText, maxChars: 120, stableStamp: true })).filter(Boolean);
    const lines = trimHistoryLines(rawLines, Number(lite.historyMaxChars) || 2400);
    // 历史最后一条与最新未读之间空了很久 → 明确告诉模型这是两段对话。
    const newestUnreadAt = Number(opts.newestUnreadAt);
    const lastHistoryAt = recent.length ? Number(recent[recent.length - 1].time) : NaN;
    if (lines.length && Number.isFinite(newestUnreadAt) && newestUnreadAt > 0 && Number.isFinite(lastHistoryAt) && lastHistoryAt > 0
      && newestUnreadAt - lastHistoryAt > 30 * 60000) {
      lines.push('（上一段对话已经过去很久，上面是旧话题：不要续旧梗，只接最新消息。）');
    }
    return lines;
  }

  function renderLiteMessageLine(msg, now, extra = {}) {
    return renderMessageLinePure(msg, { now, describeAge, truncateText, maxChars: 160, ...extra });
  }

  async function buildWakePromptLite(key, reason, opts = {}) {
    const nativeImages = opts.nativeImages === true;
    const st = getSocialV2State(key);
    const snap = buildWakeSnapshotV2(key);
    const unread = Array.isArray(snap?.messages) ? snap.messages : [];
    // skippedSeqs 也要从「最近上下文」里排掉：它们是本轮明确说「已略过、不用回」的旧未读，
    // 再以历史身份出现在下面等于换个位置把旧账端上来（模型照样会去接）。
    const unreadSeqs = new Set(
      [...unread.map((m) => m.seq), ...(Array.isArray(snap?.skippedSeqs) ? snap.skippedSeqs : [])]
        .filter((seq) => Number.isSafeInteger(seq) && seq > 0)
    );
    // 媒体预取放在拼提示词之前：失败不影响唤醒（只留占位）。
    try {
      await prefetchLiteMedia(key, unread, { nativeImages });
    } catch (error) {
      log(`[lite] ${key} 媒体预取异常：${error?.message ?? error}`);
    }
    // 原生附图：下载本轮图片字节；opts.images 是调用方传进来的数组，函数只负责填。
    let inlineImages = [];
    const imageIndexBySeq = new Map();
    // 归一化说明（动图抽帧/拼图布局）按 seq 存一份：模型看到的是 3×2 拼图，
    // 不告诉它「这是同一张动图的 6 帧、行优先」，它只会描述成一张四分格表情包。
    const imageNoteBySeq = new Map();
    if (nativeImages) {
      try {
        inlineImages = await fetchLiteInlineImages(key, unread, Math.min(3, Number(cfg.socialV2?.liteChat?.maxImagesPerWake) || 1));
        inlineImages.forEach((img, i) => {
          if (!img.seq) return;
          imageIndexBySeq.set(Number(img.seq), i + 1);
          if (img.note) imageNoteBySeq.set(Number(img.seq), String(img.note));
        });
        if (Array.isArray(opts.images)) opts.images.push(...inlineImages);
      } catch (error) {
        log(`[lite] ${key} 原生附图收集失败，改用文字：${error?.message ?? error}`);
      }
    }
    const now = Date.now();
    const parts = [];
    const roleState = readRoleState();
    if (roleState.role) {
      let roleText = '';
      try { roleText = currentRoleHintLite().trim(); } catch (error) { log(`[lite] 读取人格卡失败：${error?.message ?? error}`); }
      parts.push(roleText ? `【当前角色】${roleState.role}\n${roleText}` : `【当前角色】${roleState.role}`);
      // 只在对「角色/长度」变化时打一行：确认人设真的进了提示词（排查"人设不一样"用）。
      if (roleText && liteRoleInjectedCache.key !== `${roleState.role}:${roleText.length}`) {
        liteRoleInjectedCache = { key: `${roleState.role}:${roleText.length}` };
        log(`[lite] 人格注入：${roleState.role}（${roleText.length} 字符）`);
      }
    }
    const identity = selfIdentityTextV2(key).trim();
    if (identity) parts.push(identity);
    // 后台控制端提醒（操作者在控制台写的引导）：位置刻意靠前——它是「这一轮该怎么调整」，
    // 权重该高于人物档案和上下文。注入过的先标记 delivered，等本轮真的收尾再删。
    const consoleNotes = pendingConsoleNotes(key, now);
    const consoleText = renderConsoleNotesPure(consoleNotes, {
      max: CONSOLE_NOTE_MAX,
      maxChars: CONSOLE_NOTE_MAX_CHARS,
      truncateText
    });
    if (consoleText) {
      parts.push(consoleText);
      markConsoleNotesDelivered(key, consoleNotes, now);
    }
    // 人物档案 · 本轮主角：当前说话人的档案正文直接预取进 prompt（B3）。
    // 位置刻意放在纪要与最近历史之前：越靠前权重越高，「这是谁」比「最近聊过啥」更该先被看到。
    const focusProfiles = personFocusProfiles(key, unread);
    const focusIds = focusProfiles.map((profile) => profile.id);
    const focusText = personFocusText(key, unread, focusProfiles);
    if (focusText) {
      parts.push(focusText);
      // 只给「知道什么」不够，还要给「怎么用」：模型拿到一段人生履历会当成要展示的知识。
      parts.push(LITE_RULES.focusUsage);
    }
    // 人物档案名单：只有**置顶**的档案进这里，给标题+摘要，细节按需读。
    // 本轮已预取正文的人不重复列（focusIds），否则同一份内容在一轮里出现两遍。
    const personText = personMemorySummaryText(focusIds);
    if (personText) {
      parts.push(personText);
      parts.push(LITE_RULES.rosterUsage);
    }
    // 首次唤醒带上操作者预写的「初始提示词」（圈子主题/群内氛围），之后不再重复。
    if (reason === 'bootstrap') {
      const initial = formatInitialPromptV2(key);
      if (initial) parts.push(initial);
    }
    const participation = formatParticipationV2(st);
    if (participation) parts.push(participation);
    // 对方明确要语音时，给这一轮开个「可以发语音」的窗——只在显式开启 requireAsk 时才需要。
    try {
      if (voiceTtsCfg().requireAsk) {
        const voiceAsks = unread.filter((m) => m && looksLikeVoiceAsk(String(m.text || m.plain || '')));
        if (voiceAsks.length) {
          st.voiceAskAt = Date.now();
          saveSocialV2State();
        }
      }
    } catch {}
    // 滚动纪要：比历史窗口更早的对话压缩成短句，用来续接长期上下文（每轮只多 ~200 token）。
    // 时间给「整理于 23:31」而不是「10 分钟前」：后者每轮都在变，而它排在历史段**前面**，
    // 一变就把后面的历史整段打进全价重算。这里是整条 prompt 最靠前的那个断点。
    if (st.liteSummary && String(st.liteSummary.text || '').trim()) {
      const stamp = clockStamp(Number(st.liteSummary.updatedAt) || 0, now);
      parts.push(`【对话纪要】（更早的对话已压缩${stamp ? `，整理于 ${stamp}` : ''}；只用于衔接上下文，不要复述纪要本身，也不要把里面记的事当成这轮该回答的问题）
${String(st.liteSummary.text).trim()}`);
    }
    const noteOf = (m) => {
      if (nativeImages && m && liteMessageMediaKind(m) === 'image') {
        const seq = Number(m.seq);
        const idx = imageIndexBySeq.get(seq);
        if (!idx) return '图片（未取到，可能加载失败）';
        const note = imageNoteBySeq.get(seq);
        // 用「｜」而不是括号隔开：renderMessageLine 会把整段 note 再包一层全角括号，
        // 这里再嵌括号就成了「（图1（已直接附上；…））」两层套着，动图说明一长就读不通顺。
        return note ? `图${idx}｜已直接附上；${note}` : `图${idx}｜已直接附上`;
      }
      return liteCachedMediaNote(m);
    };
    // 顺序：**最近上下文 → 未读消息**，不是反过来。
    //
    // 这不只是阅读顺序，是缓存顺序。DeepSeek 的上下文缓存只认「从头逐字节一致的前缀」，
    // 第一处不同之后全部按全价重算。未读消息天生每轮都变，把它放在最近上下文之前，
    // 等于每轮都在最前面砍一刀，后面那几百 token 的历史永远命中不了。
    // 换过来以后：稳定段（人格/档案/纪要/历史）连成一片前缀，只在未读处断开。
    // 附带好处是时间顺序也顺了——先看过往，再看新消息。
    const newestUnreadAt = unread.reduce((max, m) => Math.max(max, Number(m.time) || 0), 0);
    const history = liteHistoryLines(key, unreadSeqs, now, { newestUnreadAt });
    if (history.length) parts.push(`【最近上下文】（只接最新消息，旧话题不要重提）\n${history.join('\n')}`);
    if (unread.length) {
      // 未读也用绝对时刻（stableStamp）：一是同一条消息从「未读」滑进「最近上下文」时
      // 文本不变，模型不会看到同一句话两种写法；二是未读列表是尾部追加的，行文本固定后
      // 前半截还能命中缓存，只有新进来的那几条要重算。
      const lines = unread.map((m) => renderMessageLinePure(m, {
        now, describeAge, truncateText, maxChars: 220, showSeq: true, mediaNote: noteOf, stableStamp: true
      })).filter(Boolean);
      const skippedNote = Number(snap?.skippedCount) > 0 ? `（更早还有 ${snap.skippedCount} 条已略过，不用回、也别提）` : '';
      parts.push(`【未读消息】${skippedNote}（早→新；[#序号] 可用于引用，只引用这里出现过的）\n${lines.join('\n')}`);
    } else if (Number(snap?.skippedCount) > 0) {
      parts.push(`【未读消息】（更早的 ${snap.skippedCount} 条已经略过，本轮没有需要回的新消息）`);
    }
    if (nativeImages && inlineImages.length) {
      // 只有本轮真的附了动图拼图时才讲这段——静态图跟着念一遍等于白烧 token。
      const hasGrid = [...imageNoteBySeq.values()].some((n) => /网格|动图/.test(n));
      const gridRule = hasGrid
        ? '带「网格」说明的是动图抽帧拼成的图：各格是同一张动图按时间顺序抽出的帧（行优先，左上→右下），要当成一张连贯的动图来理解——先看整体在做什么，再看帧与帧之间变了什么；不要当成多张不相干的图，也别只描述其中一格。'
        : '';
      // 「别复述画面」这条是 2026-11-02 加的：群友发图后模型稳定走
      // 「我看到 X，它像 Y」这条最省力的路（实测一轮里连出四句同模板），信息量为零。
      // 图是群友自己发的、他看得见，所以复述画面等于没说；要点是接梗或抓一个具体细节。
      parts.push(`【附图】本轮直接附上了 ${inlineImages.length} 张图，按【未读消息】里「图1…」的顺序对应；你能直接看到图片内容，不要说"看不到图"。但别把画面描述一遍——图是他们自己发的，看得见；除非画面里有关键信息，否则直接对图里的梗、气氛或某个具体细节说一句，不要「这X看着像Y」地复述画面。${gridRule}`);
    }
    // 对话连续性规则是给「有人在说话」的场景写的——「只回应未读消息里最新的内容」
    // 在主动开口时是一条**反向**指令：未读本来就是空的，模型会照字面执行成 [SILENT]。
    // 所以主动私聊换一段规则，而不是往上叠。
    if (String(reason ?? '').split(':')[0] === 'proactivePrivate') {
      parts.push(LITE_RULES.proactiveOpen);
    } else {
      parts.push(LITE_RULES.continuity);
      // 「接哪条」之后的下一问是「接住之后说什么」。没有这一段时，模型把 continuity
      // 执行成「跟着最新一条复读」，于是只有附和、没有判断和提问（管理员 2026-10-31 反馈）。
      parts.push(LITE_RULES.stance);
    }

    // 视频链接的元数据（标题/UP/时长）由入库时预取，这里只带一行，不额外联网。
    const videoHints = Array.isArray(snap?.videoHints) ? snap.videoHints : [];
    if (videoHints.length) {
      parts.push(`【视频线索】\n${videoHints.map((h) => `- ${truncateText(String(h ?? '').replace(/\s+/g, ' '), 160)}`).join('\n')}`);
    }
    const isGroup = String(key).startsWith('group:');
    const lastAi = Number(st.lastAiReplyAt) > 0
      ? `${Math.max(0, Math.round((now - Number(st.lastAiReplyAt)) / 60000))} 分钟前`
      : '无记录';
    // 消息行给的是**发出时刻**而不是「几分钟前」：相对时间每轮都会漂，一漂就把缓存前缀打断。
    // 代价是模型得拿这里的「现在」自己相减，所以这句提示不能省——否则它会以为 23:38 是刚才。
    parts.push(`【状态】${isGroup ? '群聊' : '私聊'} ${key}｜现在 ${localClockText(now)}（消息行开头的时刻＝发出时间，拿它和「现在」相减就是多久以前）｜未读 ${(st.unread || []).length} 条｜你上次发言 ${lastAi}`);
    // 群聊「唤醒后保持活跃」窗口：明确告诉模型现在是「还在聊」的状态，可以自然接话，
    // 但接不上就潜水——窗口到点自动关，不需要它做任何事。
    const activeLeftMs = activeWindowLeftMs(st, now);
    if (activeLeftMs > 0) {
      const minutes = Math.max(1, Math.ceil(activeLeftMs / 60000));
      parts.push(`【活跃窗口】你刚被叫醒，接下来约 ${minutes} 分钟里群友说话都会叫醒你（不用 @ 你）。接得上就自然接一句，接不上、不想接就 [SILENT]；没人说话到点会自动回到潜水。`);
    }
    parts.push(`【唤醒原因】${wakeReasonLabel(reason)}${snap?.partial ? '（快照只含部分未读）' : ''}`);
    const stickerChoices = liteStickerChoices();
    const stickerIndex = liteStickerIndexText(stickerChoices);
    if (stickerIndex) {
      parts.push(`【表情】想发表情就把 [STICKER:编号] 写在一行的最开头（半角冒号），后面可以接文字，例如「[STICKER:3] 好呀」；也可整行只写表情。写在句尾会被当成普通文字原样发出去。每轮最多 2 个：${stickerIndex}`);
    }
    // 除文字/表情/引用外的能力：发图、拍一拍、语音。都是「单独一行指令」，桥接执行。
    if (cfg.socialV2?.image?.enabled !== false) {
      const imgCfg = cfg.socialV2?.image ?? {};
      const rawMaxImages = Number(cfg.socialV2?.liteChat?.maxImagesPerReply);
      const maxImagesPerReply = Math.max(1, Math.min(5, Number.isFinite(rawMaxImages) && rawMaxImages > 0 ? rawMaxImages : 5));
      const perMinute = Math.max(0, Number(imgCfg.maxPerMinute) || 0);
      const perHour = Math.max(0, Number(imgCfg.maxPerHour) || 0);
      const minBookmarks = Math.max(0, Number(imgCfg.minBookmarks) || 0);
      // 桥接只管客观闸门：发图频率、Pixiv 作品的收藏数、年龄分级。发不发、发几张归模型判断——
      // 原来写「每轮最多 1 张，别刷屏，别连续发」等于替它做主，越劝它越只敢发一张。
      const gates = [
        perMinute > 0 || perHour > 0
          ? `频率（${[perMinute > 0 ? `每分钟 ${perMinute} 张` : '', perHour > 0 ? `每小时 ${perHour} 张` : ''].filter(Boolean).join('、')}）`
          : '',
        minBookmarks > 0 ? `Pixiv 作品收藏数 ≥ ${minBookmarks}` : '',
        // 这条不是劝它自律，是告知事实：R-18 一定会被桥接拦掉，别白写一次 [IMAGE]。
        imgCfg.allowR18 === true ? '' : '只发全年龄作品（R-18 会被桥接挡掉）'
      ].filter(Boolean);
      // 两种写法按「对方说没说要什么」来分，不是按「哪种图更好看」。
      // 实测模型会把「随便来三张」理解成「我得挑个题材」，然后自己编关键词去 Pixiv 搜
      // （真实案例：[IMAGE:蓝发少女] [IMAGE:鲸鱼娘]）——所以这条必须写成明确的二选一规则。
      parts.push(`【发图】两种写法，看对方有没有说要什么：
· 只说要图、没指定内容（「发点图」「随便来三张」「来几张」）→ 全部写裸 [IMAGE]，桥接从现成图库（几千张存图）随机发，别自己编关键词；
· 说了想看什么（「发张猫」「来张风景」）→ 写 [IMAGE:关键词]（去 Pixiv 搜，关键词 1–6 个字）。
一轮最多 ${maxImagesPerReply} 张${gates.length ? `，桥接只卡${gates.join('、')}` : ''}。发不发、发几张你自己判断，别为了凑数发。`);
      // 「自己的照片」单列一条：它和 [IMAGE] 的区别是**图从哪来**，不是发几张。
      // 只在对方明确要照片/自拍时用；「随便来几张」里塞自拍算凑数，也不是对方要的东西。
      // 要是拿 [IMAGE:关键词] 去搜一张别人的画当自己，一眼就假，比不发更糟。
      parts.push('【自己的照片】只有对方明确要你的照片、自拍，或问你「你长什么样」时，才写 [SELFIE]（桥接从「当前人格」的自拍图库里挑一张，不用写关键词）。[SELFIE] 单独占一行最稳，写在句子里也能识别；对方只是「随便来几张图」时用裸 [IMAGE]，别拿自拍凑数；也别用 [IMAGE:关键词] 搜别人的图冒充自己。');
    }
    parts.push('【拍一拍】想戳对方一下（手贱/提醒/逗一下）就单独一行写 [POKE]；每轮最多 1 次，别频繁。');
    try {
      const tc = voiceTtsCfg();
      if (tc.enabled) {
        parts.push(`【语音】想用声音说一句就单独一行写 [VOICE] 要说的内容（不超过 ${tc.maxChars} 字）；发不发你自己判断，语气合适、这句话适合用声音说就用，不必等对方要。桥接只限频率（每分钟 ${tc.maxPerMinute} 条、每小时 ${tc.maxPerHour} 条），别连着刷。`);
      }
    } catch {}
    const maxMessages = Math.max(1, Math.min(8, Number(cfg.socialV2?.liteChat?.maxMessages) || 2));
    // 群聊的「来回」是靠两句撑起来的：一句接住话头，一句给判断。原来对群聊也写死
    // 「默认只发 1 条」，模型于是每轮只丢一句就走，接不上也接不下去（2026-11-02 改）。
    // 私聊保持原样：对方在等一个回答，一次说完比切成两条更像对话。
    const volumeRule = isGroup
      ? '**群聊默认 1 条，接得住就说 2 条**——前一条接住对方，后一条补自己的判断或反问，别把一句话拆两半凑数'
      : '**默认只发 1 条**，确实需要追问或补充时才发第 2 条';
    // [WAKE:x] 只在私聊生效：群聊的 wakeConfig.mode 恒为 'diving'（见 lite-chat.js 的
    // liteWakeConfig），handleLiteTurnEnd 会直接丢掉这条指令。提示词按会话类型分开教，
    // 群里说了等于让模型以为自己调节了节奏，实际什么也没发生。
    const wakeRule = isGroup
      ? ''
      : '；最后可选一行 [WAKE:30m]（这段时间除非有人叫你，别叫醒我）';
    parts.push(`【输出】只输出要发到 QQ 的消息，一行一条；${volumeRule}，最多 ${maxMessages} 行；每行一句完整的话，不要把一个意思拆成多条；不想说话只输出 [SILENT]；引用某条消息就在行首写 [QUOTE:序号]（只能引用本轮【未读消息】里出现过的 [#序号]，别引用更早的旧消息）${wakeRule}。不要解释、不要 Markdown。`);
    return parts.join('\n\n');
  }

  function liteSystemPrompt() {
    const preset = cfg.socialV2?.liteChat?.preset || 'qq-chat-lite';
    const file = path.join(ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
    try {
      const stat = fs.statSync(file);
      if (litePersonaCache.mtimeMs !== stat.mtimeMs || !litePersonaCache.text) {
        const prefix = extractPresetPrefix(fs.readFileSync(file, 'utf8'));
        if (!prefix) throw new Error('preset 里没有 persona.prefix');
        const model = cfg.socialV2?.liteChat?.model || cfg.dsh?.model || 'deepseek-flash';
        litePersonaCache = {
          mtimeMs: stat.mtimeMs,
          text: String(prefix)
            .replace(/\{\{model\}\}/g, model)
            .replace(/\{\{provider\}\}/g, cfg.dsh?.provider || 'deepseek-official')
        };
      }
      return litePersonaCache.text;
    } catch (error) {
      log(`[lite-direct] 读取人设失败（用兜底人设）：${error?.message ?? error}`);
      return '你是 DeepSeek 的鲸鱼（小鲸鱼），在 QQ 里和群友聊天。只输出要发到 QQ 的消息，一行一条；不想说话只输出 [SILENT]。';
    }
  }

  // 机器人自己的身份（昵称 + QQ 号 + 本群群名片）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。
  // 更隐蔽的一层：群里 @ 人显示的是**群名片**，不是账号昵称。实测这台机器人昵称
  // 「祈愿冬不寒」、群名片「秋」，而旧版只写昵称 —— 「@秋 笨鱼，这是猫吗？」在它眼里
  // 就是别人在叫别人，于是「分不清哪句是对它说的」。群名片缓存在 st.selfGroupCard，
  // 由入站消息解析后写入（见 mux/ingest.js）。
  function selfIdentityTextV2(key = '') {
    const name = String(getSelfDisplayName() || '').trim();
    const id = String(getSelfUserId() || '').trim();
    if (!name && !id) return '';
    let card = '';
    try {
      if (String(key).startsWith('group:')) card = String(getSocialV2State(key).selfGroupCard || '').trim();
    } catch { card = ''; }
    if (card && card === name) card = '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const cardText = card
      ? `当前群里的群名片是「${card}」—— 别人 @ 你、引用你时显示的是这个群名片，不是昵称；`
      : '群名片可能与昵称不同；';
    const callBits = name
      ? `消息里出现「@${name}」${card ? `、「@${card}」` : ''}、有人叫你 ${name}${card ? ` 或 ${card}` : ''}、或引用你的消息`
      : `被 @、被叫到你的昵称${card ? `或群名片「${card}」` : ''}、或引用你的消息`;
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${cardText}${callBits}，指的都是你 —— 不要当成别人。at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  return { bind, buildWakePromptLite, liteHistoryLines, renderLiteMessageLine, buildWakeSnapshotV2, localClockText, currentRoleHintLite, selfIdentityTextV2, formatParticipationV2, formatInitialPromptV2, consoleNoteList, pendingConsoleNotes, addConsoleNote, markConsoleNotesDelivered, clearDeliveredConsoleNotes, liteSystemPrompt };
}
