// index.js — 会话「初始提示词」存储：读写 state/initial-prompts.json。
//
// 为什么单独成文件：这是一份**操作者手写的配置**，生命周期与仿真状态机完全无关——
// 重置 AI 上下文不该清掉它，群还没说过话时也要能先写好。它有自己的磁盘文件、
// 自己的降级策略（读坏 → 只读不写，绝不覆盖操作者的内容）。混在 bridge.js 的
// 6000 行闭包里时，这条「只读降级」规则极容易被后来的人改错。
//
// 状态归属：域独占。`entries`（Map）与 `writable`（降级标记）只有本模块碰，
// 桥接侧通过 getEntries() / isWritable() 读，不再持有副本。
//   · entries 是 const Map，从不整体替换 → 直接交出引用是安全的；
//   · writable 是 let，会被改成 false → 必须走取值函数，传值会永远看到启动时的 true。
//
// bind 时机：loadInitialPrompts() 在 boot 中段（紧接 loadSocialV2State）就要跑，
// 而 handles / httpLiveValues 更早就会取用本模块的函数，所以 bind 必须落在
// `cfg` 就绪之后、这两处之前，不能等到尾部统一注入。

import fs from 'node:fs';

export function createInitialPromptStore() {
  const entries = new Map();   // canonicalKey -> { text, createdAt, updatedAt }
  let writable = true;

  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let INITIAL_PROMPTS_FILE, atomicWriteJson, canonicalV2Key, cfg, log;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ INITIAL_PROMPTS_FILE, atomicWriteJson, canonicalV2Key, cfg, log } = deps);
  }

  /** 条目映射本体（引用恒定，供 HTTP 列表接口直接遍历） */
  function getEntries() {
    return entries;
  }

  /** 是否处于可写状态（false = 读坏了，已降级为只读，不会覆盖原文件） */
  function isWritable() {
    return writable;
  }

  function initialPromptMaxChars() {
    const n = Number(cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        writable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      writable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      entries.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (entries.size) log(`已加载 ${entries.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!writable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of entries) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (entries.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = entries.get(canonical) ?? null;
    const rollback = () => { if (prev) entries.set(canonical, prev); else entries.delete(canonical); };
    if (!text) {
      entries.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    entries.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  return { bind, getEntries, isWritable, initialPromptMaxChars, normalizeInitialPromptText, loadInitialPrompts, saveInitialPrompts, getInitialPrompt, setInitialPrompt };
}
