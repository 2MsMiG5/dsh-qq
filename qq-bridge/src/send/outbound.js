// outbound.js — 出站文本：审计 → 分段 → 发送链 → 失败标记。
//
// 为什么单独成文件：所有「一句话最终怎么变成 QQ 消息」的规则都在这里，而且它们是**串联**的：
// 敏感信息审计 → 静默标记判定 → 分段 → 串行发送链（带节奏间隔）→ 成功/失败记账。
// 任何一环顺序错都会静默丢消息（当年审计放在分段之后就漏掉了跨段拼接的令牌）。
//
// 状态归属：
//   · lastSendFailed 是本域独占的失败标记（只在这里读写）；
//   · state（sessions 映射）是跨域只读容器，按引用交入 —— 它只在 loadState 时整体替换，
//     而 loadState 早于本模块 bind；
//   · currentMode 是 `let`，必须走取值函数：传值会让「closed-agent 必须带 ownerQQ 前缀」
//     这条规则在切模式后失效。
//
// bind 时机：`bot` 创建之后（boot 后段），早绑会撞 TDZ。
//
// ⚠️ `fetch` 必须走 bind：OneBot HTTP 直连只有这一处，审计 harness 用假 fetch 断言
//    发出的报文并模拟网关离线。用全局 fetch 会绕过桩、真的打网络（表现为 500 unauthorized）。

import http from 'node:http';
import { text } from '@snowluma/sdk';
import { splitForQQ } from '../md-to-plain.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { sendQueue } from '../send/queue.js';

export function createOutboundSend() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let KNOWN_AGENT_TOKENS, SEND_TIMEOUT_MS, appendActivity, bot, cfg, escapeCqText, fetch, getCurrentMode, isSessionAllowedInCurrentMode, lastSendFailed, log, readRoleState, redactKnownTokensOnly, sessionPolicy, sleep, state, withTimeout;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ KNOWN_AGENT_TOKENS, SEND_TIMEOUT_MS, appendActivity, bot, cfg, escapeCqText, fetch, getCurrentMode, isSessionAllowedInCurrentMode, lastSendFailed, log, readRoleState, redactKnownTokensOnly, sessionPolicy, sleep, state, withTimeout } = deps);
  }

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendQueue.tail = sendQueue.tail
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendQueue.tail;
  }

  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  function sendTextMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendQueue.tail = sendQueue.tail
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendQueue.tail = sendQueue.tail.then(() => sleep(d));
      }
    }
    return sendQueue.tail.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (getCurrentMode() === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  return { bind, sendToQQ, lastSendSucceeded, onebotSend, sendTextMessagesV2, shouldAuditKey, captureSendGuard, shouldBlockSilentReply, auditAndSend };
}
