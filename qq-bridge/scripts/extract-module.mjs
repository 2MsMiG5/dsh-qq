// 重构工具：把一个函数簇从 bridge.js 抽成独立模块（延迟绑定模式）。
//
// 为什么用「延迟绑定」而不是构造参数：
//   · 这些函数依赖 bot / handles / currentMode 等**在 boot 尾部才创建**的对象，
//     如果工厂在创建时解构，会撞 TDZ（Cannot access before initialization）；
//   · 函数声明本来会提升，所以原代码可以在声明之前调用它们——换成 const 绑定就失去这层保护。
// 做法：模块内部用 `let` 保存依赖，工厂先返回可用的函数引用，boot 装配完再 bind 一次。
// 函数体一行不改，名字不变，调用点不变。
//
// 用法：node scripts/extract-module.mjs --target src/media/inbound.js --factory createInboundMedia \
//         --anchor <接线锚点文本> fn1 fn2 fn3 ...
//
// ⚠️ 前置步骤：先 `node scripts/analyze-coupling.mjs --json state/coupling.json` 刷新快照。
//    不带 --json 时它只打印报告、**不写文件**，于是抽取器会拿着上一次的行号去切代码——
//    切出来的碎片照样是合法语句，`node --check` 也过，只有跑审计才会炸。
//    脚本内置了锚点校验（该行必须真的声明了这个函数），过期会直接报错而不是静默切坏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { braceDelta, commentDelta } from './lib/js-scan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcPath = path.join(root, 'src/bridge.js');
const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);
const coupling = JSON.parse(fs.readFileSync(path.join(root, 'state/coupling.json'), 'utf8'));

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const target = opt('--target');
const factory = opt('--factory');
const anchor = opt('--anchor');
// 句柄名必须唯一：boot 里可能有多个迁出模块，都用 `inventory` 会直接 SyntaxError。
// 默认从工厂名推：createSendService → sendService。
const derivedHandle = factory.replace(/^create/, '').replace(/^./, (c) => c.toLowerCase());
const handle = opt('--handle', derivedHandle);
const VALUE_FLAGS = ['--target', '--factory', '--anchor', '--handle'];
const names = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
if (!target || !factory || !names.length) {
  throw new Error('用法：--target <文件> --factory <工厂名> --anchor <锚点> fn1 fn2 ...');
}

const picked = new Set(names);

// 函数结束行：从声明行起累加花括号增量，第一次归零处就是函数体闭合。
//
// 为什么不再用启发式（"下一个 function 之前的最后一个 `  }`"）：
// 它在「函数之间夹着别的 2 空格代码」时会算错，而错法是**静默**的——
// 区间可能停在函数体中间，剩下的半个函数留在原处，于是多出一个 `}`。
// 症状是 boot 被提前闭合，报 `await xxx: Unexpected reserved word`，
// 报错位置却在几百行之外，跟真正出错的地方毫无关系。
// braceDelta 已对字符串/模板/正则/注释做过跳过，实测与独立分析器的 endLine 逐函数一致。
function functionEnd(startLine) {
  let depth = 0;
  for (let i = startLine - 1; i < lines.length; i++) {
    depth += braceDelta(lines[i]);
    if (depth === 0) return i + 1;
  }
  return startLine;
}

const infos = names.map((n) => {
  const f = coupling.fn[n];
  if (!f) throw new Error(`找不到函数 ${n}（耦合分析里没有它）`);
  // ⚠️ coupling.json 是**上一次** analyze-coupling 的快照。bridge.js 每抽走一批函数，
  //    后面的行号就整体前移，快照立刻失真。失真时的错法极其恶性：抽取器按旧行号
  //    切出一堆「看起来像代码」的碎片，既不报错也不破坏语法，只是把别的函数切碎了。
  //    所以这里做一次锚点校验：该行必须真的声明了这个函数。
  if (!new RegExp(`function\\s+${n}\\s*\\(`).test(lines[f.line - 1] ?? '')) {
    throw new Error(
      `耦合分析快照已过期：第 ${f.line} 行不是 function ${n}。\n` +
      `  该行实际内容：${lines[f.line - 1]}\n` +
      `  修法：先跑 node scripts/analyze-coupling.mjs 刷新 state/coupling.json。`
    );
  }
  return { name: n, ...f, endLine: functionEnd(f.line) };
}).sort((a, b) => a.line - b.line);

