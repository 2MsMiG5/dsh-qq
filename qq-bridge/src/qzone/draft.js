// draft.js — QQ 空间的「AI 起草」：让模型把素材写成一条说说。
//
// 为什么单独成模块、单独一套档位：聊天回复要快，用 low 就够（见 lite-chat.js 的取舍）；
// 写一条要发到空间、会被所有人看见的说说，是**一次性、低频、重质量**的任务，
// 值得多想几步。两者共用同一个 reasoningEffort 只会互相拖累，所以这里独立配，
// 默认 high（`socialV2.qzone.aiDraft.reasoningEffort`）。
//
// 边界：这里只产出**草稿文本**，不发布、不碰 QQ、不写 state。
// 草稿要不要进待批队列、要不要真的发出去，由上层（qzone 服务 / 控制台 / AI 端点）决定。
import { chatCompletion, normalizeModelConfig, resolveDeepSeekKey } from '../model-client.js';
import { clampInt, clampNumber } from '../util/num.js';

/** 起草允许的思考档位（'disabled' 不提供：不思考写不出像样的东西）。 */
export const DRAFT_EFFORTS = Object.freeze(['low', 'high', 'max']);

/** 默认档位：high。这就是本模块存在的理由。 */
export const DRAFT_EFFORT_DEFAULT = 'high';

/** 默认字数区间（说说的舒适区，太长没人看）。 */
export const DRAFT_LENGTH = Object.freeze({ min: 20, max: 120 });

// ── 花费归属 ────────────────────────────────────────────────────────────────
// 起草是自己调模型、自己计费的，账本靠合成 sessionId 把开销归属回 QQ 会话。
// 这套映射只在这里定义一次：装配层用它生成 sid、账本用它反解归属，
// 两边各写一份迟早会漂（lite 的前缀表就踩过「只认主回复前缀」的坑）。
export const QZONE_DRAFT_SID_PREFIX = 'qzone-draft:';
/** 没有会话来源时的归属条目（控制台手动起草、CLI 直接起草）。 */
export const QZONE_DRAFT_INTERNAL_KEY = 'internal:空间起草';
/** 合法的 QQ 会话 key 形状。外部传入的字符串必须先过这个，才允许拼进 sid。 */
const SESSION_KEY_SHAPE_RE = /^(?:group|private):\d+$/;

/** 会话 key → 账本 sessionId。形状不对一律归内部条目，避免脏字符串污染账本。 */
export function qzoneDraftSessionId(sessionKey) {
  const key = String(sessionKey ?? '').trim();
  return QZONE_DRAFT_SID_PREFIX + (SESSION_KEY_SHAPE_RE.test(key) ? key : QZONE_DRAFT_INTERNAL_KEY);
}

/**
 * 账本 sessionId → 归属 key。不是空间起草的 sid 时返回 null，交给调用方继续匹配。
 * 注意这里**不能**对非法 key 返回 undefined：那会让它掉进「未归属:xxxx」桶，
 * 看起来像脏数据，实际是一笔正经开销。
 */
export function qzoneDraftOwner(sessionId) {
  const sid = String(sessionId ?? '');
  if (!sid.startsWith(QZONE_DRAFT_SID_PREFIX)) return null;
  const key = sid.slice(QZONE_DRAFT_SID_PREFIX.length);
  return SESSION_KEY_SHAPE_RE.test(key) ? key : QZONE_DRAFT_INTERNAL_KEY;
}


const DRAFT_SYSTEM_PROMPT = [
  '你在替一个真人写「QQ空间说说」。',
  '',
  '硬性输出规则：',
  '1. 只输出说说正文本身：不要解释、不要标题、不要引号包裹、不要 Markdown、不要分点。',
  '2. 不要自己加 #话题#——话题前缀由系统追加，你加了会重复。',
  '3. 不要提自己是 AI、不要提"生成"、不要出现"作为…"这类书面腔。',
  '4. 不要编造具体的人名、地名、公司名、精确数字；拿不准就用模糊表达。',
  '5. 不要写成广告文案或心灵鸡汤，就像普通人随手发的日常。',
  '6. 一句话也行，两三句也行，但不要超过给定字数上限。',
  '7. 如果附了人设卡：只借鉴「是谁、什么性格、怎么说话」。人设卡里关于群聊、被叫醒、',
  '   调用工具、输出标记的规则**一概不适用**——这条是空间说说，不是群聊回复。'
].join('\n');

