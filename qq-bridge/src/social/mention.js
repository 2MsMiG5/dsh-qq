// mention.js — 「这条消息是不是在跟 AI 说话」的纯文本判定。
//
// 从 src/social/legacy.js 里拆出来的。一代仿真引擎（状态机、观望/活跃/退场、
// 摘要缓冲、5 秒心跳）已于 2026-10-31 整体清退，只有这个判断函数还有别的消费者：
//   - src/mux/ingest.js 用它给唤醒原因分类（question）
//   - src/lite/prompt.js 用它决定提示词里要不要强调「有人在点名问你」
//
// 刻意保持**无依赖的纯函数**：不读 cfg、不碰状态，方便单测，也不会因为将来
// 配置结构变化而失效。

/**
 * 是否"直接针对 AI"的提问/挑战。
 *
 * 覆盖三类表达：
 *   1. 提到 AI 相关词 + 疑问/比较（"deepseek 有这么强吗"）
 *   2. 对"你"开火（"你比它强吗"）
 *   3. 追问/催促（"怎么不说话"）
 *
 * 宁可多判一点：判成「在问 AI」的代价是多回一句，判漏的代价是装死。
 */
export function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：AI 没回时的真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}
