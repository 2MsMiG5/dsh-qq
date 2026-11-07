// record.js — 从 src/bridge.js 抽取的函数簇（13 个函数）。
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

import { GEN1_ROLE_LINE_RE, selectRoleText } from '../role-card.js';
import { text } from '@snowluma/sdk';
import { truncateText, truncateTextTail } from '../md-to-plain.js';
import { sanitizeForwardId } from '../forward.js';
import { touchActiveWindow } from '../lite-chat.js';

export function createSocialRecord() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let REPLY_INFO_TTL_MS, bot, cfg, convertExampleSpacesToComma;
  let getRoleInjectMaxChars, getSocialV2State, log, looksLikeVoiceAsk, readRoleState, readRoleContent, redactKnownTokensOnly;
  let replyInfoCache, resolveReplyInfo, roleContentStamp, sanitizeMediaSummary, sanitizeRoleName, saveSocialV2State;
  let seenForwardIds, voiceMarkerText, voiceTtsCfg;

  // ── 本簇独占的状态：只有这里用，就搬进来 ────────────────────────────────
  // 人格卡缓存：key 为「人格名 + 库内 updated_at」，未变时直接返回，避免每条提示词都查库。
  let roleHintCache = { key: '', raw: '' };
  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要给 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  // replyInfoCache / REPLY_INFO_TTL_MS 留在桥接侧：发送模块（src/send）也在用同一份，
  // 属于跨域容器，按引用交进来，不能在这里重新 new 一个。

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ REPLY_INFO_TTL_MS, bot, cfg, convertExampleSpacesToComma,
       getRoleInjectMaxChars, getSocialV2State, log, looksLikeVoiceAsk, readRoleContent, readRoleState,
       redactKnownTokensOnly, replyInfoCache, resolveReplyInfo, roleContentStamp, sanitizeMediaSummary,
       sanitizeRoleName, saveSocialV2State, seenForwardIds, voiceMarkerText,
       voiceTtsCfg } = deps);
  }

  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName。
      // 而 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让库外的内容被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      // 缓存 key = 人格名 + 库里这一行的更新时间。
      // 名字进 key：切换人格时即使两张卡更新时间巧合相同，也不会误命中旧卡。
      // 时间戳用库的 updated_at 而不是文件 mtime：写入路径统一走 role-store，
      // 每次 update 必然推进 updated_at（毫秒级），不存在「同一秒内改写导致缓存不失效」。
      const stamp = roleContentStamp(safeName);
      if (!stamp) return '';
      const cacheKey = `${safeName}:${stamp}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = readRoleContent(safeName);
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }

  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    const cap = getRoleInjectMaxChars();
    return selected.length > cap ? truncateText(selected, cap) : selected;
  }

  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }

  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // 群聊「唤醒后保持活跃」窗口：窗口内还有人说话就按最新一条续期；已潜水则不动。
    if (String(key).startsWith('group:')) {
      touchActiveWindow(st, Number(cfg.socialV2?.wake?.postWakeActiveMs) || 0);
    }
    // 「对方这次明确要语音」的时间戳：只在显式开启 requireAsk 时有意义（默认已关，
    // 默认情况下发不发语音由模型自己判断，桥接不猜语义）。
    // 记在收消息时而不是唤醒时：唤醒会被繁忙合并/延后，真正那句「发个语音」到那时已经不在了。
    // 只认**别人发来的**消息（isSelf 为 false，这里仍显式判断，避免以后复用本函数时误记）。
    const voiceAskGate = voiceTtsCfg();
    if (voiceAskGate.requireAsk && voiceAskGate.enabled && !msg.isSelf && looksLikeVoiceAsk(`${msg.text} ${msg.plain}`)) {
      st.voiceAskAt = Date.now();
      log(`[voice-tts] ${key} 收到要语音的请求（${msg.sender}）：${msg.text.slice(0, 40)}`);
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  /**
   * lite 直连回复也要进「最近上下文」。
   *
   * 为什么必须记：`sendToQQ` 只负责发出去，不记账。于是直连路径的历史里**只有对方说的话**，
   * 模型每轮都像第一次开口——对方连问「还有呢」，它不知道上一轮已经列过什么，只能把同一批
   * 旧事再念一遍。这就是「AI 一直重复」的机械原因，跟提示词无关。
   */
  function recordLiteSentMessage(key, text) {
    const body = String(text ?? '').trim();
    if (!body) return;
    const st = getSocialV2State(key);
    const now = Date.now();
    st.recentMessages.push({
      sender: '我',
      text: truncateText(body, 200),
      plain: truncateText(body, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      time: now
    });
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    saveSocialV2State();
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    const tc = voiceTtsCfg();
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      // [语音] 条目只是给上层计数用的占位：语音发送已在 sendVoiceV2 里记过一条，
      // 这里再记会在最近消息里出现两条一模一样的「我」，AI 以为自己说了两遍。
      if (tc.enabled && voiceMarkerText(tc, text)) continue;
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  return { bind, roleRawContent, roleHintForMode, currentRoleHint, currentRoleHintV2, pruneGroupMemberNameCache, assertGroupMember, resolveGroupMemberName, pruneReplyInfoCache, isQuoteTargetSelf, appendSocialV2Message, appendSocialV2Poke, recordLiteSentMessage, recordSentMessagesV2 };
}
