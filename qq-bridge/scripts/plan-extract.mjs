// 重构辅助：在把一个函数簇拆成独立模块之前，算清三件事。
//
// 拆函数簇最容易踩的坑不是「依赖漏了」，而是**接线位置**：
//   · 函数声明会提升，所以原代码可以在声明之前就调用它；
//   · 换成 `const { f } = createX(...)` 之后不再提升，解构发生在哪一行，就要那一行的
//     所有依赖都已初始化（否则 TDZ），同时所有调用点都必须在它之后。
// 位置算错的表现是启动即 `Cannot access 'X' before initialization`，或者偶发 undefined。
//
// 用法：node scripts/plan-extract.mjs fn1 fn2 fn3 ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcPath = path.join(root, 'src/bridge.js');
const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);
const coupling = JSON.parse(fs.readFileSync(path.join(root, 'state/coupling.json'), 'utf8'));

const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!names.length) throw new Error('用法：node scripts/plan-extract.mjs fn1 fn2 ...');

const picked = new Set(names);
const infos = names.map((n) => {
  const f = coupling.fn[n];
  if (!f) throw new Error(`找不到函数 ${n}`);
  return { name: n, ...f };
});

// 状态依赖的声明行号（在 boot 体内 2 空格缩进的 let/const）
const stateDeclLine = new Map();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^  (?:let|const) ([A-Za-z_$][\w$]*)\s*[=;]/);
  if (m && !stateDeclLine.has(m[1])) stateDeclLine.set(m[1], i + 1);
}

const stateUnion = new Map();   // name -> { declLine }
for (const info of infos) {
  for (const s of info.state) {
    if (!stateUnion.has(s)) stateUnion.set(s, { declLine: stateDeclLine.get(s) ?? null });
  }
}

const externalFns = new Set();
for (const info of infos) for (const c of info.calls) if (!picked.has(c)) externalFns.add(c);

// 调用点：本簇外的函数里出现这些名字的行（粗查，含注释，取最小行号）
const firstCallLine = new Map();
for (const name of picked) {
  const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]) && !infos.some((f) => i + 1 >= f.line && i + 1 <= f.endLine)) {
      firstCallLine.set(name, i + 1);
      break;
    }
  }
}

const maxDecl = Math.max(...[...stateUnion.values()].map((v) => v.declLine ?? 0));
const minCall = Math.min(...[...firstCallLine.values()]);

console.log(`函数 ${infos.length} 个，共 ${infos.reduce((s, f) => s + f.lines, 0)} 行`);
console.log(`行区间 ${Math.min(...infos.map((f) => f.line))} - ${Math.max(...infos.map((f) => f.endLine))}`);
console.log(`\n=== 状态依赖（${stateUnion.size}）===`);
for (const [name, v] of [...stateUnion].sort((a, b) => (a[1].declLine ?? 0) - (b[1].declLine ?? 0))) {
  console.log(`  ${String(v.declLine ?? '模块级').padStart(6)}  ${name}`);
}
console.log(`\n=== 外部函数依赖（${externalFns.size}）===`);
console.log('  ' + [...externalFns].sort().join(', '));
console.log(`\n=== 接线约束 ===`);
console.log(`  依赖最晚声明于第 ${maxDecl} 行`);
console.log(`  最早外部调用在第 ${minCall} 行`);
console.log(maxDecl < minCall
  ? `  ✅ 可接线区间 [${maxDecl + 1}, ${minCall - 1}]`
  : `  ⚠️ 无安全区间：需要在第 ${minCall} 行的调用方之前，把相关状态提前声明`);
