// db.js — 桥接的 SQLite 底座：连接、PRAGMA、建表、事务封装。
//
// 为什么用 Node 内置的 node:sqlite 而不是 better-sqlite3：
//   1. 零依赖：本项目刻意保持依赖面很小（package.json 只有 5 个 runtime 依赖），
//      better-sqlite3 是原生扩展，Windows 上装它要 MSVC 工具链，换机器就翻车；
//   2. API 同步：与原来 fs.readFileSync 的调用习惯一致，person-memory 那套同步语义
//      不用改成 async，改动面小；
//   3. 代价是 Node 22 里它还是实验特性，启动会打一行 ExperimentalWarning。这行警告
//      不影响功能，但如果嫌吵，可在启动脚本加 --disable-warning=ExperimentalWarning。
//
// 表结构（schema v3，2026-11 改）：
//   人物档案正文不再整段存 Markdown，而是拆成三个结构化段（section_who / section_traits /
//   section_notes）+ 一张独立时间线表（person_timeline，一条事实一行）。理由：预取正文只需要
//   「这个人是谁」，每轮追加时间线也只该写一行，而不是重写整份档案。
//   v3 只修字段语义、不动结构：tags = 他自己的称呼与分类（owner / 爸爸 / 外号），
//   people = **和他相关的人**（关系网，不含他自己）。详见 migrateV2toV3。
// 人格卡（roles.content）仍然整段 Markdown —— 它的 〔一代〕〔二代〕靠标题解析，拆列是纯亏。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseProfileBody } from './person-sections.js';

