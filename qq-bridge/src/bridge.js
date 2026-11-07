// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractPresetPrefix } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, selectRoleText } from './role-card.js';
import { openBridgeDb } from './db.js';
import { createRoleStore } from './role-store.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from './dsh-client.js';
import { truncateText } from './md-to-plain.js';
// 轻量聊天路径（Track 2）的纯函数：解析模型文本、渲染快照、生成唤醒配置。
// Track 3：轻量聊天直连 DeepSeek（不经 DSH 会话）。没有 key 时自动回退 DSH 轻量会话。
import { chatCompletion, normalizeModelConfig, resolveDeepSeekKey, usageToLedgerBuckets } from './model-client.js';
import { SENSITIVE_RE, redactKnownTokens } from './sensitive.js';
import { safeFetchBuffer, looksLikeImageBuffer, withTimeout } from './safe-fetch.js';
import { normalizeImageForModel } from './media-normalize.js';
// 出站图片的两个来源：Pixeval MCP 预览图、本地图库随机一张（取舍见 image-source.js 头部）。
// 为什么在桥接侧解析、而不是让调用方传 path/base64：本文件 readBody 上限 1MB，装不下 1.6MB 的
// Pixeval 预览图（base64 还要 ×1.33）；更关键的是「接受调用方给的路径」等于把任意本地文件读取权
// 交给模型。这条通道只认下面两种来源：illustId（走 Pixeval MCP resources/read）或配置里的图库目录。
import { IMAGE_DEFAULTS } from './image-source.js';
import { normalizeVisionConfig, describeImagesWithVision } from './vision-client.js';
import { normalizeAsrConfig, extractRecordSegments, fetchRecordWav, canonicalizeWav, transcribeViaDsh, transcribeViaQqAsr, ASR_LANGUAGES } from './voice-asr.js';
// 视频链接理解（B 站/抖音等）：contract 见 docs/design/VIDEO_LINKS_SPEC.md。
// 该模块只依赖 node:* / safe-fetch / canonical-wav，不反向 import 桥接（避免循环）。
import { normalizeVideoConfig, extractVideoLinks, parseShareCard, describeVideo, formatVideoCard, formatVideoReport } from './video-link.js';
import { cleanupTemp, describeAudio, inspectAudio, processAudioVolume } from './voice-core.js';
// SnowLuma 只读观测（控制台「SnowLuma 上游」卡片）：只读 runtime.json/日志 + 探活，不启停它。
// 人物档案：跨会话、长期、人工可编辑的 Markdown 档案（docs/design/PERSON_PROFILES_SPEC.md）。
// 只把索引注入 prompt，正文由 AI 用 qq_person 按需读 —— 记忆越写越多，每轮 prompt 成本基本不变。
// 控制台 HTTP 服务：路由与安全闸门已拆到 src/http/（5,200 行单体 → 骨架 + 6 个领域模块）。
// 它在桥接侧只暴露 createConsoleServer(deps)，依赖全部显式传入，不再读 boot 的闭包。
import { createConsoleServer } from './http/server.js';
import { createInboundMedia } from './media/inbound.js';
import { createSendService } from './send/index.js';
import { createStickerService } from './sticker/index.js';
import { createSocialV2Store } from './social/v2-store.js';
import { createPersonMemory } from './person/index.js';
import { createLiteMedia } from './lite/media.js';
import { isDirectedAtAi } from './social/mention.js';
import { createSocialRecord } from './social/record.js';
import { createWakeScheduler } from './social/wake.js';
import { createProactivePrivate } from './social/proactive.js';
import { createAccountGuard } from './account/index.js';
import { createConnectionMonitor } from './conn/monitor.js';
import { createLitePrompt } from './lite/prompt.js';
import { createLiteDirect } from './lite/direct.js';
import { sendQueue } from './send/queue.js';
import { createRetryQueue } from './send/retry-queue.js';
import { createDiagLog } from './diag-log.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { forwardIdFromData } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import { findSticker, markStickerUsed } from './sticker-lib.js';
import { createTextSegmenter } from './text/segment.js';
import { createInitialPromptStore } from './initial-prompt/index.js';
import { createVoiceTts } from './voice/tts.js';
import { createMuxPump } from './mux/pump.js';
import { createMuxIngest } from './mux/ingest.js';
import { createVoiceSend } from './voice/send.js';
import { createLocalImages } from './media/local-images.js';
import { createSessionUsage } from './session/usage.js';
import { createSessionEnsurer } from './session/ensure.js';
import { createModeService } from './mode/index.js';
import { createOutboundSend } from './send/outbound.js';
import { createQzoneService } from './qzone/index.js';
import { createQzoneDrafter, qzoneDraftOwner, qzoneDraftSessionId } from './qzone/draft.js';

/**
 * 视频理解模块的**容错绑定**。
 *
 * 正常运行时它等同于 `import ... from './video-link.js'` 的那几个导出；这里再包一层
 * `typeof` 探测，是为了让「模块缺席/尚未落地」的环境也能把桥接跑起来：
 *   · 审计 VM（scripts/audit-bridge-harness.mjs）会**整行剥掉顶层 import**、改用注入绑定，
 *     不探测的话 loadConfig 第一句 `normalizeVideoConfig(cfg)` 就是 ReferenceError，
 *     整套 audit 会红成一片，和「桥接真的坏了」无法区分；
 *   · 模块缺席时视频能力整体降级为**不可用**（fail-closed：不猜视频内容、不编造），
 *     而不是让 24/7 的桥接进程起不来。
 */
