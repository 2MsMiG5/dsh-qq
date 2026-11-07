// local-images.js — 本地图库：目录解析 + 「最近发过」轮换记录。
//
// 为什么单独成文件：发图功能的失败模式全在**配置与磁盘**上（目录写错、记录文件损坏），
// 而它的调用点散在 HTTP 路由与 MCP 工具两处。放在同一个文件里，可以让「配置错了会怎样」
// 一眼看完：目录全不存在才抛错（少一个目录只是少一个图库），记录文件坏了当空处理
// （轮换退化成随机，但发图本身不受影响）。
//
// 状态归属：IMAGE_RECENT_FILE 是桥接侧的路径常量（依赖 STATE_DIR），按值交入即可
// —— 它启动后就不会变；配置走 cfg（只读），日志走 bind（测试要断言告警文案）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_DEFAULTS } from '../image-source.js';

// 仓库自带的「自己的照片」形象图库：src/media/ → ../../assets
// 用 import.meta.url 而不是 __dirname：本文件是 ESM，没有 __dirname；
// 也不从 ROOT 注入，避免绑定时序问题（这个路径启动后就不会变）。
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));
// 项目根（assets 的上一级）：配置里写相对路径（如 "./assets"）时按它解析。
const PROJECT_ROOT = path.resolve(ASSETS_DIR, '..');

