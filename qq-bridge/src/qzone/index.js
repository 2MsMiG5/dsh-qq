// QQ 空间动态（说说）发布能力：授权 → 参数校验 → 内容组装 → 审计 → 限频 → 调用 OneBot。
//
// 四条设计原则（都写死在这里，别在别处偷偷放宽）：
//
//   1. **授权是操作者的权力。** AI 只能提交素材（主题/正文/情绪/图片/可见范围），
//      不能改策略、不能给自己续期。策略与授权凭证只存在于 state/qzone-policy.json，
//      改它的唯一入口是控制台或 CLI（两者都要 consoleToken）。
//   2. **单一闸门，失败关闭。** 任何一次真实发布都必须过 assertCanPublish()，
//      它返回 not-ok 就是不发，绝不存在"绕过一下就好"的分支。
//   3. **模型给的事实一个字都不改。** content 原样保留；情绪只追加一个结尾符号，
//      主题只加一个 #话题# 前缀。渲染做了什么都记在 notes 里回给调用方，
//      避免 AI 以为"我写的内容会被润色"而偷懒或乱写。
//   4. **本地图片只能来自图库白名单。** 否则这个接口等于给 AI 开了一条
//      "把本机任意文件上传到公网空间"的路。URL 也要先过 SSRF 预检。
//
// 与 OneBot 的对接点：SnowLuma 的 `send_qzone_msg` action（见 _snowluma-catalog.json）。
// 参数只有 content / images / ugc_right / target_uins，所以"主题/情绪"必须在桥接侧
// 就渲染进 content —— 网关不认识这两个概念。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SENSITIVE_RE } from '../sensitive.js';
import { validateFetchUrl } from '../safe-fetch.js';
import { clampInt } from '../util/num.js';

/**
 * 可见范围 → OneBot `ugc_right`。
 *
 * 这五个值是 SnowLuma catalog 里写明的枚举，不能自己发明：
 * 1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见。
 * 16/128 必须带 target_uins，网关有 invariant 校验。
 */
export const QZONE_VISIBILITIES = {
  public: { label: '公开（所有人可见）', ugcRight: 1, needsTargets: false },
  friends: { label: '好友可见', ugcRight: 4, needsTargets: false },
  partial_show: { label: '部分好友可见', ugcRight: 16, needsTargets: true },
  partial_hide: { label: '部分好友不可见', ugcRight: 128, needsTargets: true },
  private: { label: '仅自己可见', ugcRight: 64, needsTargets: false }
};

// 中文/英文别名都收，避免 AI 因为词形不同直接被拒。归一化后再做授权判断。
const VISIBILITY_ALIASES = new Map(Object.entries({
  公开: 'public', 所有人: 'public', all: 'public', everyone: 'public', open: 'public',
  好友: 'friends', friend: 'friends', friends_only: 'friends',
  部分可见: 'partial_show', 指定可见: 'partial_show', 白名单: 'partial_show',
  include: 'partial_show', show: 'partial_show', some: 'partial_show',
  部分不可见: 'partial_hide', 指定不可见: 'partial_hide', 黑名单: 'partial_hide',
  exclude: 'partial_hide', hide: 'partial_hide',
  私密: 'private', 仅自己: 'private', 仅自己可见: 'private', self: 'private', only_me: 'private', secret: 'private'
}));

/** 策略默认值。授权状态（enabled/expiresAt）不在这里——它只由 grant 写入。 */
export const DEFAULT_SETTINGS = {
  requireApproval: true,          // 每次发布先挂起等人工批准（授权模型的核心）
  dailyQuota: 3,                  // 每天最多几条
  hourlyQuota: 2,                 // 每小时最多几条
  minIntervalMs: 600_000,         // 两条之间最短间隔（10 分钟）
  defaultVisibility: 'friends',   // 未指定可见范围时的默认值
  allowedVisibilities: ['friends', 'private'], // 授权范围上界：AI 不能自己扩大
  allowImages: true,
  maxImages: 9,                   // QQ 空间九宫格上限
  maxChars: 1000,                 // 渲染后正文上限（QQ 空间本身约 2000）
  allowTopic: true,
  quietHours: [1, 7],             // 本地时间 [起, 止)，跨零点写法同样支持
  pendingTtlMs: 600_000           // 待审条目的存活时间（10 分钟）
};

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const MAX_TOPIC_CHARS = 40;
const MAX_TARGET_UINS = 200;

/**
 * 已废弃的策略键：读到就丢弃，不再回给控制台、也不再写回。
 * 情绪参数于 2026-11-01 移除，`moodEnabled` 属于这一类。
 */
const DEPRECATED_SETTINGS = ['moodEnabled'];

