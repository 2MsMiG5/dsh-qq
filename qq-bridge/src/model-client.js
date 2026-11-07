// 轻量聊天（Track 2/Track 3）的 DeepSeek 直连客户端：不经过 DSH agent 会话，
// 一次 QQ 聊天只花一次 `chat/completions` 调用。
//
// 为什么需要它：走 DSH 的一轮聊天要建/续会话、发 prompt、追事件流、收尾，固定开销
// 远大于模型调用本身；群聊里绝大多数轮次只是「看几句话、回一句话」，用 agent 会话
// 是拿大炮打蚊子（更慢、更贵，还容易把思考内容当成回复发出去）。这里把调用压成
// 一个可注入 fetch 的纯函数，bridge.js 只负责拼消息和记账。
//
// 四条实测出来的约定（别改回去）：
//
// 1) **thinking 默认必须关**。DeepSeek 默认进思考模式（响应带 reasoning_content，
//    输出 token 60+）；加 `{"thinking":{"type":"disabled"}}` 后同样一句话输出 10 token。
//    聊天回复根本读不到思考，不关就是白花钱 —— 所以 normalizeModelConfig 默认 disabled。
//
// 2) **usage 的缓存字段有两套键名**：官方是 prompt_cache_hit_tokens /
//    prompt_cache_miss_tokens，兼容层还可能给 cached_tokens。漏读一套就会把缓存命中
//    算成 0，账本上的花费凭空虚高，所以两套都读，命中缺失时用 prompt_tokens 反推未命中。
//
// 3) **重试要按状态码区分**：400/401/403 是请求或 key 的问题，重试还是错；429/5xx 和
//    网络抖动才值得退避重试。超时/外部取消不重试 —— 单次已经等满 timeout，再重试只会
//    让 QQ 那头多等一轮。
//
// 4) **key 不许出现在日志和错误里**：QQ 群聊日志会被贴到各处，错误消息统一走
//    redactSecret()（替换 + 截断 200 字符）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'js-yaml';
import { clampInt, clampNumber } from './util/num.js';

/** 模型调用默认值；bridge 的 config 段覆盖它们。 */
const MODEL_DEFAULTS = Object.freeze({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 60000,
  maxTokens: 2048,
  maxRetries: 2
});

/**
 * 思考强度合法取值（DeepSeek 官方 `reasoning_effort`）。
 *
 * 官方映射表：请求 low/medium/high/xhigh/max → 实际 low/high/high/high/max。
 * 这里只留 low/high/max 三档——与 DSH 侧 `REASONING_EFFORT_OPTIONS` 对齐，
 * 免得控制台在这两条路径上给出不一样的选项。
 */
const REASONING_EFFORT_VALUES = Object.freeze(['low', 'high', 'max']);

/** 指数退避：400ms → 1200ms → 3600ms ...（与「秒级重试两次」的实测手速一致）。 */
const RETRY_BASE_MS = 400;
const RETRY_FACTOR = 3;
const MAX_BACKOFF_MS = 30000;
const MAX_ERROR_CHARS = 200;
const MAX_TEMPERATURE = 2;

// ── 密钥 ────────────────────────────────────────────────────────────────────

function normalizeKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * 解析 DeepSeek API Key：显式传入 > 环境变量 > DSH 凭据文件。
 *
 * DSH 把用户填的 key 明文保存在 `~/.dsh/.credentials.yaml` 的 `refs` 段（不是记录 id），
 * 所以桥接不需要自己的密钥管理：读同一个位置即可与 DSH 共用凭据。
 * 文件缺失、权限不足、YAML 写坏都按「没配置」返回 null —— 不能让桥接因此起不来。
 *
 * @param {object} [opts]
 * @param {string} [opts.explicitKey]       调用方显式给的值（优先级最高）
 * @param {Record<string,string|undefined>} [opts.env] 环境变量表（单测注入）
 * @param {string} [opts.credentialsPath]   凭据文件路径（单测注入；默认 ~/.dsh/.credentials.yaml）
 * @param {string} [opts.refName]           refs 段里的名字，默认 DEEPSEEK_API_KEY
 * @returns {{key:string, source:'explicit'|'env'|'credentials'}|null}
 */
