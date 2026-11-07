// 重构辅助：把 startConsoleServer 这个 5,200 行的 HTTP 单体切成可枚举的语句块。
//
// 目的：拆分 HTTP 层时，需要知道「一共多少个顶层语句、每个占多少行、哪些是路由」。
// 手工数不现实，正则数不准（`} else {` 会让行数对不上），所以按缩进切块：
// 该函数体顶层语句一律 8 空格缩进，内部至少 10 空格。
//
// 用法：node scripts/analyze-http.mjs [--json state/http-blocks.json] [--min 20]
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
if (fnStart < 0) throw new Error('找不到 startConsoleServer 定义');
const fnEnd = findBlockEnd(lines, fnStart);

const serverStart = lines.findIndex((l) => /^    const server = http\.createServer/.test(l));
if (serverStart < 0) throw new Error('找不到 http.createServer');
const serverEnd = findBlockEnd(lines, serverStart);

// 路由全部包在请求入口的 `try {` 里（6 空格），块内才升到 8 空格。
// 不先定位这个 try，切块会把 catch 分支里的语句也当成顶层语句。
const tryStart = lines.findIndex((l, i) => i > serverStart && i < serverEnd && /^      try \{$/.test(l));
if (tryStart < 0) throw new Error('找不到路由分发所在的 try 块');
const tryEnd = findBlockEnd(lines, tryStart);
const bodyStart = tryStart + 1;
const bodyEnd = tryEnd - 1;

// 顶层语句：正好 8 空格缩进。`} else {` / `} catch` 不是新语句，是上一条的延续。
const starts = [];
for (let i = bodyStart; i <= bodyEnd; i++) {
  if (!/^ {8}\S/.test(lines[i])) continue;
  const trimmed = lines[i].trim();
  if (!trimmed) continue;
  if (trimmed.startsWith('//')) continue;                        // 独立注释行不是语句
  if (/^\}*[;,)]*$/.test(trimmed)) continue;                     // 纯闭合行归上一块
  if (/^\}\s*(else|catch|finally)\b/.test(trimmed)) continue;     // else/catch 是上一条的延续
  starts.push(i);
}

const blocks = [];
{
  // 动态段识别：`const slangMatch = url.pathname.match(...)` 之后的块不含 url.pathname，
  // 光看首行会被当成守卫。这里跟踪这种「路径匹配结果变量」，引用它的块一律算路由。
  let dynamicVar = null;
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : bodyEnd;
    const head = lines[start].trim();

    const decl = head.match(/^const ([A-Za-z_$][\w$]*)\s*=\s*url\.pathname\.match\(/);
    if (decl) dynamicVar = decl[1];

    // 路由判定：url.pathname 必须紧跟 if——这条规则把 `if (socialV2.paused && req.headers…url.pathname…)`
    // 这类长复合守卫挡在外面（它们曾被误判为路由，导致守卫段被截成 6 行）。
    const routeByHead = /^if \((req\.method === '[A-Z]+' && )?\(?url\.pathname/.test(head);
    const routeByDynamic = dynamicVar && new RegExp(`(?<![.\\w$])${dynamicVar}(?![\\w$])`).test(head);
    const isRoute = routeByHead || !!routeByDynamic;

    const routeMatch = head.match(/if \(req\.method === '([A-Z]+)' && url\.pathname === '([^']+)'\)/)
      || head.match(/if \(req\.method === '[A-Z]+' && \(([^)]*(?:\|\|[^)]*)+)\)\)/);

    blocks.push({
      index: k + 1,
      start: start + 1,
      end: end + 1,
      lines: end - start + 1,
      method: routeMatch?.[1] ?? (head.match(/req\.method === '([A-Z]+)'/)?.[1] ?? ''),
      route: routeMatch?.[2] ?? '',
      isRoute,
      head: head.slice(0, 110)
    });
  });
}

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const minIdx = args.indexOf('--min');
const minLines = minIdx >= 0 ? Number(args[minIdx + 1]) || 20 : 20;

const total = blocks.reduce((s, b) => s + b.lines, 0);
const routes = blocks.filter((b) => b.isRoute);
console.log(`startConsoleServer : 第 ${fnStart + 1}-${fnEnd + 1} 行，共 ${fnEnd - fnStart + 1} 行`);
console.log(`req handler        : 第 ${serverStart + 1}-${serverEnd + 1} 行`);
console.log(`顶层语句           : ${blocks.length} 条，覆盖 ${total} 行`);
console.log(`其中路由语句       : ${routes.length} 条`);
console.log(`非路由语句         : ${blocks.length - routes.length} 条，${blocks.filter((b) => !b.isRoute).reduce((s, b) => s + b.lines, 0)} 行`);

console.log(`\n=== 最大的 ${minLines > 0 ? '' : ''}语句块（Top 20）===`);
for (const b of [...blocks].sort((a, b) => b.lines - a.lines).slice(0, 20)) {
  console.log(`  ${String(b.lines).padStart(4)} 行  [${String(b.start).padStart(5)}]  ${b.head}`);
}

console.log(`\n=== 非路由语句（拆 HTTP 时必须留在骨架里的）===`);
for (const b of blocks.filter((x) => !x.isRoute)) {
  console.log(`  ${String(b.lines).padStart(4)} 行  [${String(b.start).padStart(5)}]  ${b.head}`);
}

console.log(`\n=== 路由按路径前缀分组 ===`);
const groups = new Map();
for (const b of routes) {
  const key = (b.route || '').split('/').slice(0, 3).join('/') || '(空)';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(b);
}
for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(3)} 条  ${key}  (${list.reduce((s, x) => s + x.lines, 0)} 行)`);
}

if (jsonIdx >= 0) {
  const out = args[jsonIdx + 1] || path.join(root, 'state/http-blocks.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ fnStart: fnStart + 1, fnEnd: fnEnd + 1, serverStart: serverStart + 1, serverEnd: serverEnd + 1, blocks }, null, 2));
  console.log(`\n完整清单已写入 ${out}`);
}
