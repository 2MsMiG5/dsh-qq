// index.js — 人物档案（跨会话长期档案）这一层：目录解析、索引摘要、focus 预取、读写操作。
//
// 为什么单独一层：聊天热点状态每轮全量注入 prompt，写多了就是纯烧
// token；人物档案**只注入索引**（标题/摘要/更新时间/字数），正文由 qq_person 按需读取。
// 文件是 Markdown + YAML front matter，人工可直接用编辑器改，控制台也提供编辑器。
//
// 状态归属：personStoreCache / personFocusLogCache 由本模块独占 —— 它们只服务于这里的
// 读取路径，桥接侧持有副本只会变成「两处缓存、各自过期」。
// 依赖注入：ROOT / cfg / log 与 getSocialV2State 全部走 bind，不在这里 import，
// 测试才能注入桩实现。

import path from 'node:path';
import { truncateText } from '../md-to-plain.js';
import { createPersonStore } from '../person-memory.js';

/**
 * 事实去重：档案会随每条消息注入，同一件事记三遍比不记更糟（模型会当成强调点反复提）。
 * 只做粗粒度比对——去标点空白后看新事实的前 12 字是否已出现在正文里。
 * 不做编辑距离：档案是给人看的长期资料，宁可漏判也不要把「喜欢猫粮」误伤成「喜欢猫」。
 */
