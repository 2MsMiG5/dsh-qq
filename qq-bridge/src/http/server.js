// 控制台 HTTP 服务：请求入口、安全闸门、路由分发、监听。
//
// 由 scripts/build-http-server.mjs 从 src/bridge.js 的 startConsoleServer 生成，
// 依赖全部通过 createConsoleServer(deps) 显式传入——不再读 boot 的闭包。
//
// 分层：
//   入口检查（Host / 令牌 / CSRF）→ 路由分发（routes/*.js）→ 错误兜底
// 任何一步失败都「失败关闭」：宁可 403，也不放行一个没鉴权的管理接口。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRouter } from './router.js';
import { tokenEquals, createAuthTools } from './auth.js';
import { createSocialV2Routes } from './routes/social-v2.js';
import { createPlatformRoutes } from './routes/platform.js';
import { createMediaRoutes } from './routes/media.js';
import { createPersonaRoutes } from './routes/persona.js';
import { createQzoneRoutes } from './routes/qzone.js';
import { createDshRoutes } from './routes/dsh.js';
import { SECURITY_HEADERS } from './security-headers.js';

/**
 * @param {object} deps
 * @param {object} deps.cfg 配置（只读）
 * @param {(msg: string) => void} deps.log 日志
 * @param {string} deps.ROOT 项目根目录（读 public/console.html 用）
 * @param {() => string} deps.loadOrCreateConsoleToken 生成/读取控制台令牌
 * @param {object} deps.socialV2 二代会话状态
 * @param {(key: string) => boolean} deps.isSessionAllowedInCurrentMode
 * @param {() => Promise<any>} deps.loadDshCatalog 读 DSH 模型目录（在途去重）
 * @param {(key: string) => string|null} deps.canonicalV2Key
 * @param {object} deps.routeDeps 各路由模块需要的桥接依赖（不含运行时可变值）
 * @param {() => object} deps.liveValues 读取当前的可变状态快照（每请求调用一次）
 * @returns {import('node:http').Server}
 */
