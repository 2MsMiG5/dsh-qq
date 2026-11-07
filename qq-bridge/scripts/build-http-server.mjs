// 重构工具：把 startConsoleServer 的骨架（鉴权、守卫、监听）生成为 src/http/server.js。
//
// 只搬「与路由无关」的部分：请求入口的前置检查、安全闸门、错误兜底、监听与退出策略。
// 路由本体已由 split-http.mjs 拆到 routes/ 下，这里只负责按顺序调用分发器。
//
// 行文策略：守卫段原样搬运（减 2 空格缩进，因为少了两层函数嵌套），
// 不改写任何判断——这些闸门每一条都对应过真实事故，重写风险远大于收益。
//
// 用法：node scripts/build-http-server.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlockEnd } from './lib/js-scan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// 切块源文件可指定：拆分完成后 bridge.js 里已经没有这段代码了，
// 再对着它重跑生成器会拿到整段漂移的坐标（曾把媒体段当成 slang 端点生成）。
// 传 --src state/.bridge-prehttp.js 可对着 git 里的原文重新生成。
const srcArgIdx = process.argv.indexOf('--src');
const srcPath = srcArgIdx >= 0 ? path.resolve(process.argv[srcArgIdx + 1]) : path.join(root, 'src/bridge.js');
const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);