export function normalizeForDedupe(text) {
  return String(text ?? '').toLowerCase().replace(/[\s，。、！？：；,.!?:;"'“”‘’（）()《》【】[\]-]/g, '');
}

export function isKnownFact(body, fact) {
  const hay = normalizeForDedupe(body);
  const needle = normalizeForDedupe(fact);
  if (!hay || !needle) return false;
  // 探针取前 8 字（不足则全长）。为什么是 8：
  //   · 模型的措辞每轮都在飘（「可能要动手术」→「可能需动手术」），探针越长越容易把
  //     同一件事判成两件，档案就被同一句话灌满；
  //   · 短于 8 字时退化成全文比对，「喜欢猫」不会被「喜欢猫粮」误伤；
  //   · 前 8 字全同、后面不同的两件事，现实中基本就是同一件事的两次复述。
  const probe = Array.from(needle).slice(0, 8).join('');
  return hay.includes(probe);
}

export function createPersonMemory() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let ROOT, appendActivity, cfg, db, getSocialV2State, log, redactKnownTokensOnly;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ ROOT, appendActivity, cfg, db, getSocialV2State, log, redactKnownTokensOnly } = deps);
  }

  // 本模块独占的缓存：桥接侧不再持有副本，避免「两处各缓存一份、行为分叉」。
  let personStoreCache = null;            // createPersonStore() 的实例（配置变化前复用）
  let personFocusLogCache = { key: '' };  // 本轮命中的档案 key 集合，仅用于日志去重

  /**
   * 人物档案目录：cfg.personMemory.dir，相对路径按仓库根解析。
   */
  function personStoreDir() {
    const configured = String(cfg.personMemory?.dir || 'memory').trim() || 'memory';
    return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
  }

  function personStore() {
    if (cfg.personMemory?.enabled === false) return null;
    if (!personStoreCache) {
      const store = createPersonStore({
        dir: personStoreDir(),
        db: db(),
        dbFile: path.join(ROOT, 'state', 'bridge.db'),
        redact: (value) => redactKnownTokensOnly(String(value ?? '')),
        maxProfiles: Math.max(1, Math.min(2000, Number(cfg.personMemory?.maxProfiles) || 300)),
        maxProfileChars: Math.max(1000, Math.min(2_000_000, Number(cfg.personMemory?.maxProfileChars) || 200000)),
        log
      });
      // 目录/库不可用只降级：不让整条桥接启动失败。
      try { store.ensureDir(); } catch (error) {
        log(`人物档案目录创建失败（不影响主流程）：${error?.message ?? error}`);
      }
      // 首次启动把 memory/*.md 导入库；原文件保留作回滚保险。
      try {
        const migrated = store.importLegacyMarkdown();
        if (!migrated.skipped) log(`人物档案已从 Markdown 迁移：导入 ${migrated.imported}/${migrated.scanned} 份`);
      } catch (error) {
        log(`人物档案迁移失败（继续用现有库运行）：${error?.message ?? error}`);
      }
      personStoreCache = store;
    }
    return personStoreCache;
  }

  function personMemoryIndexText() {
    if (cfg.personMemory?.enabled === false || cfg.personMemory?.injectIndex === false) return '';
    const store = personStore();
    if (!store) return '';
    try { return store.formatIndex(Number(cfg.personMemory?.injectMax) || 12); }
    catch (error) {
      log(`人物档案索引生成失败：${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 每轮唤醒注入的【人物档案摘要】。
   * `excludeIds` 传本轮已预取正文的人：同一份档案不在一轮 prompt 里出现两遍
   * （重复出现会被模型当成「这件事很重要」，于是反复提）。
   */
  function personMemorySummaryText(excludeIds = []) {
    if (cfg.personMemory?.enabled === false || cfg.personMemory?.injectSummary === false) return '';
    const store = personStore();
    if (!store) return '';
    try {
      const text = store.formatSummaryIndex(Number(cfg.personMemory?.injectSummaryMax) || 6, {
        summaryChars: Number(cfg.personMemory?.injectSummaryChars) || 160,
        pinnedOnly: cfg.personMemory?.injectPinnedOnly !== false,
        excludeIds
      });
      return String(text || '');
    } catch (error) {
      log(`人物档案摘要生成失败：${error?.message ?? error}`);
      return '';
    }
  }

  function defaultPersonTargetId(key) {
    const [kind, id] = String(key ?? '').split(':');
    return kind === 'private' && /^\d{5,12}$/.test(String(id ?? '')) ? `person-${id}` : '';
  }

  /**
   * 本轮「@ 指谁」：私聊是对方；群聊是**本轮最新发言人**。
   *
   * 为什么要这一步：群聊的消息行只渲染昵称（模型看不到 QQ），让它自己写昵称去命中档案
   * 仍然不可靠（昵称不唯一/改过名 ⇒ resolveRef 建出一份 person-n-<hash> 的重复档案）。
   * 有了这个 fallback，模型在所有场景都能统一写 [PERSON:note:@]，QQ 号由桥接补。
   */
  function currentPersonTargetId(key) {
    const direct = defaultPersonTargetId(key);
    if (direct) return direct;
    try {
      const st = getSocialV2State(key);
      const unread = Array.isArray(st?.unread) ? st.unread : [];
      for (let i = unread.length - 1; i >= 0; i -= 1) {
        const msg = unread[i];
        if (!msg || msg.isSelf) continue;
        const uid = String(msg.userId || '').trim();
        if (/^\d{5,12}$/.test(uid)) return `person-${uid}`;
      }
    } catch {}
    return '';
  }

  /**
   * 本轮「自动带正文」的档案：当前正在说话的人。
   *
   * 命中规则（不依赖模型主动，也不依赖「最近更新」排序）：
   *   1. 私聊：对话对方 person-<QQ>；
   *   2. 群聊：本轮未读里最近发言的真人成员 person-<userId>，最多 focusMaxPeople 个。
   * 只返回**真实存在**的档案：不存在就不占位，省得模型以为「有档案可读」而反复试探。
   */
  function personFocusProfiles(key, unread) {
    if (cfg.personMemory?.enabled === false || cfg.personMemory?.injectFocusBody === false) return [];
    const store = personStore();
    if (!store) return [];
    const maxPeople = Math.max(1, Math.min(4, Number(cfg.personMemory?.focusMaxPeople) || 2));
    const profiles = [];
    const seen = new Set();
    const addIfExists = (id) => {
      const value = String(id || '').trim().toLowerCase();
      if (!value || seen.has(value) || profiles.length >= maxPeople) return;
      seen.add(value);
      let detail = null;
      try { detail = store.get(value); } catch { detail = null; }
      if (!detail) return;
      // 只带三段概况：时间线不进预取（每轮塞十几条旧事，模型就开始逐条回味）。
      profiles.push({ id: detail.id, meta: detail.meta, sections: detail.sections });
    };
    // 私聊优先：对方就是这轮唯一的说话人。
    addIfExists(defaultPersonTargetId(key));
    // 群聊：从最新一条往前取发言人的档案。
    const list = Array.isArray(unread) ? unread : [];
    for (let i = list.length - 1; i >= 0 && profiles.length < maxPeople; i -= 1) {
      const msg = list[i];
      if (!msg || msg.isSelf) continue;
      const uid = String(msg.userId || '').trim();
      if (/^\d{5,12}$/.test(uid)) addIfExists(`person-${uid}`);
    }
    return profiles;
  }

  function personFocusText(key, unread, picked) {
    if (cfg.personMemory?.enabled === false || cfg.personMemory?.injectFocusBody === false) return '';
    const store = personStore();
    if (!store) return '';
    const profiles = Array.isArray(picked) ? picked : personFocusProfiles(key, unread);
    if (!profiles.length) return '';
    const group = String(key ?? '').startsWith('group:');
    const maxChars = Math.max(200, Math.min(8000, Number(cfg.personMemory?.focusMaxChars) || 1500));
    const blocks = [];
    for (const profile of profiles) {
      try {
        const block = store.formatFocusBlock(profile, { maxChars, group });
        if (block) blocks.push(block);
      } catch (error) {
        log(`人物档案预取格式失败（${profile.id}）：${error?.message ?? error}`);
      }
    }
    if (!blocks.length) return '';
    const stamp = `${key}:${profiles.map((p) => p.id).join(',')}`;
    if (personFocusLogCache.key !== stamp) {
      personFocusLogCache = { key: stamp };
      const size = (p) => {
        const s = p.sections || {};
        return Array.from(`${s.who || ''}${s.traits || ''}${s.notes || ''}`).length;
      };
      log(`[person] ${key} 预取档案概况：${profiles.map((p) => `${p.id}(${size(p)}字)`).join('、')}`);
    }
    return blocks.join('\n\n');
  }

  /**
   * 执行模型输出的 [PERSON:...] 指令（读写人物档案）。
   * 只做「写」：read 的正文在调用模型前就补进上下文了（见 runLiteDirectWake）。
   * 任何一条失败都只记日志，绝不影响这一轮的正常发消息。
   *
   * 两类写入分工明确：
   *   note            → 时间线追加一条（主回复就该只做这件事）
   *   who/traits/notes → 概况整段重写（纪要兼职读完整段对话后归纳，主回复里不该出现）
   */
  async function applyPersonOps(key, ops) {
    if (!Array.isArray(ops) || !ops.length) return;
    const store = personStore();
    if (!store) {
      log(`[person] 档案功能已关闭，忽略 ${ops.length} 条指令（${key}）`);
      return;
    }
    const fallbackId = currentPersonTargetId(key);
    // 上限 6：纪要兼职一次可能写「≤2 条时间线 + 最多 3 段概况」，主回复通常只有 1~2 条。
    for (const op of ops.slice(0, 6)) {
      try {
        if (op.action === 'note') {
          // 写之前先看时间线里有没有同样的事，避免每轮醒来把同一句话再记一遍。
          // 只比对时间线（最近 40 条）：三段是概括，拿它去重会把「喜欢猫粮」误判成「喜欢猫」。
          let existing = null;
          try {
            const target = store.resolveRef(op.ref, { fallbackId });
            existing = target.existing ? store.get(target.id) : null;
          } catch { existing = null; }
          const recent = (existing?.timeline || []).slice(-40).map((entry) => String(entry.text || '')).join('\n');
          if (existing && isKnownFact(recent, op.text)) {
            log(`[person] ${key} 跳过重复事实（${existing.id}）：${truncateText(String(op.text ?? ''), 40)}`);
            continue;
          }
          const saved = store.note(op.ref, op.text, { fallbackId });
          log(`[person] ${key} 追加时间线 ${saved.id}：${truncateText(String(op.text ?? ''), 40)}`);
          appendActivity(`${key} 人物档案追加：${saved.id}`);
        } else if (op.action === 'save') {
          const saved = store.upsert(op.ref, { title: op.title, summary: op.summary }, { fallbackId });
          log(`[person] ${key} 写入档案 ${saved.id}（${saved.chars} 字）`);
          appendActivity(`${key} 人物档案写入：${saved.id}`);
        } else if (op.action === 'who' || op.action === 'traits' || op.action === 'notes') {
          const saved = store.updateSection(op.ref, op.action, op.text, { fallbackId });
          appendActivity(`${key} 人物档案概况：${saved.id}（${op.action}）`);
        }
      } catch (error) {
        log(`[person] ${key} 指令失败（${op.action}:${op.ref}）：${error?.message ?? error}`);
      }
    }
  }

  function personProfileForRead(ref, key) {
    const store = personStore();
    if (!store) return null;
    try {
      const target = store.resolveRef(ref, { fallbackId: currentPersonTargetId(key) });
      const detail = store.get(target.id);
      if (!detail) return null;
      // 读全文 = 摘要 + 三段 + 时间线；body 由 store 按预算拼好（时间线从新到旧）。
      // sections / recentFacts 额外给纪要兼职用：归纳「是谁/性格/注意」时得先看到旧的三段，
      // 否则模型只能写出「这段对话里他表现得…」，一覆盖就把历史全丢了。
      return {
        id: detail.id,
        title: detail.meta?.title || detail.id,
        body: store.formatReadBlock(detail, { maxChars: Number(cfg.personMemory?.readMaxChars) || 3000 }),
        sections: detail.sections,
        recentFacts: (detail.timeline || []).slice(-3).map((entry) => String(entry.text || '')).filter(Boolean)
      };
    } catch (error) {
      log(`[person] 读档案失败（${ref}）：${error?.message ?? error}`);
      return null;
    }
  }

  return { bind, personStoreDir, personStore, personMemoryIndexText, personMemorySummaryText, defaultPersonTargetId, currentPersonTargetId, personFocusProfiles, personFocusText, applyPersonOps, personProfileForRead };
}
