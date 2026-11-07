// 人物档案（Person Profiles）：跨会话、长期、人工可编辑的档案。
//
// 设计意图见 docs/design/PERSON_PROFILES_SPEC.md。与 state/social-v2.json 里的「滚动纪要」
// 分工：纪要是会话热点状态（每轮注入，有上限）；人物档案是冷备档案，**只注入概况**
// （是谁 / 性格与相处 / 待续 / 注意），时间线不进预取，细节按需读取。
//
// 轻量聊天路径（模型没有任何工具）下，AI 的读写走桥接的文本指令：
//   [PERSON:read:<ref>]             读全文（三段 + 时间线）
//   [PERSON:note:<ref>] 内容         往**时间线**追加一条事实
//   [PERSON:who/traits/notes:<ref>] 内容  覆盖**概况**的对应一段（纪要兼职归纳时用）
//   [PERSON:save:<ref>] 标题｜摘要    新建档案或改标题/摘要
// 本模块负责解析 <ref>（档案 id、QQ 号、他自己的称呼）与落盘，不含指令文本的解析（在 lite-chat.js）。
//
// 本模块刻意不依赖桥接内核（不 import bridge.js、不读 config.json），只做存储与
// 纯字符串格式化，方便脚本直接单测。
//
// 存储形态（2026-11 schema v3）：正文拆成三个结构化列（section_who / section_traits /
// section_notes）+ 独立的 person_timeline 表（一条事实一行）。这样「预取概况」与
// 「追加一条时间线」都不必重写整份档案。旧的 memory/*.md 只在首次启动导入一次。
//
// 两个名字类字段的分工（v3 修正，别再混用）：
//   tags   —— 他自己：称呼、外号、关系称谓（owner / 爸爸 / 牢嘉）与分类（人物 / 群友 / 群号）；
//   people —— **和他相关的人**（DarLing、信马鸣枪），标的是关系网，永远不含他自己。
// 为什么要分这么清：resolveRef 靠名字找档案，若自己的名字也躺在 people 里，
// 它就会和「相关的人」撞车——同一个外号既是 A 的自称又是 B 的关系人，写入只能报歧义。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isImported, markImported, transaction } from './db.js';
import {
  emptySections,
  normalizeBodyText,
  parseProfileBody,
  renderProfileBody,
  renderTimelineEntry,
  SECTION_DEFS,
  SECTION_KEYS
} from './person-sections.js';
import yaml from 'js-yaml';

// 这几个是「正文格式」的历史导出：脚本（check-profile-format / normalize-person-profiles）
// 与导出 .md 还在用，实现已搬到 person-sections.js，这里只做转出。
// serializeTopicMarkdown 例外：它要按本模块的 meta 字段顺序序列化，仍定义在本文件里。
export { PROFILE_SECTIONS, TIMELINE_HEADING } from './person-sections.js';
export { normalizeBodyText, stripLegacyEditStamp } from './person-sections.js';

/** 合法档案 id：小写字母数字开头，只含小写字母数字与 . _ -，最长 64。 */
export const TOPIC_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const KNOWN_META_KEYS = ['id', 'title', 'summary', 'tags', 'people', 'source', 'pinned', 'createdAt', 'updatedAt'];
const MAX_ID_LEN = 64;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 240;
const MAX_TAGS = 16;
const MAX_TAG_CHARS = 32;
const MAX_PEOPLE = 20;
const MAX_PERSON_CHARS = 40;
/** 被 ≥N 份档案共享的标签视为分类（人物/群友/私聊/群号），不当作某人的称呼解析。 */
const SHARED_TAG_MIN = 3;
const MAX_SOURCE_CHARS = 200;
const MAX_SOURCE_NOTE_CHARS = 400;
/** 单段概况上限：纪要归纳时整段覆盖，给足空间但不允许把库撑爆。 */
const MAX_SECTION_CHARS = 4000;

// 本机时区口径与桥接其它地方一致：都按 Asia/Shanghai 展示（控制台/日志/摘要）。
// 不用 toLocaleString：zh-CN 的日期分隔符是 `/`，而记忆文件/会话记录人要读写、要跟
// QQ 里看到的 `10-24` 对得上，所以统一按 `YYYY-MM-DD HH:MM` 手动拼。
const TIME_ZONE = 'Asia/Shanghai';
const timePartFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const datePartFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function partsOf(formatter, date) {
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

function formatTime(date) {
  const p = partsOf(timePartFmt, date);
  const hour = p.hour === '24' ? '00' : p.hour; // 部分 ICU 在 24 小时制下把午夜写成 24
  return `${hour}:${p.minute}`;
}

function formatDate(date) {
  const p = partsOf(datePartFmt, date);
  return `${p.year}-${p.month}-${p.day}`;
}

function formatStamp(date) {
  return `${formatDate(date)} ${formatTime(date)}`;
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function truncateChars(text, max) {
  const value = String(text ?? '');
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}

function normalizeText(value, maxChars) {
  // 记忆内容里出现 \r\n 会让 front matter / 时间线在编辑器里看着乱，统一成 LF。
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  return maxChars ? truncateChars(text, maxChars) : text;
}

function toList(value, maxItems, maxChars) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，、\s]+/) : []);
  const out = [];
  for (const item of raw) {
    const text = normalizeText(item, maxChars);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function toIsoTime(value, fallbackMs) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  const finalMs = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
  return new Date(finalMs).toISOString();
}

/** 标题 → 文件名 slug。中文标题没有 ASCII 字母数字时返回 fallback（由调用方再补日期）。 */
export function slugifyTopicId(text, fallback = 'topic') {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_ID_LEN);
  if (slug && TOPIC_ID_RE.test(slug)) return slug;
  return fallback;
}

/** 解析 `---` front matter。没有 front matter 或 YAML 坏掉时按「纯正文」降级，绝不抛错。 */
export function parseTopicMarkdown(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text };
  let meta = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    // 人工改坏 YAML 时不让整条记忆消失：正文仍然可用。
    meta = {};
  }
  return { meta, body: text.slice(match[0].length) };
}

/** YAML 标量输出：中文等安全字符保持裸值（人读友好），含特殊字符的走 JSON 引号。 */
function yamlScalar(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (/^[\p{L}\p{N}][\p{L}\p{N} _.\-，。、！？…（）()·+]+$/u.test(text)) return text;
  if (/^[\p{L}\p{N}]$/u.test(text)) return text;
  return JSON.stringify(text);
}