/** 带 HTTP 状态码的业务错误：路由层直接拿去回包。 */
class QzoneError extends Error {
  constructor(message, { httpStatus = 400, code = 'INVALID_PARAMS' } = {}) {
    super(message);
    this.name = 'QzoneError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * 情绪（`mood`）参数已按管理员要求移除（2026-11-01）。
 *
 * 传了就**报错**，不静默忽略：调用方会以为语气被控制了，实际什么都没发生——
 * 和「指定了不存在的人格不能降级成无人设」是同一个理由，假成功比失败更糟。
 * 空值（''、null、undefined）当作没传：老客户端清空字段不该被判错。
 */
export function assertNoMood(params) {
  const raw = params?.mood;
  if (raw === undefined || raw === null || String(raw).trim() === '') return;
  throw new QzoneError(
    `情绪参数已移除（收到「${String(raw).slice(0, 20)}」）：语气请直接写进 content，桥接不再补任何结尾符号`,
    { code: 'MOOD_REMOVED' }
  );
}

function readJsonFile(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 规范化可见范围：别名 → key。 */
export function normalizeVisibility(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (Object.hasOwn(QZONE_VISIBILITIES, lower)) return lower;
  return VISIBILITY_ALIASES.get(s) ?? VISIBILITY_ALIASES.get(lower) ?? '';
}

/** 当前小时是否落在安静时段内。支持 [23,7] 这种跨零点写法。 */
export function inQuietHours(hour, range) {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const from = Number(range[0]);
  const to = Number(range[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 文件是否位于白名单目录之内（含 realpath 解析，挡软链接逃逸）。
 * Windows 大小写不敏感，比较前统一小写。
 */
function isInsideAnyDir(file, dirs) {
  let real;
  try { real = fs.realpathSync(file); } catch { return false; }
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return dirs.some((dir) => {
    let realDir;
    try { realDir = fs.realpathSync(dir); } catch { return false; }
    const rel = path.relative(norm(realDir), norm(real));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

export function createQzoneService({ cfg, log = () => {}, stateDir, atomicWriteJson, onebotHttpAction, knownAgentTokens = new Set(), drafter = null }) {
  const policyFile = path.join(stateDir, 'qzone-policy.json');
  const pendingFile = path.join(stateDir, 'qzone-pending.json');
  const postsFile = path.join(stateDir, 'qzone-posts.jsonl');

  // 内存里的策略副本：单进程模型，写时同步落盘，所以不需要每次读文件。
  let policy = null;
  let pending = null;
  let posts = null;

  const featureEnabled = () => cfg.socialV2?.qzone?.enabled !== false;

  function loadPolicy() {
    if (policy) return policy;
    const raw = readJsonFile(policyFile, {});
    const settings = { ...DEFAULT_SETTINGS, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) };
    // 已废弃的键从内存里剔除：情绪参数移除了，`moodEnabled` 留在 settings 里
    // 只会被 describePolicy 原样回给控制台，看着像「还有个开关没生效」。
    // 不主动改盘——下一次 grant / 改设置保存时自然就写没了。
    for (const key of DEPRECATED_SETTINGS) delete settings[key];
    policy = {
      version: 1,
      enabled: raw.enabled === true,
      grantId: typeof raw.grantId === 'string' ? raw.grantId : '',
      grantedAt: raw.grantedAt ?? null,
      grantedBy: raw.grantedBy ?? null,
      expiresAt: raw.expiresAt ?? null,
      revokedAt: raw.revokedAt ?? null,
      revokeReason: raw.revokeReason ?? '',
      lastUsedAt: raw.lastUsedAt ?? null,
      settings
    };
    return policy;
  }

  function savePolicy() {
    atomicWriteJson(policyFile, policy);
  }

  function loadPending() {
    if (pending) return pending;
    const raw = readJsonFile(pendingFile, []);
    pending = Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object' && e.id) : [];
    return pending;
  }

  function savePending() {
    atomicWriteJson(pendingFile, pending);
  }

  function loadPosts() {
    if (posts) return posts;
    posts = [];
    try {
      const raw = fs.readFileSync(postsFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-500);
      for (const line of lines) {
        try { posts.push(JSON.parse(line)); } catch {}
      }
    } catch {
      // 文件不存在是正常状态（还没发过）
    }
    return posts;
  }

  /** 追加审计记录。写盘失败只记日志：审计失败不该让已经发出去的说说"回滚"。 */
  function recordPost(entry) {
    const row = { ts: new Date().toISOString(), ...entry };
    loadPosts().push(row);
    if (posts.length > 500) posts.splice(0, posts.length - 500);
    try {
      fs.appendFileSync(postsFile, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log(`QQ 空间审计写入失败：${error?.message ?? error}`);
    }
    return row;
  }

  /** 对外暴露的策略视图（控制台与 AI 都看这份）。 */
  function describePolicy() {
    const p = loadPolicy();
    const now = Date.now();
    const auth = checkAuth(now);
    return {
      featureEnabled: featureEnabled(),
      enabled: p.enabled,
      grantId: p.grantId,
      grantedAt: p.grantedAt,
      grantedBy: p.grantedBy,
      expiresAt: p.expiresAt,
      revokedAt: p.revokedAt,
      revokeReason: p.revokeReason,
      lastUsedAt: p.lastUsedAt,
      authorized: auth.ok,
      authCode: auth.code,
      authReason: auth.reason,
      settings: { ...p.settings },
      quota: quotaSnapshot(now, p.settings),
      defaults: { ...DEFAULT_SETTINGS },
      visibilities: Object.entries(QZONE_VISIBILITIES).map(([key, v]) => ({ key, ...v })),
      // 起草档位放在这里而不是只放 GET 的响应里：grant / 改策略 / 撤销都把整份
      // describePolicy() 回给控制台当新快照，少一处就会在授权成功后把档位显示成空白。
      draft: describeDraft()
    };
  }

  /** 授权状态判定（不含配额/时段，那些在 assertCanPublish 里）。 */
  function checkAuth(now = Date.now()) {
    const p = loadPolicy();
    if (!featureEnabled()) {
      return { ok: false, code: 'FEATURE_DISABLED', reason: 'QQ 空间功能已在配置里关闭（socialV2.qzone.enabled=false）', httpStatus: 403 };
    }
    if (!p.enabled) {
      // 撤销会同时把 enabled 置 false，所以先判 revokedAt：否则"已撤销"会被报成
      // "未授权"，操作者会以为授权没生效过，找不到自己刚点过的那一下。
      if (p.revokedAt) {
        return { ok: false, code: 'REVOKED', reason: `授权已撤销${p.revokeReason ? `（${p.revokeReason}）` : ''}`, httpStatus: 403 };
      }
      return { ok: false, code: 'NOT_GRANTED', reason: '未授权：请先在控制台「QQ 空间」页授权 AI 发布动态', httpStatus: 403 };
    }
    if (p.revokedAt && (!p.grantedAt || new Date(p.revokedAt).getTime() >= new Date(p.grantedAt).getTime())) {
      return { ok: false, code: 'REVOKED', reason: `授权已撤销${p.revokeReason ? `（${p.revokeReason}）` : ''}`, httpStatus: 403 };
    }
    if (p.expiresAt && new Date(p.expiresAt).getTime() <= now) {
      return { ok: false, code: 'EXPIRED', reason: `授权已于 ${p.expiresAt} 过期，请重新授权`, httpStatus: 403 };
    }
    return { ok: true, code: 'OK', reason: '已授权', httpStatus: 200 };
  }

  /** 配额快照：今日已发 / 本小时已发 / 距上次多久。只统计成功发布的记录。 */
  function quotaSnapshot(now = Date.now(), settings = loadPolicy().settings) {
    const published = loadPosts().filter((r) => r.ok === true && r.action === 'publish');
    const dayStart = startOfDay(now);
    const hourStart = now - 3_600_000;
    const todayCount = published.filter((r) => new Date(r.ts).getTime() >= dayStart).length;
    const hourCount = published.filter((r) => new Date(r.ts).getTime() >= hourStart).length;
    const lastTs = published.length ? new Date(published[published.length - 1].ts).getTime() : 0;
    return {
      todayCount,
      hourCount,
      dailyQuota: settings.dailyQuota,
      hourlyQuota: settings.hourlyQuota,
      remainingToday: Math.max(0, settings.dailyQuota - todayCount),
      remainingThisHour: Math.max(0, settings.hourlyQuota - hourCount),
      lastPublishedAt: lastTs ? new Date(lastTs).toISOString() : null,
      nextAllowedAt: lastTs && settings.minIntervalMs > 0
        ? new Date(lastTs + settings.minIntervalMs).toISOString()
        : null
    };
  }

  /**
   * 发布闸门：授权 → 时段 → 配额 → 间隔。
   * `skipTimeGates` 只给 approve 用：人工点批准的那一刻已经表示"现在可以发"，
   * 但配额仍然要算（不然批准就等于无限额度）。
   */
  function assertCanPublish({ skipTimeGates = false } = {}) {
    const p = loadPolicy();
    const auth = checkAuth();
    if (!auth.ok) return auth;

    const s = p.settings;
    const now = Date.now();
    if (!skipTimeGates && inQuietHours(new Date(now).getHours(), s.quietHours)) {
      return {
        ok: false,
        code: 'QUIET_HOURS',
        reason: `当前处于安静时段 ${s.quietHours[0]}:00-${s.quietHours[1]}:00，不对外发布`,
        httpStatus: 429
      };
    }
    const q = quotaSnapshot(now, s);
    if (q.todayCount >= s.dailyQuota) {
      return { ok: false, code: 'DAILY_QUOTA', reason: `今日配额已用完（${s.dailyQuota} 条）`, httpStatus: 429 };
    }
    if (q.hourCount >= s.hourlyQuota) {
      return { ok: false, code: 'HOURLY_QUOTA', reason: `本小时配额已用完（${s.hourlyQuota} 条）`, httpStatus: 429 };
    }
    if (!skipTimeGates && q.lastPublishedAt && s.minIntervalMs > 0) {
      const wait = new Date(q.lastPublishedAt).getTime() + s.minIntervalMs - now;
      if (wait > 0) {
        return {
          ok: false,
          code: 'TOO_SOON',
          reason: `距上一条说说不足 ${Math.round(s.minIntervalMs / 60000)} 分钟，还需等待 ${Math.ceil(wait / 1000)} 秒`,
          httpStatus: 429,
          retryAfterMs: wait
        };
      }
    }
    return { ok: true, code: 'OK', reason: '可以发布', httpStatus: 200 };
  }

  /** 内容审计：与文本发送同一套启发式 + 已知令牌精确拦截。 */
  function assertContentSafe(text) {
    const body = String(text ?? '');
    if (SENSITIVE_RE.test(body)) {
      throw new QzoneError('正文命中敏感信息规则（疑似本机路径或凭据），已拒绝发布', { code: 'SENSITIVE_CONTENT' });
    }
    for (const token of knownAgentTokens) {
      if (token && body.includes(token)) {
        throw new QzoneError('正文包含会话令牌，已拒绝发布', { code: 'TOKEN_LEAK' });
      }
    }
  }

  /**
   * 图片解析。
   *   - 本地路径：必须命中图库白名单目录，否则拒绝（这条是 AI 通道的硬边界）；
   *   - http(s)：先过 SSRF 预检（禁内网/环回/凭据 URL）；
   *   - base64://：只校验体积；
   * 返回可直接交给 OneBot 的字符串数组。
   */
  async function resolveImages(list, s) {
    if (!Array.isArray(list) || !list.length) return [];
    if (!s.allowImages) throw new QzoneError('当前授权不允许带图', { code: 'IMAGES_NOT_ALLOWED', httpStatus: 403 });
    if (list.length > s.maxImages) {
      throw new QzoneError(`图片最多 ${s.maxImages} 张，收到 ${list.length} 张`, { code: 'TOO_MANY_IMAGES' });
    }
    const maxBytes = Number(cfg.socialV2?.image?.maxBytes) || 10 * 1024 * 1024;
    const dirs = (Array.isArray(cfg.socialV2?.image?.dirs) ? cfg.socialV2.image.dirs : [])
      .map((d) => String(d ?? '').trim())
      .filter(Boolean)
      .map((d) => path.resolve(d));
    const out = [];
    for (const raw of list) {
      const item = String(raw ?? '').trim();
      if (!item) continue;
      if (/^base64:\/\//i.test(item)) {
        const payload = item.slice('base64://'.length);
        if (payload.length * 0.75 > maxBytes) {
          throw new QzoneError(`内联图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, { code: 'IMAGE_TOO_LARGE' });
        }
        out.push(item);
        continue;
      }
      if (/^https?:\/\//i.test(item)) {
        try {
          await validateFetchUrl(item);
        } catch (error) {
          throw new QzoneError(`图片 URL 不安全：${error?.message ?? error}`, { code: 'UNSAFE_IMAGE_URL' });
        }
        out.push(item);
        continue;
      }
      // 剩下的按本地路径处理。file:// 也归到这一类，先转成路径再校验。
      const asPath = /^file:\/\//i.test(item) ? new URL(item).pathname.replace(/^\/([A-Za-z]:)/, '$1') : item;
      const abs = path.resolve(asPath);
      if (!dirs.length) {
        throw new QzoneError('未配置图库目录（socialV2.image.dirs），本地图片一律不受理', { code: 'NO_IMAGE_DIRS' });
      }
      if (!isInsideAnyDir(abs, dirs)) {
        throw new QzoneError(`本地图片不在图库白名单目录内：${path.basename(abs)}`, { code: 'IMAGE_OUTSIDE_WHITELIST', httpStatus: 403 });
      }
      let stat;
      try { stat = fs.statSync(abs); } catch {
        throw new QzoneError(`图片不存在：${path.basename(abs)}`, { code: 'IMAGE_NOT_FOUND' });
      }
      if (!stat.isFile()) throw new QzoneError('图片路径不是文件', { code: 'IMAGE_NOT_FILE' });
      if (stat.size > maxBytes) {
        throw new QzoneError(`图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限：${path.basename(abs)}`, { code: 'IMAGE_TOO_LARGE' });
      }
      if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) {
        throw new QzoneError(`不支持的图片格式：${path.extname(abs) || '（无扩展名）'}`, { code: 'IMAGE_BAD_FORMAT' });
      }
      out.push(pathToFileURL(abs).href);
    }
    return out;
  }

  /** 主题 → 纯净的话题词（去掉多余 # 与换行）。 */
  function normalizeTopic(raw, s) {
    if (s.allowTopic === false) return '';
    const text = String(raw ?? '').replace(/[\r\n]+/g, ' ').replace(/^#+|#+$/g, '').trim();
    if (!text) return '';
    if (text.length > MAX_TOPIC_CHARS) {
      throw new QzoneError(`主题最多 ${MAX_TOPIC_CHARS} 字`, { code: 'TOPIC_TOO_LONG' });
    }
    return text;
  }

  /**
   * 组装正文。
   * 只有一件事：需要时在正文前加 `#话题#`。
   *
   * 曾经还有「情绪尾符号」——已按管理员要求移除（2026-11-01）。
   * 理由：它只在结尾挂一个 emoji，手动发布时纯装饰，AI 起草时又和「语气」提示重复，
   * 两个作用都不足以支撑一个参数。语气该写进正文，而不是靠一个符号暗示。
   */
  function renderContent({ topic, content }) {
    const notes = [];
    let body = String(content ?? '').trim();
    if (topic) {
      const tag = `#${topic}#`;
      if (!body.includes(tag)) {
        body = body ? `${tag}\n${body}` : tag;
        notes.push(`正文前已加话题 ${tag}`);
      }
    }
    return { body, notes };
  }

  /**
   * 把外部参数规范化成一次"可发布"的载荷。
   * 校验顺序：正文 → 审计 → 主题/情绪 → 可见范围 → 图片（异步）。
   * 这里可以抛 QzoneError，调用方统一转成 400/403。
   */
  async function prepare(params = {}) {
    const p = loadPolicy();
    const s = p.settings;

    const content = String(params.content ?? '').trim();
    if (!content) throw new QzoneError('content（正文）不能为空', { code: 'EMPTY_CONTENT' });

    // 先审计原文再渲染：话题标签是桥接加的，不该被当成可疑内容；
    // 反过来也不行——万一 topic 里带了路径，渲染后再审计能一并拦住。两道都做。
    assertContentSafe(content);

    const topic = normalizeTopic(params.topic, s);
    if (topic) assertContentSafe(topic);

    assertNoMood(params);

    // 可见范围：AI 不能自己往上抬。allowedVisibilities 是授权时操作者画的那个圈。
    const requested = String(params.visibility ?? '').trim();
    const visibility = requested ? normalizeVisibility(requested) : String(s.defaultVisibility ?? 'friends');
    if (!visibility) {
      throw new QzoneError(
        `未知可见范围「${requested.slice(0, 20)}」，可用：${Object.keys(QZONE_VISIBILITIES).join(' / ')}`,
        { code: 'BAD_VISIBILITY' }
      );
    }
    if (!Array.isArray(s.allowedVisibilities) || !s.allowedVisibilities.includes(visibility)) {
      throw new QzoneError(
        `当前授权不允许「${QZONE_VISIBILITIES[visibility].label}」，允许的范围：${(s.allowedVisibilities ?? []).map((k) => QZONE_VISIBILITIES[k]?.label ?? k).join('、') || '（无）'}`,
        { code: 'VISIBILITY_NOT_ALLOWED', httpStatus: 403 }
      );
    }

    const spec = QZONE_VISIBILITIES[visibility];
    let targetUins = [];
    if (spec.needsTargets) {
      const raw = Array.isArray(params.targetUins) ? params.targetUins : [];
      targetUins = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
      if (!targetUins.length) {
        throw new QzoneError(`「${spec.label}」必须提供 targetUins（QQ 号数组）`, { code: 'TARGET_UINS_REQUIRED' });
      }
      if (targetUins.length > MAX_TARGET_UINS) {
        throw new QzoneError(`targetUins 最多 ${MAX_TARGET_UINS} 个`, { code: 'TOO_MANY_TARGETS' });
      }
      for (const uin of targetUins) {
        if (!/^\d{5,12}$/.test(uin)) throw new QzoneError(`targetUins 含非法 QQ 号：${uin.slice(0, 12)}`, { code: 'BAD_TARGET_UIN' });
      }
    }

    const images = await resolveImages(params.images, s);
    const { body, notes } = renderContent({ topic, content });

    assertContentSafe(body);
    if (body.length > s.maxChars) {
      throw new QzoneError(`渲染后正文 ${body.length} 字，超过上限 ${s.maxChars} 字`, { code: 'CONTENT_TOO_LONG' });
    }

    return {
      content: body,
      rawContent: content,
      topic,
      visibility,
      visibilityLabel: spec.label,
      ugcRight: spec.ugcRight,
      targetUins,
      images,
      chars: body.length,
      notes
    };
  }

  /**
   * AI 起草一条说说（只产文本，不发布、不占发布配额）。
   *
   * 为什么起草不要求发布授权：它没有外部副作用，只是花一次模型调用。
   * 真正落地仍要走 publish 的完整闸门（授权/时段/配额/批准），所以这里放宽是安全的。
   * 但功能总开关与起草开关都看——关掉就不烧钱。
   */
  async function compose(params = {}, { actor = 'agent' } = {}) {
    if (!featureEnabled()) {
      return { ok: false, code: 'FEATURE_DISABLED', error: 'QQ 空间功能已在配置中关闭（socialV2.qzone.enabled=false）', httpStatus: 403 };
    }
    if (!drafter) {
      return { ok: false, code: 'DRAFT_UNAVAILABLE', error: 'AI 起草模块未装配', httpStatus: 501 };
    }
    const p = loadPolicy();
    const s = p.settings;

    try {
      assertNoMood(params);
    } catch (error) {
      // compose 用返回值而不是抛错表达失败，这里对齐它的风格。
      return { ok: false, code: error.code, error: error.message, httpStatus: error.httpStatus ?? 400 };
    }
    const topic = normalizeTopic(params.topic, s);

    let result;
    try {
      result = await drafter.draft({
        hint: params.hint ?? params.content,
        topic,
        style: params.style,
        // 人设：不传 role 就用当前激活的人格卡（聊天用的是同一份）。
        role: params.role,
        persona: params.persona,
        // 花费归属：AI 从某个群/私聊发起时，这笔起草开销算到那个会话头上；
        // 控制台手动起草没有会话 key，由装配层记到「空间起草」这个内部条目。
        sessionKey: params.key
      });
    } catch (error) {
      log(`[qzone] 起草异常：${error?.message ?? error}`);
      return { ok: false, code: 'DRAFT_FAILED', error: error?.message ?? '起草失败', httpStatus: 502 };
    }
    if (!result?.ok) {
      // 参数类问题回 400，环境类（无 key / 关闭）回 503，其余算上游故障。
      const status = result?.code === 'NO_API_KEY' || result?.code === 'DRAFT_DISABLED' ? 503
        : result?.code === 'ROLE_NOT_FOUND' || result?.code === 'HINT_TOO_LONG' ? 400
          : 502;
      return { ...result, httpStatus: status };
    }

    // 模型写出来的东西同样要过审计：它是外来的文本，不是"可信来源"。
    try {
      assertContentSafe(result.content);
    } catch (error) {
      return { ok: false, code: error.code ?? 'SENSITIVE_CONTENT', error: error.message, httpStatus: error.httpStatus ?? 400 };
    }

    const { body, notes } = renderContent({ topic, content: result.content });

    return {
      ok: true,
      actor,
      draft: {
        content: result.content,
        rendered: body,
        topic,
        chars: body.length,
        overLimit: body.length > s.maxChars,
        maxChars: s.maxChars,
        notes
      },
      meta: {
        model: result.model,
        reasoningEffort: result.effort,
        persona: result.persona ?? null,
        usage: result.usage,
        latencyMs: result.latencyMs
      }
    };
  }

  /** 起草能力的当前状态（控制台展示用）。 */
  function describeDraft() {
    return drafter ? drafter.describe() : { enabled: false, unavailable: true };
  }

  /** 真正发出去。调用方必须已经过 assertCanPublish 与 prepare。 */
  async function sendPrepared(prepared, meta = {}) {
    const params = { content: prepared.content, ugc_right: prepared.ugcRight };
    if (prepared.images.length) params.images = prepared.images;
    if (prepared.targetUins.length) params.target_uins = prepared.targetUins;

    const base = {
      action: 'publish',
      actor: meta.actor ?? 'agent',
      key: meta.key ?? '',
      approvalId: meta.approvalId ?? '',
      visibility: prepared.visibility,
      ugcRight: prepared.ugcRight,
      targetUins: prepared.targetUins,
      topic: prepared.topic,
      imageCount: prepared.images.length,
      chars: prepared.chars
    };

    try {
      const resp = await onebotHttpAction('send_qzone_msg', params);
      const data = resp?.data ?? {};
      const tid = String(data.tid ?? data.data?.tid ?? data.fid ?? '');
      recordPost({ ...base, ok: true, tid, content: prepared.content });
      const p = loadPolicy();
      p.lastUsedAt = new Date().toISOString();
      savePolicy();
      log(`QQ 空间已发布${tid ? `（tid=${tid}）` : ''}：${prepared.visibilityLabel} / ${prepared.chars} 字 / ${prepared.images.length} 图`);
      return { ok: true, status: 'published', tid, publishedAt: new Date().toISOString() };
    } catch (error) {
      const message = error?.message ?? String(error);
      recordPost({ ...base, ok: false, error: message, content: prepared.content });
      log(`QQ 空间发布失败：${message}`);
      return { ok: false, status: 'failed', error: message, httpStatus: 502 };
    }
  }

  /**
   * 对外发布入口。
   * requireApproval 为真时只挂起，返回 approvalId；控制台批准后才真正发出。
   */
  async function publish(params = {}, { actor = 'agent', key = '', requireApproval } = {}) {
    const p = loadPolicy();
    // 顺序是刻意的：先「有没有权限」，再「参数对不对」，最后「现在能不能发」。
    // 反过来（先查限频）会让参数错误被报成 TOO_SOON，AI 完全看不出是 content 写错了。
    const auth = checkAuth();
    if (!auth.ok) return { ...auth, ok: false };

    let prepared;
    try {
      prepared = await prepare(params);
    } catch (error) {
      return { ok: false, code: error.code ?? 'INVALID_PARAMS', error: error.message, httpStatus: error.httpStatus ?? 400 };
    }

    const gate = assertCanPublish();
    if (!gate.ok) return { ...gate, ok: false };

    const needsApproval = typeof requireApproval === 'boolean' ? requireApproval : p.settings.requireApproval === true;
    if (needsApproval) {
      const now = Date.now();
      const entry = {
        id: crypto.randomBytes(8).toString('hex'),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (p.settings.pendingTtlMs ?? DEFAULT_SETTINGS.pendingTtlMs)).toISOString(),
        actor,
        key,
        prepared
      };
      loadPending().push(entry);
      savePending();
      log(`QQ 空间发布已挂起待批准（${entry.id}）：${prepared.visibilityLabel} / ${prepared.chars} 字`);
      return {
        ok: true,
        status: 'pending',
        approvalId: entry.id,
        expiresAt: entry.expiresAt,
        message: '已进入待批准队列，操作者在控制台「QQ 空间」页确认后才会真正发布',
        preview: prepared
      };
    }

    const sent = await sendPrepared(prepared, { actor, key });
    return { ...sent, preview: prepared };
  }

  /** 预览：不检查授权、也不占配额，只回答"会发成什么样"。 */
  async function preview(params = {}) {
    try {
      const prepared = await prepare(params);
      return { ok: true, preview: prepared, gate: assertCanPublish() };
    } catch (error) {
      return { ok: false, code: error.code ?? 'INVALID_PARAMS', error: error.message, httpStatus: error.httpStatus ?? 400 };
    }
  }

  function listPending({ includeExpired = false } = {}) {
    const now = Date.now();
    return loadPending()
      .filter((e) => includeExpired || new Date(e.expiresAt).getTime() > now)
      .map((e) => ({ ...e }));
  }

  /** 人工批准：越过"待审"与时段限制，但配额/授权仍然生效。 */
  async function approve(id, { actor = 'console' } = {}) {
    const list = loadPending();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, error: '找不到这条待批记录（可能已过期或被处理）', httpStatus: 404 };
    const entry = list[idx];
    if (new Date(entry.expiresAt).getTime() <= Date.now()) {
      list.splice(idx, 1);
      savePending();
      return { ok: false, error: '这条待批记录已过期，请重新提交', httpStatus: 410 };
    }
    const gate = assertCanPublish({ skipTimeGates: true });
    if (!gate.ok) return { ...gate, ok: false };

    list.splice(idx, 1);
    savePending();
    const sent = await sendPrepared(entry.prepared, { actor: entry.actor, key: entry.key, approvalId: entry.id });
    return { ...sent, approvalId: entry.id };
  }

  function reject(id, reason = '') {
    const list = loadPending();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, error: '找不到这条待批记录', httpStatus: 404 };
    const [entry] = list.splice(idx, 1);
    savePending();
    recordPost({
      action: 'reject',
      ok: false,
      actor: 'console',
      approvalId: entry.id,
      visibility: entry.prepared?.visibility,
      chars: entry.prepared?.chars,
      imageCount: entry.prepared?.images?.length ?? 0,
      error: String(reason ?? '').slice(0, 200) || '操作者拒绝'
    });
    log(`QQ 空间发布被拒绝（${entry.id}）：${String(reason ?? '').slice(0, 60) || '未填理由'}`);
    return { ok: true, rejected: entry.id };
  }

  /**
   * 授权（发放凭证）。
   * `hours` 为 null/0 表示不设到期时间——即便如此也仍然可以随时撤销。
   */
  function grant({ hours = 24, settings: settingsPatch = {}, actor = 'console' } = {}) {
    const p = loadPolicy();
    const now = Date.now();
    const h = Number(hours);
    const expiresAt = Number.isFinite(h) && h > 0 ? new Date(now + h * 3_600_000).toISOString() : null;
    p.enabled = true;
    p.grantId = crypto.randomBytes(12).toString('hex');
    p.grantedAt = new Date(now).toISOString();
    p.grantedBy = actor;
    p.expiresAt = expiresAt;
    p.revokedAt = null;
    p.revokeReason = '';
    p.settings = { ...p.settings, ...sanitizeSettings(settingsPatch, p.settings) };
    savePolicy();
    log(`QQ 空间授权已发放（${p.grantId.slice(0, 8)}…，${expiresAt ? `到期 ${expiresAt}` : '长期有效'}，${p.settings.requireApproval ? '需逐条批准' : '免批准直接发布'}）`);
    return describePolicy();
  }

  function revoke(reason = '', { actor = 'console' } = {}) {
    const p = loadPolicy();
    p.enabled = false;
    p.revokedAt = new Date().toISOString();
    p.revokeReason = String(reason ?? '').slice(0, 200);
    savePolicy();
    const cleared = loadPending().length;
    pending = [];
    savePending();
    log(`QQ 空间授权已撤销（${actor}）${cleared ? `，清空 ${cleared} 条待批` : ''}`);
    return { ok: true, clearedPending: cleared, policy: describePolicy() };
  }

  /** 只改策略，不动授权状态——避免"改个配额就把授权续上了"。 */
  function updateSettings(patch = {}) {
    const p = loadPolicy();
    p.settings = { ...p.settings, ...sanitizeSettings(patch, p.settings) };
    savePolicy();
    log('QQ 空间策略已更新');
    return describePolicy();
  }

  return {
    describePolicy,
    describeDraft,
    compose,
    publish,
    preview,
    approve,
    reject,
    grant,
    revoke,
    updateSettings,
    listPending,
    listPosts: (limit = 50) => loadPosts().slice(-Math.max(1, Math.min(500, Number(limit) || 50))).reverse(),
    quotaSnapshot,
    checkAuth
  };
}

/**
 * 策略补丁的净化：只接受已知键，类型与范围都夹紧。
 * 这里刻意不做"未知键透传"——否则控制台一个手滑就能往 state 里写入任意字段。
 */
export function sanitizeSettings(patch, current) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const s = { ...DEFAULT_SETTINGS, ...(current ?? {}) };

  if (patch.requireApproval !== undefined) out.requireApproval = patch.requireApproval === true;
  if (patch.allowImages !== undefined) out.allowImages = patch.allowImages === true;
  if (patch.allowTopic !== undefined) out.allowTopic = patch.allowTopic === true;

  if (patch.dailyQuota !== undefined) out.dailyQuota = clampInt(patch.dailyQuota, 1, 20, s.dailyQuota);
  if (patch.hourlyQuota !== undefined) out.hourlyQuota = clampInt(patch.hourlyQuota, 1, 10, s.hourlyQuota);
  if (patch.maxImages !== undefined) out.maxImages = clampInt(patch.maxImages, 1, 9, s.maxImages);
  if (patch.maxChars !== undefined) out.maxChars = clampInt(patch.maxChars, 50, 2000, s.maxChars);
  if (patch.minIntervalMs !== undefined) out.minIntervalMs = clampInt(patch.minIntervalMs, 0, 86_400_000, s.minIntervalMs);
  if (patch.pendingTtlMs !== undefined) out.pendingTtlMs = clampInt(patch.pendingTtlMs, 60_000, 86_400_000, s.pendingTtlMs);

  if (patch.defaultVisibility !== undefined) {
    const v = normalizeVisibility(patch.defaultVisibility);
    if (v) out.defaultVisibility = v;
  }
  if (patch.allowedVisibilities !== undefined) {
    const raw = Array.isArray(patch.allowedVisibilities) ? patch.allowedVisibilities : [patch.allowedVisibilities];
    const list = [...new Set(raw.map((v) => normalizeVisibility(v)).filter(Boolean))];
    // 空列表等于"什么都不许发"，是合法的收紧方向，允许保存。
    out.allowedVisibilities = list;
  }
  if (patch.quietHours !== undefined) {
    const raw = Array.isArray(patch.quietHours) ? patch.quietHours : [];
    if (raw.length === 0) out.quietHours = [];
    else if (raw.length === 2) {
      const from = Math.min(23, Math.max(0, Math.round(Number(raw[0]))));
      const to = Math.min(24, Math.max(0, Math.round(Number(raw[1]))));
      if (Number.isFinite(from) && Number.isFinite(to)) out.quietHours = [from, to % 24];
    }
  }
  return out;
}
