// 轻量聊天的上下文压缩（纯函数，便于单测）：
//   · 历史窗口按时间 + 字符预算裁剪（解决"隔几小时还接旧话题"与"上下文无限膨胀"）；
//   · 滚动对话纪要的触发判定、输入拼装、输出清洗；
//   · 纪要文本的清洗/截断（模型偶尔会带 markdown 包裹，必须收敛成纯文本）。
//
// 为什么单开一个模块：bridge.js 已经很大，而这几条规则是「连续性 vs token」的核心，
// 需要单测钉住；bridge 只负责读状态、调模型、落盘。

/** 纪要允许的最大字符数（默认 300：约 200–250 token，够记 3–6 条事实）。 */
export const DEFAULT_SUMMARY_MAX_CHARS = 300;

/** 冲掉模型爱加的 markdown 包裹/列表符号，压成单行；空串表示没有可用纪要。 */
export function cleanSummaryText(raw, maxChars = DEFAULT_SUMMARY_MAX_CHARS) {
  const limit = Math.max(40, Math.min(2000, Number(maxChars) || DEFAULT_SUMMARY_MAX_CHARS));
  let text = String(raw ?? '').trim();
  // 去掉 ```json / ``` 包裹
  text = text.replace(/^```[a-zA-Z]*\s*/m, '').replace(/\s*```$/m, '');
  // 去掉「纪要：」「以下是…」这类开场
  text = text.replace(/^(?:<{0,2}摘要>{0,2}|【?纪要】?|对话纪要|以下是[^\n]{0,20}(?:纪要|摘要)[：:]?)\s*[:：]?\s*/m, '');
  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine
      .replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '')
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    lines.push(line);
  }
  const joined = lines.join('；');
  return joined.length > limit ? `${joined.slice(0, Math.max(0, limit - 1))}…` : joined;
}

/**
 * 是否该生成/更新滚动纪要。
 * @param {object} p
 * @param {number} [p.turnsSinceSummary] 上次纪要后经过的回合数
 * @param {number} [p.messagesSinceSummary] 上次纪要后新增的消息条数
 * @param {number} [p.lastSummaryAt] 上次纪要时间戳（0=从未生成）
 * @param {number} [p.lastMessageAt] 最近一条消息时间戳（没有消息就不生成）
 * @param {number} [p.now]
 * @param {number} [p.everyTurns=8]
 * @param {number} [p.maxMessages=24] 新增消息超过这个数也触发（防止窗口被挤爆）
 * @param {number} [p.staleMs=45*60*1000] 纪要太旧且又有新消息时触发
 */
export function summaryDue({
  turnsSinceSummary = 0,
  messagesSinceSummary = 0,
  lastSummaryAt = 0,
  lastMessageAt = 0,
  now = Date.now(),
  everyTurns = 8,
  maxMessages = 24,
  staleMs = 45 * 60 * 1000
} = {}) {
  const every = Math.max(2, Math.min(50, Math.round(Number(everyTurns) || 8)));
  const maxMsgs = Math.max(4, Math.min(200, Math.round(Number(maxMessages) || 24)));
  if (!Number.isFinite(Number(lastMessageAt)) || Number(lastMessageAt) <= 0) return false;
  if (!Number(lastSummaryAt)) return true;
  if (Number(turnsSinceSummary) >= every) return true;
  if (Number(messagesSinceSummary) >= maxMsgs) return true;
  if (now - Number(lastSummaryAt) >= staleMs && Number(messagesSinceSummary) > 0) return true;
  return false;
}

/**
 * 历史行按字符预算裁剪：从**最新的往旧的**保留，超预算的旧行丢弃。
 * 为什么从新往旧：预算不够时宁可少讲远古，也要保住刚发生的上下文。
 * @param {string[]} lines 已渲染的历史行（旧→新）
 * @param {number} maxChars
 * @returns {string[]}
 */
export function trimHistoryLines(lines, maxChars = 2400) {
  const list = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string' && line) : [];
  const limit = Math.max(200, Math.min(20000, Number(maxChars) || 2400));
  const kept = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const line = list[i];
    const cost = line.length + 1;
    if (kept.length > 0 && used + cost > limit) break;
    kept.push(line);
    used += cost;
  }
  return kept.reverse();
}

/**
 * 拼纪要请求：把上一版纪要和最近消息交给同一个直连模型（一次廉价调用）。
 * system 固定，便于缓存；user 里按时间顺序列消息，最后明确字数上限。
 *
 * 2026-10-29 改：删掉「还没回答的问题」这一栏。
 * 原设计会把历史里所有没答的问句一代代继承下来，变成一份「你欠这些问题」的清单；
 * 模型每轮看到就照着逐条回答，表现成「反复念叨同一批旧事」。
 * 现在只记「在聊什么 / 已定的事 / 称呼」，明确说明旧纪要里那一栏要删掉。
 *
 * @param {{previousSummary?:string, lines:string[], maxChars?:number, withPersonNotes?:boolean, knownFacts?:string[], knownProfiles?:Array<{id:string,title:string,sections?:object}>}} p
 * @returns {Array<{role:string, content:string}>}
 */
