// 重构工具：从 bridge.js 里现有的 bind 调用反推出每个模块的依赖清单。
//
// 为什么用脚本反推而不是手抄：
//   boot 里有 23 处 bind、711 行手写参数表。手工抄成 needs 数组不但慢，而且抄错一个
//   名字的后果是「审计全绿、单条业务路径炸」——这正是前几轮踩过三次的坑
//   （videoLinkApi / safeFetchBuffer / sleep）。机器从同一份源码里抽，不可能抄漏。
//
// 产物：state/wiring-manifest.json
//   {
//     "src/send/index.js": {
//       "factory": "createSendService",
//       "handle": "sendSvc",
//       "bindLine": 3546,
//       "values": ["MAX_MEDIA_BYTES", ...],
//       "getters": { "getCurrentMode": "currentMode" }
//     }, ...
//   }
//
// 用法：node scripts/gen-wiring-manifest.mjs [--out state/wiring-manifest.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcPath = path.join(root, 'src/bridge.js');
const source = fs.readFileSync(srcPath, 'utf8');
const lines = source.split(/\r?\n/);

const outArgIdx = process.argv.indexOf('--out');
const outRel = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : 'state/wiring-manifest.json';

// ── 第一步：工厂名 → 模块路径（从 import 语句拿）────────────────────────────
const factoryToPath = new Map();
for (const line of lines) {
  const m = line.match(/^import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/);
  if (!m) continue;
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (/^create[A-Z]/.test(name)) factoryToPath.set(name, m[2]);
  }
}

// ── 第二步：句柄名 → 工厂名（从 boot 里的 `const xSvc = createX()` 拿）────────
const handleToFactory = new Map();
const handleLine = new Map();
lines.forEach((line, i) => {
  const m = line.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(create[A-Z]\w*)\(\)\s*;/);
  if (!m) return;
  handleToFactory.set(m[1], m[2]);
  handleLine.set(m[1], i + 1);
});

// ── 第三步：解析每处 bind 的参数表 ──────────────────────────────────────────
// 按括号深度切分，避免把 `() => { a, b }` 内部的逗号当成参数分隔符。
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((s) => s.trim()).filter(Boolean);
}

const manifest = {};
for (let i = 0; i < lines.length; i += 1) {
  // 两种写法都要认：多行（bind({ 独占一行）与单行（bind({ a, b }); 一行写完）。
  const multi = lines[i].match(/^\s*([A-Za-z_$][\w$]*)\.bind\(\{\s*$/);
  const single = lines[i].match(/^\s*([A-Za-z_$][\w$]*)\.bind\(\{(.*)\}\);\s*$/);
  if (!multi && !single) continue;
  const handle = (multi ?? single)[1];

  // 收集到本层闭合的 `});` 为止。
  const body = [];
  if (multi) {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\}\);/.test(lines[j])) break;
      body.push(lines[j]);
    }
  } else {
    body.push(single[2]);
  }

  const values = [];
  const getters = {};
  for (const raw of body) {
    // 去掉行尾注释再切；`//` 可能出现在字符串里，但 bind 参数表不会有。
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    for (const part of splitTopLevel(line)) {
      const asGetter = part.match(/^([A-Za-z_$][\w$]*)\s*:\s*\(\s*\)\s*=>\s*(.+?)\s*$/);
      if (asGetter) {
        getters[asGetter[1]] = asGetter[2];
      } else {
        const asValue = part.match(/^([A-Za-z_$][\w$]*)$/);
        if (asValue) values.push(asValue[1]);
      }
    }
  }

  const factory = handleToFactory.get(handle);
  const modPath = factory ? factoryToPath.get(factory) : null;
  if (!modPath) {
    console.error(`⚠️  跳过 ${handle}：找不到工厂 ${factory ?? '?'} 的 import 来源`);
    continue;
  }
  const key = modPath.replace(/^\.\//, 'src/');
  if (manifest[key]) {
    console.error(`⚠️  ${key} 被 bind 了多次（${manifest[key].handle} 与 ${handle}），取最后一次`);
  }
  manifest[key] = { factory, handle, bindLine: i + 1, values, getters };
}

const outPath = path.join(root, outRel);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const totalValues = Object.values(manifest).reduce((n, m) => n + m.values.length, 0);
const totalGetters = Object.values(manifest).reduce((n, m) => n + Object.keys(m.getters).length, 0);
console.log(`已写入 ${outRel}`);
console.log(`模块 ${Object.keys(manifest).length} 个 | 值依赖 ${totalValues} 个 | getter 依赖 ${totalGetters} 个`);
for (const [mod, m] of Object.entries(manifest)) {
  console.log(`  ${mod.padEnd(28)} ${String(m.values.length).padStart(3)} 值 / ${Object.keys(m.getters).length} getter  (bind @${m.bindLine})`);
}
