// 数值夹紧的唯一实现。
//
// 收敛前散落 8 份同名同义实现：
//   clampInt  × 6  src/image-source.js、src/media-normalize.js、src/qzone/draft.js、
//                  src/qzone/index.js、src/social/proactive.js、src/video-link.js
//   clampNumber × 2  src/model-client.js、src/social/proactive.js
//
// 其中有两处语义分叉，统一时按「更安全的一种」收口：
//   1. 签名：qzone/draft 与 model-client 用对象参数 { min, max, fallback }，
//      其余用位置参数。统一走位置参数——调用点最多，读起来也最短。
//   2. 空值：model-client 把 undefined / null / '' 直接判成 fallback，
//      proactive 走 Number('') === 0 会夹成区间下界。统一按前者：
//      配置项清空（写成 ""）时应回落到默认值，而不是被静默改成 0
//      （minIntervalMs 被夹成 0 会让调度器空转）。
//   3. 取整：qzone/draft 原先用 Math.trunc，其余用 Math.round。统一 round——
//      「想填 7 个字，配了 7.4」应当靠到 7 而不是被截断成 7 的邻居；实际影响为 0
//      （这几个键都只接受整数配置）。

/**
 * 把任意输入夹到 [min, max]。
 * 缺失（undefined / null / 空串）或非有限值返回 fallback。
 *
 * @param {unknown} value 原始输入，可以是字符串
 * @param {number} min 下界
 * @param {number} max 上界
 * @param {number} fallback 非法输入时的默认值
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 同 clampNumber，但结果四舍五入成整数。
 * 计数、时长档位、配额这类字段必须用这个——小数配额写进 state 只会更难排查。
 *
 * @param {unknown} value 原始输入
 * @param {number} min 下界
 * @param {number} max 上界
 * @param {number} fallback 非法输入时的默认值
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