export function buildSummaryMessages({ previousSummary = '', lines = [], maxChars = DEFAULT_SUMMARY_MAX_CHARS, withPersonNotes = false, knownFacts = [], knownProfiles = [] } = {}) {
  const limit = Math.max(40, Math.min(2000, Number(maxChars) || DEFAULT_SUMMARY_MAX_CHARS));
  const list = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string' && line.trim()).slice(-60) : [];
  const body = [];
  if (previousSummary) body.push(`【已有纪要（需要更新，可保留仍有效的部分）】\n${String(previousSummary).slice(0, 800)}`);
  body.push(`【新增聊天记录（旧→新）】\n${list.join('\n')}`);
  body.push([
    `请输出更新后的对话纪要：2–4 条中文短句，只按这三方面记录：`,
    `1) 正在聊什么；2) 已有结论或约定（含对方明确提过、还没兑现的事，最多 1 条）；3) 对方称呼或外号。`,
    `不要记录「还没回答的问题」，也不要罗列对方的问句——没答的问题当场就该答，过期的直接丢掉。`,
    `已有纪要里如果还有「还没回答的问题」这一栏，直接删掉，不要延续。`,
    `只写记录里出现过的信息，不要编造，不要 Markdown，不要开场白，总字数不超过 ${limit} 字。`
  ].join('\n'));
  // 兼职记档案：主回复被压到十几 token，根本没空间写指令行，于是改成在这里顺手做。
  // 这一段只在 withPersonNotes 时出现——纯纪要场景（控制台重算/单测）不该被档案规则污染。
  if (withPersonNotes) {
    // 已经记过的先给模型看：字符级去重对中文措辞变化（「长东西」vs「长了个东西」）
    // 天生判不准，语义层面交给模型，桥接只做兜底。
    const known = Array.isArray(knownFacts) ? knownFacts.filter((line) => String(line || '').trim()).slice(0, 4) : [];
    if (known.length) {
      body.push([
        `【这些事实已经记进档案了，不要重复记】`,
        ...known.map((line) => `- ${String(line).slice(0, 220)}`)
      ].join('\n'));
    }
    // 旧的三段概况：不先给模型看，它改写时就会把历史丢掉（只剩这轮聊到的事）。
    const profiles = (Array.isArray(knownProfiles) ? knownProfiles : []).filter((p) => p && p.id).slice(0, 2);
    if (profiles.length) {
      const block = profiles.map((profile) => {
        const sections = profile.sections || {};
        const clip = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140) || '（空）';
        return [
          `- ${profile.id} · ${String(profile.title || profile.id).slice(0, 40)}`,
          `  · 是谁：${clip(sections.who)}`,
          `  · 性格与相处：${clip(sections.traits)}`,
          `  · 待续 / 注意：${clip(sections.notes)}`
        ].join('\n');
      });
      body.push([`【他们现在的档案概况（下面是旧版，改写时在这个基础上更新）】`, ...block].join('\n'));
    }
    body.push([
      `另外，纪要之后按需另起几行，做两件事（每条独占一行，没有就不写）：`,
      ``,
      `A 记新事实：\`[PERSON:note:<QQ号>] 一句话事实\``,
      `- ref 填说话人后面括号里的 QQ 号，照抄数字；没有 QQ 号就填那个人的昵称。`,
      `- 只记：称呼/真名、喜恶、在忙的事、近况变化、约好的事、重要的情绪或身体情况。`,
      `- 不记：寒暄、玩笑、猜测、我自己的回复、别人转述的隐私、纪要里已经有的旧事。`,
      `- 意思和上面「已经记过」相同就不要写，换个说法也不行。最多 2 行。`,
      ``,
      `B 更新概况（只给这段里说过话的人写，最多 2 个人）：`,
      `\`[PERSON:who:<QQ号>] 这个人是谁\` / \`[PERSON:traits:<QQ号>] 性格与相处\` / \`[PERSON:notes:<QQ号>] 待续 / 注意\``,
      `- 必须写**这一段的完整新版**（旧内容会被整段替换），不要只写这次新增的那一条。`,
      `- 只在确实出现「改变判断」的信息时才写；没变化就一行都不写，别为了凑数重写一遍。`,
      `- 每段不超过 120 字，用「- 」开头的短句；不要抄时间线里的事，那是 A 的活。`,
      `- 「待续 / 注意」写：该怎么称呼、别踩什么坑、别在群里提什么、答应过还没做的事。`
    ].join('\n'));
  }
  return [
    {
      role: 'system',
      content: '你是聊天记录整理器，只做客观压缩：把零散聊天压缩成可供下一轮对话续接的简短纪要，不评价、不脑补、不输出聊天回复。'
    },
    { role: 'user', content: body.join('\n\n') }
  ];
}

/**
 * 把模型输出里的档案指令行剥出来，剩下的才是纪要正文。
 *
 * 为什么要分开：纪要调用现在顺带做「记人物档案」这件兼职（主回复太短，塞不下指令行）。
 * 一旦剥不干净，`[PERSON:note:123456] 喜欢猫` 就会被 cleanSummaryText 当成纪要压平，
 * 于是每轮都以「对话纪要」的名义重复注入，模型读着读着就开始对着指令行聊天。
 *
 * 只做「切行」，解析交给调用方（parsePersonDirective），保持本模块纯函数、可单测。
 * @param {string} raw 模型原始输出
 * @returns {{text: string, notes: string[]}} text=去掉指令行后的正文；notes=指令行原文
 */
export function splitPersonNoteLines(raw) {
  const kept = [];
  const notes = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (/^\s*\[PERSON\s*:/i.test(line)) notes.push(line.trim());
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), notes };
}

/** 纪要的新鲜度标签：给提示词用，避免把一周前的纪要当"正在聊"。 */
export function summaryFreshness(updatedAt, now = Date.now()) {
  const at = Number(updatedAt);
  if (!Number.isFinite(at) || at <= 0) return '';
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 5) return '刚刚更新';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
