// role-store.js — 人格卡（roles）的 SQLite 存取。
//
// 为什么要单独一层：人格卡原来散在 4 个地方直接 fs 读写（bridge.js 的 CRUD、
// social/record.js 的热注入缓存、mux/ingest.js 的 /role 命令、persona.js 的控制台接口）。
// 换存储时如果只改其中一两处，会出现「控制台里改好了、注入的还是旧卡」这类最难查的错。
// 现在全部收口到这里的 6 个方法，调用方只认名字，不再关心存在哪。
//
// 正文依旧是整段 Markdown：〔一代〕〔二代〕的分节标记靠标题解析（role-card.js），
// 换成结构化列反而要多维护一套映射，收益为零。
//
// 迁移同样是一次性的（meta 表 role_import_v1）：之后库是唯一源。这样在控制台删掉的卡，
// 不会被 roles/ 目录里遗留的 .md 复活。
import fs from 'node:fs';
import path from 'node:path';
import { isImported, markImported, transaction } from './db.js';

const IMPORT_FLAG = 'role_import_v1';
// README.md 是目录说明，不是人格卡：迁移时跳过，也不允许被控制台读写。
const RESERVED_NAMES = new Set(['README']);

export function createRoleStore({ db, dir, log = () => {} } = {}) {
  if (!db) throw new Error('createRoleStore 需要 db');
  const storeDir = dir ? path.resolve(dir) : '';

  function listNames() {
    return db.prepare('SELECT name FROM roles ORDER BY name').all()
      .map((row) => String(row.name))
      .filter((name) => !RESERVED_NAMES.has(name));
  }

  function has(name) {
    const key = String(name ?? '').trim();
    if (!key) return false;
    return !!db.prepare('SELECT 1 AS hit FROM roles WHERE name = ?').get(key);
  }

  /** 读不到返回空串而不是抛错：调用方（热注入路径）本来就要把「没有角色」当正常情况。 */
  function read(name) {
    const key = String(name ?? '').trim();
    if (!key) return '';
    const row = db.prepare('SELECT content FROM roles WHERE name = ?').get(key);
    return row ? String(row.content) : '';
  }

  /** 缓存 key 用：人格卡内容或时间一变，热注入缓存必须失效。 */
  function updatedAt(name) {
    const key = String(name ?? '').trim();
    if (!key) return 0;
    const row = db.prepare('SELECT updated_at FROM roles WHERE name = ?').get(key);
    return row ? Number(row.updated_at) || 0 : 0;
  }

  function write(name, content) {
    const key = String(name ?? '').trim();
    if (!key) throw new Error('人格名不能为空');
    const text = String(content ?? '').replace(/\r\n/g, '\n');
    if (!text.trim()) throw new Error('人格内容不能为空');
    const nowMs = Date.now();
    const existing = db.prepare('SELECT created_at FROM roles WHERE name = ?').get(key);
    db.prepare(`
      INSERT INTO roles (name, content, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(key, text, existing ? Number(existing.created_at) : nowMs, nowMs);
    return { name: key, createdAt: existing ? Number(existing.created_at) : nowMs, updatedAt: nowMs };
  }

  /** 修改人格名。调用方负责校验目标名是否已存在（控制台要返回 400）。 */
  function rename(from, to) {
    const source = String(from ?? '').trim();
    const target = String(to ?? '').trim();
    if (!source || !target) throw new Error('人格名不能为空');
    // 必须整行搬：改名时只带 content 会把音色与唤醒词静默丢掉（v4 新增的三列），
    // 自拍图库同理（v5）。
    const row = db.prepare('SELECT content, created_at, tts_voice, tts_voice_name, wake_keywords, selfie_dirs FROM roles WHERE name = ?').get(source);
    if (!row) throw new Error(`人格「${source}」不存在`);
    const nowMs = Date.now();
    transaction(db, () => {
      db.prepare('DELETE FROM roles WHERE name = ?').run(source);
      db.prepare(`INSERT INTO roles (name, content, created_at, updated_at, tts_voice, tts_voice_name, wake_keywords, selfie_dirs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(target, String(row.content), Number(row.created_at) || nowMs, nowMs,
          String(row.tts_voice ?? ''), String(row.tts_voice_name ?? ''), String(row.wake_keywords ?? '[]'),
          String(row.selfie_dirs ?? '[]'));
    });
    return { from: source, to: target, updatedAt: nowMs };
  }

  function remove(name) {
    const key = String(name ?? '').trim();
    const row = db.prepare('SELECT content FROM roles WHERE name = ?').get(key);
    if (!row) throw new Error(`人格「${key}」不存在`);
    db.prepare('DELETE FROM roles WHERE name = ?').run(key);
    return { ok: true, name: key, chars: String(row.content).length };
  }

  // ── 人格的形象与声音设定（自拍图库 + 音色 + 唤醒词）────────────────────
  // 与正文分开读写：改音色不该让「人格提示词热注入缓存」失效（缓存 key 是 updated_at），
  // 也不该把人格列表的「更新时间」推到刚刚——那会让人以为卡内容被改过。
  const VOICE_ID_MAX = 64;
  const VOICE_NAME_MAX = 40;
  const WAKE_KEYWORD_MAX_COUNT = 30;
  const WAKE_KEYWORD_MAX_CHARS = 40;
  const SELFIE_DIR_MAX_COUNT = 8;
  const SELFIE_DIR_MAX_CHARS = 240;

  function normalizeWakeKeywords(value) {
    const list = Array.isArray(value)
      ? value
      : String(value ?? '').split(/[,，、\n\r]+/);
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const word = String(item ?? '').trim();
      if (!word) continue;
      if (word.length > WAKE_KEYWORD_MAX_CHARS) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
      if (out.length >= WAKE_KEYWORD_MAX_COUNT) break;
    }
    return out;
  }

  function parseWakeKeywords(raw) {
    try {
      const parsed = JSON.parse(String(raw ?? '[]'));
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * 归一化自拍图库目录列表。
   *
   * 只做「形状」清洗，不做存在性校验：目录可能在别的盘、可能要等挂载，
   * 真伪交给取图时的 resolveSelfieDirs 判断（它会把不存在的目录跳过并记日志）。
   * 但含 `..` 的路径一律丢弃——那是「写到 assets 外面去」的唯一入口，
   * 而自拍库的语义是「我长什么样」，没有理由指向父目录。
   */
  function normalizeSelfieDirs(value) {
    const list = Array.isArray(value)
      ? value
      : String(value ?? '').split(/[\n\r,，;；]+/);
    const seen = new Set();
    const out = [];
    for (const item of list) {
      // 容忍从资源管理器复制来的引号包裹路径。
      const raw = String(item ?? '').trim().replace(/^["']|["']$/g, '').trim();
      if (!raw) continue;
      if (raw.length > SELFIE_DIR_MAX_CHARS) continue;
      if (raw.split(/[/\\]+/).includes('..')) continue;
      const key = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
      if (out.length >= SELFIE_DIR_MAX_COUNT) break;
    }
    return out;
  }

  function parseSelfieDirs(raw) {
    try {
      const parsed = JSON.parse(String(raw ?? '[]'));
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** 每次返回新对象：调用方可能改动数组，共享常量会互相污染。 */
  const emptyProfile = () => ({ voice: '', voiceName: '', wakeKeywords: [], selfieDirs: [] });

  /** 读一个人格的设定。空字符串 / 空数组 = 跟随全局默认（config.json）。 */
  function readProfile(name) {
    const key = String(name ?? '').trim();
    if (!key) return emptyProfile();
    const row = db.prepare('SELECT tts_voice, tts_voice_name, wake_keywords, selfie_dirs FROM roles WHERE name = ?').get(key);
    if (!row) return emptyProfile();
    return {
      voice: String(row.tts_voice ?? ''),
      voiceName: String(row.tts_voice_name ?? ''),
      wakeKeywords: parseWakeKeywords(row.wake_keywords),
      selfieDirs: parseSelfieDirs(row.selfie_dirs)
    };
  }

  /**
   * 写设定。patch 里没出现的字段保持不变（四个字段各写各的，互不覆盖）。
   * 不接受「人格不存在」的写入：静默 upsert 会造出半截人格，列表里看不见。
   */
  function writeProfile(name, patch = {}) {
    const key = String(name ?? '').trim();
    if (!key) throw new Error('人格名不能为空');
    if (!db.prepare('SELECT 1 AS hit FROM roles WHERE name = ?').get(key)) throw new Error(`人格「${key}」不存在`);
    const current = readProfile(key);
    const next = {
      voice: patch.voice === undefined ? current.voice : String(patch.voice ?? '').trim().slice(0, VOICE_ID_MAX),
      voiceName: patch.voiceName === undefined ? current.voiceName : String(patch.voiceName ?? '').trim().slice(0, VOICE_NAME_MAX),
      wakeKeywords: patch.wakeKeywords === undefined ? current.wakeKeywords : normalizeWakeKeywords(patch.wakeKeywords),
      selfieDirs: patch.selfieDirs === undefined ? current.selfieDirs : normalizeSelfieDirs(patch.selfieDirs)
    };
    // 没有音色 id 时显示名也无意义：一起清空，避免「已删除的音色 + 旧名字」残留。
    if (!next.voice) next.voiceName = '';
    db.prepare('UPDATE roles SET tts_voice = ?, tts_voice_name = ?, wake_keywords = ?, selfie_dirs = ? WHERE name = ?')
      .run(next.voice, next.voiceName, JSON.stringify(next.wakeKeywords), JSON.stringify(next.selfieDirs), key);
    return next;
  }

  /**
   * 首次启动从 roles/*.md 一次性导入。
   * 原文件保留（回滚保险 + 人工可读的历史），但之后不再读目录。
   */
  function importLegacyMarkdown() {
    if (isImported(db, IMPORT_FLAG)) return { imported: 0, scanned: 0, skipped: true };
    let files = [];
    try {
      files = fs.readdirSync(storeDir).filter((name) => name.endsWith('.md') && !name.startsWith('.'));
    } catch { files = []; }
    let imported = 0;
    const insert = db.prepare('INSERT OR IGNORE INTO roles (name, content, created_at, updated_at) VALUES (?, ?, ?, ?)');
    transaction(db, () => {
      for (const file of files) {
        const name = file.slice(0, -3);
        if (!name || RESERVED_NAMES.has(name)) continue;
        let content = '';
        let mtimeMs = Date.now();
        try {
          content = fs.readFileSync(path.join(storeDir, file), 'utf8');
          mtimeMs = fs.statSync(path.join(storeDir, file)).mtimeMs || mtimeMs;
        } catch { continue; }
        const info = insert.run(name, content, mtimeMs, mtimeMs);
        if (Number(info.changes) > 0) imported += 1;
      }
      markImported(db, IMPORT_FLAG);
    });
    return { imported, scanned: files.length, skipped: false };
  }

  /** 导出回 Markdown（默认 roles/）：人工 diff、整库回滚、或迁移到别的机器时用。 */
  function exportMarkdown(targetDir = storeDir) {
    if (!targetDir) throw new Error('exportMarkdown 需要目标目录');
    const outDir = path.resolve(targetDir);
    fs.mkdirSync(outDir, { recursive: true });
    const rows = db.prepare('SELECT name, content FROM roles ORDER BY name').all();
    for (const row of rows) {
      fs.writeFileSync(path.join(outDir, `${String(row.name)}.md`), String(row.content), 'utf8');
    }
    return { exported: rows.length, dir: outDir };
  }

  return {
    dir: storeDir,
    listNames,
    has,
    read,
    write,
    rename,
    remove,
    readProfile,
    writeProfile,
    updatedAt,
    importLegacyMarkdown,
    exportMarkdown
  };
}