const fnStart = lines.findIndex((l) => /^  function startConsoleServer\s*\(/.test(l));
if (fnStart < 0) throw new Error('找不到 startConsoleServer');
const serverStart = lines.findIndex((l) => /^    const server = http\.createServer/.test(l));
const tryStart = lines.findIndex((l, i) => i > serverStart && /^      try \{$/.test(l));
const tryEnd = findBlockEnd(lines, tryStart);

// 闸门段只到「第一条路由语句」为止。try 块本身有近 5000 行（整条路由链），
// 直接取到 tryEnd 会把所有路由又抄一遍。
const httpBlocks = JSON.parse(fs.readFileSync(path.join(root, 'state/http-blocks.json'), 'utf8')).blocks;
const firstRoute = httpBlocks.find((b) => b.isRoute);
if (!firstRoute) throw new Error('http-blocks.json 里没有路由语句，先跑 analyze-http.mjs');
const guardsEnd = firstRoute.start - 1;   // 1-based 行号，正好是最后一条闸门块的闭合行

const dedent = (from, to, n) => lines.slice(from, to).map((l) => (l.startsWith(' '.repeat(n)) ? l.slice(n) : l));

const entry = dedent(serverStart + 1, tryStart, 2);           // 请求入口前置检查
const guards = dedent(tryStart + 1, guardsEnd, 2);            // try 内的安全闸门（路由之前）
const tokenBlock = dedent(3927, 3939, 2);                     // 控制台令牌初始化

const out = [];
out.push('// 控制台 HTTP 服务：请求入口、安全闸门、路由分发、监听。');
out.push('//');
out.push('// 由 scripts/build-http-server.mjs 从 src/bridge.js 的 startConsoleServer 生成，');
out.push('// 依赖全部通过 createConsoleServer(deps) 显式传入——不再读 boot 的闭包。');
out.push('//');
out.push('// 分层：');
out.push('//   入口检查（Host / 令牌 / CSRF）→ 安全闸门（agent token 白名单、只读降级）');
out.push('//   → 路由分发（routes/*.js）→ 错误兜底');
out.push('// 任何一步失败都「失败关闭」：宁可 403，也不放行一个没鉴权的管理接口。');
out.push('');
out.push("import fs from 'node:fs';");
out.push("import http from 'node:http';");
out.push("import path from 'node:path';");
out.push("import crypto from 'node:crypto';");
out.push("import { createRouter } from './router.js';");
out.push("import { tokenEquals, createAuthTools } from './auth.js';");
out.push("import { createSocialV2Routes } from './routes/social-v2.js';");
out.push("import { createPlatformRoutes } from './routes/platform.js';");
out.push("import { createMediaRoutes } from './routes/media.js';");
out.push("import { createPersonaRoutes } from './routes/persona.js';");
out.push("import { createDshRoutes } from './routes/dsh.js';");
out.push('');
out.push('/**');
out.push(' * @param {object} deps');
out.push(' * @param {object} deps.cfg 配置（只读）');
out.push(' * @param {(msg: string) => void} deps.log 日志');
out.push(' * @param {string} deps.ROOT 项目根目录（读 public/console.html 用）');
out.push(' * @param {() => string} deps.loadOrCreateConsoleToken 生成/读取控制台令牌');
out.push(' * @param {object} deps.socialV2 二代会话状态');
out.push(' * @param {string} deps.currentMode 当前模式');
out.push(' * @param {boolean} deps.stickerStoreWritable 表情库是否可写');
out.push(' * @param {(key: string) => boolean} deps.isSessionAllowedInCurrentMode');
out.push(' * @param {() => Promise<any>} deps.loadDshCatalog 读 DSH 模型目录（在途去重）');
out.push(' * @param {(key: string) => string|null} deps.canonicalV2Key');
out.push(' * @param {object} deps.routeDeps 各路由模块需要的桥接依赖（不含运行时可变值）');
out.push(' * @param {() => object} deps.liveValues 读取当前的可变状态快照（每请求调用一次）');
out.push(' * @returns {import(\'node:http\').Server}');
out.push(' */');
out.push('export function createConsoleServer(deps) {');
out.push('  const {');
out.push('    cfg, log, ROOT, loadOrCreateConsoleToken,');
out.push('    socialV2, currentMode, stickerStoreWritable,');
out.push('    isSessionAllowedInCurrentMode, loadDshCatalog, canonicalV2Key, routeDeps, liveValues');
out.push('  } = deps;');
out.push('');
out.push('  const port = cfg.consolePort ?? 3100;');
out.push(...tokenBlock);
out.push('');
out.push('  const { agentTokenOk, isLiveAgentToken } = createAuthTools({ socialV2, canonicalV2Key });');
out.push('  // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。');
out.push('  const v2SessionAllowed = isSessionAllowedInCurrentMode;');
out.push('  // 令牌热更新：consoleToken 是本模块的 let，路由侧拿到的只是解构副本，');
out.push('  // 直接赋值改不到这里。给一个显式 setter，改动才是真的热更新。');
out.push('  const setConsoleToken = (value) => { consoleToken = value; };');
out.push('');
out.push('  // 这几个是「HTTP 层自己造的工具」，bridge 侧根本不存在，所以在这里一次性合并，');
out.push('  // 不塞进 routeDeps —— 那会让桥接层被迫知道控制台内部的鉴权实现。');
out.push('  const shared = { agentTokenOk, isLiveAgentToken, v2SessionAllowed, loadDshCatalog, setConsoleToken };');
out.push('  const routes = [');
out.push('    ...createSocialV2Routes({ ...routeDeps, ...shared }),');
out.push('    ...createPlatformRoutes({ ...routeDeps, ...shared }),');
out.push('    ...createMediaRoutes({ ...routeDeps, ...shared }),');
out.push('    ...createPersonaRoutes({ ...routeDeps, ...shared }),');
out.push('    ...createDshRoutes({ ...routeDeps, ...shared })');
out.push('  ];');
out.push('  const router = createRouter(routes);');
out.push('');
out.push('  const server = http.createServer(async (req, res) => {');
out.push(...entry);
out.push('    try {');
out.push(...guards);
out.push('');
out.push('      // 路由分发：候选 handler 依次尝试，直到有响应写出。');
out.push('      // 用「响应是否已写出」判定，而不是 handler 的返回值——');
out.push('      // 原实现里 handler 内部是 `return;`，改成返回值等于改写语义。');
out.push('      // 可变状态每请求取一次最新值：currentMode 之类会在运行中被控制台改掉，');
out.push('      // 若在工厂创建时解构，快照会让 /api/status 永远报启动时的模式。');
out.push('      const live = liveValues();');
out.push('      for (const handler of router.candidates(req.method, url.pathname)) {');
out.push('        await handler({ req, res, url, sendJson, readBody, ...live });');
out.push('        if (res.headersSent || res.writableEnded) return;');
out.push('      }');
out.push('      sendJson({ ok: false, error: \'not found\' }, 404);');
out.push('    } catch (error) {');
out.push('      const status = Number(error?.statusCode) || 500;');
out.push('      sendJson({ ok: false, error: error?.message ?? String(error) }, status);');
out.push('    }');
out.push('  });');
out.push('  server.listen(port, \'127.0.0.1\', () => {');
out.push('    log(`本地控制台已启动：http://127.0.0.1:${port}`);');
out.push('  });');
out.push('  // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启');
out.push('  server.on(\'error\', (error) => {');
out.push('    log(`控制台服务错误: ${error?.message ?? error}`);');
out.push('    if (error?.code === \'EADDRINUSE\') {');
out.push('      console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);');
out.push('      process.exit(2);');
out.push('    }');
out.push('    process.exit(1);');
out.push('  });');
out.push('  return server;');
out.push('}');

const outPath = path.join(root, 'src/http/server.js');
fs.writeFileSync(outPath, out.join('\n') + '\n');
console.log(`已生成 ${outPath}`);
console.log(`入口段 ${entry.length} 行 / 闸门段 ${guards.length} 行 / 令牌段 ${tokenBlock.length} 行`);