// ---- 1. 收集依赖 ----
const stateNames = new Set();
const siblingNames = new Set();   // 本簇外的桥接函数（含顶层工具函数）
for (const info of infos) {
  for (const s of info.state) stateNames.add(s);
  for (const c of info.calls) if (!picked.has(c)) siblingNames.add(c);
  for (const t of info.topFns) siblingNames.add(t);
}

// ---- 2. 顶层 import 复用：模块里能直接 import 的就不必走 bind ----
const importMap = new Map();
{
  const source = lines.join('\n');
  const re = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm;
  let m;
  while ((m = re.exec(source))) {
    const clause = m[1].trim();
    const spec = m[2];
    if (/^[A-Za-z_$][\w$]*$/.test(clause)) { importMap.set(clause, { spec, default: true }); continue; }
    const named = clause.match(/\{([\s\S]*)\}/);
    if (!named) continue;
    for (const part of named[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      importMap.set((as[1] ?? as[0]).trim(), { spec, imported: as[0].trim() });
    }
  }
}

const bodyText = infos.map((f) => lines.slice(f.line - 1, f.endLine).join('\n')).join('\n');
const usedImports = [];
for (const [local, info] of importMap) {
  if (new RegExp(`(?<![.\\w$])${local.replace(/\$/g, '\\$')}(?![\\w$])`).test(bodyText)) {
    usedImports.push({ local, ...info });
  }
}
const importLocals = new Set(usedImports.map((i) => i.local));

const bindNames = [...new Set([...stateNames, ...siblingNames])]
  .filter((n) => !importLocals.has(n))
  .sort();

// ---- 3. 抽取函数文本（含紧邻的前导注释） ----
//
// ⚠️ JSDoc 的续行是**3 空格**缩进（`   * `），而函数是 2 空格。
// 早期版本只判 `/^  \*/`，于是 `   */` 不匹配、循环立刻 break —— 整段 JSDoc 既不进模块，
// 也不进删除区间，只剩一个孤零零的 `*/` 留在原地。删掉函数后块注释再没闭合，
// 后面的常量全被并进注释里（语法合法，运行时才炸）。所以这里必须先整段吞掉块注释。
function withLeadingComments(startLine) {
  let from = startLine - 1;                    // 0-based：函数声明行
  // ① 紧邻的块注释：从结尾的 */ 一路回退到 /** 开头
  if (from > 0 && /^\s*\*\/\s*$/.test(lines[from - 1])) {
    let j = from - 1;
    while (j > 0 && !/^\s*\/\*\*?/.test(lines[j])) j -= 1;
    if (/^\s*\/\*\*?/.test(lines[j])) from = j;
  }
  // ② 再吃紧邻的 2 空格行注释
  while (from > 0 && /^  \/\//.test(lines[from - 1])) from -= 1;
  return from;
}
const chunks = [];
for (const info of infos) {
  const from = withLeadingComments(info.line);
  chunks.push(lines.slice(from, info.endLine).join('\n'));
}

// ---- 4. 生成模块 ----
const out = [];
out.push(`// ${path.basename(target)} — 从 src/bridge.js 抽取的函数簇（${names.length} 个函数）。`);
out.push('//');
out.push('// 采用「延迟绑定」：工厂先返回可调用的函数，boot 装配完成后再 bind 一次依赖。');
out.push('// 原因是这些函数依赖 bot / handles 等在 boot 尾部才创建的对象，在工厂创建时解构会撞 TDZ。');
out.push('//');
out.push('// 三条规则（违反任一条都会静默出错）：');
out.push('//   1) 可变状态必须 bind **取值函数**，不能 bind 值快照——否则模块看到的是永久冻结的旧状态。');
out.push('//   2) 函数体与原实现逐字一致，只把闭包引用改为 bind 进来的局部变量。');
out.push('//   3) 凡是能被测试/调用方替换的能力（抓取、外部服务调用），一律走 bind，不要在这里 import。');
out.push('//      原实现从 boot 外层作用域取这些名字，调用方通过注入同名绑定来替换；改成直接 import');
out.push('//      会绕过那个注入点——调用方以为自己换了实现，实际跑的还是真模块（假绿）。');
out.push('');
const bySpec = new Map();
for (const h of usedImports) {
  if (!bySpec.has(h.spec)) bySpec.set(h.spec, []);
  bySpec.get(h.spec).push(h);
}
for (const [spec, list] of bySpec) {
  const tgt = spec.startsWith('.') ? '../' + spec.replace(/^\.\//, '') : spec;
  const defaults = list.filter((h) => h.default);
  const named = list.filter((h) => !h.default);
  const parts = [];
  if (defaults.length) parts.push(defaults[0].local);
  if (named.length) parts.push('{ ' + named.map((h) => (h.imported === h.local ? h.local : `${h.imported} as ${h.local}`)).join(', ') + ' }');
  out.push(`import ${parts.join(', ')} from '${tgt}';`);
}
if (bySpec.size) out.push('');

out.push('export function ' + factory + '() {');
if (bindNames.length) {
  out.push('  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用，');
  out.push('  // 这与原实现（引用 boot 内后声明的变量）的时序要求完全一致。');
  out.push('  let ' + bindNames.join(', ') + ';');
  out.push('');
  out.push('  /** 由 boot 在依赖就绪后调用一次 */');
  out.push('  function bind(deps) {');
  // 必须用「解构赋值」({ a, b } = deps)。写成逗号表达式 (a, b = deps) 只会给最后一个
  // 变量赋值，其余全是 undefined —— 语法合法、测试一跑才炸。
  out.push('    ({ ' + bindNames.join(', ') + ' } = deps);');
  out.push('  }');
} else {
  // 纯函数簇：不引用 boot 作用域里任何东西，bind 是空实现。
  // 保留 bind 只是为了让装配侧写法统一（统一 `const X = createX(); X.bind({})` 收尾），
  // 不必为「有没有依赖」分叉出第二种接线方式。
  out.push('  /** 纯函数簇：不依赖 boot 作用域，bind 空转（保留统一接线形状）。 */');
  out.push('  function bind() {}');
}
out.push('');
out.push(chunks.join('\n\n'));
out.push('');
out.push(`  return { bind, ${names.join(', ')} };`);
out.push('}');

const targetPath = path.join(root, target);
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
const moduleText = out.join('\n') + '\n';
fs.writeFileSync(targetPath, moduleText);

// ---- 4.6 产物自检 ----
{
  // 块注释必须平衡：不平衡说明某段代码被注释吞了（语法仍合法，运行时才炸）。
  // 用 commentDelta 而不是逐字符数：正则字面量里的「星号+斜杠」会被误判成注释结束
  // （`/   s* /` 这种写法在 splitLongSegment 一带就有，曾把合法产物判成坏文件）。
  let depthC = 0;
  for (const l of moduleText.split('\n')) {
    depthC += commentDelta(l);
    if (depthC < 0) throw new Error(`生成的 ${target} 出现多余的 */ —— 抽取区间切坏了注释`);
  }
  if (depthC !== 0) throw new Error(`生成的 ${target} 有未闭合的块注释（净 ${depthC}）——后续代码会被吞掉`);
}

// ---- 5. 从 bridge.js 删除这些函数，插入接线 ----
//
// 关键：删除区间里可能夹着状态声明（媒体链路里 MAX_MEDIA_* 配额、限频时间戳数组
// 就散落在函数之间）。按连续区间删会把这些声明一起删掉，表现为启动即 `X is not defined`。
// 所以先把区间内 2 空格缩进的 let/const 语句「抢救」出来，其余才删。
// ⚠️ withLeadingComments() 返回的是 **0-based 下标**（要喂给 lines.slice），
// 这里必须 +1 转成 1-based 行号，否则每个删除区间都会多吞掉函数前的**那一行**。
// 症状取决于那一行是什么：是空行就看不出来，是 `  }` 就会让外层函数少一个闭合括号，
// 于是 boot 被提前闭合——报错却是几百行之后的 `await xxx: Unexpected reserved word`。
const removeRanges = infos.map((f) => [withLeadingComments(f.line) + 1, f.endLine]);

// ---- 4.5 删除区间体检（必须在动手之前）----
//
// 踩过的坑：区间起点若落在 `/** … */` 的**中间**，删完之后块注释就再也没闭合，
// 后面的 const 全被并进注释里。`node --check` 依然通过（注释是合法的），
// 表现为启动时某个常量 `is not defined`——而且报的是**另一个**常量名，极难定位。
//
// 所以这里做两道硬检查：
//   A) 区间起点不能落在块注释内部；
//   B) 区间内注释定界符必须自平衡（`/*` 与 `*/` 数量相等）。
{
  // 逐行标记「本行是否处在块注释开头」，同时统计每行进入/离开注释的状态。
  // ⚠️ 必须用词法感知的 commentDelta，不能在这里逐字符数 `/*` 与 `*/`：
  //    代码里出现 `/...*/` 形态的正则（`.replace(/\s*\n\s*/g, ' ')`）会被误判成
  //    块注释结束，导致合法区间被判定为「不平衡」而挡下抽取。
  const inComment = [];       // inComment[i] = 该行字符是否在注释内开始（近似：行首状态）
  const openDelta = [];       // openDelta[i] = 该行的块注释净增量（词法感知）
  let depthC = 0;
  for (let i = 0; i < lines.length; i++) {
    inComment[i] = depthC > 0;
    const d = commentDelta(lines[i]);
    openDelta[i] = d;
    depthC += d;
    if (depthC < 0) depthC = 0;
  }
  for (const [from, end] of removeRanges) {
    if (inComment[from - 1]) {
      throw new Error(
        `删除区间起点第 ${from} 行落在块注释内部（多半是 JSDoc 的 */ 被当成了函数起始）。\n` +
        `  行内容：${lines[from - 1]}\n` +
        `  修法：让 withLeadingComments 把整段 /** … */ 一起纳入区间。`
      );
    }
    let sum = 0;
    for (let n = from; n <= end; n += 1) sum += openDelta[n - 1];
    if (sum !== 0) {
      throw new Error(
        `删除区间 [${from}, ${end}] 的块注释定界符不平衡（净 ${sum}）：删完会污染后续代码。`
      );
    }
    // C) 花括号也必须自平衡。多吞一行 `  }` 会让外层函数少一个闭合，
    //    而 `node --check` 往往还能通过（只是把后面的代码并进同一个函数体）。
    let bsum = 0;
    for (let n = from; n <= end; n += 1) bsum += braceDelta(lines[n - 1]);
    if (bsum !== 0) {
      throw new Error(
        `删除区间 [${from}, ${end}] 的花括号不平衡（净 ${bsum}）：区间切到了别的函数的边界。\n` +
        `  起始行：${lines[from - 1]}\n  结束行：${lines[end - 1]}`
      );
    }
  }
}


function statementEnd(startIdx) {
  // 单行语句：以分号结尾（允许行尾注释）
  if (/;\s*(\/\/.*)?$/.test(lines[startIdx])) return startIdx;
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const d = braceDelta(lines[i]);
    if (d > 0) started = true;
    depth += d;
    if (started && depth <= 0) return i;
    if (!started && /;\s*(\/\/.*)?$/.test(lines[i]) && i > startIdx) return i;
  }
  return startIdx;
}

const rescued = new Set();   // 行号（1-based）
for (const [from, end] of removeRanges) {
  for (let n = from; n <= end; n++) {
    if (!/^  (?:const|let) [A-Za-z_$][\w$]*\s*=/.test(lines[n - 1])) continue;
    // 不能按区间末尾截断：`const X = (() => {…})()` 的闭合行若被切掉，
    // 后面的声明就会被包进一个未闭合的 IIFE，变成「语法没问题但变量不可见」——
    // node --check 完全看不出来，运行时却 ReferenceError。
    const stmtEnd = statementEnd(n - 1) + 1;
    for (let k = n; k <= stmtEnd; k++) rescued.add(k);
  }
}

const keep = [];
let ri = 0;
for (let i = 0; i < lines.length; i++) {
  const lineNo = i + 1;
  if (rescued.has(lineNo)) { keep.push(lines[i]); continue; }
  if (ri < removeRanges.length && lineNo >= removeRanges[ri][0] && lineNo <= removeRanges[ri][1]) {
    if (lineNo === removeRanges[ri][0]) keep.push(`  // 〔已迁出〕见 ${target}`);
    if (lineNo === removeRanges[ri][1]) ri++;
    continue;
  }
  keep.push(lines[i]);
}
let next = keep.join('\n');

// 接线：解构函数引用（放锚点处），bind 放在 boot 尾部
const destructure = [
  `  // ${path.basename(target)}：${names.length} 个函数已迁出，这里保留同名绑定以保证调用点不变。`,
  `  const ${handle} = ${factory}();`,
  `  const { ${names.join(', ')} } = ${handle};`
].join('\n');

if (anchor) {
  const idx = next.indexOf(anchor);
  if (idx < 0) throw new Error(`找不到接线锚点：${anchor}`);
  next = next.slice(0, idx) + destructure + '\n\n' + next.slice(idx);
}
fs.writeFileSync(srcPath, next);

// ---- 6. 产物自检：整个文件的花括号必须归零 ----
// node --check 对「提前闭合 + 多余闭合」这类错误不一定报错，但整文件深度不归零一定有问题。
{
  const outLines = next.split('\n');
  let d = 0;
  for (const l of outLines) d += braceDelta(l);
  if (d !== 0) {
    fs.writeFileSync(srcPath, lines.join('\n'));   // 回滚，别留下坏文件
    throw new Error(`改写后 src/bridge.js 花括号深度为 ${d}（应为 0），已回滚。检查删除区间边界。`);
  }
}

console.log(`已生成 ${target}（${names.length} 个函数 / ${chunks.join('\n').length ? chunks.join('\n').split('\n').length : 0} 行）`);
console.log(`bind 依赖 ${bindNames.length} 项：${bindNames.join(', ')}`);

// 值快照风险提示：被 bind 进来、又在函数体里被**赋值**的名字，很可能是可变状态。
// 传值会冻结状态（典型症状：改了配置不生效、缓存永不命中）。
const reassigned = bindNames.filter((n) =>
  new RegExp(`(?<![.\\w$])${n.replace(/\$/g, '\\$')}\\s*=[^=]`).test(bodyText));
if (reassigned.length) {
  console.log(`\n⚠️ 以下名字在函数体里被赋值，属于可变状态，bind 时必须传取值/写入函数而不是值：`);
  console.log(`   ${reassigned.join(', ')}`);
}

console.log(`\n还需要手工补三步（脚本不代劳，因为接线位置依赖具体装配顺序）：`);
console.log(`  1) import { ${factory} } from './${target.replace(/^src\//, '')}';`);
console.log(`  2) 在 boot 尾部（依赖就绪、handles 成型之后、onReady 之前）调用：`);
console.log(`     ${handle}.bind({ ${bindNames.join(', ')} });`);
console.log(`  3) 检查 bind 清单里有没有「可被测试替换的能力」仍被你留成了模块内 import。`);