export function createLocalImages() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let IMAGE_RECENT_FILE, cfg, log;
  // 当前人格的自拍图库目录（读库，可能随时切换）。bind 成 getter 而不是值快照：
  // 人格是运行时可切的，「自拍照跟着人格走」靠的就是每次取图都重新读一次。
  let getRoleSelfieDirs;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ IMAGE_RECENT_FILE, cfg, log, getRoleSelfieDirs } = deps);
  }

  /** 安全的日志：未 bind 时（单测/脚本直接调用）不至于因为 log 是 undefined 崩掉。 */
  function note(message) {
    if (typeof log === 'function') log(message);
  }

  // ── 出站发图：本地图库「最近发过」的轮换记录 ──────────────────────────────
  // 只保存最近 N 条路径，让「随机发一张」不会连续撞同一张。文件损坏/不存在一律当空处理，
  // 绝不因为这份辅助状态读不出来就阻断发图。
  function loadRecentLocalImages() {
    try {
      const parsed = JSON.parse(fs.readFileSync(IMAGE_RECENT_FILE, 'utf8'));
      return Array.isArray(parsed?.paths) ? parsed.paths.filter((p) => typeof p === 'string') : [];
    } catch { return []; }
  }

  function rememberLocalImage(filePath, limit) {
    if (!filePath) return;
    const keep = Math.max(1, Math.min(200, Number(limit) || IMAGE_DEFAULTS.recentLimit));
    const next = [String(filePath), ...loadRecentLocalImages().filter((p) => p !== filePath)].slice(0, keep);
    try {
      fs.writeFileSync(IMAGE_RECENT_FILE, JSON.stringify({ paths: next, updatedAt: Date.now() }, null, 2), 'utf8');
    } catch (error) {
      // 轮换记忆写不进去不影响发图本身，但要留一行日志。
      log(`[image] 最近图片记录写入失败：${error?.message ?? error}`);
    }
  }

  // 解析配置里的图库目录：只保留真实存在的目录（不存在就跳过），全部不存在才报错。
  // 目的是让「配置里写错一个目录」变成「少一个图库」，而不是整条发图功能 500。
  function resolveImageDirs(imageCfg) {
    const dirs = Array.isArray(imageCfg?.dirs) ? imageCfg.dirs : [];
    const existing = [];
    for (const dir of dirs) {
      if (typeof dir !== 'string' || !dir.trim()) continue;
      const abs = path.resolve(dir);
      try { if (fs.statSync(abs).isDirectory()) existing.push(abs); } catch {}
    }
    if (!existing.length) {
      throw new Error(`配置的图库目录都不存在（socialV2.image.dirs）：${dirs.join(', ') || '（空）'}`);
    }
    return existing;
  }

  // 归一化 Pixeval 预览图尺寸；非法值返回 null（路由据此报 400，而不是静默改用默认值）。
  function normalizePixevalSize(value) {
    const allowed = ['square_medium', 'medium', 'large', 'not_cropped'];
    if (value === undefined || value === null || String(value).trim() === '') {
      return allowed.includes(imageDefaultsSize()) ? imageDefaultsSize() : 'not_cropped';
    }
    const raw = String(value).trim().toLowerCase();
    const alias = { square: 'square_medium', squaremedium: 'square_medium', notcropped: 'not_cropped' };
    const normalized = alias[raw] ?? raw;
    return allowed.includes(normalized) ? normalized : null;
  }

  function imageDefaultsSize() {
    return String(cfg.socialV2?.image?.pixevalSize || IMAGE_DEFAULTS.pixevalSize || 'not_cropped');
  }

  // 把配置里的一串目录解析成绝对路径，只保留真实存在的目录。
  // 相对路径按**项目根**解析，而不是进程 cwd：桥接可能被计划任务或别的目录启动，
  // cwd 一换 `./assets` 就指向别处，表现成「形象库不存在」。
  function resolveExistingDirs(dirs) {
    const existing = [];
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      if (typeof dir !== 'string' || !dir.trim()) continue;
      const raw = dir.trim();
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PROJECT_ROOT, raw);
      try { if (fs.statSync(abs).isDirectory()) existing.push(abs); } catch {}
    }
    return existing;
  }

  /** 当前人格配置的自拍图库目录（原始字符串，未做存在性判断）。 */
  function roleSelfieDirs() {
    if (typeof getRoleSelfieDirs !== 'function') return [];
    try {
      const dirs = getRoleSelfieDirs();
      return Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d.trim()) : [];
    } catch (error) {
      note(`[image] 读取人格自拍图库配置失败，回落到全局 selfDirs：${error?.message ?? error}`);
      return [];
    }
  }

  // 解析「自己的照片」形象库目录：人格配了就用**只**用它，否则回落到全局 selfDirs
  // （默认仓库里的 assets/）。
  //
  // 为什么不把两处合起来扫：人格的自拍库是「这个角色长什么样」，混进全局图库
  // 就等于让 A 人格用 B 人格的脸。人格目录配了却全部不存在时也不静默合并，
  // 而是记一行日志再回落全局——「配置写错」要看得出来，但不能让发图直接失效。
  //
  // 与 resolveImageDirs 分开是因为失败语义不同——形象库空/目录丢了不该 silently
  // 退化去随机别人的图（那是"拿别人的图冒充自己"），所以最终没有任何目录时明确报错。
  function resolveSelfieDirs(imageCfg, roleDirs) {
    const own = Array.isArray(roleDirs) ? roleDirs : roleSelfieDirs();
    const ownExisting = resolveExistingDirs(own);
    if (ownExisting.length) return ownExisting;
    if (own.length) {
      note(`[image] 人格自拍图库目录都不存在（${own.join(', ')}），回落到全局 selfDirs`);
    }
    const dirs = Array.isArray(imageCfg?.selfDirs) && imageCfg.selfDirs.length
      ? imageCfg.selfDirs
      : [ASSETS_DIR];
    const existing = resolveExistingDirs(dirs);
    if (!existing.length) {
      throw new Error(`自己的形象图库目录不存在（socialV2.image.selfDirs）：${dirs.join(', ')}`);
    }
    return existing;
  }

  // 控制台用：把一串自拍目录翻译成「能不能用、里面有多少张图」。
  // 只数扩展名，不读魔数也不看体积——这里回答的是「路径对不对、图归没归对地方」，
  // 不是「这张图能不能发」。所以给一个扫描上限，指到 C:\ 时也不会卡住控制台。
  const INSPECT_LIMIT = 5000;
  function countImages(root) {
    const exts = new Set(IMAGE_DEFAULTS.exts);
    let count = 0;
    let scanned = 0;
    const stack = [root];
    while (stack.length && scanned < INSPECT_LIMIT) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        scanned += 1;
        if (scanned >= INSPECT_LIMIT) break;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          stack.push(path.join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        if (exts.has(path.extname(entry.name).toLowerCase())) count += 1;
      }
    }
    return { count, truncated: scanned >= INSPECT_LIMIT };
  }

  /**
   * @param {string[]} dirs 人格配置的目录（原始字符串）
   * @returns {{configured: string[], resolved: string[], images: number, entries: Array<{dir:string, abs:string|null, exists:boolean, images:number}>, truncated: boolean}}
   */
  function inspectSelfieDirs(dirs) {
    const configured = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d.trim()) : [];
    const entries = [];
    let images = 0;
    let truncated = false;
    for (const raw of configured) {
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PROJECT_ROOT, raw);
      let exists = false;
      try { exists = fs.statSync(abs).isDirectory(); } catch {}
      const counted = exists ? countImages(abs) : { count: 0, truncated: false };
      if (counted.truncated) truncated = true;
      images += counted.count;
      entries.push({ dir: raw, abs: exists ? abs : null, exists, images: counted.count });
    }
    return {
      configured,
      resolved: entries.filter((e) => e.exists).map((e) => e.abs),
      images,
      entries,
      truncated
    };
  }

  return { bind, loadRecentLocalImages, rememberLocalImage, resolveImageDirs, resolveSelfieDirs, roleSelfieDirs, inspectSelfieDirs, normalizePixevalSize, imageDefaultsSize };
}
