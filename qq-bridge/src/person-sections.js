// person-sections.js — 人物档案正文的「结构化拆分 / 渲染」（纯函数，无 IO、无外部依赖）。
//
// 为什么单独一层：2026-11 起档案正文拆成三个结构化段 + 一张独立时间线表（person_timeline）。
// 需要拆/拼正文的地方有四处：schema 迁移（db.js）、读写接口（person-memory.js）、
// 旧 Markdown 导入、导出回 .md（脚本）。放在同一个纯模块里，口径才不会各自漂移。
//
// 结构约定：
//   · 三个段：是谁 / 性格与相处 / 待续 / 注意 —— 存在 person_profiles 的三个列里；
//   · 时间线：一条一行，存在 person_timeline（day + text），不再塞在正文末尾；
//   · 开头的 `> 来源：…` 是人话描述（含群名片等），单独存 source_note 列。

/** 「> 最后整理：…」是 2026-11-04 之前的历史第二副本，读/写/导入/注入/导出统一剥掉。 */
const LEGACY_EDIT_STAMP_RE = /^[ \t]*>[ \t]*最后整理[：:].*(?:\n|$)/gm;

/** 去掉历史遗留的「> 最后整理：」行。 */
export function stripLegacyEditStamp(text) {
  return String(text ?? '').replace(LEGACY_EDIT_STAMP_RE, '');
}

/** 正文归一：统一 LF、剥掉历史时间戳行、压掉多余空行（读/写/计数共用同一口径）。 */
export function normalizeBodyText(value) {
  return stripLegacyEditStamp(String(value ?? '').replace(/\r\n?/g, '\n'))
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/** 四段标题（含时间线，保持历史导出形状给脚本用）。 */
export const PROFILE_SECTIONS = ['是谁', '性格与相处', '待续 / 注意', '聊过什么（时间线）'];
export const TIMELINE_HEADING = '## 聊过什么（时间线）';

/** 三个结构化段的定义：key 是数据库列后缀，heading 是 Markdown 标题。 */
export const SECTION_DEFS = [
  { key: 'who', heading: '是谁' },
  { key: 'traits', heading: '性格与相处' },
  { key: 'notes', heading: '待续 / 注意' }
];

export const SECTION_KEYS = SECTION_DEFS.map((def) => def.key);

/** 空的三段，用作兜底，避免调用方到处写 `sections.who || ''`。 */
export function emptySections() {
  return { who: '', traits: '', notes: '' };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 把一行时间线条目拆成 { day, text }。
 * 接受 `10/24 深夜：倾诉`、`10-28 xxx`、`2026-10-28 xxx`，统一成 MM-DD（年份对长期资料没信息量）。
 */
export function parseTimelineEntry(line) {
  const text = String(line ?? '').replace(/^[-*]\s+/, '').trim();
  if (!text) return { day: '', text: '' };
  const withYear = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*[:：]?\s*(.*)$/.exec(text);
  if (withYear) return { day: `${pad2(withYear[2])}-${pad2(withYear[3])}`, text: withYear[4].trim() };
  const short = /^(\d{1,2})[/-](\d{1,2})\s*[:：]?\s*(.*)$/.exec(text);
  if (short) return { day: `${pad2(short[1])}-${pad2(short[2])}`, text: short[3].trim() };
  return { day: '', text };
}

/**
 * 从任意文本里捞一个日期提示（`群里的样子（10/25 凌晨）`、`2026-10-28 上午`）。
 * 时间线里的 `### 分组` 会把日期写在标题里、子条目只写时间，靠这个把日期找回来。
 */
function extractDayHint(text) {
  const value = String(text ?? '');
  const long = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(value);
  if (long) return `${pad2(long[2])}-${pad2(long[3])}`;
  const short = /(\d{1,2})[/-](\d{1,2})/.exec(value);
  if (short) return `${pad2(short[1])}-${pad2(short[2])}`;
  return '';
}

/**
 * 正文 → { sourceNote, sections, timeline }。
 *
 * 容错口径：认得 `## 是谁 / ## 性格与相处 / ## 待续 / ## 聊过什么` 四类标题，
 * 认不出的 H2 整段丢弃（避免混进结构段）。
 * 时间线里的 `### 分组标题`：生成一条 `【分组】` 条目保留信息，并把标题里的日期
 * 作为后续子条目的默认日期——子条目只写 `00:14 …`，丢了这个日期就再也补不回来。
 */
export function parseProfileBody(raw) {
  const text = normalizeBodyText(raw);
  if (!text) return { sourceNote: '', sections: emptySections(), timeline: [] };

  const sections = emptySections();
  const buffers = { who: [], traits: [], notes: [] };
  const timeline = [];
  let sourceNote = '';
  let mode = 'intro';
  let sectionDay = '';

  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line)) {
      const heading = line.replace(/^##\s+/, '').trim();
      if (/^是谁/.test(heading)) mode = 'who';
      else if (/^性格/.test(heading)) mode = 'traits';
      else if (/^待续|^注意/.test(heading)) mode = 'notes';
      else if (/时间线|聊过什么|历史|timeline/i.test(heading)) mode = 'timeline';
      else mode = 'unknown';
      continue;
    }
    if (mode === 'intro') {
      const hit = /^>\s*来源\s*[：:]\s*(.*)$/.exec(line.trim());
      if (hit) sourceNote = hit[1].trim();
      continue;
    }
    if (mode === 'timeline') {
      const sub = /^###\s+(.*)$/.exec(line.trim());
      if (sub) {
        const head = sub[1].trim();
        const hint = extractDayHint(head);
        if (hint) sectionDay = hint;
        timeline.push({ day: '', text: `【${head}】` });
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const entry = parseTimelineEntry(line);
        if (entry.text) timeline.push({ day: entry.day || sectionDay, text: entry.text });
      }
      continue;
    }
    if (mode in buffers) buffers[mode].push(line);
  }

  for (const key of SECTION_KEYS) {
    sections[key] = buffers[key].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return { sourceNote, sections, timeline };
}

/** 渲染一条时间线条目：`- 10-28 内容`；`【分组】` 这种不带日期。 */
export function renderTimelineEntry(entry) {
  const text = String(entry?.text ?? '').trim();
  if (!text) return '';
  const day = String(entry?.day ?? '').trim();
  return day ? `- ${day} ${text}` : `- ${text}`;
}

/** 只渲染三个结构化段（预取正文用，不含时间线）。 */
export function renderSectionsMarkdown(sections = {}) {
  const parts = [];
  for (const def of SECTION_DEFS) {
    const body = String(sections[def.key] || '').trim();
    parts.push(`## ${def.heading}`);
    if (body) parts.push('', body);
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

/** 渲染完整正文（三段 + 时间线），导出 .md 与控制台源码视图共用。 */
export function renderProfileBody({ sections = {}, timeline = [] } = {}) {
  const parts = [renderSectionsMarkdown(sections), '', TIMELINE_HEADING];
  const entries = (Array.isArray(timeline) ? timeline : [])
    .map(renderTimelineEntry)
    .filter(Boolean);
  if (entries.length) parts.push('', ...entries);
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
