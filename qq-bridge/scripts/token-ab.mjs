// scripts/token-ab.mjs —— 改配置前后的 token/花费对比（只读，不改任何状态）
//
// 用法：
//   node scripts/token-ab.mjs                 # 用 state/token-ab-cutoff.json 里的分界时间
//   node scripts/token-ab.mjs 2026-10-27T15:23:00+08:00   # 临时指定分界
//
// 数据源：state/token-usage.jsonl（k="turn" 的逐轮采样），价目表来自 config.json 的 pricing
// 覆盖 + src/model-prices.js 默认表（峰谷按采样自己的时间点判定）。
//
// 输出只用 ASCII，避免 Windows 终端代码页把中文打成乱码。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceUsage, resolvePriceTable, addBuckets, ZERO_BUCKETS } from '../src/model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'state', 'token-usage.jsonl');
const CUTOFF_FILE = path.join(ROOT, 'state', 'token-ab-cutoff.json');

function readPricing() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return cfg?.pricing && typeof cfg.pricing === 'object' ? cfg.pricing : undefined;
  } catch {
    return undefined;
  }
}

function resolveCutoff(argv) {
  const arg = argv[2];
  if (arg) {
    const t = Date.parse(arg);
    if (!Number.isFinite(t)) {
      console.error(`无法解析分界时间：${arg}`);
      process.exit(2);
    }
    return { at: t, source: 'argv' };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(CUTOFF_FILE, 'utf8'));
    const t = Number(saved.at);
    if (Number.isFinite(t) && t > 0) return { at: t, source: 'state/token-ab-cutoff.json' };
  } catch {}
  console.error('没有分界时间：请传入参数，或先写 state/token-ab-cutoff.json（{"at": <epoch ms>}）');
  process.exit(2);
}

function readSamples() {
  let text = '';
  try {
    text = fs.readFileSync(LEDGER, 'utf8');
  } catch {
    console.error(`读不到账本：${LEDGER}`);
    process.exit(2);
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try {
      row = JSON.parse(t);
    } catch {
      continue; // 进程中断留下的半行
    }
    if (row?.k !== 'turn') continue;
    if (!Number.isFinite(Number(row.t))) continue;
    out.push(row);
  }
  return out;
}

function summarize(samples, table) {
  const buckets = { ...ZERO_BUCKETS };
  const turns = new Set();
  const sessions = new Set();
  let cost = 0;
  let firstT = 0;
  let lastT = 0;
  for (const s of samples) {
    const b = {
      cacheMiss: Number(s.b?.cacheMiss) || 0,
      cacheHit: Number(s.b?.cacheHit) || 0,
      cacheWrite: Number(s.b?.cacheWrite) || 0,
      output: Number(s.b?.output) || 0,
      reasoning: Number(s.b?.reasoning) || 0
    };
    Object.assign(buckets, addBuckets(buckets, b));
    if (s.sid && s.turn != null) turns.add(`${s.sid}|${s.turn}`);
    if (s.sid) sessions.add(s.sid);
    const priced = priceUsage(b, { model: s.model, at: Number(s.t), table });
    cost += priced.cost.total;
    if (!firstT || Number(s.t) < firstT) firstT = Number(s.t);
    if (Number(s.t) > lastT) lastT = Number(s.t);
  }
  const steps = samples.length;
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  return {
    steps,
    turns: turns.size,
    sessions: sessions.size,
    input,
    output: buckets.output,
    buckets,
    cost,
    firstT,
    lastT,
    perStep: steps ? input / steps : 0,
    perTurn: turns.size ? input / turns.size : 0,
    stepsPerTurn: turns.size ? steps / turns.size : 0,
    costPerStep: steps ? cost / steps : 0,
    costPerTurn: turns.size ? cost / turns.size : 0,
    hitRate: input ? buckets.cacheHit / input : 0
  };
}

const fmtN = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const fmtCNY = (n) => `CNY ${n >= 10 ? n.toFixed(2) : n.toFixed(3)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE') : '-');
const delta = (before, after) => (before > 0 ? `${(((after - before) / before) * 100).toFixed(0)}%` : 'n/a');

const cutoff = resolveCutoff(process.argv);
const table = resolvePriceTable(readPricing());
const all = readSamples();
const before = summarize(all.filter((s) => Number(s.t) < cutoff.at), table);
const after = summarize(all.filter((s) => Number(s.t) >= cutoff.at), table);

const rows = [
  ['samples (steps)', before.steps, after.steps, false],
  ['turns', before.turns, after.turns, false],
  ['sessions', before.sessions, after.sessions, false],
  ['input tokens', before.input, after.input, true],
  ['output tokens', before.output, after.output, true],
  ['input / step', before.perStep, after.perStep, true],
  ['input / turn', before.perTurn, after.perTurn, true],
  ['steps / turn', before.stepsPerTurn, after.stepsPerTurn, true],
  ['cache hit rate', before.hitRate * 100, after.hitRate * 100, true],
  ['cost', before.cost, after.cost, true],
  ['cost / step', before.costPerStep, after.costPerStep, true],
  ['cost / turn', before.costPerTurn, after.costPerTurn, true]
];

console.log('=== token A/B (before vs after config change) ===');
console.log(`cutoff : ${fmtTime(cutoff.at)}  (from ${cutoff.source})`);
console.log(`before : ${fmtTime(before.firstT)} .. ${fmtTime(before.lastT)}`);
console.log(`after  : ${fmtTime(after.firstT)} .. ${fmtTime(after.lastT)}`);
console.log('');
const pad = (s, n) => String(s).padEnd(n);
const num = (v, isCost, isRate) => (isCost ? fmtCNY(v) : isRate ? `${v.toFixed(1)}%` : fmtN(v));
console.log(`${pad('metric', 18)}${pad('before', 14)}${pad('after', 14)}delta`);
console.log('-'.repeat(56));
for (const [label, b, a, pct] of rows) {
  const isCost = label.startsWith('cost');
  const isRate = label === 'cache hit rate';
  const isRatio = label === 'steps / turn';
  const bs = isRate ? `${b.toFixed(1)}%` : isRatio ? b.toFixed(2) : num(b, isCost, isRate);
  const as = isRate ? `${a.toFixed(1)}%` : isRatio ? a.toFixed(2) : num(a, isCost, isRate);
  const show = pct && after.steps > 0;
  console.log(`${pad(label, 18)}${pad(bs, 14)}${pad(as, 14)}${show ? delta(b, a) : ''}`);
}
console.log('');
if (after.steps < 50) {
  console.log(`NOTE: only ${after.steps} samples after the cutoff -- numbers are still noisy.`);
  console.log('      Re-run later; aim for >=200 samples (~25 turns) before trusting the delta.');
}
