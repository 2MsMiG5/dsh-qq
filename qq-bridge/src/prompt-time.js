// prompt-time.js — 给投递给模型的提示词加「当前时间」前缀。
//
// 这段逻辑原本混在黑话上下文注入函数里，黑话功能移除后单独拆出来。时间行必须保留：
// 模型没有别的时间来源，缺了它会把几天前的消息当成刚刚发生的。
//
// 只做前缀拼接，不读任何配置、不碰任何状态——注入顺序由调用方决定。

export function withTimeContext(promptText) {
  const now = new Date();
  const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
  return `${timeLine}\n\n${promptText}`;
}
