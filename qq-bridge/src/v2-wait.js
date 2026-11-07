// 二代仿真模式：等待/结束回合相关的轻量判断工具。
// 这些是“提示/软信号”，不是硬规则；最终是否等待、是否发催话仍由 AI 自主决定。

// 常见“话说一半/没说完”的结尾特征。
const UNFINISHED_TAIL_RE = /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;

// 以中文逗号/顿号/分号/冒号等“非终止标点”结尾，也常表示还没说完。
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;

// 明确以终止标点/省略号结尾的消息视为说完。
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

export function looksLikeUnfinished(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (FINISHED_TAIL_RE.test(s)) return false;
  if (UNFINISHED_TAIL_RE.test(s)) return true;
  if (UNFINISHED_PUNCT_RE.test(s)) return true;
  return false;
}

// AI 等不到下文时可以用的“催话”短句。
export const UNFINISHED_PROMPT_REPLIES = ['什么', '啥', '你说啊', '然后呢', '？'];

// 建议的“结束前再等一轮”的等待时长范围（毫秒）。
export const END_ROUND_WAIT_MIN_MS = 5 * 60 * 1000;
export const END_ROUND_WAIT_MAX_MS = 10 * 60 * 1000;

/**
 * 建议这一轮回复前再等多久（毫秒）：对方明显还没说完、或者正在连发，就多给一点时间。
 *
 * `cfg` 显式传进来而不是 bind 进来：它只是读一个配置数字，做成纯函数就能让两个
 * 调用方（src/send/index.js 与 src/http/routes/social-v2.js）直接 import，
 * 免掉一条只为带 cfg 而存在的依赖注入链。
 *
 * @param {object} st   会话状态；传空直接用默认值
 * @param {object} cfg  全局配置（读 socialV2.wait.defaultQuietMs）
 */
export function suggestQuietMsV2(st, cfg) {
  const defaultMs = Number(cfg?.socialV2?.wait?.defaultQuietMs) || 8000;
  if (!st) return defaultMs;
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return defaultMs;
  const text = String(last.tail || last.plain || last.text || '').trim();
  if (looksLikeUnfinished(text)) return 12000;
  const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
  if (burst >= 3) return 12000;
  return defaultMs;
}
