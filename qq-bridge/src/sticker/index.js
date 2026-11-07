// index.js — 从 src/bridge.js 抽取的函数簇（9 个函数）。
//
// 采用「延迟绑定」：工厂先返回可调用的函数，boot 装配完成后再 bind 一次依赖。
// 原因是这些函数依赖 bot / handles 等在 boot 尾部才创建的对象，在工厂创建时解构会撞 TDZ。
//
// 三条规则（违反任一条都会静默出错）：
//   1) 可变状态必须 bind **取值函数**，不能 bind 值快照——否则模块看到的是永久冻结的旧状态。
//   2) 函数体与原实现逐字一致，只把闭包引用改为 bind 进来的局部变量。
//   3) 凡是能被测试/调用方替换的能力（抓取、外部服务调用），一律走 bind，不要在这里 import。
//      原实现从 boot 外层作用域取这些名字，调用方通过注入同名绑定来替换；改成直接 import
//      会绕过那个注入点——调用方以为自己换了实现，实际跑的还是真模块（假绿）。
//   4) **本域自有状态**（表情库数据、可写标志、同步时间戳）不 bind、不外置：
//      它们只服务于这个域，由模块独占；bridge 要读就调 getEntries()。
//      若改成 bind 值绑定，立刻出现「模块写自己那份、bridge 读旧那份」的分叉——
//      markStickerUsed 返回的是**新数组**，这正是表情 usage 不增长的那个 bug。

import http from 'node:http';
import { truncateText } from '../md-to-plain.js';
import { loadStickerStore, saveStickerStore, mergeStickerLibrary, findSticker, formatStickerList, applyStickerNote } from '../sticker-lib.js';

export function createStickerService() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let MAX_MEDIA_BYTES, MAX_MEDIA_FETCH_BYTES, STICKER_FILE, bot, captureSendGuard, cfg, getSocialV2State, log, onebotHttpAction, socialV2;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ MAX_MEDIA_BYTES, MAX_MEDIA_FETCH_BYTES, STICKER_FILE, bot, captureSendGuard, cfg, getSocialV2State, log, onebotHttpAction, socialV2 } = deps);
  }

  // ── 本域自有状态 ────────────────────────────────────────────────────────
  // 表情库是「模块独占」的：bridge 不再持有 entries，只通过访问器读写。
  // 这样就不需要 get/set 双向接线，也不会出现两份副本谁改谁不生效的问题。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  let stickerSyncedAt = 0;

  /**
   * 启动时加载表情库。**读失败不能当成空库继续**：
   * 之后任何一次 saveStickerStoreSafe 都会把「空库」写回磁盘，
   * 把 AI 学到的 localNote / tags / usage 永久清零。
   * 所以读失败显式降级为「只读不写」，并留下醒目日志。
   */
  function load({ file, log: logFn }) {
    try {
      stickerEntries = loadStickerStore(file);
    } catch (error) {
      stickerStoreWritable = false;
      logFn(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
  }

  const getEntries = () => stickerEntries;
  const setEntries = (value) => { stickerEntries = value; };
  const isWritable = () => stickerStoreWritable;
  const getSyncedAt = () => stickerSyncedAt;

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      let response;
      let via = 'ws';
      try {
        response = await bot.request('fetch_custom_face_detail', { count });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
        }
      } catch (wsError) {
        // WS 失败 ⇒ 立刻用 HTTP 再问一次同一个 action（语义相同，token 可能不同但同一账号）。
        log(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
        response = await onebotHttpAction('fetch_custom_face_detail', { count });
        via = 'http';
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条，via ${via}）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false, via };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  function liteStickerChoices() {
    const lite = cfg.socialV2?.liteChat ?? {};
    const max = Math.max(0, Math.min(12, Number(lite.stickerMax) || 6));
    if (max === 0 || !stickerEnabled()) return [];
    const entries = Array.isArray(stickerEntries) ? stickerEntries.slice() : [];
    entries.sort((a, b) => (Number(b?.useCount) || 0) - (Number(a?.useCount) || 0));
    const out = [];
    for (const entry of entries) {
      const id = String(entry?.id || entry?.emoji_id || entry?.resId || '').trim();
      const label = String(entry?.localNote || entry?.desc || '').replace(/\s+/g, ' ').trim();
      if (!id || !label) continue;
      out.push({ id, label: truncateText(label, 12) });
      if (out.length >= max) break;
    }
    return out;
  }

  return { bind, load, getEntries, setEntries, isWritable, getSyncedAt, stickerEnabled, saveStickerStoreSafe, syncStickerLibrary, listStickersForV2, getStickerImageData, applyStickerNoteV2, setStickerRemarkV2, liteStickerChoices };
}
