#!/usr/bin/env node
// 把新工厂注入审计 harness 的 VM context。
//
// 为什么需要：harness 用 vm 执行 boot() 的源码文本，import 语句在 vm 里不生效，
// 所以每个新模块的工厂都得手工挂到 context 上。漏一步就会在**运行时**炸
// `createXxx is not defined`，而且报错行号指向 boot 开头，看不出缺的是哪个工厂。
//
// 用法：node scripts/wire-harness.mjs createVoiceSend src/voice/send.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [factory, target] = process.argv.slice(2);
if (!factory || !target) {
  console.error('用法：node scripts/wire-harness.mjs <factoryName> <src/xxx.js>');
  process.exit(1);
}

const file = path.join(root, 'scripts/audit-bridge-harness.mjs');
let text = fs.readFileSync(file, 'utf8');
const before = text;

// ① import：插在「最后一个 create* 的 import」之后，保持 import 区聚在一起
if (!new RegExp(`^import \\{[^}]*\\b${factory}\\b`, 'm').test(text)) {
  const imports = [...text.matchAll(/^import .*from '\.\.\/src\/.*';$/gm)];
  const last = imports[imports.length - 1];
  if (!last) throw new Error('找不到任何 ../src 的 import，harness 结构变了');
  const at = last.index + last[0].length;
  text = `${text.slice(0, at)}\nimport { ${factory} } from '../${target}';${text.slice(at)}`;
}

// ② context 注入：挂在 create* 列表末尾（该列表以 `sendQueue,` 结束）
if (!new RegExp(`\\b${factory},`).test(text)) {
  const m = text.match(/createVoiceSend, /);
  if (!m) throw new Error('找不到注入锚点（createVoiceSend,）——harness 结构变了');
  const at = m.index + m[0].length;
  text = `${text.slice(0, at)}${factory}, ${text.slice(at)}`;
}

if (text === before) {
  console.log(`✓ ${factory} 已在 harness 中，无需改动`);
} else {
  fs.writeFileSync(file, text);
  console.log(`✓ 已注入 ${factory}（来自 ${target}）`);
}
