// QQ 语音转写（SenseVoice）的桥接侧实现：取 record 段 → 网关转 WAV → 规整成
// canonical 16 kHz mono PCM16 → 调 DSH 的 speech/transcribe（SenseVoice 本地模型）。
//
// 数据流（2026-10-26 实测跑通）：
//   OneBot get_msg(message_id)  → record 段（file=xxx.amr，url=QQ CDN）
//   OneBot get_record(file, out_format='wav') → base64 的 24kHz 单声道 PCM16 WAV
//   canonical-wav.js → 16kHz 单声道 PCM16 WAV
//   DSH RPC speech.transcribe({ request:{ audioBase64, providerId, language } })
//     → { text, audioSeconds, inferenceSeconds }
//
// 失败兜底：SenseVoice 不可用时，可选回退到 QQ 自带的语音转写
// （fetch_ptt_text，仅对「收到的」语音有效），并在结果里标注 source 让模型如实转述。
import { toCanonicalWav16k } from './canonical-wav.js';

/** 转写默认配置（上限与 DSH speech/catalog 的 maxAudioBytes / maxDurationSeconds 对齐）。 */
export const ASR_DEFAULTS = Object.freeze({
  enabled: true,
  providerId: 'sensevoice-local',
  language: 'auto',
  maxBytes: 4 * 1024 * 1024,
  maxDurationSeconds: 120,
  fallbackToQqAsr: true,
  timeoutMs: 120000,
});

/** 允许传给 SenseVoice 的语言（来自 speech/catalog 的 languages）。 */
export const ASR_LANGUAGES = Object.freeze(['auto', 'zh', 'en', 'yue', 'ja', 'ko']);

/**
 * 把 config.json 的 voice.asr 段规整成带默认值的对象。
 * @param {object} cfg
 */
export function normalizeAsrConfig(cfg) {
  const a = cfg?.voice?.asr ?? {};
  const language = String(a.language || ASR_DEFAULTS.language);
  return {
    enabled: a.enabled !== false,
    providerId: String(a.providerId || ASR_DEFAULTS.providerId),
    language: ASR_LANGUAGES.includes(language) ? language : ASR_DEFAULTS.language,
    maxBytes: Math.max(1024, Number(a.maxBytes) || ASR_DEFAULTS.maxBytes),
    maxDurationSeconds: Math.max(1, Number(a.maxDurationSeconds) || ASR_DEFAULTS.maxDurationSeconds),
    fallbackToQqAsr: a.fallbackToQqAsr !== false,
    timeoutMs: Math.min(300000, Math.max(10000, Number(a.timeoutMs) || ASR_DEFAULTS.timeoutMs)),
  };
}

/** 从 OneBot 消息段里抽出 record（语音）段。 */
export function extractRecordSegments(segments) {
  const out = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'record') continue;
    const d = seg.data ?? {};
    out.push({
      file: String(d.file ?? ''),
      file_id: String(d.file_id ?? ''),
      url: String(d.url ?? ''),
      fileName: String(d.fileName ?? d.name ?? ''),
      duration: d.duration != null ? Number(d.duration) : null
    });
  }
  return out;
}

/**
 * 调 OneBot get_record 把语音转成 WAV（base64）。
 * @param {(action:string, params:object)=>Promise<object>} oneBot OneBot HTTP 调用器
 * @param {{file?:string,file_id?:string,url?:string}} record
 * @returns {Promise<Buffer>} WAV 字节
 */
export async function fetchRecordWav(oneBot, record) {
  const ref = String(record.file || record.file_id || record.url || '').trim();
  if (!ref) throw new Error('语音消息缺少 record 文件引用');
  const data = await oneBot('get_record', { file: ref, out_format: 'wav' });
  if (!data || typeof data !== 'object' || typeof data.base64 !== 'string' || !data.base64) {
    throw new Error('网关语音转码结果缺少 base64');
  }
  const wav = Buffer.from(data.base64, 'base64');
  if (!wav.length) throw new Error('网关语音转码结果为空');
  return wav;
}

/**
 * WAV → canonical 16kHz mono PCM16（见 canonical-wav.js）。
 * @param {Buffer} wav
 */
export function canonicalizeWav(wav) {
  const conv = toCanonicalWav16k(wav);
  if (!conv.ok) return conv;
  return {
    ok: true,
    buffer: conv.buffer,
    sourceRate: conv.sourceRate,
    sourceChannels: conv.sourceChannels,
    durationSeconds: conv.durationSeconds,
    note: conv.note,
  };
}

/**
 * 调 DSH 的 speech.transcribe（SenseVoice）。rpcUnary 形如
 * (method, payload) => { rpcId, result }（bridge 的 api.callUnary）或
 * (endpoint, args) => { ok, value|error }（probeRpc）。
 * @param {(method:string, payload:object)=>Promise<object>} rpcUnary
 * @param {string} audioBase64 canonical 16kHz mono PCM16 WAV 的 base64
 * @param {{providerId:string,language:string}} opts
 * @returns {Promise<{ok:true,text:string,audioSeconds:number,inferenceSeconds:number}|{ok:false,error:string}>}
 */
export async function transcribeViaDsh(rpcUnary, audioBase64, opts) {
  const result = await rpcUnary('speech.transcribe', {
    request: {
      audioBase64,
      providerId: opts.providerId,
      language: opts.language,
    },
  });
  // 两种信封都认：callUnary 的 { rpcId, result } 与 probeRpc 的 { ok, value|error }
  const inner = result?.result ?? result ?? {};
  if (inner && typeof inner === 'object' && (inner.ok === true || inner.value !== undefined)) {
    const t = inner.ok === true ? inner.value ?? inner : inner;
    const text = String(t?.text ?? '').trim();
    if (!text) return { ok: false, error: 'SenseVoice 返回了空转写文本' };
    return {
      ok: true,
      text,
      audioSeconds: Number(t?.audioSeconds) || 0,
      inferenceSeconds: Number(t?.inferenceSeconds) || 0,
    };
  }
  const err = inner?.error ?? inner;
  const message = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err ?? {}));
  return { ok: false, error: `SenseVoice 转写失败：${String(message).slice(0, 400)}` };
}

/**
 * 回退：QQ 自带语音转写（fetch_ptt_text，仅收到的语音有效）。
 * @param {(action:string, params:object)=>Promise<object>} oneBot
 * @param {string|number} messageId
 * @returns {Promise<string>}
 */
export async function transcribeViaQqAsr(oneBot, messageId) {
  const data = await oneBot('fetch_ptt_text', { message_id: String(messageId) });
  const text = String(data?.text ?? '').trim();
  if (!text) throw new Error('QQ 转写结果为空（语音可能没有转写）');
  return text;
}