export function resolveDeepSeekKey({
  explicitKey,
  env = process.env,
  credentialsPath,
  refName = 'DEEPSEEK_API_KEY'
} = {}) {
  const fromExplicit = normalizeKey(explicitKey);
  if (fromExplicit) return { key: fromExplicit, source: 'explicit' };

  const fromEnv = normalizeKey(env?.[refName]);
  if (fromEnv) return { key: fromEnv, source: 'env' };

  const file = credentialsPath || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const doc = YAML.load(fs.readFileSync(file, 'utf8'));
    const fromFile = normalizeKey(doc?.refs?.[refName]);
    if (fromFile) return { key: fromFile, source: 'credentials' };
  } catch {
    // 文件不存在 / 不是合法 YAML：都只是「这个来源没配」，交回 null 由调用方提示。
  }
  return null;
}

// ── 配置 ────────────────────────────────────────────────────────────────────

/**
 * 归一化模型调用配置。
 *
 * thinking 只接受 'disabled' / 'enabled'：拼错或传了别的字符串一律按 disabled ——
 * 宁可少花 thinking 的钱，也不要因为一个配置笔误让每条群消息都多付一段推理 token。
 * temperature 缺省为 undefined（表示请求里完全不传），避免覆盖服务端默认值。
 *
 * reasoningEffort 只在 thinking 开启时才有意义（官方：思考模式下默认 high）。
 * 拼错/非法值一律 undefined，即「不传这个字段、用服务端默认」，而不是猜一个档位。
 *
 * @param {object} [cfg]
 * @returns {{baseUrl:string, model:string, timeoutMs:number, maxTokens:number,
 *   thinking:'disabled'|'enabled', reasoningEffort:'low'|'high'|'max'|undefined,
 *   temperature:number|undefined, maxRetries:number}}
 */
export function normalizeModelConfig(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const baseUrl = String(c.baseUrl ?? MODEL_DEFAULTS.baseUrl).trim().replace(/\/+$/, '')
    || MODEL_DEFAULTS.baseUrl;
  const model = String(c.model ?? MODEL_DEFAULTS.model).trim() || MODEL_DEFAULTS.model;
  const effortRaw = typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim().toLowerCase() : '';
  return {
    baseUrl,
    model,
    timeoutMs: clampInt(c.timeoutMs, 1000, 600000, MODEL_DEFAULTS.timeoutMs),
    maxTokens: clampInt(c.maxTokens, 1, 8192, MODEL_DEFAULTS.maxTokens),
    thinking: c.thinking === 'enabled' ? 'enabled' : 'disabled',
    reasoningEffort: REASONING_EFFORT_VALUES.includes(effortRaw) ? effortRaw : undefined,
    // 缺省/非法一律 undefined：请求里完全不传，不覆盖服务端默认值。
    temperature: clampNumber(c.temperature, 0, MAX_TEMPERATURE, undefined),
    maxRetries: clampInt(c.maxRetries, 0, 5, MODEL_DEFAULTS.maxRetries)
  };
}

// ── 消息拼装 ────────────────────────────────────────────────────────────────

/** 一张图片 → OpenAI 兼容的 image_url 块；缺数据返回 null（不把空图发上去）。 */
function imageBlockOf(image) {
  const base64 = typeof image?.base64 === 'string' ? image.base64
    : (typeof image?.data === 'string' ? image.data : '');
  const data = base64.trim();
  if (!data) return null;
  const mimeRaw = String(image?.mimeType ?? image?.mime ?? '').trim().toLowerCase();
  // 只放行 image/*：bridge 的媒体表里可能带别的东西，不能把非图片塞进 image_url。
  const mime = /^image\/[a-z0-9.+-]+$/.test(mimeRaw) ? mimeRaw : 'image/png';
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
}

