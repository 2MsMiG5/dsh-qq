// 重构辅助：分析 bridge.js 装配函数（boot）内部的耦合结构。
// 输出：函数调用图、闭包状态引用矩阵、纯函数簇、强连通分量。
// 用法：node scripts/analyze-coupling.mjs [--json out.json] [--top 20] [--fn 函数名]
//
// 历史说明：B0/B1 之后 main() 只剩 `return boot()`，原先按 main() 定位的算法
// 会算出「0 个内嵌函数」。这里改为定位装配函数（boot，回退到 main），
// 并用大括号平衡求每个函数的真实结束行——旧算法把「下一个函数起点」当结尾，
// 函数之间的注释与普通语句会被算进上一个函数的引用集，导致依赖被高估。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcPath = path.join(root, 'src/bridge.js');
const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);

// ---- 0. 简易词法扫描：跳过字符串、模板串、注释、正则，求括号平衡 ----
// 正则字面量（如 /^\s*$/）按运算符处理；只有以 / 开头且前一个非空白字符是
// 运算符/左括号时才可能是正则，这里用「不进入任何特殊状态」的宽松策略——
// 本仓库的正则里没有裸 `{`/`}`（量词都带内容），因此不会干扰括号计数。
// 递归处理模板字符串里的 `${ ... }`：本文件存在嵌套模板（`` `${a ? `/x` : ''}` ``），
// 简单地把反引号当字符串边界会在内层反引号处提前收尾，随后把 `${}` 当代码扫，
// 括号计数立刻错乱——曾把 formatParticipationV2（35 行）算成 4,747 行。
function findBlockEnd(lines, startIndex) {
  const text = lines.slice(startIndex).join('\n');
  let i = 0;
  let depth = 0;
  let paren = 0;      // 参数列表深度：签名里的默认值 `= {}` 不能被当函数体
  let started = false;
  let prev = '';      // 上一个有意义的字符，用于判定 `/` 是正则还是除号
  // 这些字符之后出现的 `/` 只能是正则字面量的开始
  const regexPreceders = new Set(['', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);

  const skipString = (quote) => {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) { i++; return; }
      i++;
    }
  };
  const skipRegex = () => {
    i++;
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { i++; return; }
      i++;
    }
  };
  const skipTemplate = () => {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { i++; return; }
      if (ch === '$' && text[i + 1] === '{') { i += 2; skipExpression(); continue; }
      i++;
    }
  };
  const skipExpression = () => {
    let d = 0;
    let p = '';
    while (i < text.length) {
      const ch = text[i];
      const nx = text[i + 1];
      if (ch === '/' && nx === '/') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
        continue;
      }
      if (ch === '/' && nx === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      if (ch === "'" || ch === '"') { skipString(ch); p = ch; continue; }
      if (ch === '`') { skipTemplate(); p = '`'; continue; }
      if (ch === '/' && regexPreceders.has(p)) { skipRegex(); p = '/'; continue; }
      if (ch === '{') { d++; p = ch; i++; continue; }
      if (ch === '}') {
        if (d === 0) { i++; return; }
        d--; p = ch; i++; continue;
      }
      if (!/\s/.test(ch)) p = ch;
      i++;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    if (ch === '/' && nx === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && nx === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') { skipString(ch); prev = ch; continue; }
    if (ch === '`') { skipTemplate(); prev = '`'; continue; }
    if (ch === '/' && regexPreceders.has(prev)) { skipRegex(); prev = '/'; continue; }
    if (ch === '(') { paren++; prev = ch; i++; continue; }
    if (ch === ')') { paren--; prev = ch; i++; continue; }
    if (paren > 0) { if (!/\s/.test(ch)) prev = ch; i++; continue; }  // 参数列表里，忽略成对的 { }
    if (ch === '{') { depth++; started = true; prev = ch; i++; continue; }
    if (ch === '}') {
      depth--; prev = ch; i++;
      if (started && depth === 0) {
        // 换算回行号：从 startIndex 起数换行数
        return startIndex + (text.slice(0, i).match(/\n/g)?.length ?? 0);
      }
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return lines.length - 1;
}

// ---- 1. 定位装配函数边界 ----
const bootStart = lines.findIndex((l) => /^export async function boot\s*\(/.test(l));
const mainStart = bootStart >= 0
  ? bootStart
  : lines.findIndex((l) => /^(async )?function main\s*\(/.test(l));
if (mainStart < 0) throw new Error('找不到 boot() / main() 定义');
const mainEnd = findBlockEnd(lines, mainStart);
const scopeName = bootStart >= 0 ? 'boot()' : 'main()';

// ---- 2. 提取内嵌函数（2 空格缩进）与闭包变量 ----
const fnRe = /^  (async )?function ([A-Za-z_$][\w$]*)\s*\(/;
const varRe = /^  (let|const) ([A-Za-z_$][\w$]*)\s*(=|;)/;

const fns = []; // { name, start, end, async }
const closureVars = []; // { name, kind, line }

for (let i = mainStart; i <= mainEnd; i++) {
  const fm = lines[i].match(fnRe);
  if (fm) fns.push({ name: fm[2], start: i, end: null, async: !!fm[1] });
  const vm = lines[i].match(varRe);
  if (vm) closureVars.push({ name: vm[2], kind: vm[1], line: i + 1 });
}
// 每个函数用括号平衡求真实结束行（跨函数之间的注释不再被算进引用集）
for (const f of fns) f.end = findBlockEnd(lines, f.start);

// ---- 3. 构建调用图与变量引用矩阵 ----
const fnNames = new Set(fns.map((f) => f.name));
const varNames = new Set(closureVars.map((v) => v.name));
// 顶层工具（可以被正常 import，不算耦合）——**不能只认 `function`**。
// 顶层还有一批 `const sleep = (ms) => …` / `const videoLinkApi = (() => {…})()` 这类
// 名字，它们同样能被函数体引用到。早先只扫 `function`，于是 `sleep` 这种顶层 const
// 在依赖清单里彻底消失：抽取模块时没人 bind 它，跑起来才 `sleep is not defined`。
const topFns = new Set(
  lines.slice(0, mainStart)
    .map((l) => l.match(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/)
      || l.match(/^(?:export )?(?:const|let|var) ([A-Za-z_$][\w$]*)\s*(?:=|;)/)
      || l.match(/^(?:export )?(?:default )?class ([A-Za-z_$][\w$]*)/))
    .filter(Boolean).map((m) => m[1])
);

const calls = new Map(); // fn -> Set(fn)
const reads = new Map(); // fn -> Set(var)
const externalCalls = new Map(); // fn -> Set(topFn)

// 已迁出模块的导出函数（`const { a, b } = xxxSvc;` 这行解构出来的名字）。
//
// 为什么必须单独认：calls 只统计**还留在 boot 里**的函数。一个函数迁进模块后，
// 留在 boot 的调用方对它的引用就从依赖表里消失了——于是下一次抽取时没人 bind 它，
// 跑起来才 `saveSocialV2State is not defined`（appendMemoryV2 踩过）。
// 把解构出来的名字也当成「可调用依赖」，这类跨模块调用才会被如实记录。
const moduleBound = new Set();
for (const l of lines.slice(mainStart)) {
  const m = l.match(/^\s*const \{([^}]+)\} = [A-Za-z_$][\w$]*;/);
  if (!m) continue;
  for (const part of m[1].split(',')) {
    const name = part.trim().split(/\s*:\s*/).pop();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) moduleBound.add(name);
  }
}

for (const f of fns) {
  const body = lines.slice(f.start, f.end + 1).join('\n');
  const c = new Set();
  for (const other of fnNames) {
    if (other === f.name) continue;
    if (new RegExp(`\\b${other}\\b`).test(body)) c.add(other);
  }
  for (const other of moduleBound) {
    if (c.has(other)) continue;
    if (new RegExp(`\\b${other}\\b`).test(body)) c.add(other);
  }
  calls.set(f.name, c);
  const r = new Set();
  for (const v of varNames) {
    if (new RegExp(`\\b${v}\\b`).test(body)) r.add(v);
  }
  reads.set(f.name, r);
  const e = new Set();
  for (const t of topFns) {
    if (new RegExp(`\\b${t}\\b`).test(body)) e.add(t);
  }
  externalCalls.set(f.name, e);
}

// ---- 4. 无闭包依赖判定 ----
// 不能只统计 `let`：`const social = {...}` 这类对象容器内容同样是可变的，只查 let 会误判。
const mutableVars = new Set(closureVars.map((v) => v.name));
const pure = new Set();
let changed = true;
while (changed) {
  changed = false;
  for (const f of fns) {
    if (pure.has(f.name)) continue;
    const touchesMutable = [...reads.get(f.name)].some((v) => mutableVars.has(v));
    if (touchesMutable) continue;
    const depImpure = [...calls.get(f.name)].some((d) => !pure.has(d));
    if (depImpure) continue;
    pure.add(f.name); changed = true;
  }
}

// ---- 5. Tarjan 强连通分量（找循环依赖簇）----
let idx = 0;
const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
function strongconnect(v) {
  index.set(v, idx); low.set(v, idx); idx++;
  stack.push(v); onStack.add(v);
  for (const w of calls.get(v) ?? []) {
    if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(index.get(v) ?? v) === index.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) sccs.push(comp.sort());
  }
}
for (const f of fns) if (!index.has(f.name)) strongconnect(f.name);

// ---- 6. 输出 ----
const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const topIdx = args.indexOf('--top');
const fnIdx = args.indexOf('--fn');
const topN = topIdx >= 0 ? Number(args[topIdx + 1]) || 15 : 15;

const report = {
  scope: { name: scopeName, startLine: mainStart + 1, endLine: mainEnd + 1, lines: mainEnd - mainStart + 1 },
  // 兼容旧字段名（文档与其它脚本引用过 report.main.*）
  main: { startLine: mainStart + 1, endLine: mainEnd + 1, lines: mainEnd - mainStart + 1 },
  counts: { fns: fns.length, closureVars: closureVars.length, mutableVars: mutableVars.size, pure: pure.size, sccs: sccs.length },
  pureFns: [...pure].sort(),
  sccs,
  // 每个函数的迁移输入：依赖的闭包变量、调用的兄弟函数、可外迁性
  fn: Object.fromEntries(fns.map((f) => [f.name, {
    line: f.start + 1, endLine: f.end + 1, lines: f.end - f.start + 1, async: f.async,
    state: [...reads.get(f.name)].sort(),
    calls: [...calls.get(f.name)].sort(),
    topFns: [...externalCalls.get(f.name)].sort(),
    pure: pure.has(f.name)
  }])),
  fanIn: Object.fromEntries(fns.map((f) => [f.name, [...calls].filter(([, s]) => s.has(f.name)).length])),
  stateRefs: Object.fromEntries(fns.map((f) => [f.name, [...reads.get(f.name)].filter((v) => mutableVars.has(v))])),
  deps: Object.fromEntries(fns.map((f) => [f.name, [...calls.get(f.name)]])),
};
if (jsonIdx >= 0) {
  const out = args[jsonIdx + 1] || path.join(root, 'state/coupling.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`完整数据已写入 ${out}`);
}

// --fn 模式：打印单个函数的迁移清单，供拆分时直接照抄依赖
if (fnIdx >= 0) {
  const name = args[fnIdx + 1];
  const info = report.fn[name];
  if (!info) {
    console.log(`找不到函数 ${name}。可用：${fns.slice(0, 20).map((f) => f.name).join(', ')} …`);
    process.exit(1);
  }
  console.log(`${name}  第 ${info.line}-${info.endLine} 行（${info.lines} 行，${info.async ? 'async' : 'sync'}）`);
  console.log(`纯函数: ${info.pure ? '是' : '否'}`);
  console.log(`\n依赖的状态（${info.state.length}）：\n  ${info.state.join(', ') || '（无）'}`);
  console.log(`\n调用的兄弟函数（${info.calls.length}）：\n  ${info.calls.join(', ') || '（无）'}`);
  console.log(`\n依赖的顶层工具（${info.topFns.length}）：\n  ${info.topFns.join(', ') || '（无）'}`);
  process.exit(0);
}

console.log(`${scopeName}: 第 ${report.scope.startLine}-${report.scope.endLine} 行，共 ${report.scope.lines} 行`);
console.log(`内嵌函数: ${fns.length} 个 | 闭包变量: ${closureVars.length} 个（可变 ${mutableVars.size}）`);
console.log(`纯函数  : ${pure.size} 个（可零风险外迁）`);
console.log(`循环依赖: ${sccs.length} 个强连通分量`);
if (sccs.length) {
  console.log('\n=== 循环依赖簇（拆分时必须整体迁移或打破）===');
  for (const c of sccs.slice(0, 8)) console.log(`  [${c.length} 个] ${c.slice(0, 8).join(', ')}${c.length > 8 ? ' …' : ''}`);
}

console.log(`\n=== 被调用最多的函数（fan-in Top ${topN}）===`);
const byFanIn = Object.entries(report.fanIn).sort((a, b) => b[1] - a[1]).slice(0, topN);
for (const [n, v] of byFanIn) console.log(`  ${String(v).padStart(3)} 次  ${n}`);

console.log(`\n=== 共享状态最多的函数（读可变闭包数 Top ${topN}）===`);
const byState = Object.entries(report.stateRefs).sort((a, b) => b[1].length - a[1].length).slice(0, topN);
for (const [n, v] of byState) console.log(`  ${String(v.length).padStart(2)} 个  ${n}  ->  ${v.slice(0, 5).join(', ')}${v.length > 5 ? ' …' : ''}`);
