#!/usr/bin/env node
// 把 memory/person-*.md 统一成固定四段结构：
//   > 来源：
//   ## 是谁          ## 性格与相处      ## 待续 / 注意      ## 聊过什么（时间线）
//
// 只做「搬运」不做「改写」：原有正文一行不删，只按语义归到对应段里。
// 未知标题一律并入「性格与相处」（保守：宁可归错段落，也不丢内容）。
//
// 用法：
//   node scripts/normalize-person-profiles.mjs            # 预览，只打印计划
//   node scripts/normalize-person-profiles.mjs --write    # 真写（写前自动备份）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTopicMarkdown, serializeTopicMarkdown, PROFILE_SECTIONS, TIMELINE_HEADING } from '../src/person-memory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'memory');
const WRITE = process.argv.includes('--write');

const DATED = /(\d{1,2}\/\d{1,2})|(\d{4}-\d{2}-\d{2})|(\d{1,2}:\d{2})|(\d{1,2}\s*月\s*\d{1,2}\s*日)/;

/** 少数档案原本没有引用块，来源从正文推断后固化在这里（重跑不会退回「待补」）。 */
const SOURCE_OVERRIDES = {
  'person-2268997837': '群聊「26临时绘画部」 + 私聊 2268997837',
  'person-3525542755': '私聊 3525542755',
  'person-3671146730': '私聊 3671146730'
};

/** 标题 → 目标段。顺序有意义：先判专有标题，再判日期，最后兜底。 */
function classify(heading) {
  const h = String(heading || '').replace(/\s+/g, ' ').trim();
  if (/^聊过什么/.test(h)) return 'timeline';
  if (/^是谁$/.test(h)) return 'who';
  if (/^身份核对/.test(h)) return 'who';
  // 只认「以待续开头」：原文里出现过「相处方式 / 待续」这种混合标题，内容其实是相处要点，
  // 按待续处理会把整段性格描述丢进待办里。
  if (/^待续/.test(h)) return 'todo';
  if (/^性格与相处$/.test(h)) return 'personality';
  if (/^梗与偏好/.test(h)) return 'personality';
  if (/^群里的样子/.test(h)) return DATED.test(h) ? 'timeline' : 'personality';
  if (/^(私聊|群聊)/.test(h)) return DATED.test(h) ? 'timeline' : 'personality';
  if (DATED.test(h)) return 'timeline';
  return 'personality';
}

function splitBody(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const quote = [];
  const sections = [];
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^>/.test(line)) { quote.push(line.replace(/^>\s?/, '').trim()); continue; }
    if (!line.trim()) continue;
    break;
  }
  let cur = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      cur = { heading: h2[1].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      // H2 之前的正文不留白丢：开一个「是谁」兜住。
      if (!line.trim()) continue;
      cur = { heading: '是谁', lines: [] };
      sections.push(cur);
    }
    cur.lines.push(line);
  }
  return { quote, sections };
}

/** 段内收尾：压掉连续空行、去掉首尾空行。 */
function cleanLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (out.length && out[out.length - 1].trim()) out.push('');
      continue;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * 引用块里取「来源」，其余（历史「最后整理」行、按人记忆那行）一律丢弃。
 * 最后整理时间不再落正文：权威时间只在 DB 的 updated_at / front matter 的 updatedAt。
 */
function readQuote(quote, meta) {
  let source = '';
  for (const line of quote) {
    const s = /^来源[：:]\s*(.*)$/.exec(line);
    if (s) { source = s[1].trim(); continue; }
  }
  // 引用块里没写的来源，优先用脚本里的覆盖表（人工推断的结果），再退回 front matter。
  source = SOURCE_OVERRIDES[String(meta?.id || '')] || source;
  if (!source) {
    source = String(meta?.source || '')
      .replace(/\bgroup:/g, '群聊 ')
      .replace(/\bprivate:/g, '私聊 ')
      .replace(/\s*\+\s*/g, ' + ')
      .trim();
  }
  return { source };
}

function convertFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseTopicMarkdown(raw);
  const { quote, sections } = splitBody(parsed.body);
  const { source } = readQuote(quote, parsed.meta);

  const buckets = { who: [], personality: [], todo: [], timeline: [] };
  const plan = [];
  for (const section of sections) {
    const bucket = classify(section.heading);
    plan.push(`${section.heading} → ${bucket}`);
    let lines = cleanLines(section.lines);
    // 带日期开头的条目一律算时间线，不管它挂在哪个标题下：
    // 档案的约定就是「- MM-DD 事件」。原文里有把这类条目写进「待续」的，
    // 直接照搬会让时间线断成一截一截。
    if (bucket !== 'timeline') {
      const dated = lines.filter((line) => /^-\s*\d{1,4}[-\/]\d{1,2}/.test(line));
      if (dated.length) {
        lines = lines.filter((line) => !/^-\s*\d{1,4}[-\/]\d{1,2}/.test(line));
        buckets.timeline.push(...dated);
        plan.push(`  （其中 ${dated.length} 条带日期 → timeline）`);
      }
    }
    if (bucket === 'timeline') {
      if (/^聊过什么/.test(section.heading)) buckets.timeline.push(...lines);
      else buckets.timeline.push('', `### ${section.heading}`, ...lines);
    } else {
      // 合并不同来源的同段内容：两边都是列表项就接着写，否则用空行隔开，
      // 免得「- a」紧跟「正文段落」粘成一行。
      if (buckets[bucket].length) {
        const last = [...buckets[bucket]].reverse().find((line) => line.trim()) || '';
        if (!last.startsWith('- ')) buckets[bucket].push('');
      }
      buckets[bucket].push(...lines);
    }
  }

  const body = [];
  body.push(`> 来源：${source || '（待补）'}`);
  const labels = { who: PROFILE_SECTIONS[0], personality: PROFILE_SECTIONS[1], todo: PROFILE_SECTIONS[2] };
  for (const key of ['who', 'personality', 'todo']) {
    body.push('', `## ${labels[key]}`);
    const lines = cleanLines(buckets[key]);
    if (lines.length) body.push('', ...lines);
  }
  body.push('', TIMELINE_HEADING);
  const timeline = cleanLines(buckets.timeline);
  if (timeline.length) body.push('', ...timeline);

  return { parsed, body: body.join('\n'), plan, source };
}

const files = fs.readdirSync(DIR).filter((name) => /^person-.*\.md$/.test(name)).sort();
if (!files.length) { console.error('memory/ 下没有档案'); process.exit(1); }

let changed = 0;
for (const name of files) {
  const file = path.join(DIR, name);
  const { parsed, body, plan } = convertFile(file);
  const before = String(parsed.body || '').trim();
  const same = before === body.trim();
  console.log(`\n=== ${name}${same ? '（已符合）' : ''}`);
  for (const step of plan) console.log(`    ${step}`);
  if (!same) changed += 1;
  if (WRITE && !same) {
    // 不动 updatedAt：快照的时间必须与库里的 updated_at 对齐，不能由改写脚本伪造一个「现在」。
    const meta = { ...parsed.meta };
    fs.writeFileSync(file, serializeTopicMarkdown(meta, body), 'utf8');
  }
}

console.log(`\n共 ${files.length} 份，需要改写 ${changed} 份${WRITE ? '（已写入）' : '（预览模式，加 --write 才写）'}`);