/**
 * 规范化思考档位。写错不报错、直接回 high 并告警：
 * 这是「想多深」的旋钮，不是安全开关，笔误不该让功能整个停摆。
 */
export function normalizeDraftEffort(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (DRAFT_EFFORTS.includes(v)) return { effort: v, corrected: false };
  if (!v) return { effort: DRAFT_EFFORT_DEFAULT, corrected: false };
  return { effort: DRAFT_EFFORT_DEFAULT, corrected: true };
}

/**
 * 去掉模型偶尔带上的包装：整段引号、"说说："前缀、代码块围栏。
 *
 * 这些不是配置问题，是模型习惯。放在这里而不是让调用方自己 trim，
 * 是因为「草稿」直接进待批队列给人看，多一层脏包装就多一次手动修改。
 */
export function cleanDraftText(raw) {
  let text = String(raw ?? '').trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(说说|正文|文案|内容)\s*[:：]\s*/i, '').trim();
  // 整体被一对引号包住才剥：只剥首尾，不动中间的引号（那是正文内容）。
  const pairs = [['"', '"'], ['“', '”'], ["'", "'"], ['「', '」']];
  for (const [open, close] of pairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  }
  return text;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg               全量配置（读 socialV2.qzone.aiDraft / dsh.model）
 * @param {Function} [deps.log]
 * @param {Function} [deps.resolveKey]    key 解析（测试注入用）
 * @param {Function} [deps.complete]      模型调用（测试注入用）
 * @param {object} [deps.env]
 */