/**
 * 固定字段顺序的序列化：人工编辑时字段位置稳定，diff 好读。
 *
 * `sourceNote` 是正文开头那句人话来源（含群名片等），2026-11 起单独存列，
 * 这里补回去，保证「控制台源码视图 / 导出 .md」看到的形状与改造前一致。
 */
export function serializeTopicMarkdown(meta = {}, body = '', sourceNote = '') {
  const lines = ['---'];
  lines.push(`id: ${yamlScalar(meta.id)}`);
  lines.push(`title: ${yamlScalar(meta.title)}`);
  if (meta.summary) lines.push(`summary: ${yamlScalar(meta.summary)}`);
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.length) lines.push(`tags: [${tags.map(yamlScalar).join(', ')}]`);
  const people = Array.isArray(meta.people) ? meta.people : [];
  if (people.length) lines.push(`people: [${people.map(yamlScalar).join(', ')}]`);
  if (meta.source) lines.push(`source: ${yamlScalar(meta.source)}`);
  if (meta.pinned) lines.push('pinned: true');
  lines.push(`createdAt: ${yamlScalar(meta.createdAt)}`);
  lines.push(`updatedAt: ${yamlScalar(meta.updatedAt)}`);
  const extra = (meta.extra && typeof meta.extra === 'object') ? meta.extra : {};
  for (const [key, value] of Object.entries(extra)) {
    if (KNOWN_META_KEYS.includes(key)) continue;
    if (value === undefined) continue;
    // 未知字段原样保留（人工可能加自定义元数据）；用单键 yaml.dump 保证嵌套结构不丢。
    try {
      const dumped = yaml.dump({ [key]: value }, { lineWidth: -1 }).trimEnd();
      if (dumped) lines.push(dumped);
    } catch {}
  }
  lines.push('---', '');
  const note = String(sourceNote ?? '').trim();
  if (note) lines.push(`> 来源：${note}`, '');
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
  return `${lines.join('\n')}${text ? `\n${text}\n` : '\n'}`;
}

/** 把（可能有缺省的）原始 meta 归一成模块对外形状；未知键收进 extra。 */

function normalizeMeta(rawMeta, fallbackId, nowMs, existing = null) {
  const src = (rawMeta && typeof rawMeta === 'object') ? rawMeta : {};
  const extra = {};
  for (const [key, value] of Object.entries(src)) {
    // `extra` 自己不是自定义字段：它是「未知字段容器」。不跳过就会写成 extra.extra，
    // 而且每次 save 都会多嵌一层（extra: {extra: {extra: {}}}）——曾把空对象写进 front matter。
    if (key === 'extra' || KNOWN_META_KEYS.includes(key)) continue;
    extra[key] = value;
  }
  const inheritedExtra = (src.extra && typeof src.extra === 'object' && !Array.isArray(src.extra)) ? src.extra : {};
  Object.assign(extra, inheritedExtra);
  const base = existing?.meta || {};
  const id = fallbackId;
  const title = normalizeText(src.title ?? base.title ?? id, MAX_TITLE_CHARS) || id;
  const summary = normalizeText(src.summary ?? base.summary ?? '', MAX_SUMMARY_CHARS);
  const tags = toList(src.tags ?? base.tags ?? [], MAX_TAGS, MAX_TAG_CHARS);
  const people = toList(src.people ?? base.people ?? [], MAX_PEOPLE, MAX_PERSON_CHARS);
  const source = normalizeText(src.source ?? base.source ?? '', MAX_SOURCE_CHARS);
  const pinned = src.pinned !== undefined ? src.pinned === true : base.pinned === true;
  const createdAt = toIsoTime(src.createdAt ?? base.createdAt, existing?.createdAtMs ?? nowMs);
  const updatedAt = toIsoTime(src.updatedAt, nowMs);
  return { id, title, summary, tags, people, source, pinned, createdAt, updatedAt, extra };
}

/**
 * 创建人物档案存储（SQLite 版）。
 *
 * 与文件版的差异只在「存取」：正文仍按 Markdown 存进 body 列，四段结构与时间线追加逻辑
 * 原样保留，因此注入 prompt 的结果与改造前逐字一致。
 *
 * `dir` 仍然需要：它只用于两件事——首次启动从旧 Markdown 文件迁移、删除档案时写 .trash 备份。
 * 迁移是**一次性**的（meta 表里的 person_import_v1 标记）：之后库才是唯一源，
 * 这样「在控制台删掉的档案」不会被遗留的 .md 文件重新长回来。
 */
