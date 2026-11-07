// 重构辅助：拆分 HTTP 单体前的可行性体检。
//
// 抽 handler 有两个前提，任何一个不成立，机械拆分都会产出坏代码：
//   1. 每块都以 return / res.end 收尾——否则抽成函数后会「穿过」到下一个路由；
//   2. 块内只依赖 handler 参数与共享上下文——若还引用了请求入口里的局部量，
//      这些量必须先提升成显式依赖。
//
// 用法：node scripts/check-http-split.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lines = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8').split(/\r?\n/);
const blocks = JSON.parse(fs.readFileSync(path.join(root, 'state/http-blocks.json'), 'utf8')).blocks;

// 请求入口（3982-4157）里 6 空格声明的共享局部量：这些是 handler 若直接引用就会炸的坑。
const sharedLocals = [];
// 范围含 startConsoleServer 头部（4 空格）与请求入口（6 空格）两级作用域：
// consoleToken / tokenEq / agentTokenOk / loadDshCatalog 这些都定义在 3925-3981。
for (let i = 3925; i < 4157; i++) {
  const m = lines[i]?.match(/^ {4,6}(?:const|let) ([A-Za-z_$][\w$]*)/);
  if (m) sharedLocals.push(m[1]);
}
// 请求入口的参数与路由分发后才能拿到的常驻量
const ambient = new Set(['req', 'res', 'url', 'sendJson', 'readBody', 'port', 'server', 'cfg', 'log', 'fs', 'path', 'http', 'crypto', 'ROOT', 'STATE_DIR', 'Buffer', 'JSON', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'Date', 'Set', 'Map', 'Promise', 'Error', 'RegExp', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'clearTimeout', 'console', 'structuredClone']);

let tailFail = 0;
const tailBad = [];
let depFail = 0;
const depReport = [];

for (const b of blocks) {
  const body = lines.slice(b.start - 1, b.end);
  const tail = [...body].reverse().find((l) => l.trim() && !l.trim().startsWith('//'))?.trim() ?? '';
  const okTail = /^return\b/.test(tail) || /res\.end\(/.test(tail) || /^}$/.test(tail);
  if (!okTail) { tailFail++; tailBad.push({ ...b, tail }); }

  const text = body.join('\n');
  const used = sharedLocals.filter((name) => new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text));
  if (used.length) { depFail++; depReport.push({ start: b.start, head: b.head.slice(0, 60), used }); }
}

console.log(`语句块总数: ${blocks.length}`);
console.log(`\n[1] 收尾检查：${blocks.length - tailFail}/${blocks.length} 以 return/res.end 结尾`);
for (const b of tailBad) console.log(`  ✗ [${b.start}-${b.end}] 末句: ${b.tail.slice(0, 80)}`);

const unresolved = depReport.filter((r) => r.used.some((n) => !ambient.has(n)));
console.log(`\n[2] 共享局部量：${blocks.length - depFail}/${blocks.length} 块不依赖请求入口局部量`);
console.log(`    依赖方共 ${unresolved.length} 块，涉及 ${new Set(unresolved.flatMap((r) => r.used)).size} 个名字`);
const tally = new Map();
for (const r of unresolved) for (const n of r.used) if (!ambient.has(n)) tally.set(n, (tally.get(n) ?? 0) + 1);
console.log('    名字 -> 被多少块引用：');
for (const [n, c] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`      ${String(c).padStart(3)}  ${n}`);