/**
 * 把图片追加到最后一条 user 消息（返回新数组，不改调用方对象）。
 *
 * 没有图片时**原样返回**（同一个引用）：这条路径上 messages 可能很长，热路径上
 * 没必要为了「结构统一」每次浅拷贝一遍。
 *
 * @param {Array<object>} messages
 * @param {Array<{mimeType?:string, mime?:string, base64?:string, data?:string}>} images
 */
export function withImages(messages, images) {
  if (!Array.isArray(messages)) return messages;
  if (!Array.isArray(images) || images.length === 0) return messages;
  const blocks = images.map(imageBlockOf).filter(Boolean);
  if (blocks.length === 0) return messages;

  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      targetIndex = i;
      break;
    }
  }
  const out = messages.slice();
  if (targetIndex < 0) {
    // 没有 user 消息（不该发生）：补一条只带图片的，总比把图片丢掉强。
    out.push({ role: 'user', content: blocks });
    return out;
  }
  const target = messages[targetIndex];
  const content = target?.content;
  let parts;
  if (Array.isArray(content)) {
    // 已经是数组（调用方自己拼过 content）：直接续在后面，不嵌套。
    parts = [...content, ...blocks];
  } else {
    const text = typeof content === 'string' ? content : String(content ?? '');
    parts = text ? [{ type: 'text', text }, ...blocks] : [...blocks];
  }
  out[targetIndex] = { ...target, content: parts };
  return out;
}

// ── 错误 / 脱敏 ─────────────────────────────────────────────────────────────

/** 把 key 从文本里抹掉并截断：错误会进 QQ 群日志，不能带凭据。 */
function redactSecret(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('***');
  return out.length > MAX_ERROR_CHARS ? out.slice(0, MAX_ERROR_CHARS) : out;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/** 解析 Retry-After（秒数或 HTTP 日期）；拿不到返回 undefined。 */
function parseRetryAfter(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** 把额定的 timeout 与外部取消信号合并成一个 signal（每次尝试各建一个）。 */
function composeSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeout]);
  // 老 Node 没有 AbortSignal.any 的兜底（package.json 引擎已是 22+，这里只是兜底）。
  const controller = new AbortController();
  if (external.aborted) {
    controller.abort(external.reason);
    return controller.signal;
  }
  external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}

// ── usage 归一化 ────────────────────────────────────────────────────────────

/** 取第一个合法数字（0 也算合法）；都没有返回 undefined。 */
function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return undefined;
}

/**
 * 把 provider 原始 usage 归一化成客户端对外形状。
 *
 * 缓存两个字段必须成对算：官方有的版本只给 hit，未命中要靠 prompt_tokens - hit 反推；
 * 直接读 prompt_cache_miss_tokens 拿到 undefined 会被当成 0，账本上输入几乎全免费。
 */
function normalizeUsageOf(rawUsage) {
  const u = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  const cachedTokens = firstNumber(
    u.prompt_cache_hit_tokens,
    u.cached_tokens,
    u.prompt_tokens_details?.cached_tokens
  ) ?? 0;
  const promptTokensRaw = firstNumber(u.prompt_tokens, u.input_tokens);
  const cacheMissTokens = firstNumber(u.prompt_cache_miss_tokens)
    ?? Math.max(0, (promptTokensRaw ?? 0) - cachedTokens);
  const promptTokens = promptTokensRaw ?? (cacheMissTokens + cachedTokens);
  const completionTokens = firstNumber(u.completion_tokens, u.output_tokens) ?? 0;
  const reasoningTokens = firstNumber(
    u.completion_tokens_details?.reasoning_tokens,
    u.reasoning_tokens
  ) ?? 0;
  const totalTokens = firstNumber(u.total_tokens) ?? (promptTokens + completionTokens);
  return { promptTokens, completionTokens, reasoningTokens, cachedTokens, cacheMissTokens, totalTokens };
}

