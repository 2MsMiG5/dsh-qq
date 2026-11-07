// security-headers.js — 控制台页面与 JSON 响应的统一安全响应头。
//
// 为什么单独成文件：这些头必须**每一个响应**都带上（含 401 / 503 / 204 预检和
// 静态页直出），而响应点分散在 server.js（sendJson / 预检 / 鉴权失败页）与
// routes/（控制台首页直出）两处。桥接还是单文件时这个常量在两个作用域都能看到；
// HTTP 层拆成多文件后，写在请求处理函数**内部**的常量对 routes/ 不可见，
// 于是 `GET /` 直接 500 `SECURITY_HEADERS is not defined`。
//
// 冻结：这是安全策略，不允许任何调用点按引用改写（比如某个接口为了内联第三方
// 脚本偷偷放宽 CSP）。要改策略就改这里，全局一起生效。

export const SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
});
