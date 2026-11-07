// 控制台/会话令牌的比对工具。
//
// 从 bridge.js 的 startConsoleServer 头部抽出：原来这三个函数捕获 boot 的闭包
// （socialV2 / canonicalV2Key / crypto），抽成工厂后依赖只剩显式参数，
// 也就能单独测「令牌长度不同、内容不同、空值」这些边界。
import crypto from 'node:crypto';

/**
 * 定长比较。`===` 会在首个不同字符处短路，本机进程理论上可用响应时延逐字节试探；
 * 会话令牌同样是凭据，所以和 consoleToken 一样走 timingSafeEqual。
 */
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{socialV2: {conversations: Map}, canonicalV2Key: (key: string) => string|null}} deps
 */
export function createAuthTools({ socialV2, canonicalV2Key }) {
  /** 会话 key 的 agentToken 是否与给定令牌一致 */
  const agentTokenOk = (key, token) => {
    const canonical = canonicalV2Key(key);
    const st = socialV2.conversations.get(canonical ?? key);
    return !!st && !!st.agentToken && tokenEquals(token, st.agentToken);
  };

  /**
   * 令牌是否匹配**任意**一个活跃二代会话。
   *
   * 用途是集中式纵深防御（对应请求入口的 x-agent-call 关卡）：各端点自己那套
   * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
   * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
   * 端点漏写时会整个失效。
   */
  const isLiveAgentToken = (token) => {
    if (typeof token !== 'string' || !token) return false;
    for (const st of socialV2.conversations.values()) {
      if (st?.agentToken && tokenEquals(token, st.agentToken)) return true;
    }
    return false;
  };

  return { agentTokenOk, isLiveAgentToken };
}