/**
 * 把 chatCompletion 的 usage 转成 state/token-usage.jsonl 的 `b` 桶。
 *
 * 同时接受客户端归一化后的键（cachedTokens/cacheMissTokens/completionTokens）和
 * provider 原始键（prompt_cache_hit_tokens/...）：bridge 可能直接透传原始 usage。
 * cacheWrite 恒为 0 —— DeepSeek 这条链路没有缓存写入计费，别凭空造一个桶。
 *
 * @param {object} [usage]
 * @returns {{cacheMiss:number, cacheHit:number, cacheWrite:0, output:number, reasoning:number}}
 */
export function usageToLedgerBuckets(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const cacheHit = firstNumber(
    u.cacheHit,
    u.cachedTokens,
    u.cached_tokens,
    u.prompt_cache_hit_tokens,
    u.prompt_tokens_details?.cached_tokens
  ) ?? 0;
  const explicitMiss = firstNumber(u.cacheMiss, u.cacheMissTokens, u.prompt_cache_miss_tokens);
  const promptTokens = firstNumber(u.promptTokens, u.prompt_tokens) ?? 0;
  return {
    cacheMiss: explicitMiss ?? Math.max(0, promptTokens - cacheHit),
    cacheHit,
    cacheWrite: 0,
    output: firstNumber(u.completionTokens, u.completion_tokens, u.output, u.output_tokens) ?? 0,
    reasoning: firstNumber(
      u.reasoningTokens,
      u.reasoning,
      u.completion_tokens_details?.reasoning_tokens
    ) ?? 0
  };
}

// ── 响应解析 ────────────────────────────────────────────────────────────────

/** content 可能是字符串，也可能是 [{type:'text',text}] 数组（多模态回包）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * 单次尝试：发请求 → 校验 HTTP → 解析 content/usage。
 * 成功返回 `{ok:true,...}`；失败返回 `{ok:false,error,retryAfterMs?}`（由调用方决定重试）。
 */
async function attemptOnce({ url, key, body, timeoutMs, signal, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: composeSignal(timeoutMs, signal)
    });
  } catch (error) {
    if (isAbortError(error)) {
      // 只有外部 signal 真的被 abort 才叫「取消」，否则就是我们自己的 timeout。
      const aborted = Boolean(signal?.aborted);
      return {
        ok: false,
        error: {
          code: aborted ? 'aborted' : 'timeout',
          message: aborted ? '请求被调用方取消' : `请求超时（${timeoutMs}ms）`,
          retryable: false
        }
      };
    }
    return {
      ok: false,
      error: { code: 'network', message: `网络错误：${error?.message ?? error}`, retryable: true }
    };
  }

  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: { code: 'network', message: `读取响应失败：${error?.message ?? error}`, retryable: true }
    };
  }

  const status = Number(response.status) || 0;
  const httpOk = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
  if (!httpOk) {
    // 错误体里通常有更具体的原因（模型不存在 / 余额不足）；拿不到就用原始文本。
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message ?? parsed?.message ?? raw;
    } catch {}
    return {
      ok: false,
      error: {
        code: 'http',
        message: `DeepSeek 返回 HTTP ${status}：${String(detail ?? '').trim()}`,
        status,
        // 400/401/403 是请求本身错了，重试没有意义；429 与 5xx 才退避重试。
        retryable: status === 429 || status >= 500
      },
      retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'))
    };
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_response', message: 'DeepSeek 返回的不是合法 JSON', status, retryable: false }
    };
  }

  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message ?? {};
  const content = textOfContent(message.content);
  const reasoning = textOfContent(message.reasoning_content) || textOfContent(message.reasoning);
  const finishReason = choice?.finish_reason ?? null;

  if (!content) {
    // 只拿到思考内容绝不能当回复发到群里 —— 那是模型的草稿，不是它想说的话。
    if (reasoning) {
      return {
        ok: false,
        error: {
          code: 'reasoning_only',
          message: `模型只返回了思考内容（finish_reason=${finishReason ?? '?'}），没有可发送的正文`,
          retryable: false
        }
      };
    }
    // 空内容可能被截断（max_tokens 太小 / 撞上长度上限），但重试同样会空，直接报错。
    return {
      ok: false,
      error: {
        code: 'empty_content',
        message: `模型返回空内容（finish_reason=${finishReason ?? '?'}）`,
        retryable: false
      }
    };
  }

  return {
    ok: true,
    text: content,
    model: String(payload?.model ?? body.model),
    usage: normalizeUsageOf(payload?.usage)
  };
}

