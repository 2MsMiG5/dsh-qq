// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
// UNC 的主机/共享名之间只有一个反斜杠；JSON 键名可能带引号。
// 这是内容审计的启发式规则，不能代替会话权限控制或对已知令牌的精确拦截。
//
// 两道内容闸门是**有意互补**的，不是重复实现：
//   ① 这里（启发式）：抓"长得像路径 / 像凭据赋值"的文本，任何一条出站文本都能过；
//   ② KNOWN_AGENT_TOKENS 精确名单（bridge.js）：抓**已知的**会话令牌原文，
//      覆盖 onebotSend / redactKnownTokensOnly 这类刻意不跑 SENSITIVE_RE 的发送路径。
// 为什么第二条不可省：32 位十六进制的裸会话令牌**不匹配**下面的正则（它既不是路径，
// 也没有 token= 这种赋值形态），只有精确名单能拦住它。
// 反过来，**不要**为了让这条正则"顺带"覆盖裸 32-hex 而往里加 [0-9a-f]{32}：
// 表情 md5、图片 URL、消息里的十六进制串本身就是 32-hex，加进去会把正常的表情包与消息
// 整条拦掉/打码（误伤面远大于收益）。要收紧令牌泄漏，请走精确名单那条路。
export const SENSITIVE_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

// 工具调用实参里要打码的键名（全小写比较）。放在这里而不是留在桥接里，
// 是因为它与上面的 SENSITIVE_RE 是同一件事的两面：一个按形状抓，一个按名字抓。
export const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);

/**
 * 精确名单脱敏：把文本里出现的**已知**会话令牌原文换成 `***`。
 *
 * 与上面的 SENSITIVE_RE 是互补的两道闸门，分工见文件顶部注释——这里是第 ② 道。
 *
 * 为什么 `tokens` 要显式传进来而不是做成单例工厂：
 * 令牌集合 (`KNOWN_AGENT_TOKENS`) 是 `const Set`，**引用恒定、只有内容在运行时增删**。
 * 直接把整个 Set 传进来就是安全的共享（同 src/send/queue.js 顶部的规矩：
 * 共享可变状态用同一个对象或取值函数）。本文件因此保持无状态纯函数即可，
 * 不必为了持有这个集合而引入 `createXxx() + bind()` 那一整套接口。
 *
 * @param {string} text
 * @param {Set<string>} tokens 已知令牌集合（内容可变，引用不变）
 */
export function redactKnownTokens(text, tokens) {
  let s = String(text ?? '');
  for (const token of tokens) {
    if (token && s.includes(token)) s = s.split(token).join('***');
  }
  return s;
}
