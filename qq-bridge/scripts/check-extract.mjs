// 抽取前体检：给定函数名，输出（1）依赖并集（2）哪些依赖在函数体内被**重新赋值**。
// 被重新赋值的依赖不能按值 bind，必须传 getter/setter，否则改动只落在模块副本上。
//
// 用法：node scripts/check-extract.mjs fn1 fn2 ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lines = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8').split(/\r?\n/);
const coupling = JSON.parse(fs.readFileSync(path.join(root, 'state/coupling.json'), 'utf8'));

const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!names.length) throw new Error('用法：node scripts/check-extract.mjs fn1 fn2 ...');

const deps = new Map();        // 名字 -> { state:bool, call:bool, top:bool, in:[函数] }
const assigned = new Map();    // 名字 -> [函数]（体内被赋值）

for (const n of names) {
  const f = coupling.fn[n];
  if (!f) throw new Error(`找不到函数 ${n}`);
  const from = f.line - 1;
  const to = (f.endLine ?? f.line) - 1;
  const body = lines.slice(from, to + 1).join('\n');
  const add = (list, kind) => {
    for (const d of list ?? []) {
      if (!deps.has(d)) deps.set(d, { state: false, call: false, top: false, in: [] });
      const rec = deps.get(d);
      rec[kind] = true;
      rec.in.push(n);
    }
  };
  add(f.state, 'state');
  add(f.calls, 'call');
  add(f.topFns, 'top');
  // 体内赋值检测：`x = ` 但排除 `==` `=>` `x.y =` 与解构目标
  for (const d of [...(f.state ?? []), ...(f.calls ?? []), ...(f.topFns ?? [])]) {
    const re = new RegExp(`(?<![.\\w$])${d.replace(/\$/g, '\\$')}\\s*=(?![=>])`);
    if (re.test(body)) {
      if (!assigned.has(d)) assigned.set(d, []);
      assigned.get(d).push(n);
    }
  }
}

const siblings = [...deps.entries()].filter(([n]) => coupling.fn[n]);
const externals = [...deps.entries()].filter(([n, r]) => !coupling.fn[n] && r.state);

console.log(`函数 ${names.length} 个，依赖并集 ${deps.size} 项`);
console.log(`\n【同簇兄弟函数 ${siblings.length} 个】不占 bind 名额（会一起搬）`);
console.log('  ' + siblings.map(([n]) => n).join(', ') || '  （无）');
console.log(`\n【外部依赖 ${externals.length} 项】需要 bind`);
for (const [n] of externals) {
  const bad = assigned.get(n);
  console.log(`  ${bad ? '⚠ 可变' : '  只读'}  ${n}${bad ? '  ← 在 ' + bad.join(', ') + ' 里被赋值' : ''}`);
}
const externalCalls = [...deps.keys()].filter((n) => !coupling.fn[n] && !externals.some(([e]) => e === n));
if (externalCalls.length) console.log(`\n【外部函数 ${externalCalls.length} 项】\n  ${externalCalls.join(', ')}`);
