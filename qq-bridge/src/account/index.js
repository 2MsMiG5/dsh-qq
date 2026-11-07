// index.js — 账号侧的两件运维事：好友申请处理、SnowLuma 令牌自愈。
//
// 为什么这两件事放一起：它们都由「机器人账号处于异常状态」触发 —— 有人要加好友，
// 或者令牌过期导致 401 / 1006 断线。两条路径都要落盘、都要通知管理员，
// 而且都在 bot 事件回调的最内层，出错必须自己兜住，不能把整个桥接拖挂。
//
// 好友申请：记录 -> 通知管理员 -> 管理员回「同意/拒绝 QQ号」-> 批复。
// 记录留 24 小时，过期自动丢弃（人不会隔天再想起来批）。
//
// 令牌自愈：SnowLuma 换令牌后，config.json 的 accessToken（HTTP 用）与 bot.accessToken
// （WS 用）必须**同时**更新。只修一个的后果是桥接以 1006 反复重连，实测踩过。
import fs from 'node:fs';
import path from 'node:path';
import { text } from '@snowluma/sdk';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from '../snowluma-conn.js';

export function createAccountGuard() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let FRIEND_APPROVE_RE, FRIEND_REJECT_RE, FRIEND_REQUEST_FILE, FRIEND_REQUEST_TTL_MS, ROOT, appendActivity, atomicWriteJson, bot, cfg, convKey, friendRequests, log, readConfigObject, reconcileSessionPolicies, sendToQQ, withTimeout;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ FRIEND_APPROVE_RE, FRIEND_REJECT_RE, FRIEND_REQUEST_FILE, FRIEND_REQUEST_TTL_MS, ROOT, appendActivity, atomicWriteJson, bot, cfg, convKey, friendRequests, log, readConfigObject, reconcileSessionPolicies, sendToQQ, withTimeout } = deps);
  }

  function saveFriendRequests() {
    try {
      atomicWriteJson(FRIEND_REQUEST_FILE, [...friendRequests.values()]);
    } catch (error) {
      log('保存好友申请失败:', error?.message ?? error);
    }
  }

  function loadFriendRequests() {
    try {
      const raw = JSON.parse(fs.readFileSync(FRIEND_REQUEST_FILE, 'utf8'));
      const now = Date.now();
      for (const rec of Array.isArray(raw) ? raw : []) {
        const userId = Number(rec?.userId);
        if (!Number.isSafeInteger(userId) || userId <= 0 || !rec?.flag) continue;
        // 超过 24h 的申请：fail-soft 丢弃（OneBot 侧的 flag 通常也早过期了）
        if (now - Number(rec.at ?? 0) > FRIEND_REQUEST_TTL_MS) continue;
        friendRequests.set(userId, {
          flag: String(rec.flag),
          userId,
          nickname: String(rec.nickname ?? ''),
          comment: String(rec.comment ?? ''),
          at: Number(rec.at ?? now)
        });
      }
      if (friendRequests.size > 0) log(`恢复了 ${friendRequests.size} 条待处理好友申请`);
    } catch {}
  }

  function parseFriendDecision(text) {
    const m = /^(.+?)\s*(\d{5,12})$/.exec(String(text ?? '').trim());
    if (!m) return null;
    const userId = Number(m[2]);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    const word = m[1].replace(/\s+/g, '');
    if (FRIEND_APPROVE_RE.test(word)) return { approve: true, userId };
    if (FRIEND_REJECT_RE.test(word)) return { approve: false, userId };
    return null;
  }

  async function notifyOwnerFriendRequest(rec) {
    const ownerQQ = Number(cfg.ownerQQ ?? 0);
    if (!ownerQQ) {
      log(`⚠️ 收到好友申请 ${rec.userId}，但未配置 ownerQQ，无法转给管理员裁决（申请已落盘，可手工处理）`);
      return;
    }
    const ownerKey = convKey('private', String(ownerQQ));
    const who = rec.nickname ? `${rec.nickname}（${rec.userId}）` : String(rec.userId);
    const lines = [
      '📨 收到好友申请',
      `申请人：${who}`,
      `验证消息：${rec.comment || '（无）'}`,
      `待处理共 ${friendRequests.size} 条`,
      `回复「同意 ${rec.userId}」或「拒绝 ${rec.userId}」`
    ];
    try {
      await sendToQQ(ownerKey, lines.join('\n'));
    } catch (error) {
      log('通知管理员好友申请失败:', error?.message ?? error);
    }
  }

  async function applyFriendDecision({ approve, userId }, replyKey) {
    const rec = friendRequests.get(userId);
    if (!rec) {
      await sendToQQ(replyKey, `没有来自 ${userId} 的待处理好友申请。`);
      return;
    }
    try {
      await withTimeout(bot.call('set_friend_add_request', { flag: rec.flag, approve }), 10000, 'set_friend_add_request');
    } catch (error) {
      log(`处理好友申请 ${userId} 失败: ${error?.message ?? error}`);
      await sendToQQ(replyKey, `⚠️ 处理失败：${error?.message ?? error}（申请仍保留，可直接重试）`);
      return;
    }
    friendRequests.delete(userId);
    saveFriendRequests();
    appendActivity(`好友申请 ${userId} 已由管理员${approve ? '同意' : '拒绝'}`);
    log(`好友申请 ${userId}：${approve ? '已同意' : '已拒绝'}`);
    const label = rec.nickname ? `${rec.nickname}（${userId}）` : String(userId);
    if (!approve) {
      await sendToQQ(replyKey, `❌ 已拒绝 ${label} 的好友申请。`);
      return;
    }
    // 同意后自动加入私聊白名单（可在 config.json 的 autoAllowApprovedFriends 关掉或改成只提醒）。
    const allowResult = approve ? autoAllowFriend(userId) : null;
    await sendToQQ(replyKey, allowResult?.added
      ? `✅ 已同意 ${label} 的好友申请，并已把它加入私聊白名单（allow.private）——现在可以直接私聊对话了。`
      : allowResult?.reason
        ? `✅ 已同意 ${label} 的好友申请。\n⚠️ 但没有自动加白名单：${allowResult.reason}`
        : `✅ 已同意 ${label} 的好友申请。`);
  }

  /**
   * 把刚通过的好友加入私聊白名单并落盘 config.json。
   * 三种不写的情况（都返回 reason，让回复说实话，不静默）：
   *   · deny.private 命中 —— 黑名单优先，绝不因为通过好友就绕过它；
   *   · allowAllWhenEmpty + 白名单为空 —— 现在本来就全放行，写进去反而会收窄成「只放行这一人」；
   *   · allow.private 里已有 —— 幂等，不重复写。
   */
  function autoAllowFriend(userId) {
    let file;
    try {
      file = readConfigObject(path.join(ROOT, 'config.json'));
    } catch (error) {
      return { added: false, reason: `读 config.json 失败（${error?.message ?? error}）` };
    }
    if (file.autoAllowApprovedFriends === false) {
      return { added: false, reason: 'autoAllowApprovedFriends=false（按配置只提醒、不自动加白名单）' };
    }
    const denyPrivate = (file.deny?.private ?? cfg.deny?.private ?? []).map(String);
    if (denyPrivate.includes(String(userId))) {
      return { added: false, reason: `${userId} 在 deny.private 黑名单里（黑名单优先）` };
    }
    const current = (file.allow?.private ?? cfg.allow?.private ?? []).map(Number).filter((n) => Number.isFinite(n));
    if (current.includes(Number(userId))) {
      return { added: false, reason: '它已经在私聊白名单里了' };
    }
    if (current.length === 0 && file.allowAllWhenEmpty !== false) {
      return { added: false, reason: '当前 allowAllWhenEmpty=true 且白名单为空，写进去会把放行范围收窄成只有它' };
    }
    const next = [...current, Number(userId)];
    try {
      file.allow = { ...(file.allow ?? {}), private: next };
      atomicWriteJson(path.join(ROOT, 'config.json'), file);
    } catch (error) {
      return { added: false, reason: `写 config.json 失败（${error?.message ?? error}）` };
    }
    cfg.allow = { ...(cfg.allow ?? { private: [], groups: [] }), private: next };
    try { reconcileSessionPolicies(); } catch {}
    log(`好友 ${userId} 已通过，并加入私聊白名单（allow.private 现为 ${next.join(',')}）`);
    return { added: true };
  }

  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken 供 HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  // 令牌自愈的节流时间戳：只服务 healTokenIfStale，桥接侧不需要知道。
  let tokenHealAt = 0;

  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  return { bind, saveFriendRequests, loadFriendRequests, parseFriendDecision, notifyOwnerFriendRequest, applyFriendDecision, autoAllowFriend, applyHealedTokens, syncTokenToFile, healTokenIfStale };
}
