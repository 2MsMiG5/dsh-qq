// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
// 出站发图的来源模块（Pixeval MCP / 本地图库）：bridge.js 顶层 import 会被剥掉，VM 里靠注入。
// 不注入会在 loadConfig 阶段就抛 `IMAGE_DEFAULTS is not defined`（bridge.js 的 socialV2.image 默认值用它）。
import * as imageSource from '../src/image-source.js';
import * as forward from '../src/forward.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/voice-core.js';
import * as presetPrompt from '../src/preset-prompt.js';
// 上下文压缩（滚动对话纪要/历史裁剪）：bridge.js 顶层 import 会被剥掉，必须在 VM 里注入，
// 否则 buildWakePromptLite 会抛 `trimHistoryLines is not defined`（相关测试全红）。
import * as liteContext from '../src/lite-context.js';
// 轻量聊天的纯函数（回复解析/快照渲染/表情索引/唤醒配置/后台提醒渲染）：同样会被剥掉。
// 之前没注入是因为测试里表情库和后台提醒都为空，`if (!list.length) return ''` 提前返回，
// 把 `renderStickerIndexPure is not defined` / `renderConsoleNotesPure is not defined`
// 挡在了测试看不见的地方 —— 一旦配了表情或写了一条后台提醒，唤醒 prompt 就会直接炸。
import * as liteChat from '../src/lite-chat.js';
// 人格卡（roles/*.md 的〔一代〕〔二代〕分节与指令过滤）：bridge.js 顶层 import 会被剥掉，
// 不注入时 lite 唤醒 prompt 读人格卡会抛 `selectRoleText is not defined`，
// 结果只剩角色名、没有人设正文（测试与真实行为都会失真）。
import * as roleCard from '../src/role-card.js';
import * as stateAcl from '../src/state-acl.mjs';
// QQ 空间服务：与上面几个同理，bridge.js 的 import 会被剥掉，VM 里必须显式注入。
// 注入真实现（而不是桩）是因为它在 boot 阶段只做依赖装配，读策略是惰性的——
// 不会碰真实 state/ 里的授权文件。
import * as qzone from '../src/qzone/index.js';
import * as qzoneDraft from '../src/qzone/draft.js';
// 识图 / 语音转写（SenseVoice）：bridge.js 顶层 import 会被下面的「去 import」逻辑剥掉，
// VM 里靠 context 注入。不注入会在 loadConfig 阶段抛 `normalizeVisionConfig is not defined`
// （bridge.js 的 cfg.vision 默认值用它），以及 `normalizeAsrConfig is not defined`（cfg.voice.asr）。
import * as visionClient from '../src/vision-client.js';
import * as voiceAsr from '../src/voice-asr.js';
// 人物档案：bridge.js 顶层 import 会被下面的「去 import」逻辑剥掉，VM 里靠 context 注入。
// 不注入会在生成唤醒 prompt 时抛 `createPersonStore is not defined`（测试全部变红）。
import * as personMemory from '../src/person-memory.js';
// SnowLuma 只读面板（控制台 /api/snowluma/info）：bridge.js 顶层 import 会被剥掉，靠注入。
import * as snowlumaPanel from '../src/snowluma-panel.js';
// 定向喊话判定（从已清退的 social/legacy.js 拆出的纯函数）：bridge.js 顶层 import 会被剥掉，
// 不注入时 muxIngestSvc.bind 解构到 `isDirectedAtAi` 就抛 ReferenceError，整套 bridge 用例全红。
import * as mention from '../src/social/mention.js';
// 视频链接理解（分享卡片/链接 → 元数据/字幕/ASR）：bridge.js 顶层 import 同样会被剥掉。
// 不注入的话 bridge 里的 videoLinkApi 全部是 null，分享卡片会悄悄退化成 `[卡片消息]`、
// /api/video/message 直接 503 —— 那是**测试环境造成的假阴性**，不是真实行为。
import * as videoLink from '../src/video-link.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
// 控制台 HTTP 服务已从 bridge.js 拆成 src/http/ 下的模块：bridge.js 的顶层 import 会被
// 下面的「去 import」逻辑剥掉，VM 里必须注入 createConsoleServer，否则 boot 走到
// startConsoleServer 时直接 ReferenceError。
import { createConsoleServer } from '../src/http/server.js';
// 入站媒体链路同样已拆成模块，VM 里必须注入工厂，否则 boot 一走到装配就 ReferenceError。
import { createInboundMedia } from '../src/media/inbound.js';
import { createSendService } from '../src/send/index.js';
import { createStickerService } from '../src/sticker/index.js';
import { createSessionEnsurer } from '../src/session/ensure.js';
import { createSocialV2Store } from '../src/social/v2-store.js';
import { createPersonMemory } from '../src/person/index.js';
import { createLiteMedia } from '../src/lite/media.js';
import { createWakeScheduler } from '../src/social/wake.js';
import { createProactivePrivate } from '../src/social/proactive.js';
import { createAccountGuard } from '../src/account/index.js';
import { createConnectionMonitor } from '../src/conn/monitor.js';
import { createLitePrompt } from '../src/lite/prompt.js';
import { createLiteDirect } from '../src/lite/direct.js';
import { createTextSegmenter } from '../src/text/segment.js';
import { createInitialPromptStore } from '../src/initial-prompt/index.js';
import { createVoiceTts } from '../src/voice/tts.js';
import { createVoiceSend } from '../src/voice/send.js';
import { createMuxPump } from '../src/mux/pump.js';
import { createMuxIngest } from '../src/mux/ingest.js';
import { sendQueue } from '../src/send/queue.js';
import { createRetryQueue } from '../src/send/retry-queue.js';
import { createDiagLog } from '../src/diag-log.js';
import { createLocalImages } from '../src/media/local-images.js';
import { createSessionUsage } from '../src/session/usage.js';
import { createModeService } from '../src/mode/index.js';
import { createOutboundSend } from '../src/send/outbound.js';
import { createSocialRecord } from '../src/social/record.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], ttsMode: 'flat' };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // 本地 TTS 服务（dafiyu-voice，默认 :3210）的 JSON 接口。
    // 形状可控：flat = 真实服务的扁平 { ok, ... }；wrapped = 早期 { s: { ok } } 包法；
    // down = 连不上。用它锁住「响应形状不对不许伪装成服务离线」这条契约。
    if (/^(https?:\/\/)?tts\.fixture/i.test(String(url)) || /:3210(\/|$)/.test(String(url))) {
      if (calls.ttsMode === 'down') throw new TypeError('fetch failed');
      const rest = String(url).replace(/^https?:\/\/[^/]+/, '');
      const payload = rest === '/voices'
        ? { ok: true, current: 'dafiyu', voices: [{ id: 'dafiyu', name: '大肥鱼' }, { id: 'voice2', name: '音色2' }] }
        : rest === '/voice'
          ? { ok: true, current: body?.voice ?? 'dafiyu' }
          : { ok: true };
      const shaped = calls.ttsMode === 'wrapped' ? { s: payload } : payload;
      return { ok: true, status: 200, json: async () => shaped };
    }
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    // bridge.js 的 main() 在注册消息处理器之前先注册 onRequest（好友/入群申请）。
    // 少这一个方法会让整个 harness 在 main() 里抛 `bot.onRequest is not a function`，
    // 于是所有基于 harness 的审计用例全部变红——与「桥接真的坏了」完全无法区分。
    onRequest(handler) { this.requestHandler = handler; }
    // 事件注册面：bridge 启动阶段会挂这些处理器。测试不触发它们，但接口必须存在——
    // 重构后 boot() 会在交出句柄前先完成事件注册（旧做法靠文本 return 提前跳过，
    // 所以这层缺口此前一直没暴露）。记下来便于将来断言"注册了哪些事件"。
    onPrivateMessage(handler) { (this.handlers ||= {}).private = handler; }
    onGroupMessage(handler) { (this.handlers ||= {}).group = handler; }
    onNotice(handler) { (this.handlers ||= {}).notice = handler; }
    onEvent(handler) { (this.handlers ||= {}).event = handler; }
    onBotStatus(handler) { (this.handlers ||= {}).botStatus = handler; }
    on(event, handler) { (this.listeners ||= {}); (this.listeners[event] ||= []).push(handler); }
    async connect() { return this; }
    async call(action, params) { return this.request(action, params); }
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  // bridge.js 现在导出 boot()（供 DI 改造后的测试直接 import）。VM 是**脚本**上下文，
  // 不接受 export 语法，剥掉关键字即可——顶层声明在 VM 里自然成为普通全局。
  // 同时 isDirectRun() 会因 import.meta.url 被改成 temp 路径而返回 false，
  // 不会自动启动，测试仍显式调用 main()。
  source = source.replace(/^export /gm, '');
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  // 句柄不再靠文本注入。boot(deps, { onReady }) 会在进入消息泵前把接口交出来，
  // 因此函数改名或外迁到别的模块都不会让测试静默失效（原先 97 个硬编码名字已移除）。
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    createConsoleServer, createInboundMedia, createSendService, createStickerService, createSocialV2Store, createPersonMemory, createLiteMedia, createWakeScheduler, createProactivePrivate, createAccountGuard, createConnectionMonitor, createLitePrompt, createLiteDirect, createTextSegmenter, createInitialPromptStore, createVoiceTts, createVoiceSend, createSocialRecord, createOutboundSend, createModeService, createSessionUsage, createSessionEnsurer, createLocalImages, createRetryQueue, createDiagLog, createMuxPump, createMuxIngest, sendQueue,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt, ...liteContext, ...roleCard, ...personMemory, ...snowlumaPanel, ...mention,
    // lite-chat 的纯函数在 bridge 里一律是 `xxx as xxxPure` 别名，import 被剥掉后 VM 只认别名，
    // 所以这里按**别名**注入（其余名字注进去也没人用）。
    // 以前这几个绑定一个都没注入：表情索引/回复解析在测试里恰好因为「列表为空提前返回」
    // 而没被触发，`renderStickerIndexPure is not defined` 被藏了起来；后台提醒一带内容就暴露。
    // 直连引擎的外部能力：默认桩掉。resolveDeepSeekKey 会去读宿主机
    // ~/.dsh/.credentials.yaml —— 那会让「默认走 DSH 轻量会话」的用例在开发机上静默变成直连，
    // 断言因此失真（R4 就这样红过）。测试要直连请用 globals 显式覆盖。
    resolveDeepSeekKey: () => null,
    chatCompletion: async () => ({ ok: false, error: 'not stubbed' }),
    normalizeModelConfig: (opts) => ({ ...opts }),
    usageToLedgerBuckets: () => ({}),
    parseLiteReplyPure: liteChat.parseLiteReply,
    renderMessageLinePure: liteChat.renderMessageLine,
    renderStickerIndexPure: liteChat.renderStickerIndex,
    renderConsoleNotesPure: liteChat.renderConsoleNotes,
    liteWakeConfigPure: liteChat.liteWakeConfig,
    ...imageSource, ...visionClient, ...voiceAsr, ...videoLink, ...qzone, ...qzoneDraft,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source, context);
  // skipRuntime：只装配并交出句柄，不启动 watch / HTTP / 消息泵。
  // 这与旧做法（在 bot.onPrivateMessage 处提前 return）的实际效果一致。
  const bridge = await new Promise((resolve, reject) => {
    let settled = false;
    const onReady = (handles) => {
      if (settled) return;
      settled = true;
      resolve(handles);
    };
    try {
      Promise.resolve(context.boot(null, { onReady, skipRuntime: true })).catch((error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
  bridge.setPresets(['standard', 'qq-chat-lite']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
