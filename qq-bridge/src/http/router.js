// HTTP 路由分发。
//
// 两段式匹配：
//   1. 精确路径用 Map 直查（O(1)），覆盖绝大多数端点；
//   2. 动态端（如 /api/persons/<id>）按前缀数组顺序匹配，长前缀优先。
//
// 「命中即调用」：路由表声明了 method + path 之后，handler 内部不再重复
// `if (req.method … url.pathname …)` 做二级判定——命中它的请求就是它唯一该处理的请求。
// 历史上这层二次判定是为了兼容「拆分前 `if` 链兜底」，代价是一次请求要试多个候选、
// 靠响应是否写出判断命中与否；现在声明必须完整，漏声明的路径会直接 404。
// 对账由 scripts/check-route-guards.mjs（npm run check:routes）负责：
// 它同时检查「声明了但没人处理」和「处理了但没声明」两个方向。

/**
 * @param {Array<{method: string, path?: string, paths?: string[], prefix?: string, prefixes?: string[], handler: Function}>} routes
 */
export function createRouter(routes) {
  const exact = new Map();   // `${method} ${pathname}` -> handler
  const prefixes = [];       // { method, prefix, handler }
  const duplicates = [];

  for (const route of routes) {
    const paths = route.paths ?? (route.path ? [route.path] : []);
    const pref = route.prefixes ?? (route.prefix ? [route.prefix] : []);
    for (const p of paths) {
      const key = `${route.method} ${p}`;
      // 同 key 先到先得。重复声明后一条会被静默丢弃，所以这里记下来供对账脚本报警。
      if (exact.has(key)) { duplicates.push(key); continue; }
      exact.set(key, route.handler);
    }
    for (const p of pref) prefixes.push({ method: route.method, prefix: p, handler: route.handler });
  }
  // 长前缀优先：/api/socialV2/send/ 应排在 /api/socialV2/ 之前
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    stats: { exact: exact.size, prefixes: prefixes.length, duplicates },
    /**
     * 返回该请求的处理者；null 表示没有任何路由认领。
     * @param {string} method
     * @param {string} pathname
     * @returns {Function|null}
     */
    match(method, pathname) {
      const hit = exact.get(`${method} ${pathname}`);
      if (hit) return hit;
      for (const p of prefixes) {
        if (p.method !== 'ANY' && p.method !== method) continue;
        if (pathname.startsWith(p.prefix)) return p.handler;
      }
      return null;
    }
  };
}