// ── 主调用 ──────────────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调用一次 DeepSeek chat/completions（带有限重试）。
 *
 * @param {object} opts
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} opts.messages
 * @param {Array<{mimeType?:string, base64:string}>} [opts.images] 追加到最后一条 user 消息
 * @param {string} opts.key
 * @param {object} [opts.config]   normalizeModelConfig 的输入
 * @param {Function} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @param {(msg:string)=>void} [opts.log]
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 单测注入 no-op，避免真等退避
 * @returns {Promise<{ok:true,text:string,model:string,usage:object,latencyMs:number}
 *   | {ok:false,error:{code:string,message:string,status?:number,retryable?:boolean},latencyMs:number}>}
 */
export async function chatCompletion({
  messages,
  images,
  key,
  config = {},
  fetchImpl = fetch,
  signal,
  log = () => {},
  sleep = defaultSleep
} = {}) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const cfg = normalizeModelConfig(config);
  const secret = normalizeKey(key);
  // 只暴露 spec 约定的 error 形状；Retry-After 的毫秒数仅在内部用于算退避。
  const fail = (error) => ({
    ok: false,
    error: { ...error, message: redactSecret(error.message, secret) },
    latencyMs: elapsed()
  });

  if (!secret) {
    return fail({ code: 'no_key', message: '未提供 DeepSeek API key', retryable: false });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return fail({ code: 'bad_request', message: 'messages 不能为空', retryable: false });
  }

  const body = {
    model: cfg.model,
    messages: withImages(messages, images),
    stream: false,
    // 默认关思考：聊天的回复用不到推理过程，开着只是多付输出 token。
    thinking: { type: cfg.thinking }
  };
  // 强度只在开思考时传：关掉思考还带 reasoning_effort 是自相矛盾的请求，
  // 官方虽然不报错，但读日志的人会以为它在思考。
  if (cfg.thinking === 'enabled' && cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  if (cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  const url = `${cfg.baseUrl}/chat/completions`;

  let attempt = 0;
  for (;;) {
    const result = await attemptOnce({
      url, key: secret, body, timeoutMs: cfg.timeoutMs, signal, fetchImpl
    });

    if (result.ok) {
      return {
        ok: true,
        text: result.text,
        model: result.model,
        usage: result.usage,
        latencyMs: elapsed()
      };
    }

    const error = {
      ...result.error,
      message: redactSecret(result.error.message, secret)
    };
    const canRetry = error.retryable === true && attempt < cfg.maxRetries;
    if (!canRetry) {
      // 只记失败原因（已脱敏）；不记请求头，避免把 key 带进日志。
      log(`model-client：调用失败（${error.code}${error.status ? ` ${error.status}` : ''}）：${error.message}`);
      return { ok: false, error, latencyMs: elapsed() };
    }

    attempt += 1;
    const backoffMs = Math.min(MAX_BACKOFF_MS, RETRY_BASE_MS * RETRY_FACTOR ** (attempt - 1));
    // 服务端给了 Retry-After 就听它的（夹到退避上限），否则用指数退避。
    const delayMs = Number.isFinite(result.retryAfterMs)
      ? Math.min(MAX_BACKOFF_MS, Math.max(0, result.retryAfterMs))
      : backoffMs;
    log(`model-client：${delayMs}ms 后重试（${attempt}/${cfg.maxRetries}，原因 ${error.code}${error.status ? ` ${error.status}` : ''}）`);
    await sleep(delayMs);
    if (signal?.aborted) {
      return {
        ok: false,
        error: { code: 'aborted', message: '请求被调用方取消', retryable: false },
        latencyMs: elapsed()
      };
    }
  }
}
