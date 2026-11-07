// v2-read.js — 二代仿真（reserved2）的「已读水位」原语。
//
// 这四个函数共同维持一件事：**一条未读消息算不算"模型已经读到"了**。
// 判据不是"发给过模型"（发了它可能没读），而是"给过模型看的机会，或者它已经永远
// 看不见了（被 unreadLimit 挤出缓冲区）"。这条区别是整套逻辑存在的理由：
//   · 只看"发过" → 模型从来不打招呼地跳过某条，水位就再也不动，未读数永远不清；
//   · 不看"挤出" → 缓冲区满了之后，早期消息再也推不动水位。
//
// 为什么这里是**纯函数 + 直接 import**，而不是像其它模块那样 createXxx() + bind()：
// 它们只依赖传入的会话状态对象 `st`，不碰任何外部状态、不做 IO、没有可替换的能力。
// 凡是" modules 内部直接 import 会绕开 harness 注入点"的顾虑（见 pump.js 顶部注释）
// 只适用于 fetch / safeFetchBuffer 这类**有副作用的可替换能力**，纯计算不适用。
// 已有先例：mdToPlain / truncateText 就是被直接 import 的。
//
// 原来它们散在 bridge.js 的 boot 闭包里，同时被 v2-store / lite-direct / lite-prompt /
// social-wake 四个模块通过 bind 索取——同一份逻辑在四条依赖链上往返，看不出属于谁。

/**
 * 该会话当前"已经读到哪条"的水位（readThroughSeq）。
 *
 * @param {object} st              会话状态（socialV2.conversations 里的值）
 * @param {Array}  [additional]    额外视为"模型已看过"的 seq 列表（本次候选消息）
 */
export function readThroughSeqV2(st, additional = []) {
  const seen = new Set(st.modelSeenSeqs || []);
  for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
  const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
  const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
  const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
  let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
  // A seq may be reached only when it was offered to the model, or when the buffer
  // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
  // again). Scoping the skip to the real buffer range is what keeps this from ever
  // stepping over a still-pending message.
  const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
  while (through < lastUnread && reachable(through + 1)) through += 1;
  return through;
}

/** 记账"模型看到过哪些消息"，并返回推进后的水位。 */
export function noteModelMessagesV2(st, messages) {
  // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
  const unread = new Set(st.unread.map((m) => m.seq));
  st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
  for (const msg of messages) {
    if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
  }
  return readThroughSeqV2(st);
}

/**
 * 校验外部传入的 throughSeq（控制台/新旧 preset 的翻页游标）。
 * isAgent 的上限更严（必须连续可读），普通调用方允许到 lastUnreadSeq。
 * @throws 带 statusCode=400 的 Error——调用方直接把它转成 HTTP 400。
 */
export function requestedReadThroughSeqV2(st, body, isAgent) {
  if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
  const seq = body.throughSeq;
  const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
    const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
    error.statusCode = 400;
    throw error;
  }
  return seq;
}

/**
 * 确认已读并回收缓冲区。
 * @param {object} st
 * @param {number|null} throughSeq null 表示"全部标记已读"（旧 preset/控制台兼容路径）。
 * @returns {number} 本次被回收的消息条数
 */
export function acknowledgeMessagesV2(st, throughSeq) {
  const before = st.unread.length;
  if (throughSeq === null) {
    // Compatibility for console actions and old presets; new agents pass a cursor.
    st.unread = [];
    st.lastReadThroughSeq = st.lastUnreadSeq;
  } else {
    st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
    st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
  }
  noteModelMessagesV2(st, []);
  return before - st.unread.length;
}