export function createPersonStore({
  dir,
  db,
  dbFile = '',
  redact = (value) => String(value ?? ''),
  maxProfileChars = 200000,
  maxProfiles = 300,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  if (!dir) throw new Error('createPersonStore 需要 dir');
  if (!db) throw new Error('createPersonStore 需要 db');
  const storeDir = path.resolve(dir);
  const trashDir = path.join(storeDir, '.trash');
  const IMPORT_FLAG = 'person_import_v1';

  const safeText = (value) => String(redact(String(value ?? '')) ?? '');
  /** 展示用定位符：控制台要能说清「这条记录在哪」，库文件 + 主键比裸 id 有用。 */
  const locate = (id) => (dbFile ? `${dbFile}#${id}` : id);

  function ensureDir() {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(trashDir, { recursive: true });
  }

  function assertId(id) {
    const value = String(id ?? '').trim().toLowerCase();
    if (!TOPIC_ID_RE.test(value)) throw statusError(400, `非法档案 id：${String(id ?? '')}（只允许小写字母数字和 . _ -）`);
    return value;
  }

  function parseList(text) {
    try {
      const value = JSON.parse(String(text ?? '[]'));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  function parseObject(text) {
    try {
      const value = JSON.parse(String(text ?? '{}'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  /** DB 行 → meta（走与文件版相同的归一函数，保证字段上限/兜底口径完全一致）。 */
  function metaFromRow(row) {
    return normalizeMeta({
      title: row.title,
      summary: row.summary,
      tags: parseList(row.tags),
      people: parseList(row.people),
      source: row.source,
      pinned: Number(row.pinned) === 1,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      extra: parseObject(row.extra)
    }, String(row.id), Number(row.updated_at), null);
  }

  function sectionsFromRow(row) {
    return {
      who: String(row.section_who ?? ''),
      traits: String(row.section_traits ?? ''),
      notes: String(row.section_notes ?? '')
    };
  }

  /** 档案总字数 = 三段 + 时间线：索引里显示的「1.4k字」用它。 */
  function entryChars(row) {
    let total = 0;
    for (const key of SECTION_KEYS) total += Array.from(String(row[`section_${key}`] ?? '')).length;
    return total + (Number(row.timeline_chars) || 0);
  }

  function rowToEntry(row) {
    const meta = metaFromRow(row);
    return {
      id: meta.id,
      title: meta.title,
      summary: meta.summary,
      tags: meta.tags,
      people: meta.people,
      pinned: meta.pinned,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      createdAtMs: Date.parse(meta.createdAt) || Number(row.created_at),
      chars: entryChars(row),
      mtimeMs: Number(row.updated_at),
      path: locate(meta.id)
    };
  }

  function listIds() {
    return db.prepare('SELECT id FROM person_profiles').all().map((row) => String(row.id));
  }

  function hasId(id) {
    const normalized = assertId(id);
    return !!db.prepare('SELECT 1 AS hit FROM person_profiles WHERE id = ?').get(normalized);
  }

  function countProfiles() {
    const row = db.prepare('SELECT COUNT(*) AS n FROM person_profiles').get();
    return Number(row?.n) || 0;
  }

  /**
   * 时间线单独查：列表/索引不需要它，只有 get()（读全文、导出、源码视图）才拉。
   * 这样 300 份档案的 list() 不会把上万条时间线全捞进内存。
   */
  function readTimeline(personId) {
    return db.prepare('SELECT seq, day, text, created_at FROM person_timeline WHERE person_id = ? ORDER BY seq ASC')
      .all(personId)
      .map((row) => ({
        seq: Number(row.seq),
        day: String(row.day ?? ''),
        text: String(row.text ?? ''),
        createdAt: Number(row.created_at)
      }));
  }

  const TIMELINE_CHARS_SQL = '(SELECT COALESCE(SUM(LENGTH(t.text)), 0) FROM person_timeline t WHERE t.person_id = p.id)';

  function list() {
    const rows = db.prepare(`SELECT p.*, ${TIMELINE_CHARS_SQL} AS timeline_chars
      FROM person_profiles p
      ORDER BY p.pinned DESC, p.updated_at DESC`).all();
    return rows.map(rowToEntry);
  }

  function get(id) {
    const normalized = assertId(id);
    const row = db.prepare(`SELECT p.*, ${TIMELINE_CHARS_SQL} AS timeline_chars
      FROM person_profiles p WHERE p.id = ?`).get(normalized);
    if (!row) return null;
    const meta = metaFromRow(row);
    const sections = sectionsFromRow(row);
    const timeline = readTimeline(normalized);
    const body = renderProfileBody({ sections, timeline });
    return {
      id: normalized,
      meta,
      sections,
      timeline,
      sourceNote: String(row.source_note ?? ''),
      body,
      // raw 是控制台「源码视图」用的：库里没有原始字节，按同一套序列化器重建，
      // 保证人看到的 front matter 与导出成 .md 时一模一样。
      raw: serializeTopicMarkdown(meta, body, row.source_note),
      chars: entryChars(row),
      path: locate(normalized),
      createdAtMs: Date.parse(meta.createdAt) || Number(row.created_at),
      mtimeMs: Number(row.updated_at)
    };
  }

  function makeUniqueId(preferred) {
    const existing = new Set(listIds());
    let base = preferred || 'topic';
    if (base === 'topic') {
      const stamp = formatDate(new Date(now())).replace(/[^0-9]/g, '');
      base = `topic-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    }
    base = base.slice(0, MAX_ID_LEN);
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const suffix = `-${i}`;
      const candidate = `${base.slice(0, MAX_ID_LEN - suffix.length)}${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw statusError(409, '无法生成唯一档案 id');
  }

  const UPSERT = `
    INSERT INTO person_profiles
      (id, title, summary, tags, people, source, source_note, pinned, extra,
       section_who, section_traits, section_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      tags = excluded.tags,
      people = excluded.people,
      source = excluded.source,
      source_note = excluded.source_note,
      pinned = excluded.pinned,
      extra = excluded.extra,
      section_who = excluded.section_who,
      section_traits = excluded.section_traits,
      section_notes = excluded.section_notes,
      updated_at = excluded.updated_at
  `;

  /** 单段归一：统一 LF、剥历史时间戳、压空行，并卡上限。 */
  function normalizeSection(value) {
    const text = normalizeBodyText(safeText(value));
    return Array.from(text).length > MAX_SECTION_CHARS ? truncateChars(text, MAX_SECTION_CHARS) : text;
  }

  function maxTimelineSeq(personId) {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM person_timeline WHERE person_id = ?').get(personId);
    return Number(row?.m) || 0;
  }

  /** 批量写时间线，返回**实际插入条数**（空行会被跳过，所以不等于 entries.length）。 */
  function insertTimelineEntries(personId, entries, startSeq = 0, createdAt = now()) {
    if (!entries?.length) return 0;
    const stmt = db.prepare(`INSERT INTO person_timeline (person_id, seq, day, text, created_at)
      VALUES (?, ?, ?, ?, ?)`);
    let seq = startSeq;
    let inserted = 0;
    for (const entry of entries) {
      const text = String(entry?.text ?? '').trim();
      if (!text) continue;
      seq += 1;
      stmt.run(personId, seq, String(entry?.day ?? '').trim(), text, createdAt);
      inserted += 1;
    }
    return inserted;
  }

  /**
   * 保存档案。三段的取值优先级：显式 sections > body 解析 > 沿用旧值。
   *
   * `body` 入口保留是为了兼容控制台「整段 Markdown 粘贴」——解析成三段后落库，
   * 时间线按模式处理：replace 整体替换，append 追加到末尾。
   * 不传 body / sections 时只更新标题摘要等 meta，正文一字不动（upsert 走这里）。
   */
  function save(input = {}) {
    const requestedId = input.id ? String(input.id).trim().toLowerCase() : '';
    const existing = requestedId ? get(requestedId) : null;
    const mode = input.mode === 'append' ? 'append' : 'replace';
    if (mode === 'append' && !existing) throw statusError(404, `档案不存在，无法追加：${requestedId}`);
    if (!existing && countProfiles() >= maxProfiles) {
      throw statusError(409, `档案数量已达上限（${maxProfiles}）`);
    }
    const id = requestedId || makeUniqueId(slugifyTopicId(input.title));
    const nowMs = now();
    const prev = existing;
    const meta = normalizeMeta({
      title: input.title !== undefined ? safeText(input.title) : undefined,
      summary: input.summary !== undefined ? safeText(input.summary) : undefined,
      tags: input.tags !== undefined ? toList(input.tags, MAX_TAGS, MAX_TAG_CHARS).map(safeText) : undefined,
      people: input.people !== undefined ? toList(input.people, MAX_PEOPLE, MAX_PERSON_CHARS).map(safeText) : undefined,
      source: input.source !== undefined ? safeText(input.source) : undefined,
      pinned: input.pinned,
      createdAt: prev?.meta?.createdAt ?? new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      extra: prev?.meta?.extra ?? {}
    }, id, nowMs, prev);

    const sections = prev?.sections ? { ...prev.sections } : emptySections();
    let sourceNote = prev?.sourceNote || '';
    let timelineEntries = null;

    if (input.sections && typeof input.sections === 'object') {
      for (const key of SECTION_KEYS) {
        if (input.sections[key] !== undefined) sections[key] = normalizeSection(input.sections[key]);
      }
    }
    if (input.body !== undefined) {
      const parsed = parseProfileBody(safeText(input.body));
      for (const key of SECTION_KEYS) sections[key] = normalizeSection(parsed.sections[key]);
      if (parsed.sourceNote) sourceNote = normalizeText(parsed.sourceNote, MAX_SOURCE_NOTE_CHARS);
      timelineEntries = parsed.timeline;
    } else if (Array.isArray(input.timeline)) {
      // 控制台分段编辑用：三段走 sections，时间线单独提交，不必再把整份档案
      // 拼成 Markdown 再解析回来（往返一次就多一次格式漂移的机会）。
      timelineEntries = input.timeline
        .map((entry) => ({
          day: String(entry?.day ?? '').trim(),
          text: String(entry?.text ?? '').trim()
        }))
        .filter((entry) => entry.text);
    }
    if (input.sourceNote !== undefined) sourceNote = normalizeText(safeText(input.sourceNote), MAX_SOURCE_NOTE_CHARS);

    // 时间线没变就不重建：整表 DELETE + 重插会让 seq 与 created_at 全部重置，
    // 「这条事实是什么时候记下的」就丢了。人打开档案只改概况时不该有这种副作用。
    if (timelineEntries && mode === 'replace' && prev) {
      const old = prev.timeline || [];
      const same = old.length === timelineEntries.length
        && old.every((entry, i) => String(entry.day ?? '') === timelineEntries[i].day
          && String(entry.text ?? '') === timelineEntries[i].text);
      if (same) timelineEntries = null;
    }

    const sectionChars = SECTION_KEYS.reduce((sum, key) => sum + Array.from(sections[key] || '').length, 0);
    const incomingChars = (timelineEntries || []).reduce((sum, entry) => sum + Array.from(String(entry?.text ?? '')).length, 0);
    const prevTimelineChars = prev
      ? Number(db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS s FROM person_timeline WHERE person_id = ?').get(prev.id)?.s) || 0
      : 0;
    const timelineChars = timelineEntries
      ? (mode === 'replace' ? incomingChars : prevTimelineChars + incomingChars)
      : prevTimelineChars;
    const totalChars = sectionChars + timelineChars;
    if (totalChars > maxProfileChars) {
      throw statusError(413, `档案正文过长（${totalChars} 字，上限 ${maxProfileChars}）`);
    }

    transaction(db, () => {
      db.prepare(UPSERT).run(
        id,
        meta.title,
        meta.summary,
        JSON.stringify(meta.tags || []),
        JSON.stringify(meta.people || []),
        meta.source,
        sourceNote,
        meta.pinned ? 1 : 0,
        JSON.stringify(meta.extra && typeof meta.extra === 'object' ? meta.extra : {}),
        sections.who,
        sections.traits,
        sections.notes,
        Date.parse(meta.createdAt) || nowMs,
        Date.parse(meta.updatedAt) || nowMs
      );
      if (timelineEntries) {
        if (mode === 'replace') {
          db.prepare('DELETE FROM person_timeline WHERE person_id = ?').run(id);
          insertTimelineEntries(id, timelineEntries, 0, nowMs);
        } else {
          insertTimelineEntries(id, timelineEntries, maxTimelineSeq(id), nowMs);
        }
      }
    });
    return get(id);
  }

  /**
   * 把「模型给的档案引用」解析成真实档案 id。
   * 接受：档案 id（带不带 person- 都行）、QQ 号、他自己的称呼/外号（匹配 tags 与 title，**唯一命中**才算）。
   * 都找不到时按规则生成新 id：QQ 号 → `person-<QQ>`；其它 → `person-n-<名字哈希>`。
   * 哈希而不是 slug：中文昵称 slug 化会变成空串，用哈希才能保证同名重复写入落到同一份档案。
   * `@`（或空）表示默认目标，由调用方传 fallbackId（私聊里是对话对方）。
   *
   * **名字只查 tags 与 title，绝不查 people**：people 是「和他相关的人」，
   * 拿它定位「这条事实属于谁」属于语义错位——同一个外号可能既是 A 的自称，
   * 又是 B 的关系人（`牢嘉` 就是这样），查 people 必然歧义。
   * @returns {{id:string, existing:boolean}}
   */
  function resolveRef(ref, opts = {}) {
    const raw = String(ref ?? '').trim();
    const fallbackId = String(opts.fallbackId ?? '').trim().toLowerCase();
    if (!raw || raw === '@') {
      if (!fallbackId) throw statusError(400, '没指定档案：群聊里写昵称或 QQ 号，私聊里可以用 @ 指对方');
      const id = assertId(fallbackId);
      return { id, existing: hasId(id) };
    }
    const lower = raw.toLowerCase();
    const direct = [];
    if (TOPIC_ID_RE.test(lower)) direct.push(lower);
    if (/^\d{5,12}$/.test(raw)) direct.push(`person-${raw}`);
    for (const id of direct) {
      // hasId() 会走 assertId：非法 id（含大写/中文）直接跳过，不当作错误。
      if (TOPIC_ID_RE.test(id) && hasId(id)) return { id, existing: true };
    }
    const shared = sharedTagSet();
    const hits = list().filter((entry) => {
      const tagHit = (entry.tags || []).some((tag) => {
        const value = String(tag).toLowerCase();
        return value === lower && !shared.has(value);
      });
      return tagHit || String(entry.title || '').toLowerCase().includes(lower);
    });
    if (hits.length === 1) return { id: hits[0].id, existing: true };
    if (hits.length > 1) {
      throw statusError(409, `「${raw}」匹配到多份档案（${hits.map((hit) => hit.id).join('、')}），请写档案 id`);
    }
    const id = /^\d{5,12}$/.test(raw)
      ? `person-${raw}`
      : `person-n-${createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
    return { id, existing: false };
  }

  /**
   * 被多份档案共享的标签 = 分类标签（人物 / 群友 / 私聊 / 群号），不是任何人的称呼。
   *
   * 为什么需要：名字改从 tags 里查之后，`群友` 这种标签会同时命中二十份档案，
   * 而模型偶尔真的会把「群友」当成 ref 写进指令。把高频标签排除在名字解析之外，
   * 既能消掉这类噪音命中，又不会误伤真正的外号（外号只属于一个人）。
   */
  function sharedTagSet() {
    const counts = new Map();
    for (const row of db.prepare('SELECT tags FROM person_profiles').all()) {
      for (const tag of parseList(row.tags)) {
        const key = String(tag).toLowerCase();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const shared = new Set();
    for (const [key, count] of counts) if (count >= SHARED_TAG_MIN) shared.add(key);
    return shared;
  }

  /**
   * 往**时间线**追加一条事实。档案不存在就顺手建一份（三段留空，标题用引用原文）。
   *
   * 这是主回复路径唯一的写入动作：一次 INSERT 一行，不再重写整份档案。
   * 三段（是谁/性格/注意）不在这里改——那是纪要兼职归纳出来的，见 updateSection()。
   */
  function note(ref, text, opts = {}) {
    const fact = normalizeText(safeText(text), 400);
    if (!fact) throw statusError(400, '追加内容不能为空');
    const target = resolveRef(ref, opts);
    const nowMs = now();
    // 日期只留 MM-DD：档案是长期资料，年份在时间线上没信息量。
    const day = formatDate(new Date(nowMs)).slice(5);
    if (!target.existing) {
      const displayName = String(ref ?? '').trim() || target.id;
      save({ id: target.id, title: displayName, sourceNote: opts.sourceNote });
    }
    transaction(db, () => {
      insertTimelineEntries(target.id, [{ day, text: fact }], maxTimelineSeq(target.id), nowMs);
      db.prepare('UPDATE person_profiles SET updated_at = ? WHERE id = ?').run(nowMs, target.id);
    });
    return get(target.id);
  }

  /**
   * 覆盖概况的某一段（`who` / `traits` / `notes`）。纪要兼职归纳时用。
   *
   * 语义是**替换**而不是追加：这三段是「这个人现在是什么样」的概述，一路追加会变成流水账，
   * 流水账已经有时间线了。传空内容视为「不改」，避免模型少写一段就把原有信息清空。
   * 档案不存在时顺手建一份（纪要手里只有 QQ 号，不能因为「还没建过」就把归纳丢掉）。
   */
  function updateSection(ref, key, text, opts = {}) {
    const wanted = String(key ?? '').trim().toLowerCase();
    const def = SECTION_DEFS.find((item) => item.key === wanted || item.heading === String(key ?? '').trim());
    if (!def) throw statusError(400, `未知档案段：${key}（支持 who / traits / notes）`);
    const target = resolveRef(ref, opts);
    if (!target.existing) {
      save({ id: target.id, title: String(ref ?? '').trim() || target.id, sourceNote: opts.sourceNote });
    }
    const content = normalizeSection(text);
    if (!content) return get(target.id);
    const current = db.prepare(`SELECT section_${def.key} AS value FROM person_profiles WHERE id = ?`).get(target.id);
    const before = String(current?.value ?? '').trim();
    if (before === content) return get(target.id); // 没变化就不刷 updated_at，别让「最近更新」排序失真
    db.prepare(`UPDATE person_profiles SET section_${def.key} = ?, updated_at = ? WHERE id = ?`)
      .run(content, now(), target.id);
    log(`[person] 概况 ${def.key} 更新（${target.id}）：${Array.from(before).length} → ${Array.from(content).length} 字`);
    return get(target.id);
  }

  /**
   * 新建或更新档案的标题/摘要（不动正文）。
   * 没给的字段沿用原值——模型只写摘要时不能把标题或正文清空。
   * 只有显式传了 body 才解析重写三段与时间线，否则一个字节都不碰。
   */
  function upsert(ref, input = {}, opts = {}) {
    const target = resolveRef(ref, opts);
    const existing = target.existing ? get(target.id) : null;
    const patch = { id: target.id };
    const title = normalizeText(input.title ?? '', MAX_TITLE_CHARS);
    const summary = normalizeText(input.summary ?? '', MAX_SUMMARY_CHARS);
    patch.title = title || existing?.meta?.title || String(ref ?? '').trim() || target.id;
    patch.summary = summary || existing?.meta?.summary || '';
    if (input.body !== undefined) patch.body = input.body;
    if (input.sourceNote !== undefined) patch.sourceNote = input.sourceNote;
    return save(patch);
  }

  /**
   * 注入提示词的「人物档案摘要」。
   *
   * 取舍（2026-10-29 改）：原来按「置顶优先 + 最近更新」取前 N 份，结果是**自锁**——
   * 谁最近被写过谁才在榜上，没被写过的人永远进不来、也就永远不会被写。
   * 现在默认由调用方传 `pinnedOnly: true`：**进不进提示词，由人手动置顶决定**，
   * 模型改不了这个名单，也就不会自己强化偏差。
   * 一份置顶都没有时回落到最近更新（否则刚清空置顶会变成「完全没记忆」，容易被当成 bug）。
   *
   * @param {number} max 最多列几份
   * @param {{summaryChars?:number, pinnedOnly?:boolean, excludeIds?:string[]|Set<string>}} opts
   */
  function formatSummaryIndex(max = 6, opts = {}) {
    const all = list();
    if (!all.length) return '';
    const limit = Math.max(1, Math.min(20, Number(max) || 6));
    const summaryChars = Math.max(20, Math.min(MAX_SUMMARY_CHARS, Number(opts.summaryChars) || 160));
    const pinnedOnly = opts.pinnedOnly === true;
    // 排除名单：本轮已经预取正文的人不必再在名单里出现一次。
    // 同一份档案在一轮 prompt 里出现两遍，会让模型以为「这件事很重要」进而反复提。
    const excluded = opts.excludeIds instanceof Set ? opts.excludeIds : new Set(Array.isArray(opts.excludeIds) ? opts.excludeIds : []);
    const skip = (entry) => excluded.has(String(entry?.id ?? '').toLowerCase());
    const pinnedAll = all.filter((entry) => entry.pinned === true);
    const pinned = pinnedAll.filter((entry) => !skip(entry));
    // 回落到最近更新时，保留原排序（list() 已经按置顶/最近更新排好）。
    const usedFallback = pinnedOnly && pinned.length === 0;
    const pool = (pinnedOnly && !usedFallback ? pinned : all).filter((entry) => !skip(entry));
    const shown = pool.slice(0, limit);
    if (!shown.length) return '';
    const heading = pinnedOnly && !usedFallback
      ? `【人物档案摘要】共 ${all.length} 份，其中 ${pinnedAll.length} 份置顶（置顶的才会每轮出现；下面 ${shown.length} 份只有摘要）`
      : `【人物档案摘要】共 ${all.length} 份（全账号共享，私聊和群聊互通；下面 ${shown.length} 份按最近更新排，只有摘要）`;
    const lines = [heading];
    for (const entry of shown) {
      const summary = entry.summary ? truncateChars(entry.summary, summaryChars) : '（还没写摘要）';
      lines.push(`- ${entry.id} · ${truncateChars(entry.title, 40)}：${summary}`);
    }
    // 没置顶时补一句提示：否则「为什么只有这几个人」在群里完全看不出来。
    if (pinnedOnly && usedFallback) lines.push('（还没有任何档案置顶：先按最近更新列。想让谁每轮都出现，就在控制台把那份置顶。）');
    lines.push('别人的细节：[PERSON:read:<档案id/QQ/昵称>]；记一条事实：[PERSON:note:<…>] 内容（只进时间线）。概况（是谁 / 性格 / 注意）由系统在整理对话时自动更新，聊天时不用写。私聊可用 @ 指对方；指令由桥接执行，不会发给群友。');
    return lines.join('\n');
  }

  /**
   * 按预算裁剪三段。优先级：notes > who > traits。
   *
   * 为什么 notes 排第一：那一段写的是「该怎么称呼、别踩什么坑、别在群里提什么」——
   * 被砍掉的代价是当场说错话；traits 被砍最多是少一点谈资。
   * 单段最多占一半预算，避免某一段写太长把另外两段整个挤掉。
   */
  function fitSections(sections, maxChars) {
    const cap = Math.max(80, Math.floor(maxChars * 0.5));
    const kept = emptySections();
    let used = 0;
    for (const key of ['notes', 'who', 'traits']) {
      const raw = String(sections?.[key] || '').trim();
      if (!raw) continue;
      const room = Math.min(cap, maxChars - used);
      if (room <= 40) continue;
      const text = truncateChars(raw, room);
      kept[key] = text;
      used += Array.from(text).length;
    }
    const truncated = SECTION_KEYS.some((key) => String(sections?.[key] || '').trim().length > kept[key].length);
    return { sections: kept, truncated };
  }

  /**
   * 每轮强制注入的「这个人是谁」：**只有三段概况，不带时间线**。
   *
   * 为什么不是让模型自己读：`[PERSON:read]` 是**额外一次完整模型调用**（全量 prompt 再来一遍，
   * 只为拿一份正文）。模型在写一条 20 字的 QQ 回复时没有任何动机付这个钱，实测一次都不会主动读。
   *
   * 为什么去掉时间线（2026-11 改）：时间线是「发生过什么」，属于对话纪要和 read 的职责；
   * 每轮把十几条旧事塞进 prompt，模型就会一条条念出来（2026-10-29 的实测教训）。
   * 概况才是「见到这个人该知道什么」。
   */
  function formatFocusBlock(profile, opts = {}) {
    if (!profile || !profile.id) return '';
    const maxChars = Math.max(200, Math.min(8000, Number(opts.maxChars) || 1500));
    const title = String(profile.meta?.title || profile.id).trim();
    const head = opts.group === true
      // 群聊刻意不写「正在说话的人」：最新发言人可能没档案，这里带回来的也许是上一位——
      // 叫「正在说话」会让模型认错人，进而用错称呼/错梗。
      ? `【群里的人】${title}（档案 ${profile.id}｜这轮已自动带上，不用再 read）`
      : `【关于对方】${title}（档案 ${profile.id}｜每轮自动带上，不用再 read）`;
    const lines = [head];
    const summary = String(profile.meta?.summary || '').trim();
    if (summary) lines.push(`摘要：${truncateChars(summary, 240)}`);
    const raw = profile.sections || emptySections();
    if (!SECTION_KEYS.some((key) => String(raw[key] || '').trim())) {
      // 空档案也要说清楚：否则模型会以为「没带正文 = 我记得」。
      lines.push('（这份档案还没有正文。你还什么都不知道，不要装作记得。）');
      return lines.join('\n');
    }
    const { sections, truncated } = fitSections(raw, maxChars);
    for (const def of SECTION_DEFS) {
      const text = String(sections[def.key] || '').trim();
      if (!text) continue;
      lines.push(`## ${def.heading}`, text, '');
    }
    if (truncated) lines.push(`（概况被截断了，想看全文和时间线就 [PERSON:read:${profile.id}]）`);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  /**
   * `[PERSON:read]` 的正文：摘要 + 三段 + 时间线（从新到旧）。不带标题行（调用方自己拼）。
   *
   * 时间线必须从新往前取：按时间正序截断会先砍掉最近发生的事，留下的全是几个月前的老梗。
   */
  function formatReadBlock(profile, opts = {}) {
    if (!profile || !profile.id) return '';
    const maxChars = Math.max(300, Math.min(20000, Number(opts.maxChars) || 3000));
    const lines = [];
    const summary = String(profile.meta?.summary || '').trim();
    if (summary) lines.push(`摘要：${truncateChars(summary, MAX_SUMMARY_CHARS)}`);
    const { sections } = fitSections(profile.sections || emptySections(), Math.floor(maxChars * 0.6));
    for (const def of SECTION_DEFS) {
      const text = String(sections[def.key] || '').trim();
      if (!text) continue;
      lines.push(`## ${def.heading}`, text, '');
    }
    const entries = Array.isArray(profile.timeline) ? profile.timeline : [];
    if (entries.length) {
      let remain = maxChars - lines.join('\n').length;
      const picked = [];
      for (let i = entries.length - 1; i >= 0 && remain > 0; i -= 1) {
        const line = renderTimelineEntry(entries[i]);
        if (!line) continue;
        const cost = Array.from(line).length + 1;
        if (cost > remain) break;
        picked.unshift(line);
        remain -= cost;
      }
      if (picked.length) lines.push('## 聊过什么（时间线）', ...picked);
      const omitted = entries.length - picked.length;
      if (omitted > 0) lines.push(`（更早的 ${omitted} 条没带上）`);
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function remove(id) {
    const normalized = assertId(id);
    const detail = get(normalized);
    if (!detail) throw statusError(404, `档案不存在：${normalized}`);
    // 先落一份 .md 到 .trash 再删行：人工误删时还能捞回来，也保留「删了什么东西」的物证。
    ensureDir();
    const backupPath = path.join(trashDir, `${Date.now()}-${normalized}.md`);
    fs.writeFileSync(backupPath, detail.raw || serializeTopicMarkdown(detail.meta, detail.body, detail.sourceNote), 'utf8');
    transaction(db, () => {
      // 时间线是独立表，没有外键级联，必须显式删；漏了会留下孤儿行，档案重建后又被读出来。
      db.prepare('DELETE FROM person_timeline WHERE person_id = ?').run(normalized);
      db.prepare('DELETE FROM person_profiles WHERE id = ?').run(normalized);
    });
    return { ok: true, backupPath };
  }

  function search(query, limit = 8) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 8));
    // 全表取回后在 JS 里过滤：档案量级（上限 300 份）远小于「为 LIKE + 片段定位写一套 SQL」的复杂度。
    // 片段要从命中的那个字段里切，SQL 做不了这种「哪个字段命中就切哪个」的定位。
    // 三段是概述级短文本，不再是整份正文，全表拉取代价比改造前更小；
    // 时间线用 instr 单独查（不用 LIKE，省掉 % 和 _ 的转义问题），每个档案只取最新一条命中。
    const rows = db.prepare(`SELECT p.*, ${TIMELINE_CHARS_SQL} AS timeline_chars
      FROM person_profiles p ORDER BY p.pinned DESC, p.updated_at DESC`).all();
    const hitTimeline = db.prepare(`SELECT text FROM person_timeline
      WHERE person_id = ? AND instr(LOWER(text), ?) > 0 ORDER BY seq DESC LIMIT 1`);
    const results = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      const haystacks = [
        entry.id,
        entry.title,
        entry.summary,
        (entry.tags || []).join(' '),
        (entry.people || []).join(' '),
        row.section_who,
        row.section_traits,
        row.section_notes
      ];
      let source = '';
      const index = haystacks.findIndex((text) => String(text || '').toLowerCase().includes(q));
      if (index >= 0) {
        source = String(haystacks[index] || '');
      } else {
        const timelineRow = hitTimeline.get(entry.id, q);
        if (!timelineRow) continue;
        source = String(timelineRow.text || '');
      }
      const at = source.toLowerCase().indexOf(q);
      const start = Math.max(0, at - 30);
      const snippet = truncateChars(source.slice(start, start + 120).replace(/\s+/g, ' '), 120);
      results.push({ id: entry.id, title: entry.title, snippet, updatedAt: entry.updatedAt });
      if (results.length >= max) break;
    }
    return results;
  }

  function formatIndex(max = 12) {
    const entries = list();
    if (!entries.length) return '';
    const limit = Math.max(1, Math.min(50, Number(max) || 12));
    const shown = entries.slice(0, limit);
    const lines = [`【人物档案】共 ${entries.length} 份档案（全账号共享，按最近更新排序；这里只有标题，细节按需取，别凭标题编）`];
    for (const entry of shown) {
      // 索引要短：日期只留 MM-DD（年份对"最近更新"没信息量），摘要/标题各截一段。
      // 行过长时宁可少给摘要，也不要在 `（10-25 更新…）` 中间切断（截断会切出半个日期）。
      const date = formatDate(new Date(Date.parse(entry.updatedAt) || entry.mtimeMs || now())).slice(5);
      const chars = entry.chars >= 1000 ? `${(entry.chars / 1000).toFixed(1)}k字` : `${entry.chars}字`;
      const summary = entry.summary ? ` — ${truncateChars(entry.summary, 22)}` : '';
      const line = `- ${entry.id} · ${truncateChars(entry.title, 28)}${summary}（${date} 更新 · ${chars}）`;
      lines.push(truncateChars(line, 130));
    }
    if (entries.length > shown.length) {
      lines.push(`- …还有 ${entries.length - shown.length} 份档案（用 qq_person(action="list") 看全部）`);
    }
    lines.push('读细节：qq_person(action="read", topic="<id>")；搜相关档案：qq_person(action="search", query="...")。');
    return lines.join('\n');
  }

  function stats() {
    const entries = list();
    return { total: entries.length, chars: entries.reduce((sum, entry) => sum + (Number(entry.chars) || 0), 0) };
  }

  /**
   * 从旧版 Markdown 目录一次性导入。
   * 只在 meta 表没有 person_import_v1 标记时执行；导入完打标记，之后不再看目录——
   * 否则「在控制台删掉的档案」会被遗留的 .md 文件重新导入，删了等于没删。
   *
   * 原 .md **不删**：它们是这次改造的回滚保险，也是人工翻查的历史快照。
   */
  function importLegacyMarkdown() {
    if (isImported(db, IMPORT_FLAG)) return { imported: 0, scanned: 0, skipped: true };
    let files = [];
    try { files = fs.readdirSync(storeDir).filter((name) => name.endsWith('.md') && !name.startsWith('.')); } catch { files = []; }
    let imported = 0;
    let timelineCount = 0;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO person_profiles
        (id, title, summary, tags, people, source, source_note, pinned, extra,
         section_who, section_traits, section_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    transaction(db, () => {
      for (const name of files) {
        const id = name.slice(0, -3).toLowerCase();
        if (!TOPIC_ID_RE.test(id)) continue;
        const file = path.join(storeDir, name);
        let raw = '';
        let mtimeMs = now();
        try {
          raw = fs.readFileSync(file, 'utf8');
          mtimeMs = fs.statSync(file).mtimeMs || mtimeMs;
        } catch { continue; }
        const parsed = parseTopicMarkdown(raw);
        const meta = normalizeMeta(parsed.meta, id, mtimeMs, null);
        // Markdown 正文在这里就拆成三段 + 时间线，之后库里不再有整段正文。
        const content = parseProfileBody(parsed.body);
        const info = insert.run(
          id,
          meta.title,
          meta.summary,
          JSON.stringify(meta.tags || []),
          JSON.stringify(meta.people || []),
          meta.source,
          normalizeText(content.sourceNote, MAX_SOURCE_NOTE_CHARS),
          meta.pinned ? 1 : 0,
          JSON.stringify(meta.extra && typeof meta.extra === 'object' ? meta.extra : {}),
          normalizeSection(content.sections.who),
          normalizeSection(content.sections.traits),
          normalizeSection(content.sections.notes),
          Date.parse(meta.createdAt) || mtimeMs,
          Date.parse(meta.updatedAt) || mtimeMs
        );
        if (Number(info.changes) > 0) {
          imported += 1;
          // 只有真的插进去才写时间线：IGNORE 掉的行说明库里已有，重复插会变成两倍条目。
          timelineCount += insertTimelineEntries(id, content.timeline, 0, mtimeMs);
        }
      }
      markImported(db, IMPORT_FLAG);
    });
    return { imported, scanned: files.length, skipped: false, timeline: timelineCount };
  }

  /** 把库导回 Markdown 目录（默认就是 memory/）：人工查看、版本对比、或整库回滚都用它。 */
  function exportMarkdown(targetDir = storeDir) {
    const outDir = path.resolve(targetDir);
    fs.mkdirSync(outDir, { recursive: true });
    const rows = db.prepare('SELECT id FROM person_profiles ORDER BY id').all();
    let exported = 0;
    for (const row of rows) {
      const detail = get(String(row.id));
      if (!detail) continue;
      fs.writeFileSync(path.join(outDir, `${detail.id}.md`), serializeTopicMarkdown(detail.meta, detail.body, detail.sourceNote), 'utf8');
      exported += 1;
    }
    return { exported, dir: outDir };
  }

  return {
    dir: storeDir,
    // 给控制台显示的「数据在哪」：库存在时它比 memory/ 目录更能说明问题，
    // 否则用户会以为改 memory/*.md 还能生效。
    storage: dbFile ? `sqlite:${path.basename(dbFile)}` : 'sqlite',
    ensureDir,
    list,
    get,
    save,
    remove,
    search,
    formatIndex,
    formatSummaryIndex,
    formatFocusBlock,
    formatReadBlock,
    resolveRef,
    note,
    upsert,
    updateSection,
    stats,
    importLegacyMarkdown,
    exportMarkdown
  };
}

/** 从 `[引用 名字：内容]` 前缀里取被引者名字；解析不到返回空串。 */
function quoteNameFromText(text) {
  const match = /^\[引用\s+([^：:\]]{1,40})[：:]/.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

/**
 * 把 QQ 会话的最近消息整理成人类可读的 Markdown 记录（纯函数，不读写文件）。
 * 供 qq_person(action="digest") 与控制台「从会话生成草稿」共用。
 */
export function formatConversationDigest({ key = '', messages = [], limit = 60, selfName = '', title = '' } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 60));
  const seen = new Set();
  const rows = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const seq = Number(message.seq);
    const dedupeKey = Number.isSafeInteger(seq) && seq > 0 ? `s:${seq}` : `t:${message.time}:${message.sender}:${message.text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push(message);
  }
  rows.sort((a, b) => {
    const sa = Number(a.seq);
    const sb = Number(b.seq);
    if (Number.isSafeInteger(sa) && Number.isSafeInteger(sb) && sa !== sb) return sa - sb;
    return (Number(a.time) || 0) - (Number(b.time) || 0);
  });
  const picked = rows.slice(-max);
  const nowMs = Date.now();
  const headTitle = String(title ?? '').trim();
  const lines = [headTitle ? `## ${headTitle}` : `## 会话记录 ${key || ''}`.trim(), ''];
  lines.push(`- 来源：${key || '未知会话'}`);
  if (picked.length) {
    const first = Number(picked[0].time) || 0;
    const last = Number(picked[picked.length - 1].time) || 0;
    if (first && last) lines.push(`- 时间范围：${formatStamp(new Date(first))} ~ ${formatStamp(new Date(last))}（共 ${picked.length} 条）`);
    else lines.push(`- 共 ${picked.length} 条`);
  } else {
    lines.push('- 共 0 条');
  }
  lines.push(`- 整理时间：${formatStamp(new Date(nowMs))}`, '');
  if (!picked.length) {
    lines.push('（这段时间没有可整理的消息）', '');
    return lines.join('\n');
  }
  let currentDate = '';
  let lastTime = 0;
  for (const message of picked) {
    const timeMs = Number(message.time) || lastTime || nowMs;
    const dateLabel = formatDate(new Date(timeMs));
    if (dateLabel !== currentDate) {
      currentDate = dateLabel;
      lines.push(`### ${dateLabel}`, '');
    }
    if (lastTime && timeMs - lastTime > 12 * 60 * 60 * 1000) {
      const hours = Math.round((timeMs - lastTime) / 3600000);
      lines.push(`> （间隔约 ${hours} 小时无记录）`, '');
    }
    lastTime = timeMs;
    // 私聊消息在桥接里 sender 是「私聊」占位（对方昵称不随私聊消息保存），
    // 直接写进记录会变成「私聊：…」这种没有信息量的行；私聊统一叫「对方」，
    // 抬头/概要里再写是谁。自己发的消息原来会渲染成「我（我）」，这里去掉重复标记。
    const isPrivateKey = /^private:/.test(String(key ?? '').trim());
    const rawSender = String(message.sender || '').trim();
    let sender;
    if (message.isSelf) {
      sender = (!rawSender || rawSender === '我' || rawSender === '私聊') ? '我' : rawSender;
    } else if (rawSender && rawSender !== '私聊') {
      sender = rawSender;
    } else if (isPrivateKey) {
      sender = '对方';
    } else {
      sender = rawSender || (message.isSelf ? (selfName || '我') : '未知');
    }
    const tags = [];
    if (message.isSelf && sender !== '我') tags.push('我');
    if (message.isOwner && !message.isSelf) tags.push('管理员');
    const senderLabel = tags.length ? `${sender}（${tags.join('、')}）` : sender;
    const rawText = String(message.plain || message.text || '').replace(/^\s+|\s+$/g, '');
    const quoteName = quoteNameFromText(message.text) || (message.quoteTargetIsSelf ? (selfName || '我') : '');
    const quoted = quoteName ? `（引用 ${quoteName}）` : '';
    let text = rawText;
    // text 里的 `[引用 X：...]` 前缀已被 quoteName 表达；正文优先用 plain（桥接已剥掉引用段）。
    if (message.text && !message.plain) text = String(message.text).replace(/^\[引用[^\]]*\]\s*/, '');
    const extras = [];
    if (message.hasMedia && !/\[(图片|表情|媒体|视频|语音|文件|动画表情)\]/.test(text)) extras.push('[含媒体]');
    if (message.hasForward && !/\[(聊天记录|转发消息)\]/.test(text)) extras.push('[含转发]');
    const suffix = extras.length ? ` ${extras.join('')}` : '';
    lines.push(`- ${formatTime(new Date(timeMs))} ${senderLabel}：${quoted}${text || '[空消息]'}${suffix}`);
  }
  lines.push('');
  return lines.join('\n');
}
