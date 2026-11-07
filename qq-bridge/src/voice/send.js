// send.js — 语音条的「合成 → 落盘 → 审计 → 限流 → 发送 → 回读」全链路。
//
// 为什么单独成文件：这段是桥接里唯一一条**自己发请求**的发送路径——文本和表情都走
// sendChain，语音因为要带 record 段只能直连网关 HTTP。于是它自带一整套周边逻辑：
// 预算限流（日/小时两个桶）、出站审计断言、发后回读校验、跨模式路径解析（图库/本地）。
// 这些和装配代码混在同一个闭包里时，出问题只能靠翻 6000 行。
//
// 状态归属：
//   · voiceSendTimes / voiceTtsSendTimes 是本域独占的限流桶 —— 搬进模块，不再外借；
//   · VOICE_ASK_RE 是本域独占的意图正则 —— 一并搬入；
//   · cfg / socialV2 / KNOWN_AGENT_TOKENS 是跨域只读容器 —— 按引用交入；
//   · socialV2 只能通过 getSocialV2State()/saveSocialV2State() 读写，不能传值：
//     它是 `let`（重置会话时会整体替换），传值会让语音永远写进被丢弃的旧对象。
//
// bind 时机：`shouldAuditKey` 与 `socialV2` 都在本段之后才声明，所以 bind 必须落在
// 它们之后、且早于 sendSvc.bind（那里会把本模块的函数取走）。传早了撞 TDZ。
//
// ⚠️ `fetch` 走 bind 而不是直接用全局：审计 harness 用假 fetch 打桩断言发出的段内容，
//    并模拟网关离线（ttsMode='down'）。直接调全局会绕过注入点，测试变成假绿。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { text } from '@snowluma/sdk';
import { truncateText } from '../md-to-plain.js';
import { renderMessageLine as renderMessageLinePure } from '../lite-chat.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { AUDIO_EXTS, listAudioFiles, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from '../voice-core.js';

export function createVoiceSend() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  const VOICE_ASK_RE = /语音|声音|说话|说句|说句话|开口|念一下|读一下|听你|听听|嗓音|嗓子|来一句/;
  // 限流桶：本域独占，全生命周期不整体替换。
  const voiceSendTimes = new Map();
  const voiceTtsSendTimes = new Map();

  let KNOWN_AGENT_TOKENS, ROOT, appendActivity, cfg, currentRoleVoice, fetch, getSocialV2State, liteHistoryLines, log;
  let saveSocialV2State, sendVoiceV2, shouldAuditKey, socialV2, voicePathInsideLibrary;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({
      KNOWN_AGENT_TOKENS, ROOT, appendActivity, cfg, currentRoleVoice, fetch, getSocialV2State, liteHistoryLines, log,
      saveSocialV2State, sendVoiceV2, shouldAuditKey, socialV2, voicePathInsideLibrary
    } = deps);
  }

  async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  /**
   * 文字转语音（TTS）配置：把「大肥鱼」音色的本地合成服务接进来。
   *
   * 为什么放在桥接而不是 MCP：合成 → 落盘 → 审计 → 限流 → sendVoiceV2 的 record 段，
   * 整条链路都在桥接里；MCP 只负责把模型要说的话递过来，不碰音频文件。
   */
  function voiceTtsCfg() {
    const v = cfg.socialV2?.voice ?? {};
    const t = v.tts ?? {};
    // 音色是「人格」的一部分：人格显式设过音色就用它的，没设才回落到全局默认。
    // 只在读取时叠加、不写回 config.json —— 切人格不该把全局默认改掉。
    let roleVoice = null;
    try { roleVoice = typeof currentRoleVoice === 'function' ? currentRoleVoice() : null; } catch { roleVoice = null; }
    return {
      enabled: v.enabled !== false && t.enabled !== false,
      baseUrl: String(t.baseUrl ?? 'http://127.0.0.1:3210').replace(/\/+$/, ''),
      timeoutMs: Math.max(5000, Number(t.timeoutMs) || 180000),
      maxChars: Math.max(1, Number(t.maxChars) || 120),
      marker: String(t.marker || '[语音]'),
      maxPerMinute: Number(t.maxPerMinute) >= 0 ? Number(t.maxPerMinute) : 2,
      maxPerHour: Number(t.maxPerHour) >= 0 ? Number(t.maxPerHour) : 10,
      cacheDir: path.resolve(ROOT, String(t.cacheDir ?? path.join('audio', '.tts'))),
      keepFiles: Math.max(1, Number(t.keepFiles) || 30),
      // 当前音色：voice 是 TTS 服务里的音色 id，voiceName 是给模型看的显示名。
      // 唤醒 prompt 是同步构造的，不能现问 HTTP；人格音色在这里同步派生即可。
      voice: String(roleVoice?.voice || t.voice || 'dafiyu'),
      voiceName: String(roleVoice?.voiceName || t.voiceName || '大肥鱼'),
      // 音色来自人格（true）还是全局默认（false），控制台据此显示「跟随全局 / 人格专属」。
      voiceFromRole: Boolean(roleVoice?.voice),
      // 「该不该发语音」是语义判断，交给模型自己决定（2026-10-29 管理员决定）。
      // 历史包袱：requireAsk 曾经默认开，桥接用关键词猜「对方这句话是不是在要语音」，
      // 结果反复误拦——唤醒被合并/延后、模型在补发回合里开口、口语说法没命中词表，
      // 都会判成"没要语音"，模型想发也发不出（state/feedback.json 里连着几条投诉）。
      // 现在默认关：语义归模型，桥接只守客观频率（maxPerMinute / maxPerHour）。
      // 想恢复旧闸门，把 tts.requireAsk 显式设成 true（askWindowMs 窗口仍是 30 分钟）。
      requireAsk: t.requireAsk === true,
      askWindowMs: Math.max(60000, Number(t.askWindowMs) || 30 * 60000)
    };
  }

  function ttsBudgetCheck(scopeKey, tc) {
    const now = Date.now();
    const bucket = voiceTtsSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (tc.maxPerMinute > 0 && inMinute.length + 1 > tc.maxPerMinute) {
      throw new Error(`合成语音频率超限（每分钟最多 ${tc.maxPerMinute} 条），稍后再试`);
    }
    if (tc.maxPerHour > 0 && inHour.length + 1 > tc.maxPerHour) {
      throw new Error(`合成语音频率超限（每小时最多 ${tc.maxPerHour} 条），稍后再试`);
    }
  }

  function ttsBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceTtsSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceTtsSendTimes.set(scopeKey, bucket);
  }

  function looksLikeVoiceAsk(text) {
    const value = String(text ?? '');
    if (!value) return false;
    return VOICE_ASK_RE.test(value);
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到 ${raw}${fuzzy}${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const now = Date.now();
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      // 字段必须叫 time：liteHistoryLines / renderMessageLinePure 都按 m.time 过滤和渲染，
      // 旧代码写成 at，导致这条在历史里既没有时间也没被正确带上（模型看到「我：lite」）。
      time: now
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  return { bind, onebotHttpAction, assertOutboundAuditOk, voiceCfg, voiceTtsCfg, ttsBudgetCheck, ttsBudgetCommit, looksLikeVoiceAsk, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck, voiceBudgetCommit, recordVoiceSentV2, verifyVoiceMessageSent, sendVoiceForV2 };
}
