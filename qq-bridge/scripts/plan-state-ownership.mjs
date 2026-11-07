// 重构辅助：把 main() 的 137 个闭包声明分配到目标模块。
// 判据：看哪些函数引用它，再按函数名的领域前缀投票，取票数最高者。
// 用法：node scripts/plan-state-ownership.mjs [--md out.md]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const coupling = JSON.parse(fs.readFileSync(path.join(root, 'state/coupling.json'), 'utf8'));
const lines = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8').split('\n');

const DOMAIN_RULES = [
  ['social/wake', /^(wake|evaluateWake|scheduleWake|sendWake|buildWake|ackLite|replayPending|setupSleep|ensureWake|proactive|isConversationBusy|v2Turn|turnLease)/i],
  ['social/lite', /^(lite|runLite|handleLite|parseLite)/i],
  ['social/ingest', /^(handleIncoming|appendSocial|acknowledge|noteModelMessages|recordSent|renderMessageLine|compactModelMessage)/i],
  ['social/mux', /^(pumpMux|recordSessionSnapshot)/i],
  ['social/send', /^(sendToQQ|sendSticker|sendImage|sendVoice|auditAndSend|captureSendGuard|assertOutbound)/i],
  ['person', /^(person|profile|applyPersonOps|currentPersonTarget|defaultPersonTarget)/i],
  ['sticker', /^(sticker|emoji|collectSticker|getStickerImageData)/i],
  ['slang', /^(slang|ensureSlangLearner|learnSlang)/i],
  ['voice', /^(voice|tts|ttsService|resolveVoicePath)/i],
  ['media', /^(image|video|media|vision|fetchMedia|resolveMedia|prepareVideo|fetchOneBotImage|acceptImageBuffer|getImageDimensions)/i],
  ['dsh/session', /^(dsh|session|rediscover|ensureSession|reconcile|retire|stopRetired|refreshMode|modeAllowed|applyWakeConfig)/i],
  ['role/preset', /^(role|preset|regenerate|backupPreset)/i],
  ['http', /^(startConsole|consoleNote|clearDeliveredConsoleNotes)/i],
  ['token', /^(token|heal|applyHealed)/i],
];
function domainOf(fnName) {
  for (const [d, re] of DOMAIN_RULES) if (re.test(fnName)) return d;
  return 'core';
}

// 反向索引：闭包变量 -> 引用它的函数
const owners = new Map();
for (const [fn, vars] of Object.entries(coupling.stateRefs)) {
  for (const v of vars) {
    if (!owners.has(v)) owners.set(v, []);
    owners.get(v).push(fn);
  }
}

const rows = [...owners.entries()].map(([v, fns]) => {
  const votes = {};
  for (const f of fns) votes[domainOf(f)] = (votes[domainOf(f)] || 0) + 1;
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const total = fns.length;
  const top = ranked[0]?.[1] ?? 0;
  return {
    name: v,
    users: total,
    domain: ranked[0]?.[0] ?? 'core',
    // 归属置信度：领先者占比。低于 0.6 说明跨域，需要拆成 store 或显式传参
    confidence: total ? top / total : 0,
    crossDomain: ranked.filter(([, n]) => n >= 2).map(([d, n]) => `${d}(${n})`),
  };
}).sort((a, b) => b.users - a.users);

// 未被任何函数引用的声明（可能是死代码或仅被 main 自身使用）
const all = new Set();
for (const l of lines.slice(1703, 15900)) {
  const m = l.match(/^  (let|const) ([A-Za-z_$][\w$]*)\s*(=|;)/);
  if (m) all.add(m[2]);
}
const orphans = [...all].filter((n) => !owners.has(n));

const byDomain = {};
for (const r of rows) (byDomain[r.domain] ||= []).push(r);

console.log(`闭包声明 ${all.size} 个，其中 ${rows.length} 个被内嵌函数引用，${orphans.length} 个仅 main 自用`);
console.log('\n=== 按目标模块分组 ===');
for (const [d, list] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
  const cross = list.filter((r) => r.confidence < 0.6).length;
  console.log(`  ${d.padEnd(14)} ${String(list.length).padStart(3)} 个  （其中 ${cross} 个跨域，需拆 store 或传参）`);
}
console.log('\n=== 引用最广的 12 个状态（优先做成显式 store）===');
for (const r of rows.slice(0, 12)) {
  const flag = r.confidence < 0.6 ? ' ⚠跨域' : '';
  console.log(`  ${String(r.users).padStart(2)} 处  ${r.name.padEnd(26)} -> ${r.domain}${flag}  ${r.crossDomain.slice(0, 3).join(' ')}`);
}

const mdIdx = process.argv.indexOf('--md');
if (mdIdx >= 0) {
  const out = process.argv[mdIdx + 1] || path.join(root, 'state/state-ownership.md');
  let md = '# 闭包状态归属表\n\n';
  md += `由 \`scripts/plan-state-ownership.mjs\` 生成。共 ${rows.length} 个被引用的闭包声明。\n\n`;
  md += '置信度 = 最可能归属领域的票数占比。低于 0.6 表示被多个领域共用，必须做成显式 store。\n\n';
  for (const [d, list] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
    md += `## ${d}（${list.length}）\n\n| 状态 | 引用数 | 置信度 | 分布 |\n|---|---|---|---|\n`;
    for (const r of list) md += `| \`${r.name}\` | ${r.users} | ${r.confidence.toFixed(2)} | ${r.crossDomain.join(' ') || '-'} |\n`;
    md += '\n';
  }
  if (orphans.length) md += `## 未被内嵌函数引用（${orphans.length}）\n\n${orphans.map((o) => `\`${o}\``).join('、')}\n`;
  fs.writeFileSync(out, md);
  console.log(`\n明细已写入 ${out}`);
}