const videoLinkApi = (() => {
  const pick = (value) => (typeof value === 'function' ? value : null);
  return Object.freeze({
    normalizeVideoConfig: pick(typeof normalizeVideoConfig === 'function' ? normalizeVideoConfig : undefined),
    extractVideoLinks: pick(typeof extractVideoLinks === 'function' ? extractVideoLinks : undefined),
    parseShareCard: pick(typeof parseShareCard === 'function' ? parseShareCard : undefined),
    describeVideo: pick(typeof describeVideo === 'function' ? describeVideo : undefined),
    formatVideoCard: pick(typeof formatVideoCard === 'function' ? formatVideoCard : undefined),
    formatVideoReport: pick(typeof formatVideoReport === 'function' ? formatVideoReport : undefined)
  });
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
// 最近发过的本地图片路径（只用于「随机发图别老是同一张」的轮换，不是审计日志，也不对模型暴露）。
const IMAGE_RECENT_FILE = path.join(STATE_DIR, 'image-recent.json');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
// 轻量引擎用「合成 sessionId」记账（没有 DSH 会话），格式统一是 `<前缀><QQ key>`。
// 账本要靠这张表把花费归属回 QQ 会话，改前缀时这里和 recordLiteDirectUsage 的调用点要同步。
const LITE_SID_PREFIXES = Object.freeze(['lite-direct:', 'lite-summary:', 'lite-person:']);

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * 一代仿真引擎（`chat` / `reserved`）清退后，内部真正只有两种模式：
 *   · `reserved2`    —— 二代仿真：AI 带工具、桥接负责发送与唤醒（日常运行模式）；
 *   · `closed-agent` —— 封闭 agent：仅 owner 私聊，用完整工具面（管理员直连）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` 是历史拼写。三者**必须继续被接受**：`state/mode.json` 与 DSH 的
 * `qq-mode` 命名空间里可能还存着旧值，归一失败会让启动直接 fail-closed 到「无模式」。
 * 它们一律收敛到 `reserved2` —— 语义上都是「AI 自动回 QQ」，与二代最接近。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'reserved2',        // 历史拼写：一代仿真（已清退，按二代跑）
  reserved: 'reserved2',    // 历史拼写：一代仿真（已清退，按二代跑）
  reserved2: 'reserved2',
  simulation: 'reserved2',  // 规范名
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程读 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
/**
 * 原子写 JSON：临时文件 + rename，读者永远看不到半截文件。
 *
 * pretty 默认 true（缩进 2 空格）：config.json、qzone-policy.json 这类要人肉翻查、
 * 要 git diff 的文件离不开缩进。但缩进对**机器只读**的大状态是纯开销 ——
 * social-v2.json 实测 249 KB 里有 45% 是空白，且它每个 tick 都要整份重写一次。
 * 这类文件显式传 { pretty: false }（见 social/v2-store.js 的 writeSocialV2StateNow）。
 *
 * @param {string} file
 * @param {unknown} obj
 * @param {{pretty?: boolean}} [opts]
 */
function atomicWriteJson(file, obj, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  // indent 传 0 等价于不留空白（JSON.stringify 的第三参为 0 时不缩进）
  const indent = opts.pretty === false ? 0 : 2;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, indent) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

// ── 数据库（SQLite）：人物档案与人格卡的唯一存储 ─────────────────────────────
// 惰性打开：bridge.js 被测试/审计脚本 import 时不应该顺手创建库文件。
// 单进程独占，WAL 由 db.js 统一设置，这里只管「同一进程里只开一次」。
let bridgeDbCache = null;
function bridgeDb() {
  if (!bridgeDbCache) {
    const file = path.join(STATE_DIR, 'bridge.db');
    bridgeDbCache = openBridgeDb({ file, log });
    log(`数据库已打开：${file}`);
  }
  return bridgeDbCache;
}

let roleStoreCache = null;

/** 关闭数据库（退出钩子调用）：先落 WAL 再释放句柄，避免备份时只拷到主库文件。 */
function closeBridgeDb() {
  if (!bridgeDbCache) return;
  try { bridgeDbCache.close(); } catch {}
  bridgeDbCache = null;
}
function roleStore() {
  if (!roleStoreCache) {
    roleStoreCache = createRoleStore({ db: bridgeDb(), dir: ROLES_DIR, log });
    // 首次启动把 roles/*.md 导入库；之后库是唯一源（见 role-store.js 的迁移说明）。
    try {
      const migrated = roleStoreCache.importLegacyMarkdown();
      if (!migrated.skipped) log(`人格卡已从 roles/*.md 迁移：导入 ${migrated.imported}/${migrated.scanned} 份`);
    } catch (error) {
      log(`人格卡迁移失败（继续用空库启动，不影响主流程）：${error?.message ?? error}`);
    }
  }
  return roleStoreCache;
}

function listRoles() {
  try {
    return roleStore().listNames();
  } catch (error) {
    log(`读取人格列表失败：${error?.message ?? error}`);
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 8000（2026-10 起：小鲸鱼卡补了形象/圈层/白饭-token/开发事件梗，6000 会把
// 末尾「你的样子」整段截掉——截断点落在卡尾而不是卡中，比调大预算更危险），
// 仍是每条约 6~8k token 的成本护栏；可用 config.json 的 role.maxInjectChars 调整
// （1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 8000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * 人格卡定位符：改造后人格存在 SQLite 里，不再是一个个 .md 文件。
 * 保留这个函数是为了让日志与诊断信息仍能说清「这条卡在哪」，不要再拿它去 fs 判断存在性。
 */
function roleFilePath(name) {
  return `${path.join(STATE_DIR, 'bridge.db')}#roles/${name}`;
}

/** 人格是否存在。控制台、/role 命令、QQ 空间起草统一走这里，别再各自 fs.existsSync。 */
function roleExists(name) {
  try { return roleStore().has(name); } catch { return false; }
}

/** 人格卡的更新时间（毫秒）。热注入路径拿它当缓存 key，写入必然推进它。 */
function roleContentStamp(name) {
  try { return roleStore().updatedAt(name); } catch { return 0; }
}

/** 重命名 / 删除人格：控制台这两个动作原来直接 fs.renameSync / rmSync，现在必须走库。 */
function roleRename(from, to) {
  roleStore().rename(from, to);
}

function roleDelete(name) {
  roleStore().remove(name);
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    try {
      const content = readRoleContent(name);
      const stats = roleCharStats(content);
      return {
        name,
        bytes: Buffer.byteLength(content, 'utf8'),
        chars: content.length,
        lines: content.split('\n').length,
        // 字段名沿用 mtime：控制台的「更新时间」列不需要知道底层是库还是文件。
        mtime: roleStore().updatedAt(name),
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
        // 声音设定：控制台人格列表直接显示「音色 / 唤醒词」，不用再为每张卡打一次请求。
        profile: readRoleProfile(name),
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0, profile: emptyRoleProfile() };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return roleStore().read(name);
}

function writeRoleContent(name, content) {
  // 末尾补换行：Markdown 结尾没有空行时，追加小节容易粘在同一行，人看着别扭。
  const text = String(content ?? '');
  roleStore().write(name, text.endsWith('\n') ? text : `${text}\n`);
}

// ── 人格的声音设定（音色 + 唤醒词）────────────────────────────────────────
// 一个「人格」= 一套说话方式 + 一张脸 + 一个声音。音色与唤醒词跟着人格走：
//   · 人格设了音色 → 合成语音时用它；没设 → 跟随 config.json 的全局默认；
//   · 人格设了唤醒词 → 作为该人格的默认唤醒条件；没设 → 跟随全局推荐值。
// 只在「运行时读」而不写回 config.json：人格来回切不该污染全局默认，
// 退出人格（清除）后要能自然回落到原来的音色与关键词。
//
// 注意：这里不放模块级 const 兜底对象——roleSummaries() 定义在本段之前，
// 同模块的 const 在初始化前被读会撞 TDZ；空值直接内联，省一个时序陷阱。
function emptyRoleProfile() {
  return { voice: '', voiceName: '', wakeKeywords: [], selfieDirs: [] };
}

function readRoleProfile(name) {
  try {
    return roleStore().readProfile(name);
  } catch (error) {
    log(`读取人格声音设定失败（${name}）：${error?.message ?? error}`);
    return emptyRoleProfile();
  }
}

function writeRoleProfile(name, patch) {
  return roleStore().writeProfile(name, patch);
}

/** 当前启用人格的完整声音设定；没有启用人格时返回空值（调用方回落到全局）。 */
function currentRoleProfile() {
  const role = readRoleState().role;
  if (!role) return { name: '', ...emptyRoleProfile() };
  return { name: role, ...readRoleProfile(role) };
}

/** 给 voiceTtsCfg 用：当前人格显式指定的音色；没设返回 null（＝用全局）。 */
function currentRoleVoice() {
  const profile = currentRoleProfile();
  if (!profile.voice) return null;
  return { voice: profile.voice, voiceName: profile.voiceName || profile.voice };
}

/** 给唤醒配置用：当前人格显式指定的唤醒词；没设返回 null（＝用全局推荐值）。 */
function currentRoleWakeKeywords() {
  const profile = currentRoleProfile();
  return profile.wakeKeywords.length ? profile.wakeKeywords.slice() : null;
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
const PRESET_NAMES = { lite: 'qq-chat-lite' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.lite;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

/**
 * 把预设源重新渲染成 bundle patch（DSH 0.1.7 只读 patch，不读源目录）。
 * 控制台保存/还原仿真提示词后必须跑这一步，否则 DSH 重启后读到的仍是旧 patch；
 * 直连引擎读源文件（liteSystemPrompt 按 mtime 失效），保存后下一轮即生效。
 */
function regeneratePresetPatch(preset) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-agent-preset-patches.mjs')], {
      cwd: ROOT,
      timeout: 20000,
      stdio: 'ignore'
    });
    return true;
  } catch (error) {
    log(`控制台：重新生成 ${preset} 的 bundle patch 失败：${error?.message ?? error}`);
    return false;
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: '轻量聊天（qq-chat-lite）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    // 0.1.7 起 DSH 只读 bundle patch（不扫 .agent-presets 目录），所以「已同步」判据是 patch 产物存在。
    // 保存时 regeneratePresetPatch() 会立即重渲染；DSH 仍需重启才会加载新 patch。
    installed: fs.existsSync(path.join(ROOT, 'plugins', 'qq-agent', 'presets', `${name}.patch.yml`)),
    requiresRestart: true,
  };
}

// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
// lite 预设缺失的告警只打一次（见 modePreset）：避免 reconcileSessionPolicies() 每秒刷屏。
let litePresetMissingWarned = false;
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__dfy66__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
// 做成共享对象、按引用传递：控制台（src/http/routes/dsh.js）与 ensureChatModel 都要读写
// 同一个代号。原先是 `let modelSelection = 0` 按值传出去，控制台里的
// `modelSelection.epoch += 1` 只递增了它自己的副本，bridge 侧永远是 0，于是
// 「改完强度后已有会话重新 selectModel」静默失效（2026-10-30 修复）。
const modelSelection = { epoch: 0 };
// 内置兜底档位（DeepSeek provider 的取值，见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
// 模型目录里声明了别的档位（openai 系的 minimal / medium / xhigh 等）时，以目录为准（见 allowedEffortsFor）。
// 2026-10-29 起默认档位改为 low：群聊回复用不到深推理，低档位更快更省（config.json 里可随时改回）。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'low';
/** 模型目录条目里可用于 QQ 助手的档位：去掉 'off'，其余按目录原样返回。 */
function allowedEffortsFor(entry) {
  const declared = (entry?.reasoning?.efforts ?? [])
    .map((e) => String(e?.id ?? '').trim().toLowerCase())
    .filter(Boolean);
  return declared.filter((id) => id !== 'off');
}
function normalizeReasoningEffort(value, allowed = REASONING_EFFORT_OPTIONS) {
  const v = String(value ?? '').trim().toLowerCase();
  const list = Array.isArray(allowed) && allowed.length ? allowed : REASONING_EFFORT_OPTIONS;
  if (!list.includes(v)) {
    throw new Error(`思考强度只能是 ${list.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 视频理解配置（config.video） ──────────────────────────────────────────────
// 默认值/上下限由 src/video-link.js 的 normalizeVideoConfig 统一收口（唯一契约），桥接只负责：
//   1) 模块缺席时给一份**关闭**的兜底配置（见 videoLinkApi 的注释）；
//   2) 把 state/bilibili-auth.json 里的登录 cookie 合进来 —— config.json 显式给了非空
//      cookie 就优先用它（用户显式配置 > 脚本写入的登录态）。
function resolveVideoConfig(cfg) {
  let video = null;
  if (videoLinkApi.normalizeVideoConfig) {
    try {
      video = videoLinkApi.normalizeVideoConfig(cfg);
    } catch (error) {
      log(`⚠️ 视频配置规整失败，已按关闭处理：${error?.message ?? error}`);
      video = null;
    }
  }
  if (!video || typeof video !== 'object') {
    video = {
      enabled: false,
      maxPerMinute: 0,
      maxPerHour: 0,
      metaTimeoutMs: 3500,
      fetchTimeoutMs: 20000,
      transcriptMaxChars: 6000,
      ffmpegPath: '',
      bilibili: { cookie: '', fetchSubtitles: false, fetchAiSummary: false },
      asr: { enabled: false }
    };
  }
  // 登录态文件（scripts/bili-login.mjs 写入）：{ cookie, savedAt, uname, mid }。
  // 不存在/损坏只记日志，绝不让桥接起不来 —— 匿名也能取元数据/热评/弹幕。
  try {
    const authFile = path.join(STATE_DIR, 'bilibili-auth.json');
    const auth = readJsonSafe(authFile, null);
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      const cookie = String(auth.cookie ?? '').trim();
      const configured = String(video.bilibili?.cookie ?? '').trim();
      if (cookie && !configured) {
        video.bilibili = { ...(video.bilibili ?? {}), cookie };
        log(`B 站登录态已加载（${auth.uname || auth.mid || '已登录'}）：官方字幕与 AI 总结可用`);
      } else if (cookie && configured) {
        log('B 站 cookie：config.json 显式配置优先，已忽略 state/bilibili-auth.json');
      }
    } else if (fs.existsSync(authFile)) {
      log('⚠️ state/bilibili-auth.json 无法解析（已忽略，按匿名模式运行）；可重新运行 node scripts/bili-login.mjs');
    }
  } catch (error) {
    log(`⚠️ 读取 state/bilibili-auth.json 失败（已忽略，按匿名模式运行）：${error?.message ?? error}`);
  }
  return video;
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      // 默认 low：QQ 聊天不需要深推理，低档位延迟更低、输出更短。
      reasoningEffort: 'low',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat-lite',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    // 人物档案：跨会话、长期、人工可编辑的 Markdown 档案。
    // 只把最近几份档案的摘要注入 prompt（injectSummaryMax 份），全文由模型用
    // [PERSON:read:...] 指令按需读取；写入走 [PERSON:note:/save:...]（见 lite-chat.js）。
    // dir 相对仓库根；也可写绝对路径。文件在 <dir>/<id>.md，可直接用编辑器改。
    personMemory: {
      enabled: true,
      dir: 'memory',
      injectIndex: true,       // 是否把档案索引注入 qq_get_prompt / 状态接口
      injectMax: 12,           // 索引最多列几份档案
      injectSummary: true,     // 是否把置顶档案的摘要注入每轮唤醒 prompt
      injectSummaryMax: 6,     // 最多注入几份
      injectSummaryChars: 160, // 每份摘要最多多少字（控制每轮 token）
      // 只有置顶的档案进摘要（2026-10-29 改）：原来是「最近更新」排序，谁最近被写过谁在榜上，
      // 没被写过的人永远进不来 ⇒ 自锁。现在由人手动置顶决定名单，模型改不了。
      // 一份都没置顶时才回落到最近更新（避免刚清空置顶变成「完全没记忆」）。
      injectPinnedOnly: true,
      // 当前对话对象的档案正文直接预取进 prompt（省掉 [PERSON:read] 那次额外模型调用）。
      injectFocusBody: true,
      focusMaxChars: 1500,     // 预取正文最多多少字
      focusMaxPeople: 2,       // 群聊里最多预取几个发言人的档案
      readMaxChars: 3000,      // [PERSON:read] 一次最多读多少字正文
      searchLimit: 8,
      maxProfiles: 300,
      maxProfileChars: 200000,
      ...(file.personMemory ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-lite',
      provideRecommendations: true,
      // 轻量聊天路径（Track 2）：无工具会话 + 桥接负责发送/唤醒。
      // 打开后 reserved2 会话切到 liteChat.preset（默认 qq-chat-lite：模型没有任何工具，
      // 只输出要发到 QQ 的文本；桥接按行切分发送，并自行写下一次唤醒配置）。
      // 成本约为 agent 工具循环的 1/10。关闭后立刻回到原预设（会温和重建会话）。
      liteChat: {
        enabled: false,
        preset: 'qq-chat-lite',
        groupWakeProbability: 0,        // 群聊普通消息的唤醒概率：0=完全不唤醒，只靠 @/拍一拍/关键词
        maxMessages: 2,                  // 一轮最多几条文字（默认只发 1 条，需要追问才 2 条）
        // 灰度名单（空=全部）：建议先只放 owner 私聊，确认自动发送/唤醒都正常再全量。
        keys: [],
        // 轻量会话没有工具，媒体要在唤醒前由桥接预处理：
        maxImagesPerWake: 1,   // 每轮最多用视觉模型描述几张图（每次都是付费调用）
        maxVoicesPerWake: 1,   // 每轮最多转写几条语音（本地 SenseVoice）
        maxVideosPerWake: 1,   // 每轮最多抓几个视频的标题/字幕/AI 总结（9 秒超时，失败降级到元数据）
        nativeImages: true,    // 图片直接附给多模态模型（true）还是先让视觉模型描述（false）
        maxImagesPerReply: 5,  // 一轮回复里最多主动发几张图（上限 5，被 parseLiteReply 夹紧）
        maxPokesPerReply: 1,   // 一轮回复里最多拍一拍几次
        maxVoicesPerReply: 1,  // 一轮回复里最多发几条 TTS 语音
        historyMessages: 12,   // 提示词里带最近多少条上下文（直连引擎没有 DSH 会话历史）
        historyMaxAgeMs: 7200000, // 只带 2 小时内的历史；更早的话题不续，避免反复提旧梗
        historyMaxChars: 2400, // 历史部分的字符预算（按最新优先保留）
        summaryEnabled: true,  // 滚动对话纪要（连续性主线）：每 N 轮把更早的对话压成 3–6 条短句
        summaryEveryTurns: 8,  // 每 8 轮更新一次纪要
        summaryMaxChars: 300,  // 纪要字数上限（约 200–250 token）
        summaryMaxInputMessages: 40, // 一次纪要最多喂多少条聊天记录
        stickerMax: 6,         // 提示词里给几个可选表情
        maxStickers: 2,        // 一轮最多发几个表情
        engine: 'auto'         // auto | direct | dsh（direct = 不经 DSH 直连 DeepSeek）
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: false,
        recommendedQuestion: false,
        recommendedPoke: true,
        recommendedHint: '群聊默认策略是「一直潜水」（infinite=true，不设时长）：只有被 @、被拍一拍、命中唤醒词时才醒，普通消息不触发、也不做概率唤醒。被叫醒后会进入 postWakeActiveMs（默认 5 分钟）的活跃窗口，这段时间群友接着说话也会叫醒它；没人说话到点自动回到潜水。需要等特定某人/某几人时可设置 triggers.speakerIds。不要自己改成有限时长或打开 anyMessage/question/概率，除非对方明确要求。',
        // 群聊「唤醒后保持活跃」：被叫醒后这段时间内普通群消息也会唤醒；以最近一条消息为基准续期，
        // 没人说话到点自动回潜水。0 关闭（回到旧的「答一句就消失」）。
        postWakeActiveMs: 300000,
        // 引用限制：模型只能引用这个时间窗内的消息，避免它挑十几分钟前的老图去引用、把话题拽回旧账。
        quoteMaxAgeMs: 900000,
        batchWindowMs: 6000,
        maxWakePerMinute: 1,        // 非直接对话（timeout/概率唤醒）限频
        maxWakePerHour: 12,
        maxDirectWakePerMinute: 10, // 私聊/@/提问/关键词：必须回，只做成本兜底
        maxDirectWakePerHour: 60,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      // 主动私聊：AI 在没有新消息时自己找白名单里的人聊天。
      // 与上面 proactive（群聊「主动看看大家在聊什么」）完全独立——那边是随机机会，
      // 这边是「每日配额 + 清醒时段内随机落点」，见 src/social/proactive.js。
      proactivePrivate: {
        enabled: true,
        dailyQuota: 2,                          // 每人每天最多主动几次；0 = 关闭
        activeHours: [9, 23],                   // 只在清醒时段开口（结束 <= 开始时视为跨夜）
        minIntervalMs: 4 * 60 * 60 * 1000,      // 两次之间至少隔 4 小时
        idleThresholdMs: 2 * 60 * 60 * 1000,    // 对方最近 2 小时说过话就不打断
        onlyKnownContacts: true,                // 只找「有过聊天记录」的人，不给陌生人发第一条
        backoff: {
          enabled: true,                        // 对方连续不回就自动降频（不彻底停手）
          maxMultiplier: 8                      // 间隔最多放大到 8 倍（约 8 天一次）
        },
        tickMs: 5 * 60 * 1000                   // 全局检查周期
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000,
        // 会话轮换（方案 A）：DSH 会话没有上下文上限，聊得越久每次请求重读的上下文越大。
        // 达到任一阈值就归档旧会话、开新会话，并用「最近对话 + 记忆入口」做交接。
        // 关掉用 rotateEnabled=false；两个阈值都不设（0）= 永不轮换。
        rotateEnabled: true,
        rotateContextTokens: 80000,
        rotateAfterSteps: 60,
        handoffMessages: 8,
        rotateMinIntervalMs: 600000
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.proactivePrivate：外层 spread 会把文件里那段**整体替换**默认值，
  // 于是只写了 { enabled: false } 的用户会连带丢掉 activeHours / backoff 等默认，
  // 然后在 policyOf() 里退回兜底值（能跑，但行为和他以为的不一样）。
  // 这里按字段补一遍，backoff 单独再合并一层。
  {
    const filePP = (cfg.socialV2.proactivePrivate && typeof cfg.socialV2.proactivePrivate === 'object')
      ? cfg.socialV2.proactivePrivate
      : {};
    const defaultsPP = {
      enabled: true,
      dailyQuota: 2,
      activeHours: [9, 23],
      minIntervalMs: 4 * 60 * 60 * 1000,
      idleThresholdMs: 2 * 60 * 60 * 1000,
      onlyKnownContacts: true,
      backoff: { enabled: true, maxMultiplier: 8 },
      tickMs: 5 * 60 * 1000
    };
    cfg.socialV2.proactivePrivate = {
      ...defaultsPP,
      ...filePP,
      activeHours: Array.isArray(filePP.activeHours) ? filePP.activeHours : defaultsPP.activeHours,
      backoff: {
        ...defaultsPP.backoff,
        ...((filePP.backoff && typeof filePP.backoff === 'object') ? filePP.backoff : {})
      }
    };
  }

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.image：出站发图（Pixeval 预览图 + 本地图库随机一张）。
  //
  // 为什么只有两种来源、没有 path/url/base64 参数：
  //   · 模型只能通过输出 [IMAGE] / [IMAGE:关键词] 触发，参数只有关键词或什么都不传；
  //   · 本地图库根目录由 dirs 白名单决定，模型既指定不了路径，也读不到图库外的文件；
  //   · 不接受 URL：让桥接去抓任意 URL 等于把「发图」变成 SSRF/任意下载通道。Pixeval 的预览图
  //     已经由 Pixeval 自己带着登录态去抓（resources/read），桥接不需要也不应该再抓一次。
  // 默认开启（用户明确要「能搜图 / 随机发本地图到 QQ」）；关闭用 enabled=false。
  cfg.socialV2.image = {
    enabled: true,
    // 随机图库根目录（递归扫描子目录）。换图库只改这里，不需要改代码。
    dirs: [path.join(os.homedir(), 'Pictures', '绘画参考')],
    // 「自己的照片」形象库（[SELFIE] 的取图来源）：默认用仓库自带的 assets/。
    // 与 dirs 分开：dirs 是「随便发一张图」的素材池（Pixiv 搜得到的东西），
    // selfDirs 是「这就是我」的固定形象，混在一起会出现"拿别人的图冒充自己"。
    selfDirs: [path.join(ROOT, 'assets')],
    maxBytes: 10 * 1024 * 1024,     // 单张本地图体积上限：图库里单文件最大 36MB，超限的直接跳过
    // 出站发图的**总**体积上限（与 maxBytes 分开：maxBytes 决定「挑哪些图」，这里决定「最多发多大」）。
    // 入站媒体的 8MB 上限受 DSH 的 base64 正则炸栈线约束，出站不经过 DSH，没有那条线的限制；
    // 真实瓶颈是网关把图转码上传 QQ（实测 ~4MB 稳，10MB 级要看网关/网络），硬上限 20MB。
    maxSendBytes: 12 * 1024 * 1024,
    maxScanFiles: IMAGE_DEFAULTS.maxScanFiles,
    recentLimit: IMAGE_DEFAULTS.recentLimit,
    pixevalMcpUrl: IMAGE_DEFAULTS.pixevalMcpUrl,
    pixevalSize: IMAGE_DEFAULTS.pixevalSize,
    pixevalTimeoutMs: IMAGE_DEFAULTS.pixevalTimeoutMs,
    maxPerMinute: 6,
    maxPerHour: 30,
    // 跨会话发图（target 指向白名单里的另一个会话）单独限频：防止被群友驱使把图刷到别处。
    crossTargetPerMinute: 3,
    crossTargetPerHour: 20,
    // 最低「赞」数：Pixiv 的点赞是私有的，公开口径是**收藏数**（totalBookmarks）。
    // 0 = 不限制；默认 300（用户要求「300 收藏以上就行」，比之前的 1000 宽松，更容易搜到图）。
    // 只对 Pixiv 作品生效，本地图库没有赞数。模型可以用 qq_send_image 的 minBookmarks 按用户要求临时提高。
    minBookmarks: 300,
    // ── Pixiv 搜索的客观闸门（与「好不好看」无关，都是「能不能发」的条件） ──
    // 年龄分级：默认一律屏蔽 R-18/R-18G。搜索接口本身没有这个参数，是拿到结果后按 xRestrict 过滤。
    allowR18: false,
    // 一次拉多少条候选。Pixeval 支持到 100；样本越小越容易「矮子里拔将军」。
    searchCount: 30,
    // 历史时间窗（年）。0 = 关闭，退回 Pixiv 默认的「最新发布」。
    // 为什么需要它：sort 默认 date_desc，最新作品收藏天然只有个位数，收藏闸门筛不出好图。
    searchWindowYears: 6,
    // 时间窗最多试几次：冷门 tag 某一年可能一条都没有，多试几个窗口再退回全时段。
    searchWindowTries: 2,
    // 内容类型：'illust' 只要插画，排掉动图（只能发一帧）和漫画（只能发第一页）。
    searchContentType: 'illust',
    // Pixiv 的 includeAi 默认 true，不显式关掉就会混进 AI 图。
    searchIncludeAi: false,
    // 有单页作品就只在单页里挑，没有才放宽到多页。
    preferSinglePage: true,
    ...(cfg.socialV2?.image ?? {})
  };

  // 识图（vision）：让纯文本模型能「看图」——桥接把消息里的图片交给 OpenAI 兼容的
  // 视觉 API，返回文字描述。默认与 DSH 的 dsh-image-pathify 插件一致（deepseek-flash @
  // api.deepseek.com，凭据优先读 ~/.dsh/.credentials.yaml 的 IMAGE_PATHIFY_API_KEY）。
  // 关闭用 vision.enabled=false 或 tools.describeImage=false。
  cfg.vision = normalizeVisionConfig(cfg);

  // 视频链接理解（video）：让 AI 能「看」群友发来的视频链接/分享卡片（元数据 + 字幕/
  // AI 总结 + 热评 + 弹幕 + 必要时本地 ASR）。默认开启；关闭用 video.enabled=false
  // 或 tools.describeVideo=false。登录态从 state/bilibili-auth.json 合并（只在内存里）。
  //
  // 注意：loadConfig 的 cfg 只显式列了已知段，**不会整份展开 config.json**（file），
  // 所以这里必须把用户写的 file.video 传进去；否则 normalizeVideoConfig 只能看到默认值，
  // 用户改 video.enabled/maxPerMinute/bilibili.cookie 都不会生效。
  const rawVideo = (file.video && typeof file.video === 'object' && !Array.isArray(file.video)) ? file.video : {};
  cfg.video = resolveVideoConfig({ ...cfg, video: rawVideo });

  // 语音转写（voice.asr）：SenseVoice（DSH 本地 speech-to-text）转写 QQ 语音。
  // 上限与 DSH speech/catalog 对齐（4MB / 120s）。关闭用 voice.asr.enabled=false
  // 或 tools.transcribeVoice=false。
  cfg.voice = {
    ...(cfg.voice ?? {}),
    asr: normalizeAsrConfig(cfg),
  };

  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    ...(cfg.socialV2?.sticker ?? {})
  };
  // 旧版配置里的 socialV2.sticker.collect（AI 收藏群友表情）已随功能移除，
  // 残留字段直接丢掉，避免它继续出现在 /api/status 的快照里。
  delete cfg.socialV2.sticker.collect;

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
const state = { sessions: {} };
// 只改内容、绝不整体替换：state 会按引用 bind 进 7 个模块
// （v2-store / mux-ingest / mode / social-legacy / lite-direct / send-outbound / social-wake）。
// 换引用的话那些模块会一直握着启动那一刻的旧对象，之后 sessions 映射的写入谁也看不见。
// 今天 loadState() 只在 boot 早期调一次，替换还不出事；但只要将来加个热重载就会静默炸。
const replaceState = (next) => {
  for (const key of Object.keys(state)) if (!(key in next)) delete state[key];
  Object.assign(state, next);
};
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    replaceState({ sessions: {}, sessionPolicies: {} });
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      replaceState({ sessions: {}, sessionPolicies: {} });
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') replaceState(loaded);
  else replaceState({ sessions: {} });
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;

/**
 * 消息段里的 URL 归一：只接受 http/https、长度受限。
 *
 * 分享卡片的标题/链接、视频段 URL 都来自群友（不可信输入），它们会被拼进模型上下文，
 * 所以这里只做「保留原文 + 限长 + 协议白名单」，不做任何语义解释，也不下载。
 */
function segmentUrl(value, max = 300) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href.length <= max ? u.href : '';
  } catch {
    return '';
  }
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': {
        // QQ 视频段：保留 `[视频]` 语义，有 URL 时附在后面（模型据此才知道「这是个链接」，
        // 必要时可调 qq_describe_video）。URL 只接受 http/https 且限长。
        const videoUrl = segmentUrl(d.url);
        out.push(videoUrl ? `[视频]（${videoUrl}）` : '[视频]');
        break;
      }
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': {
        // 分享卡片（com.tencent.structmsg / miniapp_01 / B 站、抖音、小红书卡片…）。
        // 以前一律压成 `[卡片消息]`，等于把里面唯一有用的链接丢了：群友发视频卡片时
        // AI 只能看到「卡片消息」，完全不知道发了什么。现在尽量保留「标题 + URL」，
        // 解析失败仍退回 `[卡片消息]`（不抛、不影响其它段）。
        let card = null;
        try {
          // OneBot 的 json 段 data.data 是 JSON 文本；个别实现会直接给对象，统一成文本再解析。
          const rawCard = typeof d.data === 'string'
            ? d.data
            : (d.data && typeof d.data === 'object' ? JSON.stringify(d.data) : String(d.data ?? ''));
          card = videoLinkApi.parseShareCard && rawCard ? videoLinkApi.parseShareCard(rawCard) : null;
        } catch { card = null; }
        const cardUrl = card?.url ? segmentUrl(card.url) : '';
        if (cardUrl) {
          const cardTitle = sanitizeMediaSummary(card?.title, 60) || '分享';
          out.push(`[卡片：${cardTitle} ${cardUrl}]`);
        } else {
          out.push('[卡片消息]');
        }
        break;
      }
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
/**
 * 应用装配入口。
 *
 * deps 只承载「外部环境」——配置、QQ 网关、DSH 客户端。缺省时按原逻辑自己创建，
 * 因此 `node src/bridge.js` 的行为与重构前完全一致；测试则注入桩对象替换掉
 * 真实网络与文件系统，不必再对源码做文本切片。
 *
 * @param {{config?: object, bot?: object, api?: object}|null} deps
 * @param {{onReady?: (handles: object) => void}} [hooks]
 *   onReady 在进入消息泵（永不返回的 pumpMux）之前回调，供测试取得内部句柄。
 */
export async function boot(deps = null, hooks = {}) {
  const sessionEnsurer = createSessionEnsurer();
  const { ensureChatModel, ensureSession } = sessionEnsurer;

  const sendSvc = createSendService();
  const { sendVoiceV2, sendStickerV2, sendImageV2, sendBurstToQQ, sendMessagesV2, resolveReplyInfo, resolveReplyTargetV2, computeGapsV2, speakVoiceForV2, replyTimingV2 } = sendSvc;

  const stickerSvc = createStickerService();
  const { stickerEnabled, saveStickerStoreSafe, syncStickerLibrary, listStickersForV2, getStickerImageData, applyStickerNoteV2, setStickerRemarkV2, liteStickerChoices } = stickerSvc;

  const socialRecord = createSocialRecord();
  const { roleRawContent, roleHintForMode, currentRoleHint, currentRoleHintV2, pruneGroupMemberNameCache, assertGroupMember, resolveGroupMemberName, pruneReplyInfoCache, isQuoteTargetSelf, appendSocialV2Message, appendSocialV2Poke, recordLiteSentMessage, recordSentMessagesV2 } = socialRecord;

  const socialV2Store = createSocialV2Store();
  const { normalizeSpeakerIdsV2, pickWakeTriggersV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2, applyWakeConfigV2, preSleepWaitBlockedV2, computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, loadSocialV2State, saveSocialV2State, flushSocialV2State, writeSocialV2StateNow } = socialV2Store;

  const wakeSvc = createWakeScheduler();
  const { parkWakeReason, busyReasonV2, isConversationBusyV2, wakePriorityV2, isDirectWakeReason, isTimerWakeReason, scheduleWakeV2, replayPendingWakeReasonsV2, setupSleepTimerV2, cancelProactiveCheckV2, scheduleProactiveCheckV2, clearSocialV2Timers, clearAllSocialV2Timers, armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases, drainPromptQueue, drainAllPromptQueues, deliverPrompt, processPromptQueue, sendWakePromptV2, deliverPromptNow } = wakeSvc;

  // 主动私聊（src/social/proactive.js）：AI 在没有新消息时自己找人聊天。
  // 与群聊 proactiveCheck 分开：那边是「群冷场了搭一句」，这边是「今天还没找过 TA」。
  // 全局只跑一个 tick，每个会话的落点持久化在 st.proactivePrivate 里。
  const proactivePrivateSvc = createProactivePrivate();
  // 只解构真正用到的两个：tick 由模块自己的 interval 驱动，describe / resetBackoff
  // 留给控制台接入时再取，不在这里挂着三个没人用的变量。
  const { start: startProactivePrivate, stop: stopProactivePrivate } = proactivePrivateSvc;

  const personSvc = createPersonMemory();
  const { personStoreDir, personStore, personMemoryIndexText, personMemorySummaryText, defaultPersonTargetId, currentPersonTargetId, personFocusProfiles, personFocusText, applyPersonOps, personProfileForRead } = personSvc;

  const liteMediaSvc = createLiteMedia();
  const { liteMediaNoteKey, liteCachedMediaNote, rememberLiteMediaNote, liteMessageMediaKind, fetchLiteInlineImages, prefetchLiteMedia, liteStickerIndexText, liteImageBudgetOk, liteSendImage, liteSendPoke } = liteMediaSvc;

  const litePromptSvc = createLitePrompt();
  const { buildWakePromptLite, liteHistoryLines, renderLiteMessageLine, buildWakeSnapshotV2, localClockText, currentRoleHintLite, selfIdentityTextV2, formatParticipationV2, formatInitialPromptV2, consoleNoteList, pendingConsoleNotes, addConsoleNote, markConsoleNotesDelivered, clearDeliveredConsoleNotes, liteSystemPrompt } = litePromptSvc;

  const liteDirectSvc = createLiteDirect();
  const { getLiteDirectFailures, getLiteDirectBroken, liteChatEnabled, liteKeyEnabled, liteSessionActive, liteWakeConfigV2, liteDirectActive, liteModelKey, liteEngine, parseLiteReply, recordLiteDirectUsage, maybeSummarizeLite, ackLiteSeen, runLiteDirectWake, handleLiteTurnEnd } = liteDirectSvc;

  const accountSvc = createAccountGuard();
  const { saveFriendRequests, loadFriendRequests, parseFriendDecision, notifyOwnerFriendRequest, applyFriendDecision, autoAllowFriend, applyHealedTokens, syncTokenToFile, healTokenIfStale } = accountSvc;

  const connSvc = createConnectionMonitor();
  const { isDshWebApiPort, findDshWebApiPort, rediscoverDshBaseUrl, startDshWatch, noteUpstreamPacket, snowlumaHomeDir, noteReceiveHealth, snowlumaHealthSnapshot, reportSnowlumaHealth, pollSnowlumaStatus, startSnowlumaWatch } = connSvc;

  const segSvc = createTextSegmenter();
  const { clampGapV2, convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning } = segSvc;

  // initial-prompt：会话「初始提示词」的存储与降级策略由模块独占。
  // ⚠️ 本域必须在 boot **前段**完成接线，不能沿用「尾部统一 bind」的惯例：
  //    handles 对象（约 3100 行）与 httpLiveValues（约 3150 行）在**构造时**就会取用
  //    这里的函数与容器；loadInitialPrompts() 在 boot 中段就要落盘读取。
  //    接线晚一步 = 构造 handles 时撞 TDZ 或读到 undefined。
  // voice/tts：合成、缓存轮转、标记解析。fetch 走 bind（harness 注入假 fetch 打桩）。
  const voiceTtsSvc = createVoiceTts();
  voiceTtsSvc.bind({ fetch });
  const { ttsServiceJson, synthesizeVoiceFile, voiceMarkerText, pruneTtsCache, voicePathInsideLibrary } = voiceTtsSvc;

  const promptStoreSvc = createInitialPromptStore();

  const cfg = deps?.config ?? loadConfig();

  // 依赖里只有 cfg 是值；INITIAL_PROMPTS_FILE 是顶层 const，atomicWriteJson /
  // canonicalV2Key / log 是提升过的函数声明，此刻都已可用。
  promptStoreSvc.bind({ INITIAL_PROMPTS_FILE, atomicWriteJson, canonicalV2Key, cfg, log });
  const {
    getInitialPrompt, initialPromptMaxChars, loadInitialPrompts, setInitialPrompt
  } = promptStoreSvc;
  // 条目映射引用恒定（从不整体替换），直接交出去供控制台遍历即可。
  // 可写标记是 let（读坏时降级为 false），HTTP 侧改走 promptStoreSvc.isWritable()。
  const initialPrompts = promptStoreSvc.getEntries();

  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库数据/可写标志/同步时间戳全部由 src/sticker 独占，这里只触发一次加载。
  // 读失败不能当成空库继续（之后任何一次保存都会把空库写回、清掉 AI 学的标注），
  // 这条降级逻辑现在住在模块的 load() 里。
  stickerSvc.load({ file: STICKER_FILE, log });
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护
  // send 模块统计使用次数时用的读写口（markStickerUsed 返回**新**数组）。
  const getStickerEntries = stickerSvc.getEntries;
  const setStickerEntries = stickerSvc.setEntries;

  // ── 读接口的 HTTP 兜底：WS 挂了不等于网关挂了 ──────────────────────────────
  //
  // 为什么要有：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action，于是
  // 「WS 正在重连」这段时间里表情库同步必然失败。日志实测 33 次同步里 16 次失败（≈48%），
  // 全是 `SnowLuma WebSocket closed before opening`；表现就是操作者说的
  // 「有时读群友的表情包会失败」——库里没有新收藏 ⇒ qq_get_sticker_image 直接报「找不到表情」。
  //
  // 而**同一个网关的 HTTP 口一直是可用的**（onebotSend 发消息、fetch_ptt_text 转写都直接用它）。
  // 读接口没有理由单点依赖 WS。这里只在 WS 失败时兜底，不改变正常路径的延迟。
  const mediaSvc = createInboundMedia();
  const { mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe, toModelMedia, isSafeLocalMediaPath, isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer, fetchOneBotImage, fetchFaceMedia, resolveMediaList, fetchMediaData, videoHintToolHint, videoHintLine, prepareVideoHint, mediaHintFor, findMessageMedia, visionRateLimited, videoRateLimited, describeMessageImages, findMessageVoice, transcribeVoiceMessage } = mediaSvc;

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  // 合成语音的发送时间戳（scopeKey → number[]）：合成比发库里现成音频贵，额度单独计。
  const voiceTtsSendTimes = new Map();

  // 「对方在要语音」的判定词表。仅在显式开启 requireAsk 的旧模式下才会用到，默认不再参与判断。
  // 保留原因（历史教训 2026-10-26）：这套关键词判定天生不靠谱——
  //   · 唤醒原因是一条被合并/延后的 `private@seqN`（真正要语音的那条早被别的回合处理掉）；
  //   · 或 AI 是在 replyCheck / proactiveCheck 回合里补发语音；
  // 都会判成"没要语音" → 连续降级成文字，用户看到的就是「语音老被拦」。
  // 2026-10-29 起默认关闭 requireAsk：语义交给模型，桥接只管频率；这里只作回退用的旧闸门。
  const VOICE_ASK_RE = /语音|声音|说话|说句|说句话|开口|念一下|读一下|听你|听听|嗓音|嗓子|来一句/;

  const voiceSendSvc = createVoiceSend();
  const { onebotHttpAction, assertOutboundAuditOk, voiceCfg, voiceTtsCfg, ttsBudgetCheck, ttsBudgetCommit, looksLikeVoiceAsk, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck, voiceBudgetCommit, recordVoiceSentV2, verifyVoiceMessageSent, sendVoiceForV2 } = voiceSendSvc;

  // ── QQ 空间动态（说说） ─────────────────────────────────────────────────────
  //
  // 复用 onebotHttpAction 打 `send_qzone_msg`，不新开一条 HTTP 通道：
  // 网关地址与令牌的自发现、426 提示、超时都在那一处收口，多一条就多一处漂移。
  //
  // 授权与策略存在 state/qzone-policy.json（不入库）；这里只注入依赖，
  // 一切判断都在 src/qzone/index.js 里，控制台和 CLI 走的是同一份实现。
  // 起草的人设来源：必须和聊天用**同一份人格卡**，否则"同一个 AI"在空间里会变成另一个人。
  // 不传 role 名时取当前激活人格（与聊天注入的是同一段文本，筛选和截断也一致）；
  // 传了就按名字取，但同样过 sanitizeRoleName 与目录边界——state/current-role.json
  // 是用户可编辑文件，这条路不能变成任意文件读取。
  const personaForQzone = ({ role } = {}) => {
    const mode = currentMode === 'reserved2' ? 'v2' : 'v1';
    const wanted = sanitizeRoleName(role);
    if (wanted && !wanted.includes('..')) {
      try {
        const selected = selectRoleText(readRoleContent(wanted), mode);
        const capped = selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
        return capped ? { name: wanted, text: capped, source: 'role' } : null;
      } catch (error) {
        log(`QQ 空间起草：读取人格「${wanted}」失败（${error?.message ?? error}）`);
        return null;
      }
    }
    const text = mode === 'v2' ? currentRoleHintV2() : currentRoleHint();
    if (!text) return null;
    return { name: readRoleState().role ?? '', text, source: 'current' };
  };

  // 起草器：把素材写成说说。**思考强度独立于聊天**（默认 high）——
  // 聊天要快、用 low；写一条要给所有人看的说说，值得多想几步。
  // 模型目录里不支持 reasoning_effort 的模型会由 model-client 自己兜底，这里不额外判断。
  //
  // recordUsage 走函数声明（提升），它里面才用到下面才创建的 tokenLedger：
  // 记账是运行时行为，等到真有一次起草时账本早就装配好了，不需要为此调换构造顺序。
  const qzoneDrafter = createQzoneDrafter({
    cfg,
    log,
    getPersona: personaForQzone,
    recordUsage: recordQzoneDraftUsage
  });

  const qzoneSvc = createQzoneService({
    cfg,
    log,
    stateDir: STATE_DIR,
    atomicWriteJson,
    onebotHttpAction,
    knownAgentTokens: KNOWN_AGENT_TOKENS,
    drafter: qzoneDrafter
  });
  if (cfg.socialV2?.qzone?.enabled === false) {
    log('ℹ️  QQ 空间能力已在配置里关闭（socialV2.qzone.enabled=false）');
  }

  // media/local-images（src/media/local-images.js）：图库目录解析 + 轮换记录。
  // 依赖只有路径常量、只读配置和日志，全部在下方之前就已就绪，所以就地 bind。
  // getRoleSelfieDirs 传的是**取值函数**：人格随时可切，自拍照必须跟着当前人格走
  // （传值快照会让桥接永远用启动那一刻的图库）。
  const localImagesSvc = createLocalImages();
  localImagesSvc.bind({ IMAGE_RECENT_FILE, cfg, log, getRoleSelfieDirs: () => currentRoleProfile().selfieDirs });
  const { loadRecentLocalImages, rememberLocalImage, resolveImageDirs, resolveSelfieDirs, inspectSelfieDirs, normalizePixevalSize, imageDefaultsSize } = localImagesSvc;

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = deps?.api ?? new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防重入：key -> 该会话有一次唤醒回合在途（lite 收尾时删除，租约兜底）
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量。
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    // 轻量直连引擎没有 DSH 会话，用合成 sid 直接把花费记到对应 QQ 会话上。
    // 前缀一共有三种：lite-direct:<key>（主回复）、lite-summary:<key>（滚动纪要）、
    // lite-person:<key>（读档案后的补调用）。只认第一种会让后两种掉进「未归属」桶，
    // 控制台每会话花费因此偏低，而「未归属」里凭空多出一笔。
    resolveKey: (sessionId) => {
      const sid = String(sessionId ?? '');
      const fromReverse = reverse.get(sid);
      if (fromReverse) return fromReverse;
      for (const prefix of LITE_SID_PREFIXES) {
        if (!sid.startsWith(prefix)) continue;
        const key = sid.slice(prefix.length);
        if (/^(group|private):\d+$/.test(key)) return key;
      }
      // 空间起草：有会话 key 就算到那个会话，没有就单列一个内部条目。
      // 返回 undefined 会让它掉进「未归属:xxxx」，看起来像脏数据，实际是一笔正经开销。
      const draftOwner = qzoneDraftOwner(sid);
      if (draftOwner) return draftOwner;
      return undefined;
    }
  });

  /** qzone-draft 的 sid -> 已用轮次。账本靠 (turn, step) 去重，同一会话的每次起草要递增。 */
  const qzoneDraftTurns = new Map();

  /**
   * 记录一次 AI 起草的开销（由 qzone 起草器在模型返回后回调）。
   *
   * 为什么必须单独接：起草走自己的 `complete`，不经过 lite 的 `recordLiteDirectUsage`，
   * 所以在这之前**空间起草的开销完全没有进账本**——控制台上的总额、每会话花费都是偏低的。
   * `sessionKey` 是外部传入的（AI 的 body.key），先按形状白名单校验再当 sid 用。
   */
  function recordQzoneDraftUsage({ usage, model, sessionKey } = {}) {
    const sid = qzoneDraftSessionId(sessionKey);
    const turn = (qzoneDraftTurns.get(sid) || 0) + 1;
    qzoneDraftTurns.set(sid, turn);
    const resolvedModel = model || cfg.socialV2?.qzone?.aiDraft?.model || nominalModel();
    tokenLedger.ingestEvent({
      sessionId: sid,
      model: resolvedModel,
      provider: cfg.dsh?.provider || 'deepseek-official',
      at: Date.now(),
      event: {
        type: 'assistant/message',
        time: Date.now(),
        seq: turn,
        data: { usage: usageToLedgerBuckets(usage), turn, step: 1, model: resolvedModel }
      }
    });
  }

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  // session/usage（src/session/usage.js）：token 账本摄入 + 断线回合重建。
  // bind 必须紧跟这里：`recordSessionSnapshot` 会被 pumpMux 与开场帧处理直接调用，
  // 而这些容器（collectors / v2TurnStartAt / tokenLedger）在上方已全部就绪。
  const sessionUsageSvc = createSessionUsage();
  sessionUsageSvc.bind({ api, cfg, collectors, log, nominalModel, sessionModels, tokenLedger, v2TurnStartAt });
  const { fetchModelCatalog, rememberModel, recordSessionUsage, recordSessionSnapshot, rebuildInFlightCollector } = sessionUsageSvc;

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  // 启动默认值取 reserved2：一律先按最保守的「私聊/群聊都要过白名单」模式跑，
  // 真正的值由 refreshMode() 从 DSH settings / state/mode.json 读回。
  let currentMode = 'reserved2'; // reserved2 | closed-agent
  let lastMode = currentMode;
  // 取值函数：模块化之后各域拿到的是函数引用而非值快照。`currentMode` / `dshReady`
  // 都会在运行中被改写，传值会让模块永远按启动那一刻的状态判断——症状是切模式或
  // DSH 恢复后行为不变，且没有任何报错。
  const getCurrentMode = () => currentMode;
  const getDshReady = () => dshReady;
  // 写入端同样要给出去：checkDsh（已迁到 src/conn/monitor.js）负责改写这两个状态，
  // 但它们的**所有权留在装配期**——(snapshot) 状态快照、控制台的 setMode/setReady
  // 回调都要读写同一份。模块只通过访问器操作，不持有变量本身。
  const setDshReady = (value) => { dshReady = value; };
  const getLastMode = () => lastMode;
  const setLastMode = (value) => { lastMode = value; };
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  const getDshPresetIds = () => dshPresetIds;
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_HINT_COOLDOWN_MS = 30_000;

  const modeSvc = createModeService();
  const { refreshMode, refreshPresetList, modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode, sessionPolicy, isCurrentSession, stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies } = modeSvc;

  // 离线补投队列（DSH 不可用期间攒下的 QQ 消息）。整块已在 src/send/retry-queue.js，
  // 这里只取回引用：queued 是 const Map，按引用共享是安全的（详见该模块顶部注释）。
  const retryQueueSvc = createRetryQueue();
  retryQueueSvc.bind({ cfg, deliverPrompt, getCurrentMode, log, modeAllowed });
  // QUEUE_MAX 由该模块独占（此前 bridge 侧也定义了一份，三处入队逻辑各写各的，
  // 已经漂移：只有 enqueueForRetry 会去重并重置退避计数）。取回引用继续 bind 给下游。
  const { QUEUE_MAX, queued, enqueueForRetry, pushQueued, flushQueue } = retryQueueSvc;

  // 控制台诊断数据读写（src/diag-log.js）：用户反馈条目。
  // 它唯一的消费者是 HTTP 控制台路由 src/http/routes/social-v2.js。
  const diagLogSvc = createDiagLog();
  diagLogSvc.bind({ FEEDBACK_FILE, atomicWriteJson, readJsonSafe, redactSensitiveText });
  const { readFeedbackEntries, appendFeedbackEntry } = diagLogSvc;
  // 精确名单脱敏（src/sensitive.js）：KNOWN_AGENT_TOKENS 是 const Set，
  // 引用恒定、只有内容在运行中增删，所以这里传整个 Set 而不是快照。
  // 四个下游模块拿到的仍是同一个函数，调用点写法一行都不用改。
  const redactKnownTokensOnly = (text) => redactKnownTokens(text, KNOWN_AGENT_TOKENS);

  // ── DSH 端口自动跟随 ──────────────────────────────────────────────────────
  // DSH Desktop 每次启动都用 `--port 0`（随机端口，见 dsh-desktop-host），而桥接是
  // **外部进程**，只能按 config.json 的 dsh.baseUrl 找它。于是 DSH 一重启，旧端口作废，
  // 表现就是「QQ 发消息完全没反应、日志一直 DSH 不可用」。
  // 这里在 5 秒探活失败时自动重新发现本机 DSH Web API 端口，热切换 baseUrl 并写回配置。
  const REDISCOVER_THROTTLE_MS = 15_000;

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };



  /** 面板探测结果的短缓存：控制台每 3 秒轮询一次，没必要每次都去打 OneBot + 读日志。 */
  const SNOWLUMA_PANEL_CACHE_MS = 4000;
  let snowlumaPanelCache = { at: 0, value: null };






  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存在 state/*.json，桥接即时感知；此服务只读写这些文件。

  // ── 控制台 HTTP 服务 ────────────────────────────────────────────────────
  //
  // 路由、安全闸门、分发已拆到 src/http/：原来 5,200 行的 startConsoleServer
  // 现在是「汇依赖 + 启动」两步，领域逻辑在 http/routes/*.js 里。
  //
  // routeDeps 近 200 项看起来吓人，但这就是控制台的真实依赖面——它是能操作一切的入口。
  // 显式列出来的价值不在于好看，而在于「谁在依赖什么」第一次成为可检索、可审查的事实；
  // 后续收窄的路径是让端点改调 service 方法，而不是继续往这里加名字。
  //
  // 惰性构建：清单里的 MAX_MEDIA_FETCH_BYTES / MAX_MEDIA_PIXELS 声明在本段之后，
  // 立即求值会撞 TDZ（Cannot access before initialization）。原实现是函数体、
  // 天然惰性，这里保持同样的求值时机——首次启动控制台时才组装，那时闭包已全部初始化。
  let httpRouteDeps = null;

  const buildHttpRouteDeps = () => ({
    ACTIVE_WAIT_LEASE_MS, ACTIVITY_LOG, CONVERSATION_TOKENS, DSH_CONTROL_TIMEOUT_MS,
    FEEDBACK_FILE, KNOWN_AGENT_TOKENS, MAX_MEDIA_FETCH_BYTES, MAX_MEDIA_PIXELS,
    MAX_SEND_BYTES, MODE_INPUT_ALIASES, PRESET_BACKUP_DIR, PRESET_NAMES,
    REASONING_EFFORT_DEFAULT, REASONING_EFFORT_OPTIONS, ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX,
    ROOT, SNOWLUMA_PANEL_CACHE_MS, SOCIAL_V2_FILE, STATE_DIR,
    VALID_MODES,  activeWaits,
    addConsoleNote, allowed, allowedEffortsFor,
    api, appendActivity, appendFeedbackEntry,
    appendSocialV2Message, applyRoleInjectLimit, applyStickerNoteV2, applyWakeConfigV2,
    assertGroupMember, atomicWriteJson, atomicWriteText, backupPresetFile,
    bot, buildWakePromptLite, cancelPendingEntry,
    canonicalV2Key, captureSendGuard, cfg,
    clearAllPendingWakeLeases, clearAllSocialV2Timers, clearSocialV2Timers,
    clearTimeout, collectors, computeGapsV2,
    computeWakeSafetyV2, currentRoleHint, currentRoleHintLite,
    currentRoleHintV2, deliverPrompt, describeMessageImages, drainAllPromptQueues,
    drainPromptQueue, ensureChatModel, ensureSession, ensureWakeableV2,
    escapeCqText, feedbackTimes, fetch,
    fetchMediaData, findCjkSpaceWarning, findMessageMedia, findSplitBoundaryWarning,
    forgetAgentToken, formatParticipationV2,
    getImageDimensions, getSocialV2State, getStickerImageData, handleLiteTurnEnd,
    hardenStateDirAcl, initialPromptMaxChars, initialPrompts, installedPresetYaml,
    isConversationBusyV2, isSleepingConfigV2, knownPresetName,
    inspectSelfieDirs, resolveSelfieDirs,
    listPresetBackups, liteDirectActive, liteEngine,
    liteKeyEnabled, liteModelKey, loadConfig, loadRecentLocalImages,
    log, messageMediaStore, mimeFromBuffer, mimeFromUrl,
    modeAllowed, modelAppliedSessions, modelCatalogErrorLogged, modelSelection,
    normalizeModeInput, normalizeOwnerQQ, normalizePixevalSize, normalizeReasoningEffort,
     onebotHttpAction, pending, pendingSendToolCalls,
    pendingWakeKeys, personMemoryIndexText, personStore, preSleepWaitBlockedV2,
    presetSourceYaml, presetStatus, priceTable,
    // 控制台「主动私聊」面板：只读排期 + 配置保存后重排（见 social/proactive.js）。
    // 传的是服务实例而不是拆成两个函数，是因为 listSchedules / replanAll 共享同一份策略解析。
    proactivePrivateSvc,
    qzoneSvc,
    queued, queuedHintAt, readActivityTail,
    readConfigObject, readFeedbackEntries, readJsonSafe, readPresetPromptText,
    readRoleContent, readRoleProfile, readRoleState,
    currentRoleProfile, currentRoleVoice,
    reconcileSessionPolicies, recordSentMessagesV2, redactKnownTokensOnly, refreshAllDefaultWakeConfigsV2,
    refreshMode, regeneratePresetPatch, releaseLock, rememberLocalImage,
    replayPendingWakeReasonsV2, replyTimingV2,  resolveImageDirs,
    resolveReplyInfo, resolveReplyTargetV2, resolveVoicePathForOperator, resolveVoicePathForV2,
    retireSession, reverse, roleContentStamp, roleDelete, roleExists, roleFilePath, roleRename,
    roleSummaries, roleWarnings,
    sanitizeRoleName, saveSocialV2State, saveState,
    scheduleProactiveCheckV2, seenForwardIds, segmentsToText, selfIdentityTextV2,
    sendImageV2, sendMessagesV2, sendStickerV2, sendToolSucceededSessions,
    sendVoiceForV2, sendVoiceV2, sendWakePromptV2, sessionModels,
    sessionPromises, setInitialPrompt, setStickerRemarkV2,
    setTimeout, setupSleepTimerV2, shouldBlockSilentReply,
    sleep, snowlumaHealthSnapshot, snowlumaHomeDir, social,
    socialV2, state, stateDirHardened,
    stickerEnabled, stopRetiredSessionWork,  syncStickerLibrary,
    synthesizeVoiceFile, toModelMedia, tokenLedger, toolCallNames,
    transcribeVoiceMessage, ttsServiceJson, turnLeaseNoted, unquoteJsonString,
    v2TurnStartAt, validateRoleContent, validateRoleName,
    verifyVoiceMessageSent, videoCallTimes, videoLinkApi, videoRateLimited,
    visionCallTimes, voiceBudgetCheck, voiceBudgetCommit, voiceCfg,
    voiceLibrary, voiceTtsCfg, withTimeout, writeRoleContent,
    writeRoleProfile,
    writeRoleState,
  });

  // 可变状态的取值器 + 写回器：每请求调用一次。
  // 不能直接把 currentMode 塞进 routeDeps —— 工厂解构发生在上电那一刻，
  // 控制台切模式后快照就过期了，/api/status 会一直报启动时的模式。
  // 反过来也一样：handler 里的形参是**值快照**，`currentMode = x` 改的是副本，
  // 所以凡是控制台要改的状态都必须走这里的 setter，不许直接赋值。
  const httpLiveValues = () => ({
    currentMode, lastMode, dshReady, closedAgentPreset, sessionEpoch, roleInjectMaxChars,
    selfDisplayName, selfUserId,
    stickerEntries: stickerSvc.getEntries(), stickerStoreWritable: stickerSvc.isWritable(),
    stickerSyncedAt: stickerSvc.getSyncedAt(), lastForcedAgentStickerSync,
    snowlumaPanelCache, initialPromptsWritable: promptStoreSvc.isWritable(),
    liteDirectFailures: getLiteDirectFailures(), liteDirectBroken: getLiteDirectBroken(),
    setClosedAgentPreset: (value) => { closedAgentPreset = value; },
    setMode: (mode) => { currentMode = mode; lastMode = mode; },
    bumpSessionEpoch: () => { sessionEpoch++; },
    setRoleInjectMaxChars: (value) => { roleInjectMaxChars = value; }
  });

  // 读取 DSH 模型目录（在途去重 + 超时）：控制台的「模型/档位」展示、以及切换模型前的
  // 合法性校验共用一份，避免同一次刷新里对 DSH 发多个 modelCatalog。
  //
  // 从 startConsoleServer 里提到这里，是因为它依赖 modelCatalogInFlight 这个 boot 级
  // 可变状态；搬进 HTTP 模块反而要额外传 getter/setter，不如留在有状态的一方。
  const loadDshCatalog = async () => {
    if (!modelCatalogInFlight) {
      modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
        .finally(() => { modelCatalogInFlight = null; });
    }
    return unwrap(await modelCatalogInFlight, 'session.modelCatalog');
  };

  function startConsoleServer() {
    httpRouteDeps ||= buildHttpRouteDeps();
    return createConsoleServer({
      cfg, log, ROOT, loadOrCreateConsoleToken,
      socialV2, currentMode, stickerStoreWritable: stickerSvc.isWritable(),
      isSessionAllowedInCurrentMode, loadDshCatalog, canonicalV2Key,
      routeDeps: httpRouteDeps,
      liveValues: httpLiveValues
    });
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）。
  // 队列对象来自 src/send/queue.js：src/send 里的四个发送函数与这里的 sendToQQ /
  // sendTextMessagesV2 必须往**同一条**链上追加。早先用裸变量 + bind 传值是不可行的——
  // bind 拿到的是当时的 Promise，一侧 `chain = chain.then(...)` 只改自己那份，链立刻分叉，
  // 表现为并发工具调用时「先文字后表情」偶发反序。共享对象是唯一不会分叉的写法。

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）








  // 表情/图片字节解析与抓取（mimeFromBuffer、getImageDimensions、emojiCdnCandidates、
  // fetchOneBotImage、fetchFaceMedia、resolveMediaList、fetchMediaData…）
  // 已迁出 → src/media/inbound.js。

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限（8MB 能覆盖绝大多数动图表情）；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxFetchBytes — **抓取**单张图片的字节上限，故意比 maxBytes 大：得先把大图抓下来，
  //                才有机会在 toModelMedia 里压小它。没有这条时 8MB+ 的原图会在下载阶段
  //                就被 safeFetchBuffer 拒成「图片超过大小限制」，模型一个字都看不到。
  //                （QQ 里的高清照片/长图经常就在 8~16MB 这一档。）
  //   maxPixels — 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const maxMediaFetchLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxFetchBytes);
    return Number.isFinite(n) && n > 0
      ? Math.min(24 * 1024 * 1024, Math.max(1 * 1024 * 1024, Math.round(n)))
      : 16 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限（按归一化后的实际发送量算）
  // 抓取上限必须 ≥ 单条总账，否则「先抓下来再压」在 maxBytes 被调大时会自相矛盾（抓取比总量还小）；
  // 同时仍收敛在 24MiB 以内。
  const MAX_MEDIA_FETCH_BYTES = Math.min(24 * 1024 * 1024, Math.max(MAX_MEDIA_BYTES, maxMediaFetchLimit));
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  // 出站发图的体积上限。与入站的 MAX_MEDIA_BYTES 分开的理由：
  //   入站那张图要交给 DSH 的 MCP 图片入口，那里有 base64 正则炸栈线（实测 ≥4.2 MiB 起会
  //   Maximum call stack size exceeded），所以入站必须压到 1 MB 级；**出站不经 DSH**，
  //   直接 base64 交给 OneBot/网关，没有那条约束，真正的瓶颈是网关转码上传 QQ。
  // 配置 socialV2.image.maxSendBytes 可调，硬上限 20MB（再大 base64 常驻内存 ×1.33 不划算）。
  const MAX_SEND_BYTES = (() => {
    const n = Number(cfg.socialV2?.image?.maxSendBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 12 * 1024 * 1024;
  })();

  // ── 喂给模型的那一份：体积与动图形态归一化 ────────────────────────────────
  //
  // 为什么必须在这里动手（而不是"让 DSH 自己处理"）：
  //   ① DSH 的 MCP 图片入口用正则校验 base64，实测量级 ≥4,474,880 字符（原始字节 ≥3.20 MiB）
  //      必抛 RangeError: Maximum call stack size exceeded，工具结果被降级成
  //      `[image unavailable: image/gif; Maximum call stack size exceeded; …]` —— 模型只看到一行错误。
  //      而 MAX_MEDIA_FETCH_BYTES 是**抓取**上限（默认 16 MiB，比总账 maxBytes 大），
  //      得先把大图抓下来，才有机会压小它。
  //   ② DSH 对 image/gif 一律归一化成单帧，模型永远只看第一帧，且不知道那是动图。
  //      动图在桥接侧抽帧拼图后，信息量反而更高（实测 4.83MB/200 帧 → 92KB/269ms）。
  //
  // 上限默认值见 media-normalize.js 的 MEDIA_DEFAULTS；config.json 的 socialV2.media 可覆盖。
  // ⚠️ 只用于**喂模型**的出口：任何需要原始字节的路径都不能经过这里，
  //    否则图片会变成拼图/降采样版本。
  const modelMediaLimits = (() => {
    const m = cfg.socialV2?.media ?? {};
    return {
      enabled: m.normalize !== false,
      maxModelBytes: m.maxModelBytes,
      maxLongEdge: m.maxLongEdge,
      gifFrames: m.gifFrames,
      gifTile: m.gifTile,
      timeoutMs: m.normalizeTimeoutMs,
      ffmpegPath: process.env.FFMPEG_PATH || cfg.socialV2?.voice?.ffmpegPath || null
    };
  })();

  // ── 喂给模型的那一份：字节与形态归一化 ────────────────────────────────────
  // toModelMedia / acceptImageBuffer / 视频提示等 24 个媒体函数已迁出，见 src/media/inbound.js。
  // 这里只保留它们的**配置**：上限常量必须留在 boot 作用域，因为 HTTP 路由和其他业务路径
  // 也直接引用同一个值，两处各算一份就会出现「路由放行、入库拒绝」的裂缝。

  // ── 视频链接提示（消息里出现视频链接/分享卡片/视频段时） ────────────────────
  // 为什么是「同步读缓存 + 异步预取」，而不是把 mediaHintFor 改成 async：
  // mediaHintFor 有 7 个**同步**调用点，其中几处在模板字符串里；把它们全部改成 await
  // 会动到整条提示词组装链（唤醒快照渲染 / 未读行拼装 / 模板字符串里的 7 处调用点），
  // 风险远大于收益。这里改成：
  //   · videoHintLine()：同步给出「检测到视频 + 怎么调工具」的通用行（永不阻塞）；
  //   · prepareVideoHint()：消息入库后 fire-and-forget 抓一次元数据（metaTimeoutMs 竞速），
  //     成功就把《标题》/UP/时长卡片写进缓存；下一轮拼提示词时同步读到完整卡片。
  const videoHintCache = new Map();       // `${key}:${messageId}` -> { line, at }
  const videoHintPrefetching = new Set();
  const VIDEO_HINT_TTL_MS = 60 * 1000;
  const VIDEO_HINT_CACHE_MAX = 200;
  // videoHintToolHint / videoHintLine / prepareVideoHint / mediaHintFor →
  // src/media/inbound.js。缓存本体留在本地，由 bind() 交出去。

  // ── 识图（vision）与语音转写（SenseVoice）辅助 ──────────────────────────────
  // 两个能力都只在「消息确实属于当前会话」的前提下工作：先按 key/messageId 从
  // 会话内取媒体，再交给外部服务。模型拿不到任意 URL/路径，也没有文件读取通道。
  /** 识图限频（全局，保护付费视觉 API 不被群友驱使刷爆）。 */
  const visionCallTimes = [];

  /**
   * 看视频限频（全局）：群友可以驱使 AI 反复抓视频/跑 ASR，必须挡一下。
   * 只统计**工具调用**；消息入库时的自动元数据预取不计入（那是每条约一次）。
   */
  const videoCallTimes = [];

  // 识图与语音的三个入口已迁出 → src/media/inbound.js：
  //   describeMessageImages（fetchMediaData → 视觉 API → 文字描述）
  //   findMessageVoice（按关键取 record 段，v2 有 messageId/seq 映射时优先用映射）
  //   transcribeVoiceMessage（record → get_record(wav) → 16k → SenseVoice，失败回退 QQ 转写）
  // 限频数组留在本地：它们是**跨消息累计**的全局状态，bind() 交出去的是同一个引用。







  // send/outbound（src/send/outbound.js）：审计 → 分段 → 发送链 → 失败标记。
  // 这里只取函数引用；bind 必须等到 `bot` 创建之后（见下方的 accountSvc.bind 前）。
  const outboundSvc = createOutboundSend();
  const { sendToQQ, lastSendSucceeded, onebotSend, sendTextMessagesV2, shouldAuditKey, captureSendGuard, shouldBlockSilentReply, auditAndSend } = outboundSvc;

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelection，使旧记录失效并在下一条消息重新应用。
  // 模型由 config.json 的 dsh.provider/dsh.model 决定（默认 deepseek-official/deepseek-flash，
  // 可切到反代 qoder 的 DeepSeek-Flash 等）。注意：反代那类 provider 的模型不支持「思考强度」，
  // DSH 会回 `session/model-unavailable: ... does not support reasoning effort "low"`。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelection
  // 已经确认「不支持思考档位」的 `${provider}/${model}`：命中的模型以后一律省略 reasoningEffort。
  // 为什么必须记住：ensureSession 只在 'not-found' 时退役会话，'failed' 会静默沿用旧模型继续跑，
  // 于是「档位不兼容」会变成「模型切换看起来成功了、其实一直没生效」——最难查的那种。
  const modelsWithoutReasoningEffort = new Set();


  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 取值函数：网关返回登录信息后才会写 selfNickname，传值会让"被 @ 昵称"这条匹配
  // 永远停在默认的 deepseek 上。多个域都要读，提取成常量以免各处重复内联箭头函数。
  const getSelfNickname = () => selfNickname;
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  // 一代仿真引擎清退后只剩这一个容器：它的唯一用途是「后台提醒那一轮别把文本发到 QQ」。
  // 写入在 platform.js（投递后台提醒时占一个名额），消费在 mux/pump.js（回合结束时弹出并静默）。
  // 曾经同在这里的 states / recentMessages / pendingSummaries / pendingTimers / exitingSessions
  // 随状态机一起删除了——留着只会让人以为还有第二个引擎在跑。
  const social = {
    silentTurns: new Map()         // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 会话保障（src/session/ensure.js）：建会话 + 选模型，两者是一对。
  // 放在 socialV2 / modelAppliedSessions 之后——它们是最后就绪的两个依赖。
  // 四个可变量走取值函数：传值会冻结。
  sessionEnsurer.bind({
    DSH_CONTROL_TIMEOUT_MS, REASONING_EFFORT_DEFAULT, STATE_DIR,
    api, cfg, isCurrentSession, isSessionAllowedInCurrentMode, log, modePreset,
    modelAppliedSessions, modelsWithoutReasoningEffort, retireSession, reverse,
    saveState, sessionPolicy, sessionPromises, sleep, socialV2, state, withTimeout,
    getCurrentMode: () => currentMode,
    getDshPresetIds: () => dshPresetIds,
    getSessionEpoch: () => sessionEpoch,
    getModelSelectionEpoch: () => modelSelection.epoch
  });

  // voice/send（src/voice/send.js）：语音条全链路。限流桶与意图正则由模块独占，
  // 这里只交出跨域只读容器；fetch 显式传是为了保留审计 harness 的打桩点。
  // bind 放在这里而不是尾部：sendSvc.bind（下方）会把本模块的函数当值取走。
  voiceSendSvc.bind({
    KNOWN_AGENT_TOKENS, ROOT, appendActivity, cfg, currentRoleVoice, fetch, getSocialV2State, liteHistoryLines, log,
    saveSocialV2State, sendVoiceV2, shouldAuditKey, socialV2, voicePathInsideLibrary
  });

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>
  //
  // process.exit() 会 emit 'exit'，所以这一个钩子能兜住 SIGINT / SIGTERM /
  // uncaughtException 三条退出路径；'exit' 处理器里的同步写是允许的。
  // 沙箱环境可能没有 process.on，包一层以免影响离线测试。
  try {
    if (typeof process?.on === 'function') {
      process.on('exit', () => {
        try { flushSocialV2State(); } catch {}
      });
    }
  } catch {}
  // 人物档案（src/person）：目录、索引摘要、focus 预取、写入操作全部由模块独占，
  // 桥接侧只保留调用点；两个缓存随函数一起搬走。这里只交容器与可替换能力。
  personSvc.bind({ ROOT, appendActivity, cfg, db: bridgeDb, getSocialV2State, log, redactKnownTokensOnly, saveSocialV2State });

  // 二代仿真状态（src/social/v2-store）：唤醒配置与持久化。
  // 这个模块在 boot **中段**就要被调用（紧接着的 loadSocialV2State 会落盘/回写状态），
  // 所以 bind 必须提前到这里，不能等到尾部统一注入。依赖里除了容器外都是函数声明，
  // 提升后此刻已可用；容器（cfg / state / social / socialV2 / seenForwardIds / reverse）
  // 也都在这一行之前初始化完毕。
  // social / socialV2 / seenForwardIds 是**引用恒定**的容器（const 对象/Map，从不整体替换），
  // 按引用交出不会分叉；落盘句柄 socialV2SaveHandle 已归模块独占，不再从桥接侧传入。
  socialV2Store.bind({
    SOCIAL_V2_FILE,
     atomicWriteJson, canonicalV2Key, cfg, currentRoleWakeKeywords, log, readJsonSafe,
     rememberAgentToken,  reverse,
    scheduleProactiveCheckV2, seenForwardIds, setupSleepTimerV2, social, socialV2,
    startConsoleServer, state
  });

  loadSocialV2State();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();
  // mux/ingest（src/mux/ingest.js）：QQ 入站分派。
  // 容器按引用交出（引用恒定、不整体替换）；三个 let 走取值函数——传值会让入站
  // 永远按启动那一刻的模式/就绪状态/会话代次判断，切模式后规则不跟着变。
  const muxIngestSvc = createMuxIngest();
  muxIngestSvc.bind({
    APPROVE_WORDS, DIRECTION_HINT, DSH_CONTROL_TIMEOUT_MS, MAX_MEDIA_STORE_PER_KEY, QUEUE_HINT_COOLDOWN_MS,
    REJECT_WORDS, ROOT, SILENT_MARKER, SPACE_SPLIT_HINT, allowed, api,
    appendActivity, appendSocialV2Message, appendSocialV2Poke, applyFriendDecision,
    auditAndSend, buildWakeSnapshotV2, cfg, clearSocialV2Timers,
    collectors, convKey, currentRoleHint, deliverPrompt, drainPromptQueue, enqueueForRetry,
    ensureSession, extractMediaFromSegments, forgetAgentToken,
    getSelfNickname, getSocialV2State, isCurrentSession,
    isDirectedAtAi, isQuoteTargetSelf, isSessionAllowedInCurrentMode, log, mediaHintFor, messageMediaStore,
    modeAllowed, modelAppliedSessions, parseFriendDecision, pending, pendingSendToolCalls, pendingWakeKeys,
    prepareVideoHint, pushQueued, queued, queuedHintAt, readRoleState, resolveGroupMemberName, resolveMediaList,
    resolveReplyInfo, retireSession, reverse, roleExists, sanitizeRoleName, saveSocialV2State, saveState,
    scheduleWakeV2, seenForwardIds, segmentsToText, sendToQQ, sendToolSucceededSessions,
    sessionPromises, shouldAuditKey, social, socialV2,
    state, toolCallNames, turnLeaseNoted, v2TurnStartAt,
    videoHintCache, withTimeout, writeRoleState,
    getCurrentMode: () => currentMode, getDshReady: () => dshReady, getSessionEpoch: () => sessionEpoch
  });
  const { takeRotateHandoffV2, handleIncoming, cancelPendingEntry, handlePendingAnswer, handlePokeNotice, registerPending } = muxIngestSvc;

  // mode/index（src/mode/index.js）：模式总开关 + 由它派生的会话策略与退役。
  // 四个模式变量是 let，传**取值函数 + 写入函数**：传值会让模块永远按启动那一刻的模式
  // 判断（症状：控制台切了模式，QQ 行为不变，且没有任何报错）。
  // bind 放在 ingest 之后：这里要取的 cancelPendingEntry 就是它刚解构出来的。
  modeSvc.bind({
    DSH_CONTROL_TIMEOUT_MS, MODE_INPUT_ALIASES, STATE_DIR, activeWaits, allowed, api,
    cancelPendingEntry, cfg, clearSocialV2Timers, collectors, disarmPendingWakeLease,
    feedbackTimes, lastSendFailed, liteChatEnabled, liteKeyEnabled, log, modelAppliedSessions, normalizeModeInput,
    normalizeOwnerQQ, pending, pendingSendToolCalls, pendingWakeKeys, queuedHintAt, readJsonSafe,
    rememberAgentToken, reverse, saveSocialV2State, saveState, sendToolSucceededSessions, sessionModels,
    settingFromDshNamespace, social, socialV2, state, toolCallNames,
    turnLeaseNoted, v2TurnStartAt, withTimeout,
    getCurrentMode: () => currentMode,
    setCurrentMode: (value) => { currentMode = value; },
    getClosedAgentPreset: () => closedAgentPreset,
    setClosedAgentPreset: (value) => { closedAgentPreset = value; },
    getDshPresetIds: () => dshPresetIds,
    setDshPresetIds: (value) => { dshPresetIds = value; },
    getDshDefaultPreset: () => dshDefaultPreset,
    setDshDefaultPreset: (value) => { dshDefaultPreset = value; }
  });

  // 当前角色扮演提示、群成员缓存、引用解析缓存：人格卡与群成员缓存已归
  // src/social/record.js 独占；replyInfoCache 仍留在这里，因为它与发送模块（src/send）
  // 共用同一份，属于跨域容器，两处都按引用拿到同一个 Map。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败


  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.

  // ── 时间观念（沉睡后醒来最容易犯的错） ────────────────────────────────────
  //
  // 现象（操作者报告 + 会话实证）：AI 沉睡很久后被唤醒，看到一小时前的话仍然当成"刚发的"去接，
  // 甚至抢进早已散场的话题。根因之一是模型看到的时间是裸 epoch（`time: 1792294529471`），
  // 它根本算不出"这是 38 分钟前" → 已由 qq-model-view.js 换成 `at`/`ago`。
  // 原先二代 prompt 里还有一层「时间感分档规则」，随二代工具协议一起删除了；
  // lite 提示词走的是消息行的 at/ago + 快照头部的 now/newestAgo。
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  // ── 后台控制端提醒（操作者的引导）──────────────────────────────────────
  // 存在会话状态里、唤醒时注入 prompt，而不是像以前那样直接投一条 DSH prompt：
  //   · lite 直连根本不建 DSH 会话，没有「投递」这回事；
  //   · 存下来之后，模型这轮没跑成（或正在忙）时下一轮还能补上，不会白发；
  //   · 提醒天然一次性 —— 注入过的那一轮正常收尾就清掉，不留历史包袱。
  const CONSOLE_NOTE_TTL_MS = 30 * 60 * 1000;
  const CONSOLE_NOTE_MAX = 3;
  const CONSOLE_NOTE_MAX_CHARS = 600;
  /** 写入一条提醒：同文去重、只留最近 CONSOLE_NOTE_MAX 条。返回 null 表示没写进去。 */
  /** lite 的默认唤醒配置：私聊=任何消息都醒；群聊=@/名字/提问/拍一拍 + 低概率。 */
  // lite 的媒体预取与表情索引（src/lite/media.js）：无工具会话的图片/语音必须在唤醒前
  // 转成文字，否则模型只看到「[图片]」三个字，只能瞎接。描述结果按消息缓存（TTL 30 分钟），
  // 同一条消息不会因为多轮唤醒被反复送进视觉/视频接口。缓存容器与 TTL 随函数一起搬进模块。
  /**
   * lite 提示词里的硬编码规则段（只含文案，不含动态数据）。
   *
   * 集中在这里而不是散落在拼装逻辑里：这几段是"给数据配用法"的核心资产——
   * 只喂档案不给用法，模型会把履历当知识念出来。它们的改动频率比代码高，
   * 集中一处便于审阅；拼装函数只负责决定「放不放、放在哪」。
   */
  const LITE_RULES = {
    focusUsage: '【档案用法】上面是这个人的档案概况（是谁 / 性格与相处 / 待续·注意），你知道的就这些：自然用，不要念档案、不要说「根据档案」，也别像做自我介绍一样把上面几条复述给对方听。档案里没写的事别装作记得；对方问「还记得吗」，挑最相关的一件概括说，不要背清单。这轮如果听到关于他的新事实（称呼、喜好、近况、约定、在忙什么），单独一行写 [PERSON:note:<对方的QQ或昵称>] 一句话事实——它只追加到时间线，不会改动上面三段，所以别在这轮重写概况。',
    rosterUsage: '【档案名单规则】这里只是别人档案的摘要，不是本轮对话对象。要细节就 [PERSON:read:<QQ或昵称>]，别照着摘要编；对方提到某个不在这里的人，也可以 read 一下。',
    continuity: '【对话连续性】先接【未读消息】里最新的内容；不要把上下文里的旧话题重新提起，不要重复自己说过的话；距上一条消息超过 30 分钟就当作新对话开场，不要续旧梗。',
    // 为什么单独一段、而不是塞进 continuity：continuity 只回答「该接哪一条」，
    // 这一段回答「接住之后说什么」。混在一起时，模型会把「只接最新消息」执行成
    // 「只跟着最新一条说」——附和、接梗、没有任何自己的东西。分开写才能单独开关和观察。
    // 故意不写「要反驳」：那会把口嫌体正直变成抬杠，只要求「有判断」，赞不赞成都要说得出理由。
    stance: '【别只附和】接住之后要说点自己的东西：赞成，就补一句为什么；不赞成，就直接说不认同哪一点；拿不准，就说拿不准——只回「对啊」「哈哈」「确实」等于没说话。真对某个细节好奇，可以问一句具体的（「这个你在哪弄的」「后来他怎么说」），别问「真的吗」「然后呢」这种空问。表态和提问一轮最多各一次，问完就等对方说，别连着追问。',
    // 主动私聊专用（替代 continuity，不是叠在上面）：continuity 里「只回应未读消息」
    // 在主动开口时等于让人闭嘴——未读为空，模型照做就是 [SILENT]。
    proactiveOpen: '【这次是你主动开口】没有新消息，是你自己想找对方说句话，这轮不需要回应任何提问。优先接着最近聊过的事说一句你自己的看法；没有就翻翻对方档案里记着的事，挑一件具体好奇的问一句；都没有再自然关心一下近况。别用「在吗」「干嘛呢」开场，也别一口气问一串问题；一句话能说清就只说一句。对方可能正忙、也可能不想聊，发出去就算完成，不要追问「怎么不回」。不要重复你之前说过的话。实在没有想说的就只输出 [SILENT]——不发，比发一句尴尬的强。'
  };
  /** 解析 lite 回复：[SILENT] / 文本/表情/发图/拍一拍/语音/引用/下一次唤醒。 */
  // ── Track 3：直连 DeepSeek（完全绕开 DSH 会话）──────────────────────────────
  //
  // 轻量路径本来每轮就只有 1 次模型调用，DSH 剩下提供的只有「模型接入 + 人设注入」。
  // 直连引擎把这两件事也接过来：人设从 preset 源文件读、调用走 api.deepseek.com，
  // 于是 QQ 聊天完全不再依赖 DSH 的会话生命周期（也不用轮换/归档/事件流）。
  // 没有可用 key 时 liteEngine() 自动回退 dsh；连续失败 2 次会在本进程内永久回退，
  // 避免一轮坏调用把整晚的唤醒都堵死。
  const LITE_DIRECT_SID_PREFIX = 'lite-direct:';


  // 四个「本进程内是否已降级」的开关全部移入 src/lite/direct.js（只有它在读写）。
  // 控制台要展示时走下面的取值函数，避免两边各存一份、展示与实际不一致。
  const liteDirectTurnCounters = new Map();

  // lite 直连引擎（src/lite/direct.js）：无 DSH 会话时直接打 chat/completions。
  liteDirectSvc.bind({
    LITE_DIRECT_SID_PREFIX,  chatCompletion, normalizeModelConfig, resolveDeepSeekKey, usageToLedgerBuckets, appendActivity, applyPersonOps,
    armPendingWakeLease, buildWakePromptLite, buildWakeSnapshotV2, cfg,
    clearDeliveredConsoleNotes, defaultWakeConfigV2, disarmPendingWakeLease, ensureWakeableV2,
    getSocialV2State, isSilentMarker, lastSendSucceeded, liteDirectTurnCounters, liteSendImage,
    liteSendPoke, liteStickerChoices, liteSystemPrompt, log,  onebotSend,
    pendingWakeKeys, personProfileForRead, randInt,  recordLiteSentMessage,
    replayPendingWakeReasonsV2, saveSocialV2State, scheduleWakeV2, sendStickerV2, sendToQQ, setupSleepTimerV2,
    sleep, socialV2, speakVoiceForV2, state, tokenLedger
  });
  /** 直连引擎没有 qq_mark_read：提示词里给了哪些消息，就推进到哪些（同 DSH 轻量路径）。 */
  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  const WAKE_PRIORITY = {
    console: 95,
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    // 群聊「唤醒后保持活跃」窗口内有人说话：比普通消息高一点（合并窗口里不会被 anyMessage
    // 降级掉），但低于 @/关键词——真正被点名时仍然显示 atMention，模型才知道在叫它。
    activeWindow: 55,
    anyMessage: 50,
    timeout: 30,
    // 主动私聊：比 timeout 低、比群聊 proactiveCheck 高——它是「我自己想开口」，
    // 排在「对方/群里真的在叫我」之后，但比「群里冷场了凑一句」更值得说。
    proactivePrivate: 25,
    proactiveCheck: 20
  };
  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  // console = 控制台写的后台提醒专程唤醒，同样与未读无关。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'proactiveCheck', 'proactivePrivate', 'bootstrap', 'admin', 'console']);






  // ── DSH 事件流泵（src/mux/pump.js） ─────────────────────────────────────
  // 事件泵与 turn collector 生命周期由模块独占；这里只交容器与能力。
  // 容器（collectors / pendingSendToolCalls / toolCallNames / v2TurnStartAt /
  // sendToolSucceededSessions / turnLeaseNoted / pendingWakeKeys / activeWaits / reverse）
  // 全部引用恒定、从不整体替换，且被 sendSvc / wakeSvc / handles 共用 —— 按引用交出。
  // currentMode 是 let，必须传取值函数（pumpMux 的主循环会按模式分发事件）。
  const muxPumpSvc = createMuxPump();
  muxPumpSvc.bind({
    KNOWN_AGENT_TOKENS, SILENT_MARKER, SILENT_TURN_TIMEOUT_MS, activeWaits, api, appendActivity,
    cancelPendingEntry, cfg, clearAllPendingWakeLeases, collectors, defaultWakeConfigV2, getCurrentMode: () => currentMode,
    getSocialV2State, handleLiteTurnEnd, isCurrentSession, isSendToolName, isSilentMarker,
    liteSessionActive, log, pendingSendToolCalls, pendingWakeKeys,
    recordSessionSnapshot, recordSessionUsage, registerPending, replayPendingWakeReasonsV2, reverse,
    saveSocialV2State, sendBurstToQQ, sendToQQ, sendToolSucceededSessions, shouldAuditKey,
    sleep, social, socialV2,
    toolCallNames, turnLeaseNoted, v2TurnStartAt
  });
  const { trackTurnEvent, pumpMux } = muxPumpSvc;




  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = deps?.bot ?? new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  // outboundSvc 的 bind：`bot` 就在这里创建，之前的 bind 会撞 TDZ。
  // currentMode 走取值函数——「closed-agent 必须带 ownerQQ 前缀」这条规则要跟着模式变。
  outboundSvc.bind({
    KNOWN_AGENT_TOKENS, SEND_TIMEOUT_MS, appendActivity, bot, cfg, escapeCqText, fetch, getCurrentMode,
    isSessionAllowedInCurrentMode, lastSendFailed, log, readRoleState, redactKnownTokensOnly,
    sessionPolicy, sleep, state, withTimeout
  });

  // record.js 的 bind：依赖里有 bot（上一行才创建）与 seenForwardIds / segSvc 的
  // convertExampleSpacesToComma / voiceSendSvc 的 voiceTtsCfg 等，只能放在这里。
  // roleInjectMaxChars 走取值函数：控制台改注入上限后，下一条消息就要按新上限截断。
  socialRecord.bind({
    // 人格卡已迁到 state/bridge.db：热注入路径要的读取口在这里注入，
    // 不再是 ROLES_DIR + 文件 stat（缓存 key 改用库内 updated_at）。
    REPLY_INFO_TTL_MS, bot, cfg, convertExampleSpacesToComma,
    getRoleInjectMaxChars: () => roleInjectMaxChars, getSocialV2State, log, looksLikeVoiceAsk,
    readRoleContent, readRoleState, redactKnownTokensOnly, replyInfoCache, resolveReplyInfo,
    roleContentStamp, sanitizeMediaSummary,
    sanitizeRoleName, saveSocialV2State, seenForwardIds, voiceMarkerText, voiceTtsCfg
  });

  // ── 好友申请：转给管理员，由管理员裁决 ────────────────────────────────────
  // SnowLuma 推 post_type=request / request_type=friend 时：
  //   ① 申请落盘 state/friend-requests.json（桥接重启不丢）
  //   ② 私聊管理员：申请人 / 验证消息 / 「同意 <QQ号>」或「拒绝 <QQ号>」
  //   ③ 管理员回复后，桥接调 OneBot set_friend_add_request 真正处理
  // 为什么不让模型决定：加好友是不可逆的账号动作，由桥接直接执行更可控，
  // 也不受「思考强度 low」「人设是自恋又笨」这些影响。
  const FRIEND_REQUEST_FILE = path.join(STATE_DIR, 'friend-requests.json');
  const FRIEND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
  const friendRequests = new Map(); // QQ号(number) -> { flag, userId, nickname, comment, at }
  const FRIEND_APPROVE_RE = /^(?:同意|通过|批准|允许|加|yes|y|approve|ok)$/i;
  const FRIEND_REJECT_RE = /^(?:拒绝|不同意|驳回|不加|no|n|reject|deny)$/i;

  // 好友申请与令牌自愈（src/account/index.js）：申请记录的持久化、管理员批复解析、
  // 自动放行策略、以及 SnowLuma 令牌失效后的自愈重写。
  // friendRequests 容器留在桥接侧（下面的 onRequest 直接往里写），按引用共享同一份。
  // bind 必须在这里：紧接着的 loadFriendRequests() 就是模块函数。
  accountSvc.bind({
    FRIEND_APPROVE_RE, FRIEND_REJECT_RE, FRIEND_REQUEST_FILE, FRIEND_REQUEST_TTL_MS, ROOT,
    appendActivity, atomicWriteJson, bot, cfg, convKey, friendRequests, log, readConfigObject,
    reconcileSessionPolicies, sendToQQ, withTimeout
  });

  loadFriendRequests();

  bot.onRequest(async (event) => {
    try {
      if (!event || event.post_type !== 'request') return;
      if (event.request_type !== 'friend') {
        appendActivity(`收到未处理的请求事件：${event.request_type ?? '未知'}（仅记录）`);
        return;
      }
      const userId = Number(event.user_id);
      if (!Number.isSafeInteger(userId) || userId <= 0) return;
      const rec = {
        flag: String(event.flag ?? ''),
        userId,
        nickname: '',
        comment: String(event.comment ?? ''),
        at: Date.now()
      };
      try {
        const info = await withTimeout(bot.call('get_stranger_info', { user_id: userId }), 5000, 'get_stranger_info');
        if (info && typeof info.nickname === 'string') rec.nickname = info.nickname;
      } catch {}
      friendRequests.set(userId, rec);
      saveFriendRequests();
      appendActivity(`收到好友申请 ${userId}（${rec.nickname || '昵称未知'}）：${rec.comment.slice(0, 80)}`);
      log(`收到好友申请：${userId}（${rec.nickname || '昵称未知'}）`);
      await notifyOwnerFriendRequest(rec);
    } catch (error) {
      log('处理好友申请事件出错:', error?.message ?? error);
    }
  });

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) selfUserId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */


  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  if (cfg.socialV2?.liteChat?.enabled) {
    const litePreset = cfg.socialV2.liteChat.preset || 'qq-chat-lite';
    const liteKeys = Array.isArray(cfg.socialV2.liteChat.keys) ? cfg.socialV2.liteChat.keys : [];
    const presetReady = dshPresetIds.includes(litePreset);
    const engine = liteEngine();
    const keyInfo = engine === 'direct' ? liteModelKey() : null;
    const engineText = engine === 'direct'
      ? `直连 DeepSeek（key 来自 ${keyInfo?.source || '?'}）`
      : `DSH 无工具会话（预设 ${litePreset}${presetReady ? '' : '，DSH 暂无此预设 → 回退原预设'}）`;
    log(`轻量聊天（Track 2/3）：已开启，引擎=${engineText}；灰度：${liteKeys.length ? liteKeys.join(', ') : '全部会话'}；媒体预取 图${Number(cfg.socialV2.liteChat.maxImagesPerWake ?? 1)}/语音${Number(cfg.socialV2.liteChat.maxVoicesPerWake ?? 1)}/视频${Number(cfg.socialV2.liteChat.maxVideosPerWake ?? 1)}`);
  } else {
    log('轻量聊天（Track 2/3）：未开启（socialV2.liteChat.enabled=false）');
  }
  log('桥接已启动。按 Ctrl+C 退出。');
  // ── 对外句柄 ──────────────────────────────────────────────────────────────
  // 显式列出可被外部驱动的接口。重构前，测试要靠「把源码切到 bot.onPrivateMessage
  // 那一行、再文本替换插入 return {97 个名字}」才能拿到这些函数——改名或外迁即静默失效。
  // 现在改为在此处声明，测试通过 boot(deps, { onReady }) 取得。
  // 新增条目时保持字母序分组，避免重复键。
  const handles = {
    // 环境
    api, bot, cfg, promptQueues, socialV2, state,
    // 收发与分诊
    deliverPrompt, deliverPromptNow, drainPromptQueue, handleIncoming, sendStickerV2, sendToQQ,
    // 会话生命周期
    collectors, ensureSession, flushQueue, recordSessionUsage,
    resolvePresetName, retireSession, takeRotateHandoffV2, TURN_BUSY_LEASE_MS,
    turnLeaseNoted, v2TurnStartAt,
    // 社交运行时（唤醒/快照/收尾）
    addConsoleNote, appendSocialV2Message, buildWakePromptLite, buildWakeSnapshotV2,
    getSocialV2State, handleLiteTurnEnd, isConversationBusyV2, pendingConsoleNotes,
    recordSentMessagesV2, replayPendingWakeReasonsV2, sendWakePromptV2, setupSleepTimerV2,
    // 模式
    modeAllowed, refreshMode, trackTurnEvent,
    // 表情
    getStickerImageData, listStickersForV2, syncStickerLibrary,
    // 媒体
    acceptImageBuffer, emojiCdnCandidates, extractMediaFromSegments, fetchMediaData,
    fetchOneBotImage, getImageDimensions, MAX_MEDIA_BYTES, prepareVideoHint,
    resolveMediaList, segmentsToText, videoHintLine,
    // 语音
    assertOutboundAuditOk, resolveVoicePathForOperator, resolveVoicePathForV2,
    sendVoiceForV2, sendVoiceV2, voiceBudgetCheck, voiceCfg, voiceLibrary,
    // 角色与初始提示词
    currentRoleHintLite, formatInitialPromptV2, getInitialPrompt, initialPromptMaxChars,
    initialPrompts, loadInitialPrompts, readRoleState, selfIdentityTextV2,
    setInitialPrompt, settingFromDshNamespace,
    // 状态控制面：控制台与测试共用的受控入口。业务路径不得直接改这些闭包状态，
    // 一律走 refreshMode / applyWakeConfig 之类的语义接口；这里只保留机械读写。
    getMode: () => currentMode,
    setMode: (value) => { currentMode = value; },
    setPresets: (value) => { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    setReady: (value) => { dshReady = value; },
    resetEpoch: () => { sessionEpoch++; },
    setSelfIdentity: (display, id) => {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    // HTTP
    startConsoleServer
  };
  // 媒体链路的依赖注入。必须在 onReady 之前：
  // 测试在 onReady 里就会直接调媒体函数，晚一步就是 undefined。
  // （原先这里还写着「必须在 handles 成型之后」，因为 mediaSvc 一度接收整个 handles 门面；
  //  那个依赖是死代码——src/media/inbound.js 从未访问过它——现已移除，本行只是按需更新。）
  // getCurrentMode 传的是取值函数而不是 currentMode 的值——后者会让模块看到冻结的旧模式。
  // 发送链路（src/send）：依赖分三类，界线不能糊。
  //   · 状态：replyInfoCache / lastSendFailed 等是对象，按引用传没问题；
  //     真正可变的那两个走读写口 —— sendQueue 是共享模块，stickerEntries 走 get/set。
  //   · 桥接函数：sendToQQ / sendTextMessagesV2 在桥接侧，模块要复用它们复用同一套闸门与限频。
  //   · 可替换能力：fetch / safeFetchBuffer / text 必须经这里交出去。模块内部直接 import
  //     会绕开 harness 的注入点，测试就会真去打 127.0.0.1:3000（假红），或者更糟——假绿。
  sendSvc.bind({
    MAX_MEDIA_BYTES, REPLY_INFO_TTL_MS, SEND_TIMEOUT_MS, REPLY_NEGATIVE_TTL_MS,
    api, appendActivity, assertOutboundAuditOk, bot, captureSendGuard, cfg, clampGapV2,
    cleanupTemp, describeAudio, escapeCqText, fetch, findSticker, getSocialV2State,
    getStickerEntries, inspectAudio, lastSendFailed, lastSendSucceeded, log, markStickerUsed,
    processAudioVolume, pruneReplyInfoCache, randInt, recordSentMessagesV2, recordVoiceSentV2,
    redactKnownTokensOnly, replyInfoCache, resolveGroupMemberName,
    safeFetchBuffer, saveStickerStoreSafe, segmentsToText, sendTextMessagesV2, sendToQQ,
    sendVoiceForV2, setStickerEntries, sleep, socialV2,  syncStickerLibrary,
    synthesizeVoiceFile, text, ttsBudgetCheck, ttsBudgetCommit, verifyVoiceMessageSent,
    voiceBudgetCheck, voiceBudgetCommit, voiceCfg, voiceMarkerText, voiceTtsCfg, withTimeout
  });

  // 表情库（src/sticker）：这个域只暴露「可替换能力 + 桥接函数」两类依赖，
  // 库数据本身由模块独占（见模块头第 4 条规则），所以这里没有 entries。
  stickerSvc.bind({
    MAX_MEDIA_BYTES, MAX_MEDIA_FETCH_BYTES, STICKER_FILE,
    bot, captureSendGuard, cfg, getSocialV2State, log, onebotHttpAction, socialV2
  });

  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }


  mediaSvc.bind({
    MAX_MEDIA_BYTES, MAX_MEDIA_COUNT, MAX_MEDIA_FETCH_BYTES, MAX_MEDIA_PIXELS,
    VIDEO_HINT_CACHE_MAX, VIDEO_HINT_TTL_MS,
    api, appendSocialV2Message, bot, cfg,
    getCurrentMode: () => currentMode,
    getSocialV2State, log, messageMediaStore, modelMediaLimits, socialV2,
    videoCallTimes, videoHintCache, videoHintPrefetching, visionCallTimes, videoLinkApi, withTimeout,
    // 可替换能力：必须经这里交出去，媒体模块内部不得自己 import。
    // 否则测试（以及将来的调用方）通过注入同名实现来替换行为时会被静默绕过，
    // 断言跑的是真模块、结果却是假绿。
    ASR_LANGUAGES, canonicalizeWav, describeImagesWithVision, extractRecordSegments, fetchRecordWav,
    looksLikeImageBuffer, normalizeImageForModel, safeFetchBuffer, text, transcribeViaDsh, transcribeViaQqAsr
  });
  // lite 媒体（src/lite/media.js）：图片/语音转描述、表情索引、发图发拍。
  // 缓存容器 liteMediaNotes 与 TTL 归模块独占；其余依赖都是只读容器或桥接函数。
  liteMediaSvc.bind({
    MAX_SEND_BYTES,
    api, appendActivity, bot, buildWakePromptLite, cfg, describeMessageImages, fetchMediaData,
    findMessageMedia, getSocialV2State, liteStickerChoices, loadRecentLocalImages, log,
    rememberLocalImage, resolveImageDirs, resolveSelfieDirs, reverse, saveSocialV2State, sendImageV2, socialV2,
    transcribeVoiceMessage, videoCallTimes, videoLinkApi, videoRateLimited
  });

  // lite 提示词组装（src/lite/prompt.js）：唤醒提示词、历史行、快照、控制台便签、人设注入。
  // 两个缓存（人格卡正文 / 已注入角色 key）归模块独占；self 相关是 let，传取值函数。
  litePromptSvc.bind({
    CONSOLE_NOTE_MAX, CONSOLE_NOTE_MAX_CHARS, CONSOLE_NOTE_TTL_MS, LITE_RULES, ROOT,
    cfg, convertExampleSpacesToComma, fetchLiteInlineImages, getInitialPrompt, getSocialV2State,
    initialPromptMaxChars, isDirectedAtAi, liteCachedMediaNote, liteMessageMediaKind,
    liteStickerChoices, liteStickerIndexText, log, looksLikeVoiceAsk, mediaHintFor, pad2,
    personFocusProfiles, personFocusText, personMemorySummaryText, prefetchLiteMedia,
    prepareVideoHint, readRoleState,  reverse, roleHintForMode,
    saveSocialV2State, socialV2, videoHintLine, voiceTtsCfg,
    getSelfDisplayName: () => selfDisplayName,
    getSelfUserId: () => selfUserId
  });


  // 唤醒调度与投递（src/social/wake.js）：防重入、限频、有限睡眠定时器、主动机会、串行队列。
  // 这一段是 reserved2 的「什么时候叫醒 AI」全部规则；currentMode / dshReady 是 let，
  // 走取值函数，否则模式切换与 DSH 重启后判断会停在启动那一刻。
  wakeSvc.bind({
    TIMER_WAKE_REASONS, TURN_BUSY_LEASE_MS, WAKE_PRIORITY,
     api, auditAndSend, buildWakePromptLite,
    buildWakeSnapshotV2, canonicalV2Key, cfg, collectors,
    enqueueForRetry, ensureSession, ensureWakeableV2, getSocialV2State,
    isCurrentSession, isSessionAllowedInCurrentMode, liteDirectActive, liteSessionActive, log,
    messageMediaStore,  pendingWakeKeys, promptQueues, pushQueued,
     resolveMediaList, runLiteDirectWake, saveSocialV2State, sendToQQ,
    shouldAuditKey, social, socialV2, state, takeRotateHandoffV2,
    turnLeaseNoted, v2TurnStartAt,
    getCurrentMode: () => currentMode,
    getDshReady: () => dshReady
  });

  // 主动私聊调度（src/social/proactive.js）：全局 tick + 每会话持久化落点。
  // currentMode 是 let，同样走取值函数；allowed 是白名单判定的唯一实现，交引用不复制。
  proactivePrivateSvc.bind({
    allowed, cfg, getSocialV2State, isConversationBusyV2, isSessionAllowedInCurrentMode,
    liteDirectActive, log, saveSocialV2State, sendWakePromptV2, socialV2,
    getCurrentMode: () => currentMode,
    getDshReady: () => dshReady
  });

  // 连接监控（src/conn/monitor.js）：DSH 端口重发现、DSH 探活、SnowLuma 上游健康探测与告警。
  // 四个「已启动过」标志与重发现节流时间戳由模块独占。
  // checkDsh 之前是 boot 里的箭头函数、由本 bind 反向注入给 monitor（两者互相依赖成环）；
  // 现在它整个在 monitor 内部，环消失，这里只需要把它的依赖喂进去。
  // 三个 let（dshReady / lastMode / currentMode / dshPresetIds）一律走访问器，理由同上。
  connSvc.bind({
    REDISCOVER_THROTTLE_MS, ROOT, SNOWLUMA_SILENCE_WARN_MS, SNOWLUMA_STATUS_POLL_MS,
    api, atomicWriteJson, bot, cfg, clearAllSocialV2Timers,
    drainAllPromptQueues, flushQueue, getCurrentMode, getDshPresetIds, getDshReady,
    getLastMode, log, readConfigObject, reconcileSessionPolicies,
    refreshMode, refreshPresetList, scheduleProactiveCheckV2,
    setDshReady, setLastMode, setupSleepTimerV2, snowlumaHealth, socialV2,
    startProactivePrivate, stopProactivePrivate
  });

  // 句柄一旦成型就立刻交出：调用方（测试）可能在运行时启动前就要用它。
  try {
    hooks.onReady?.(handles);
  } catch (error) {
    log('onReady 回调失败:', error?.message ?? error);
  }

  // 测试模式：只交出句柄，不启动任何后台运行时。
  // 这与重构前「在 bot.onPrivateMessage 处提前 return」的效果一致——那条路径同样
  // 跳过了 watch / HTTP / 消息泵，所以测试从不会真的发起网络请求。
  if (hooks.skipRuntime) return handles;

  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();

  // 消息泵永不返回，所以句柄必须在它之前交出。
  await pumpMux();
}

/** 生产入口：按原逻辑自建依赖。 */
async function main() {
  return boot();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调。
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => {
  // 显式关库：WAL 模式下不关也不会丢已提交的事务，但会把 -wal/-shm 留在盘上，
  // 备份/拷贝目录时容易只拷走主库文件、拿到缺尾巴的数据。
  try { closeBridgeDb(); } catch {}
  releaseLock();
});

/**
 * 是否被直接执行（`node src/bridge.js`）。
 * 被 import 时（测试、工具脚本）不能有副作用——否则一 import 就真的去连 QQ 了。
 *
 * 取不到 argv[1] 的场景（`node -e`、某些宿主）一律按「不启动」处理：
 * 早先按「直接执行」兜底，结果 `node -e "import('./src/bridge.js')"` 会真的走一遍
 * 启动流程，撞上运行中实例的锁文件后直接 process.exit —— 属于最糟糕的那种意外。
 */
function isDirectRun() {
  try {
    const entry = process?.argv?.[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error('[bridge] 启动失败:', error);
    process.exit(1);
  });
}