export function createQzoneDrafter({
  cfg,
  log = () => {},
  resolveKey = resolveDeepSeekKey,
  complete = chatCompletion,
  // 取人格卡：返回 { name, text, source } 或 null。
  // 默认返回 null（不注入人设）——测试与独立使用不该被宿主人格系统绑死。
  getPersona = () => null,
  // 记账回调：起草是**真实计费**的模型调用，不记账等于让花费统计凭空少一块。
  // 由装配层注入（那里才有 tokenLedger 与 QQ 会话归属表），本模块不认识账本。
  recordUsage,
  env = process.env
} = {}) {
  let keyCache; // undefined = 还没解析过；null = 明确解析失败

  function settings() {
    const raw = cfg?.socialV2?.qzone?.aiDraft ?? {};
    const { effort, corrected } = normalizeDraftEffort(raw.reasoningEffort);
    if (corrected) {
      log(`⚠️ socialV2.qzone.aiDraft.reasoningEffort「${raw.reasoningEffort}」非法，已回退 ${DRAFT_EFFORT_DEFAULT}`);
    }
    const minChars = clampInt(raw.minChars, 5, 400, DRAFT_LENGTH.min);
    const maxChars = clampInt(raw.maxChars, minChars + 5, 800, DRAFT_LENGTH.max);
    return {
      enabled: raw.enabled !== false,
      model: String(raw.model || cfg?.dsh?.model || 'deepseek-flash').trim(),
      reasoningEffort: effort,
      maxTokens: clampInt(raw.maxTokens, 256, 8192, 4096),
      // 0.9 是「像人随手写」的默认温度；上限 1.5 是给模型留点出格空间，再高就只剩语无伦次。
      temperature: clampNumber(raw.temperature, 0, 1.5, 0.9),
      minChars,
      maxChars,
      persona: String(raw.persona ?? '').trim()
    };
  }

  function apiKey() {
    if (keyCache !== undefined) return keyCache;
    try {
      keyCache = resolveKey({ explicitKey: cfg?.socialV2?.liteChat?.apiKey, env });
    } catch (error) {
      log(`[qzone-draft] 解析 API Key 失败：${error?.message ?? error}`);
      keyCache = null;
    }
    return keyCache;
  }

  /**
   * 组装这次起草的「人设」。
   *
   * 三层叠加，顺序即权重：
   *   1. 人格卡（当前激活的 `roles/<名>.md`，按 v1/v2 标记筛过、按注入上限截过）
   *      —— 这是「同一个人」的来源，聊天注入的是同一份文本；
   *   2. `socialV2.qzone.aiDraft.persona`：长期附加的风格补充；
   *   3. 调用方传的 `persona`：这一次的附加要求。
   *
   * 为什么不是"参数覆盖人格"：人格是这个人本身，不是一次性设定。
   * 允许参数把它整个换掉，等于让一次调用就能冒充另一个人发说说。
   */
  function personaFor(input = {}) {
    const parts = [];
    let name = '';
    let source = 'none';

    if (typeof getPersona === 'function') {
      try {
        const picked = getPersona({ role: input.role });
        if (picked?.text) {
          name = picked.name || '';
          source = picked.source || 'current';
          parts.push(picked.text);
        }
      } catch (error) {
        log(`[qzone-draft] 读取人格失败：${error?.message ?? error}`);
      }
    }

    const configured = settings().persona;
    if (configured) {
      parts.push(configured);
      if (source === 'none') source = 'config';
    }

    const extra = typeof input.persona === 'string' ? input.persona.trim() : '';
    if (extra) {
      parts.push(extra);
      if (source === 'none') source = 'inline';
    }

    return { text: parts.join('\n\n'), name, source, chars: parts.join('\n\n').length };
  }

  /** 对外描述当前起草配置（控制台展示用，不含 key）。 */
  function describe() {
    const s = settings();
    const persona = personaFor({});
    return {
      enabled: s.enabled,
      model: s.model,
      reasoningEffort: s.reasoningEffort,
      maxTokens: s.maxTokens,
      minChars: s.minChars,
      maxChars: s.maxChars,
      // 人设从哪来，比"有没有配 persona"更值得写出来：
      // 绝大多数时候它来自当前激活的人格卡，而不是配置里的那个字段。
      persona: { name: persona.name, source: persona.source, chars: persona.chars },
      hasKey: Boolean(apiKey()?.key)
    };
  }

  /**
   * 起草一条说说正文。
   *
   * @param {object} input
   * @param {string} [input.hint]  素材 / 想说的要点（可空：空则自由发挥）
   * @param {string} [input.topic] 主题（只作为写作方向，不写进正文——由桥接渲染 #话题#）
   * @param {string} [input.style] 一次性风格要求（这次更俏皮 / 更克制）
   * @param {string} [input.sessionKey] 归属的 QQ 会话（`group:123` / `private:456`）。
   *   只用于花费归属，不参与写作；缺省时开销记到「空间起草」这个内部条目。
   * @returns {Promise<{ok:true, content:string, model:string, effort:string, usage:object|null, latencyMs:number}
   *   | {ok:false, code:string, error:string}>}
   */
  async function draft(input = {}) {
    const s = settings();
    if (!s.enabled) return { ok: false, code: 'DRAFT_DISABLED', error: 'AI 起草已关闭（socialV2.qzone.aiDraft.enabled=false）' };

    const resolved = apiKey();
    if (!resolved?.key) return { ok: false, code: 'NO_API_KEY', error: '没有可用的 DeepSeek API Key，无法起草' };

    const hint = String(input.hint ?? '').trim();
    const topic = String(input.topic ?? '').trim();
    // 情绪参数已移除（2026-11-01）：语气改由 style（这一次的要求）与素材本身决定。
    const style = String(input.style ?? '').trim();
    if (hint.length > 800) return { ok: false, code: 'HINT_TOO_LONG', error: '素材最多 800 字' };

    const lines = [];
    if (topic) lines.push(`【主题方向】${topic}`);
    if (style) lines.push(`【这次的要求】${style}`);
    lines.push(`【字数】${s.minChars}~${s.maxChars} 字`);
    lines.push(`【素材】${hint || '（没有给素材，自己写一条符合人设的日常）'}`);
    lines.push('', '直接输出说说正文。');

    const persona = personaFor(input);
    // 明确指定了人格却拿不到，不能静默降级成"无人设"：
    // 那样调用方以为自己在用小鲸鱼的口吻，实际拿到的是没有身份的一段通用文案。
    if (input.role && persona.source !== 'role') {
      return {
        ok: false,
        code: 'ROLE_NOT_FOUND',
        error: `找不到人格「${String(input.role).slice(0, 20)}」（roles/ 下没有这张卡）`
      };
    }

    const system = persona.text
      ? `${DRAFT_SYSTEM_PROMPT}\n\n【人设${persona.name ? `：${persona.name}` : ''}】\n${persona.text}`
      : DRAFT_SYSTEM_PROMPT;

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: lines.join('\n') }
    ];

    const config = normalizeModelConfig({
      model: s.model,
      // 开思考 + 指定档位：起草这件事的全部意义就在这里。
      thinking: 'enabled',
      reasoningEffort: s.reasoningEffort,
      maxTokens: s.maxTokens,
      temperature: s.temperature
    });

    const startedAt = Date.now();
    const result = await complete({
      messages,
      key: resolved.key,
      config,
      log: (line) => log(`[qzone-draft] ${line}`)
    });

    // 记账放在成败判断**之前**：模型答了、但清洗后为空（EMPTY_DRAFT）同样烧了 token。
    // 这条路曾经整条漏记——起草走自己的 complete，不经过 lite 的记账钩子，
    // 于是控制台的花费统计里看不到任何空间起草的开销。
    try {
      if (result?.usage && typeof recordUsage === 'function') {
        recordUsage({
          usage: result.usage,
          model: result.model || s.model,
          effort: s.reasoningEffort,
          sessionKey: input.sessionKey
        });
      }
    } catch (error) {
      // 记账失败不能连累起草本身：草稿已经写出来了，报个错记日志就行。
      log(`[qzone-draft] 记账失败：${error?.message ?? error}`);
    }

    if (!result?.ok) {
      const code = result?.error?.code ?? 'MODEL_FAILED';
      // reasoning_only / empty_content 都是「token 预算被思考吃满」的典型症状。
      // 报错里直接给两个可操作的开关，否则用户只能看着 finish_reason 发呆。
      const hint = code === 'reasoning_only' || code === 'empty_content'
        ? `（当前 maxTokens=${s.maxTokens}、思考档=${s.reasoningEffort}：调大 socialV2.qzone.aiDraft.maxTokens，或把 reasoningEffort 降到 low）`
        : '';
      return {
        ok: false,
        code,
        error: `${result?.error?.message ?? '起草失败'}${hint}`
      };
    }

    // ⚠️ chatCompletion 的成功返回是 { ok, text, model, usage } —— 字段叫 text，不是 content。
    // 这里曾误写成 result.content，于是永远拿到 undefined → 明明模型答了就报「没有输出正文」。
    // 测试的 mock 当时跟着错写，所以全绿；改契约时请同步 scripts/check-qzone-draft.mjs。
    const content = cleanDraftText(result.text);
    // 走到这里说明模型确实给了正文，只是清洗（引号/前缀/围栏）后什么都不剩。
    if (!content) {
      return {
        ok: false,
        code: 'EMPTY_DRAFT',
        error: `模型返回的正文清洗后为空（原文 ${String(result.text ?? '').length} 字符，可能只有引号或代码围栏）`
      };
    }

    return {
      ok: true,
      content,
      model: result.model || s.model,
      effort: s.reasoningEffort,
      persona: { name: persona.name, source: persona.source, chars: persona.chars },
      usage: result.usage ?? null,
      latencyMs: Date.now() - startedAt
    };
  }

  return { describe, draft, settings };
}
