// 识图客户端：把图片（base64）交给 OpenAI 兼容的视觉 API，返回文字描述。
//
// 背景：QQ 聊天 agent 跑在 qoder/DeepSeek-Flash 这类**纯文本模型**上，
// `qq_get_message_images` 返回的图像内容块文本模型根本消费不了。本模块让桥接
// 直接调视觉 API（与 DSH 的 dsh-image-pathify 插件同一套接口形状），把图片变成
// 文字描述再喂回模型 —— 这样「纯文本模型也能看图」。
//
// API Key 解析顺序（与 image-pathify 一致）：
//   1) config.json 的 vision.apiKey（显式填）
//   2) 环境变量 vision.apiKeyEnv（默认 IMAGE_PATHIFY_API_KEY），再兜底 DEEPSEEK_API_KEY
//   3) ~/.dsh/.credentials.yaml 的 refs.<apiKeyEnv>（DSH 插件保存凭据的位置）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'js-yaml';

/** 识图默认配置（与 image-pathify 默认一致：deepseek-flash @ api.deepseek.com）。 */
export const VISION_DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKeyEnv: 'IMAGE_PATHIFY_API_KEY',
  apiKey: '',
  maxTokens: 2048,
  disableThinking: true,
  maxImages: 4,
  timeoutMs: 90000,
  // 限频：QQ 群里的任何人都能驱使 AI 调识图，别让付费视觉 API 被刷爆。
  maxPerMinute: 6,
  maxPerHour: 60,
});

/**
 * 把 config.json 的 vision 段规整成带默认值的对象。
 * @param {object} cfg
 * @returns {typeof VISION_DEFAULTS & {enabled:boolean}}
 */
export function normalizeVisionConfig(cfg) {
  const v = cfg?.vision ?? {};
  return {
    enabled: v.enabled !== false,
    baseUrl: String(v.baseUrl || VISION_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: String(v.model || VISION_DEFAULTS.model),
    apiKeyEnv: String(v.apiKeyEnv || VISION_DEFAULTS.apiKeyEnv),
    apiKey: String(v.apiKey ?? ''),
    maxTokens: Math.max(0, Number(v.maxTokens) || VISION_DEFAULTS.maxTokens),
    disableThinking: v.disableThinking !== false,
    maxImages: Math.min(8, Math.max(1, Number(v.maxImages) || VISION_DEFAULTS.maxImages)),
    timeoutMs: Math.min(180000, Math.max(5000, Number(v.timeoutMs) || VISION_DEFAULTS.timeoutMs)),
    maxPerMinute: Math.max(0, Number(v.maxPerMinute) || VISION_DEFAULTS.maxPerMinute),
    maxPerHour: Math.max(0, Number(v.maxPerHour) || VISION_DEFAULTS.maxPerHour),
  };
}

/** 解析识图 API Key（见文件头顺序）。返回空串表示未配置。 */
export function resolveVisionApiKey(vc) {
  if (vc.apiKey && vc.apiKey.trim()) return vc.apiKey.trim();
  const names = [vc.apiKeyEnv, 'DEEPSEEK_API_KEY', 'IMAGE_PATHIFY_API_KEY'].filter(Boolean);
  for (const name of names) {
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  }
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    const yaml = YAML.load(text);
    for (const name of names) {
      const value = yaml?.refs?.[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {}
  return '';
}

/** 图片 → data URL（mimeType 缺失时按魔数猜）。 */
export function imageDataUrl(mimeType, dataBase64) {
  const mime = String(mimeType ?? '').trim().toLowerCase();
  if (mime && mime.startsWith('image/')) return `data:${mime};base64,${dataBase64}`;
  try {
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return `data:image/png;base64,${dataBase64}`;
    if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return `data:image/jpeg;base64,${dataBase64}`;
    if (buf.length >= 6 && buf[0] === 71 && buf[1] === 73 && buf[2] === 70) return `data:image/gif;base64,${dataBase64}`;
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return `data:image/webp;base64,${dataBase64}`;
  } catch {}
  return `data:image/jpeg;base64,${dataBase64}`;
}

/** deepseek 系接口默认会思考，识图场景关掉思考更省钱（与 image-pathify 一致）。 */
function shouldDisableThinking(model, baseUrl) {
  return /deepseek/i.test(String(model ?? '')) || /deepseek\.com/i.test(String(baseUrl ?? ''));
}

function completionsUrl(baseUrl) {
  return `${String(baseUrl).trim().replace(/\/?$/, '/')}chat/completions`;
}

/**
 * 调用视觉 API 描述一组图片（同一请求带上全部图片）。
 * @param {object} vc normalizeVisionConfig 的结果
 * @param {Array<{mimeType?:string,data:string}>} images base64 图片数组
 * @param {string} prompt 用户问题/描述要求
 * @param {{signal?:AbortSignal, fetchImpl?:Function}} opts 测试可注入 fetch
 * @returns {{ok:true,text:string,model:string}|{ok:false,error:string}}
 */
export async function describeImagesWithVision(vc, images, prompt, opts = {}) {
  const apiKey = resolveVisionApiKey(vc);
  if (!apiKey) {
    return { ok: false, error: '识图 API 未配置：请在 config.json 的 vision 段填写 apiKey（或配置 IMAGE_PATHIFY_API_KEY / DEEPSEEK_API_KEY 环境变量，或按 DSH 插件「识图」页面保存凭据）' };
  }
  if (!Array.isArray(images) || images.length === 0) {
    return { ok: false, error: '没有可识别的图片' };
  }
  const picked = images.slice(0, vc.maxImages);
  const content = [
    ...picked.map((img) => ({
      type: 'image_url',
      image_url: { url: imageDataUrl(img.mimeType, img.data) }
    })),
    { type: 'text', text: String(prompt || '请详细描述这张图片的内容。') }
  ];
  const body = {
    model: vc.model,
    messages: [{ role: 'user', content }],
    stream: false
  };
  if (vc.maxTokens > 0) body.max_tokens = vc.maxTokens;
  if (vc.disableThinking && shouldDisableThinking(vc.model, vc.baseUrl)) {
    body.thinking = { type: 'disabled' };
  }
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const response = await fetchImpl(completionsUrl(vc.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(vc.timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `识图 API HTTP ${response.status}：${text.slice(0, 300)}` };
    }
    let payload;
    try { payload = JSON.parse(text); } catch { return { ok: false, error: '识图 API 返回的不是 JSON' }; }
    const choices = payload?.choices;
    const message = Array.isArray(choices) ? choices[0]?.message : null;
    const finishReason = choices?.[0]?.finish_reason ?? '?';
    const contentText = (() => {
      const parts = message?.content;
      if (typeof parts === 'string') return parts.trim();
      if (Array.isArray(parts)) {
        return parts.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('').trim();
      }
      if (Array.isArray(message?.reasoning_content)) {
        return message.reasoning_content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('').trim();
      }
      return String(message?.reasoning_content ?? '').trim();
    })();
    if (!contentText) {
      return { ok: false, error: `识图 API 返回空内容（finish_reason=${finishReason}）` };
    }
    return { ok: true, text: contentText, model: String(payload?.model ?? vc.model) };
  } catch (error) {
    return { ok: false, error: `识图调用失败：${error?.message ?? error}` };
  }
}
