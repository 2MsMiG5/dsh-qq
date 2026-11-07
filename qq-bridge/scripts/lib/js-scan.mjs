// 轻量 JS 词法扫描：用于按大括号平衡求语句 / 函数 / 块的真实结束行。
//
// 为什么需要：重构脚本要「按结构切块」，而正则一行匹配会被字符串里的 `}`、
// 模板串里的 `${}`、正则字面量里的 `{2,}` 骗到。本模块只做一件事——
// 从某一起点扫到配对的大括号，跳过字符串 / 模板 / 正则 / 注释。
//
// 已知边界：不做完整 AST 解析，不处理 `regexExec` 之外的正则陷阱（如 `a / b / c`）。
// 对「先定位结构、再人工/脚本搬运」的重构场景足够，且比引入解析器依赖更轻。

const REGEX_PRECEDERS = new Set(['', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);

/**
 * 从 startIndex 行开始，找到该行所开启语句的配对 `}` 所在行。
 *
 * @param {string[]} lines 全文按行切分
 * @param {number} startIndex 语句起始行下标
 * @returns {number} 结束行下标；找不到时返回 lines.length - 1
 */
export function findBlockEnd(lines, startIndex) {
  const text = lines.slice(startIndex).join('\n');
  let i = 0;
  let depth = 0;      // 语句体大括号深度
  let paren = 0;      // 参数列表深度：签名里的默认值 `= {}` 不能被当语句体
  let started = false;
  let prev = '';      // 上一个有意义的字符，用于判定 `/` 是正则还是除号

  const skipString = (quote) => {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) { i++; return; }
      i++;
    }
  };
  const skipRegex = () => {
    i++;
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { i++; return; }
      i++;
    }
  };
  const skipTemplate = () => {
    i++; // 跳过起始反引号
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { i++; return; }
      if (ch === '$' && text[i + 1] === '{') { i += 2; skipExpression(); continue; }
      i++;
    }
  };
  // 递归处理模板串里的 `${ ... }`：本仓库存在嵌套模板（`` `${a ? `/x` : ''}` ``），
  // 把反引号当单向字符串边界会在内层反引号处提前收尾，随后括号计数整体错乱。
  const skipExpression = () => {
    let d = 0;
    let p = '';
    while (i < text.length) {
      const ch = text[i];
      const nx = text[i + 1];
      if (ch === '/' && nx === '/') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
        continue;
      }
      if (ch === '/' && nx === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      if (ch === "'" || ch === '"') { skipString(ch); p = ch; continue; }
      if (ch === '`') { skipTemplate(); p = '`'; continue; }
      if (ch === '/' && REGEX_PRECEDERS.has(p)) { skipRegex(); p = '/'; continue; }
      if (ch === '{') { d++; p = ch; i++; continue; }
      if (ch === '}') {
        if (d === 0) { i++; return; }
        d--; p = ch; i++; continue;
      }
      if (!/\s/.test(ch)) p = ch;
      i++;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    if (ch === '/' && nx === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && nx === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') { skipString(ch); prev = ch; continue; }
    if (ch === '`') { skipTemplate(); prev = '`'; continue; }
    if (ch === '/' && REGEX_PRECEDERS.has(prev)) { skipRegex(); prev = '/'; continue; }
    if (ch === '(') { paren++; prev = ch; i++; continue; }
    if (ch === ')') { paren--; prev = ch; i++; continue; }
    if (paren > 0) { if (!/\s/.test(ch)) prev = ch; i++; continue; }  // 参数列表里，忽略成对的 { }
    if (ch === '{') { depth++; started = true; prev = ch; i++; continue; }
    if (ch === '}') {
      depth--; prev = ch; i++;
      if (started && depth === 0) {
        return startIndex + (text.slice(0, i).match(/\n/g)?.length ?? 0);
      }
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return lines.length - 1;
}

/**
 * 计算整行内大括号的净变化（跳过字符串 / 模板 / 注释 / 正则）。
 * 用于「按缩进 + 缩进差」切块：只看一句代码占了多少层的开合。
 *
 * @param {string} line 单行文本
 * @returns {number} `{` 多于 `}` 则为正
 */
export function braceDelta(line) {
  let delta = 0;
  let i = 0;
  let prev = '';
  const skipString = (quote) => {
    i++;
    while (i < line.length) {
      if (line[i] === '\\') { i += 2; continue; }
      if (line[i] === quote) { i++; return; }
      i++;
    }
  };
  while (i < line.length) {
    const ch = line[i];
    const nx = line[i + 1];
    if (ch === '/' && nx === '/') return delta;
    if (ch === "'" || ch === '"') { skipString(ch); prev = ch; continue; }
    if (ch === '`') { skipString('`'); prev = '`'; continue; }
    if (ch === '/' && REGEX_PRECEDERS.has(prev)) {
      i++;
      let inClass = false;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '[') inClass = true;
        else if (line[i] === ']') inClass = false;
        else if (line[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      prev = '/';
      continue;
    }
    if (ch === '{') { delta++; prev = ch; i++; continue; }
    if (ch === '}') { delta--; prev = ch; i++; continue; }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return delta;
}

/**
 * 计算整行内块注释定界符的净变化，**只在代码位置计数**：
 * 字符串 / 模板 / 正则 / 行注释里的定界符一律不算。
 *
 * 为什么不能用文本正则去数：本仓库有 `/   s* /` 这类正则字面量（splitLongSegment 一带），
 * 其中的「星号 + 斜杠」两个字符恰好构成块注释结束符。按文本数会把它当成注释收尾，
 * 于是「注释是否平衡」的自检把**合法代码**判成坏文件（本次抽取就是这样被挡下来的）。
 *
 * @param {string} line 单行文本
 * @returns {number} 开启数减结束数
 */
export function commentDelta(line) {
  let delta = 0;
  let i = 0;
  let prev = '';
  const skipString = (quote) => {
    i++;
    while (i < line.length) {
      if (line[i] === '\\') { i += 2; continue; }
      if (line[i] === quote) { i++; return; }
      i++;
    }
  };
  while (i < line.length) {
    const ch = line[i];
    const nx = line[i + 1];
    if (ch === "'" || ch === '"') { skipString(ch); prev = ch; continue; }
    if (ch === '`') { skipString('`'); prev = '`'; continue; }
    // ⚠️ 定界符判定必须排在「正则」判定**之前**：`prev` 初值是 ''，而 '' 属于
    //    REGEX_PRECEDERS，于是行首的 `/*` 会被当成正则开头，skipRegex 一路吃到
    //    行内下一个 `/`——块注释开启就漏计了，紧随其后的 ` */` 反而扣 1，
    //    累计深度变负，自检把**合法文件**判成坏文件。
    //    （JS 词法里正则字面量不可能以 `*` 开头，所以先判 `/*` 不会有歧义。）
    if (ch === '/' && nx === '*') { delta += 1; i += 2; prev = '*'; continue; }
    if (ch === '*' && nx === '/') { delta -= 1; i += 2; prev = '/'; continue; }
    if (ch === '/' && nx === '/') return delta;          // 行注释之后不会再有块注释
    if (ch === '/' && REGEX_PRECEDERS.has(prev)) {
      i++;
      let inClass = false;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '[') inClass = true;
        else if (line[i] === ']') inClass = false;
        else if (line[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      prev = '/';
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return delta;
}

/**
 * 把注释、字符串、模板、正则字面量全部抹成空格（**保留换行**，因此行号不变）。
 *
 * 为什么需要：静态体检要在源码里找「全大写标识符是否声明过」，
 * 而正则字面量 `[IMAGE]`、字符串 `'<![CDATA['` 里的词并不是引用。
 * 用文本正则去剔这些字面量会互相打架（模板里套字符串、正则里套 `/`），
 * 所以这里跟 commentDelta 一样走逐字符词法扫描。
 *
 * 保留换行的原因是**行号必须准确**——报错给不出准确行号，等于没报。
 *
 * @param {string} src 整份源码
 * @returns {string} 同长度的「只剩代码」文本
 */
export function stripLiterals(src) {
  const out = [];
  let i = 0;
  let prev = '';                 // 上一个有意义的代码字符（判定正则开头用）
  const push = (ch) => out.push(ch === '\n' ? '\n' : ' ');
  const skipTo = (stopAtQuote) => {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { push(c); i++; if (i < src.length) { push(src[i]); i++; } continue; }
      if (stopAtQuote && c === stopAtQuote) { push(c); i++; return; }
      push(c);
      if (!stopAtQuote && c === '/' && prev !== '\\') return;
      i++;
    }
  };
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {                       // 行注释
      while (i < src.length && src[i] !== '\n') { push(src[i]); i++; }
      continue;
    }
    if (ch === '/' && nx === '*') {                       // 块注释
      push(ch); i++; push(src[i]); i++;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { push(src[i]); i++; }
      if (i < src.length) { push(src[i]); i++; push(src[i]); i++; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {          // 字符串 / 模板
      push(ch); i++;
      skipTo(ch);
      prev = ch;
      continue;
    }
    if (ch === '/' && REGEX_PRECEDERS.has(prev)) {         // 正则字面量
      push(ch); i++;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { push(c); i++; if (i < src.length) { push(src[i]); i++; } continue; }
        if (c === '\n') break;                              // 正则不跨行：认错就止损
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        push(c); i++;
        if (c === '/' && !inClass) break;
      }
      prev = '/';
      continue;
    }
    out.push(ch);
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out.join('');
}