/** 当前 schema 版本。加字段时 +1，并在 migrate() 里补一段迁移。 */
export const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS person_profiles (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  summary        TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '[]',
  people         TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL DEFAULT '',
  source_note    TEXT NOT NULL DEFAULT '',
  pinned         INTEGER NOT NULL DEFAULT 0,
  extra          TEXT NOT NULL DEFAULT '{}',
  section_who    TEXT NOT NULL DEFAULT '',
  section_traits TEXT NOT NULL DEFAULT '',
  section_notes  TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_order ON person_profiles(pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS person_timeline (
  person_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  day        TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_timeline_recent ON person_timeline(person_id, seq DESC);

CREATE TABLE IF NOT EXISTS roles (
  name        TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- 人格自带的「声音设定」：音色 id / 显示名 / 唤醒词表（JSON 数组）。
  -- 空值 = 跟随 config.json 的全局默认，这样没配过的人格行为不变。
  tts_voice      TEXT NOT NULL DEFAULT '',
  tts_voice_name TEXT NOT NULL DEFAULT '',
  wake_keywords  TEXT NOT NULL DEFAULT '[]',
  -- 人格自带的「自拍图库」：目录路径 JSON 数组（相对路径按项目根解析）。
  -- 空数组 = 跟随 config.json 的 socialV2.image.selfDirs（与声音设定同一套回落语义）。
  selfie_dirs    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * 打开（或创建）桥接数据库。
 *
 * @param {{file: string, log?: (msg: string) => void}} opts
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openBridgeDb({ file, log = () => {} } = {}) {
  if (!file) throw new Error('openBridgeDb 需要 file');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);
  // WAL：读不阻塞写，控制台查档案时不会卡住消息主循环；NORMAL 在 WAL 下已足够安全
  // （崩溃最多丢最后一个事务，不会损坏库）。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(SCHEMA);

  const version = Number(readMeta(db, 'schema_version') || 0);
  if (!version) {
    // 新库：SCHEMA 已经按最新结构建好，直接落版本号。
    writeMeta(db, 'schema_version', String(SCHEMA_VERSION));
  } else if (version > SCHEMA_VERSION) {
    // 结构不兼容时**必须挡住**：旧代码写新库会静默丢字段（UPSERT 列清单是写死的），
    // 而「看起来能跑」比启动失败更危险。回退代码前请先恢复 backups/ 里的库快照。
    throw new Error(`数据库 schema 版本 ${version} 高于代码支持的 ${SCHEMA_VERSION}：请升级代码，或恢复 backups/ 里的旧库快照`);
  } else if (version < SCHEMA_VERSION) {
    migrate(db, version, log);
  }
  return db;
}

/** 表里有没有这一列（迁移与幂等判断都靠它）。 */
function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
  } catch {
    return false;
  }
}

/**
 * 按版本逐级迁移。每一段都必须**幂等**：中途崩了下次重跑不能重复插时间线。
 * 幂等靠「列是否存在」「body 列是否还在」两个事实判断，不靠版本号——
 * 版本号是迁移完成之后才写的，崩在半路时它还是旧值。
 */
function migrate(db, from, log = () => {}) {
  let version = from;
  if (version < 2) {
    migrateV1toV2(db, log);
    version = 2;
  }
  if (version < 3) {
    migrateV2toV3(db, log);
    version = 3;
  }
  if (version < 4) {
    migrateV3toV4(db, log);
    version = 4;
  }
  if (version < 5) {
    migrateV4toV5(db, log);
    version = 5;
  }
  writeMeta(db, 'schema_version', String(version));
}

/**
 * v1 → v2：正文拆成三段 + 时间线表。
 *
 * 先加列、解析入库，最后才 DROP 掉 body 列；DROP 单独 try/catch，失败就留着当只读冗余，
 * 不影响读写（新代码不再 SELECT body）。这样即使老 SQLite 不支持 DROP COLUMN 也能跑完。
 */
function migrateV1toV2(db, log) {
  const newColumns = ['source_note', 'section_who', 'section_traits', 'section_notes'];
  for (const column of newColumns) {
    if (!hasColumn(db, 'person_profiles', column)) {
      db.exec(`ALTER TABLE person_profiles ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
  }
  // 时间线表由 SCHEMA 建好；这里只补数据。
  if (!hasColumn(db, 'person_profiles', 'body')) return; // 已经是 v2 形状，无需再拆

  const rows = db.prepare('SELECT id, body FROM person_profiles').all();
  const update = db.prepare(`UPDATE person_profiles
    SET section_who = ?, section_traits = ?, section_notes = ?, source_note = ?
    WHERE id = ?`);
  const clearTimeline = db.prepare('DELETE FROM person_timeline WHERE person_id = ?');
  const insertEntry = db.prepare(`INSERT INTO person_timeline (person_id, seq, day, text, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  let entryCount = 0;

  transaction(db, () => {
    for (const row of rows) {
      const parsed = parseProfileBody(row.body);
      update.run(parsed.sections.who, parsed.sections.traits, parsed.sections.notes, parsed.sourceNote, row.id);
      clearTimeline.run(row.id);
      parsed.timeline.forEach((entry, index) => {
        insertEntry.run(row.id, index + 1, entry.day || '', entry.text, Date.now());
        entryCount += 1;
      });
    }
  });

  try {
    db.exec('ALTER TABLE person_profiles DROP COLUMN body');
  } catch (error) {
    log(`⚠️ 未删除 person_profiles.body 列（${error?.message ?? error}）：已保留为只读冗余，不影响读写`);
  }
  log(`人物档案已拆成结构化字段：${rows.length} 份档案、${entryCount} 条时间线`);
}

/** tags/people 在行里都是 JSON 数组字符串；脏数据当成空数组，不让迁移因此中断。 */
function parseJsonArray(text) {
  try {
    const value = JSON.parse(String(text || '[]'));
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/**
 * 从 title 里取出「他自己」的名字。
 * title 约定形如 `不高兴喵 / 牢嘉（QQ 2729956217）`；`QQ 3525542755` 这种没起名字的返回空数组。
 */
function titleNames(title, qq) {
  const cleaned = String(title || '')
    .replace(/[（(]\s*QQ\s*[:：]?\s*\d+\s*[)）]/ig, ' ')
    .trim();
  if (!cleaned || /^QQ$/i.test(cleaned) || /^\d{5,12}$/.test(cleaned)) return [];
  return cleaned
    .split(/\s*[/／]\s*/)
    .map((name) => name.trim())
    .filter((name) => name && name !== qq && !/^QQ$/i.test(name) && !/^\d{5,12}$/.test(name));
}

/**
 * 这个 people 条目是不是「他自己」。
 *
 * 三条判据按可靠度排序：QQ 号相等 → 与 title 里的名字相等 → 与其中一个名字互相包含
 * （`宇宙无敌爆裂…拉小微` 这种长外号靠第三条认出来）。
 * 单字名（如「顺」）不参与包含判断：否则任何带「顺」的词都会被误判成他自己。
 */
function isSelfEntry(entry, names, qq) {
  const value = String(entry || '').trim().toLowerCase();
  if (!value) return false;
  if (/^\d{5,12}$/.test(value)) return value === qq;
  for (const name of names) {
    const target = name.toLowerCase();
    if (value === target) return true;
    if (value.length >= 2 && target.includes(value)) return true;
    if (target.length >= 2 && value.includes(target)) return true;
  }
  return false;
}

/**
 * v2 → v3：把 people 里「他自己」的条目搬到 tags。
 *
 * 语义修正：people 是「和他相关的人」（关系网），不该混进他自己的名字/外号；
 * 他自己的称呼属于 tags，和 owner / 爸爸 / 妈妈 这类关系称呼同一层。
 *
 * 为什么必须搬：resolveRef 靠名字找档案。如果自己的名字留在 people 里，
 * 它和「相关的人」就会撞车——`牢嘉` 既是某人的自称，也是另一个人的关系人，
 * 于是同一句话能对上两份档案，写入只能报歧义。
 *
 * 幂等：搬过一次后 people 里不再有自己的条目，重跑等于空操作。
 */
function migrateV2toV3(db, log) {
  const rows = db.prepare('SELECT id, title, tags, people FROM person_profiles').all();
  const update = db.prepare('UPDATE person_profiles SET tags = ?, people = ? WHERE id = ?');
  let movedProfiles = 0;
  let movedEntries = 0;

  transaction(db, () => {
    for (const row of rows) {
      const tags = parseJsonArray(row.tags);
      const people = parseJsonArray(row.people);
      if (!people.length) continue;
      const qq = /^person-(\d{5,12})$/.exec(String(row.id))?.[1] || '';
      const names = titleNames(row.title, qq);
      const selfEntries = [];
      const related = [];
      for (const entry of people) {
        if (isSelfEntry(entry, names, qq)) selfEntries.push(entry);
        else related.push(entry);
      }
      if (!selfEntries.length) continue;
      const seen = new Set(tags.map((tag) => String(tag).toLowerCase()));
      const nextTags = [...tags];
      for (const entry of selfEntries) {
        const key = String(entry).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        nextTags.push(entry);
      }
      update.run(JSON.stringify(nextTags), JSON.stringify(related), row.id);
      movedProfiles += 1;
      movedEntries += selfEntries.length;
    }
  });

  log(`人物档案字段语义修正：${movedProfiles} 份档案的 ${movedEntries} 个自称/外号已从 people 移到 tags`);
}

/**
 * v3 → v4：人格卡带上自己的音色与唤醒词。
 *
 * 为什么放在 roles 行里而不是另开一张表：这三点配置（音色 id / 显示名 / 唤醒词表）
 * 的生命周期与人格完全一致——重命名跟着走、删除一起没、复制副本跟着复制。
 * 独立表要额外维护外键与三种动作的一致性，收益为零。
 *
 * 幂等：按列是否存在判断，中途崩了重跑不会重复加列。
 */
function migrateV3toV4(db, log) {
  const columns = [
    ['tts_voice', "TEXT NOT NULL DEFAULT ''"],
    ['tts_voice_name', "TEXT NOT NULL DEFAULT ''"],
    ['wake_keywords', "TEXT NOT NULL DEFAULT '[]'"]
  ];
  let added = 0;
  for (const [column, ddl] of columns) {
    if (hasColumn(db, 'roles', column)) continue;
    db.exec(`ALTER TABLE roles ADD COLUMN ${column} ${ddl}`);
    added += 1;
  }
  if (added > 0) log(`人格卡新增 ${added} 个声音设定字段（音色 / 音色名 / 唤醒词）`);
}

/**
 * v4 → v5：人格卡带上自己的「自拍图库」目录。
 *
 * 为什么同样放在 roles 行里：自拍库和音色是同一种东西——「这个角色的外观/声音」。
 * 生命周期与人格完全一致（改名跟着走、删除一起没），另开一张表只会多维护一套外键。
 *
 * 空数组 = 跟随全局 `socialV2.image.selfDirs`，所以老库升级后行为完全不变。
 *
 * 幂等：按列是否存在判断，中途崩了重跑不会重复加列。
 */
function migrateV4toV5(db, log) {
  if (hasColumn(db, 'roles', 'selfie_dirs')) return;
  db.exec("ALTER TABLE roles ADD COLUMN selfie_dirs TEXT NOT NULL DEFAULT '[]'");
  log('人格卡新增自拍图库字段（selfie_dirs）');
}

export function readMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
    return row ? String(row.value) : '';
  } catch {
    return '';
  }
}

export function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value));
}

/** 一次性导入标记：没有这个键才允许从 Markdown 迁移，避免「删掉的档案被旧文件复活」。 */
export function isImported(db, key) {
  return readMeta(db, key) === 'done';
}

export function markImported(db, key) {
  writeMeta(db, key, 'done');
}

/**
 * 一个同步事务。node:sqlite 没有 better-sqlite3 的 .transaction()，
 * 这里用 BEGIN IMMEDIATE：先拿写锁，避免「读到旧值再写」的竞态。
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