export function createConsoleServer(deps) {
  const {
    cfg, log, ROOT, loadOrCreateConsoleToken,
    socialV2,
    isSessionAllowedInCurrentMode, loadDshCatalog, canonicalV2Key, routeDeps, liveValues
  } = deps;

  const port = cfg.consolePort ?? 3100;
  // 使用 let 以便控制台内手动修改令牌后热更新。
  const configuredToken = String(cfg.consoleToken ?? '').trim();
  const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
  let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
  // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
  // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
  // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
  // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
  // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
  if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
  if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
  if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);

  const { agentTokenOk, isLiveAgentToken } = createAuthTools({ socialV2, canonicalV2Key });
  // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
  const v2SessionAllowed = isSessionAllowedInCurrentMode;
  // 令牌热更新：consoleToken 是本模块的 let，路由侧拿到的只是解构副本，
  // 直接赋值改不到这里。给一个显式 setter，改动才是真的热更新。
  const setConsoleToken = (value) => { consoleToken = value; };

  // 这几个是「HTTP 层自己造的工具」，bridge 侧根本不存在，所以在这里一次性合并，
  // 不塞进 routeDeps —— 那会让桥接层被迫知道控制台内部的鉴权实现。
  const shared = { agentTokenOk, isLiveAgentToken, v2SessionAllowed, loadDshCatalog, setConsoleToken };
  const routes = [
    ...createSocialV2Routes({ ...routeDeps, ...shared }),
    ...createPlatformRoutes({ ...routeDeps, ...shared }),
    ...createMediaRoutes({ ...routeDeps, ...shared }),
    ...createPersonaRoutes({ ...routeDeps, ...shared }),
    ...createQzoneRoutes({ ...routeDeps, ...shared }),
    ...createDshRoutes({ ...routeDeps, ...shared })
  ];
  const router = createRouter(routes);

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
    catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
      res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
      return;
    }
    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify(obj, null, 2));
    };
    const readBody = () => new Promise((resolve, reject) => {
      const MAX_BODY_BYTES = 1_000_000;
      const chunks = [];
      let total = 0;
      let settled = false;
      let bodyTimer = null;
      const fail = (status, message) => {
        if (settled) return;
        settled = true;
        if (bodyTimer) clearTimeout(bodyTimer);
        const err = new Error(message);
        err.statusCode = status;
        reject(err);
      };
      const done = (val) => {
        if (settled) return;
        settled = true;
        if (bodyTimer) clearTimeout(bodyTimer);
        resolve(val);
      };
      // 提前用 Content-Length 拒绝超限请求体
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
      req.on('data', (c) => {
        if (settled) return;
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        total += buf.length;
        if (total > MAX_BODY_BYTES) {
          req.pause();
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        if (settled) return;
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data.trim()) { done({}); return; }
        let parsed;
        try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(400, '请求体必须是 JSON 对象');
          return;
        }
        done(parsed);
      });
      // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
      req.on('error', () => fail(400, '请求体读取失败'));
      req.on('aborted', () => fail(400, '请求体读取中断'));
    });
    // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
    // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
    // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
    if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
    // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
    // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
    // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
    // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
    const hostHeader = String(req.headers.host ?? '');
    // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
    // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
    const boundPort = server.address()?.port ?? port;
    const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
    if (!allowedHosts.includes(hostHeader.toLowerCase())) {
      sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
      return;
    }
    // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
    // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
    // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
    const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
    const tokenMatches = (() => {
      if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
      const a = Buffer.from(suppliedToken, 'utf8');
      const b = Buffer.from(consoleToken, 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    })();
    if (consoleToken && !tokenMatches) {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
      } else {
        sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
      }
      return;
    }
    // AI 工具面已下线：模型现在走 lite 直连 / DSH 轻量会话，不再通过 HTTP 调工具。
    // 任何带 x-agent-* 头的请求一律拒绝（保留控制台令牌这一条鉴权通道）。
    // 历史上这一层是「agent token 白名单 + 管理端隔离」的 confused-deputy 防线；
    // 工具面删除后它没有合法调用方，继续放行只会是一块没人用的攻击面。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: 'AI 工具面已下线：桥接不再接受 agent 调用' }, 403);
      return;
    }
    // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
    // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
    // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
    if (req.method !== 'GET') {
      const ctype = String(req.headers['content-type'] ?? '');
      if (!ctype.toLowerCase().includes('application/json')) {
        sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
        return;
      }
      const origin = req.headers['origin'];
      if (origin) {
        let originHost = '';
        try { originHost = new URL(String(origin)).host; } catch {}
        if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
          sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
          return;
        }
      }
    }
    try {
      // 路由分发：路由表命中的 handler 就是唯一处理者，直接调用。
      // 可变状态每请求取一次最新值：currentMode 之类会在运行中被控制台改掉，
      // 若在工厂创建时解构，快照会让 /api/status 永远报启动时的模式。
      const live = liveValues();
      const handler = router.match(req.method, url.pathname);
      if (!handler) {
        sendJson({ ok: false, error: 'not found' }, 404);
        return;
      }
      await handler({ req, res, url, sendJson, readBody, ...live });
      // 认领了路径却没写响应（例如只做权限闸门的前缀路由）：补 404，别让请求挂起
      if (!res.headersSent && !res.writableEnded) sendJson({ ok: false, error: 'not found' }, 404);
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson({ ok: false, error: error?.message ?? String(error) }, status);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    log(`本地控制台已启动：http://127.0.0.1:${port}`);
  });
  // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
  server.on('error', (error) => {
    log(`控制台服务错误: ${error?.message ?? error}`);
    if (error?.code === 'EADDRINUSE') {
      console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
      process.exit(2);
    }
    process.exit(1);
  });
  return server;
}
