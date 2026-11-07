// 重构工具：把 startConsoleServer 里的路由 if 链拆成按领域分包的模块。
//
// 设计取舍（为什么保留 if 判断而不改写成纯路由表匹配）：
//   1. 有些块是 `if (…) { … } else { … }`，把条件搬到路由表会让 else 分支失去意义；
//   2. 有些块共享请求内局部量（如 slangMatch），必须同作用域；
//   3. 保留原条件 = 行为零变化，拆分只搬位置不改语义。
// 因此每个 handler 内部仍是原来的 `if (req.method … url.pathname …)`，
// 路由表只承担「不会命中的请求别进这个函数」的粗筛，两者叠加，正确性由测试保证。
//
// 用法：node scripts/split-http.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// 切块源文件可指定：拆分完成后 bridge.js 里已经没有这段代码了，
// 再对着它重跑生成器会拿到整段漂移的坐标（曾把媒体段当成 slang 端点生成）。
// 传 --src state/.bridge-prehttp.js 可对着 git 里的原文重新生成。
const srcArgIdx = process.argv.indexOf('--src');
const srcPath = srcArgIdx >= 0 ? path.resolve(process.argv[srcArgIdx + 1]) : path.join(root, 'src/bridge.js');
const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);
const meta = JSON.parse(fs.readFileSync(path.join(root, 'state/http-blocks.json'), 'utf8'));
const coupling = JSON.parse(fs.readFileSync(path.join(root, 'state/coupling.json'), 'utf8'));
const blocks = meta.blocks;
const dry = process.argv.includes('--dry');

// ---- 1. 领域划分 ----
// 依据：路径首段。单条端点并入最接近的域，避免产出十几个 10 行的碎片文件。
const DOMAIN_RULES = [
  [/^\/api\/socialV2\//, 'social-v2'],
  [/^\/api\/slang/, 'slang'],
  [/^\/api\/(roles?|role-mode|preset|presets)\b/, 'persona'],
  [/^\/api\/(persons)\b/, 'persona'],
  [/^\/api\/(dsh|sessions?|lite)\b/, 'dsh'],
  [/^\/api\/(images?|vision|video|voice|stickers|face|emoji)\b/, 'media'],
  [/^\/api\/(send|test-send)\b/, 'media'],
  [/^\/api\/(social)\b/, 'media'],
];
function domainOf(unit) {
  // 合并单元的第一块可能只是个 `const slangMatch = ...` 声明，路径写在正则里，
  // 所以要把整单元的块头拼起来找路径，否则动态段会被错分到别的域。
  // 正则字面量里的 `/` 写成 `\/`，归一化后再找路径，否则动态段（slangMatch）识别不到
  const heads = unit.map((b) => b.head).join(' ').replace(/\\\//g, '/');
  const paths = [...heads.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  let first = paths[0] ?? '';
  if (!first) {
    const m = heads.match(/\/api\/([a-zA-Z0-9_-]+)/);
    if (m) first = `/api/${m[1]}`;
  }
  for (const [re, name] of DOMAIN_RULES) if (re.test(first)) return name;
  return 'platform';
}

// ---- 2. 合并单元：某块声明的 const 被后续块引用时不能拆开 ----
// 现状只有 slang 的动态段（slangMatch）属于这种情况，但仍写成通用逻辑，
// 以免以后新增同类块时被静默拆坏（表现为 ReferenceError）。
const units = [];
for (let i = 0; i < blocks.length; i++) {
  const b = blocks[i];
  const decl = b.head.match(/^const ([A-Za-z_$][\w$]*)\s*=/);
  if (!decl) { units.push([b]); continue; }
  const name = decl[1];
  const group = [b];
  let j = i + 1;
  while (j < blocks.length && new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(
    lines.slice(blocks[j].start - 1, blocks[j].end).join('\n'))) {
    group.push(blocks[j]);
    j++;
  }
  units.push(group);
  i = j - 1;
}

// ---- 3. 抽取块体（去掉首尾的 if 外壳那一行，保留 else 链） ----
function bodyOf(block) {
  const raw = lines.slice(block.start - 1, block.end);
  // 末行若是 `}` / `};` 之类的闭合且与首行 if 配对，去掉它；由 handler 自己的 } 收尾
  let end = raw.length;
  const last = raw[end - 1]?.trim() ?? '';
  if (last === '}' || last === '};') end -= 1;
  return raw.slice(0, end);
}

// 整块原样保留（含 if 外壳）——最安全：else 分支、内部 return 语义都不变
function textOf(block) {
  return lines.slice(block.start - 1, block.end).join('\n');
}

// ---- 4a. HTTP 层内部共享量 ----
// 这些不是 bridge 的闭包变量，而是 createConsoleServer 里创建的鉴权工具：
// agentTokenOk / isLiveAgentToken 由 http/auth.js 工厂产出，v2SessionAllowed 是别名，
// loadDshCatalog 读 DSH 模型目录，setConsoleToken 用于令牌热更新（consoleToken 是 let，
// 路由只能通过 setter 改，直接赋值只会改到解构出来的副本）。
// 它们不在 bridgeNames 里，所以要在依赖清单之外单独补。
const HTTP_SHARED = ['agentTokenOk', 'isLiveAgentToken', 'v2SessionAllowed', 'loadDshCatalog', 'setConsoleToken'];

// ---- 4b. 被注入的全局函数 ----
// fetch / setTimeout 这些本来是全局的，但拆到 ESM 模块后模块用的是**真实**全局：
//   · fetch → 测试的 fakeFetch 桩失效，请求真的打到网关（表现为 401 retcode=1401）；
//   · setTimeout → harness 登记的待清理定时器漏登记，测试结束后仍会触发。
// 所以把它们也做成显式依赖，由桥接侧传入（生产环境传的就是全局函数本身）。
const INJECTED_GLOBALS = ['fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];

// ---- 4. 依赖清单：块内引用、但不在本文件作用域里的桥接名字 ----
const bridgeFns = new Set(Object.keys(coupling.fn));
const bridgeState = new Set();
for (const list of Object.values(coupling.stateRefs)) for (const v of list) bridgeState.add(v);
const topFns = new Set();
for (const info of Object.values(coupling.fn)) for (const t of info.topFns) topFns.add(t);
// 模块级声明（boot 之外）：coupling.json 只统计 boot 内部的闭包与函数，
// 但路由块也会用到模块级常量（videoLinkApi、STATE_DIR、KNOWN_AGENT_TOKENS 这类）。
// 漏掉它们的表现是「生成的文件语法正确，一请求就 ReferenceError」。
const bootLine = lines.findIndex((l) => /^export async function boot\s*\(/.test(l));
const moduleDecls = new Set();
for (const line of lines.slice(0, bootLine < 0 ? lines.length : bootLine)) {
  const m = line.match(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) moduleDecls.add(m[1]);
}

const bridgeNames = new Set([...bridgeFns, ...bridgeState, ...topFns, ...moduleDecls]);

const HTTP_LOCALS = new Set(['req', 'res', 'url', 'sendJson', 'readBody']);

// 运行时可变的状态：不能用「工厂创建时解构」的方式传——那等于把启动那一刻的值冻成快照。
// currentMode 在控制台切模式后就变了，快照会让 /api/status 永远报旧模式。
// 这些名字改由 server 每请求取一次最新值，随 ctx 传进 handler。
const LIVE_NAMES = new Set([
  'slangEntries', 'slangStoreWritable',
  'stickerEntries', 'stickerStoreWritable', 'stickerSyncedAt', 'lastForcedAgentStickerSync',
  'dshReady', 'currentMode', 'lastMode', 'closedAgentPreset',
  'snowlumaPanelCache', 'sessionEpoch',
  'selfDisplayName', 'selfUserId',
  'initialPromptsWritable', 'liteDirectFailures', 'liteDirectBroken'
]);
const JS_BUILTINS = new Set(['JSON', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'Date', 'Set', 'Map', 'Promise', 'Error', 'TypeError', 'RegExp', 'Symbol', 'BigInt', 'Buffer', 'console', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'AbortSignal', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'undefined', 'null', 'true', 'false', 'this', 'globalThis', 'process', 'require', 'await', 'async', 'function', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void']);

function depsOf(text) {
  const found = new Set();
  for (const name of bridgeNames) {
    if (new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text)) found.add(name);
  }
  return [...found].sort();
}

// ---- 4b. 顶层 import 复用：块里用的 fs/path/crypto/mdToPlain 等不该走 deps ----
// 从 bridge.js 头部解析出「本地名 -> 来源模块」，新模块按需重新 import。
// 路径从 src/http/routes/ 回推两级，裸模块名保持原样。
const sourceText = lines.join('\n');
const importMap = new Map();
{
  const re = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm;
  let m;
  while ((m = re.exec(sourceText))) {
    const clause = m[1].trim();
    const spec = m[2];
    if (/^[A-Za-z_$][\w$]*$/.test(clause)) {
      importMap.set(clause, { spec, default: true });
      continue;
    }
    const named = clause.match(/\{([\s\S]*)\}/);
    if (!named) continue;
    for (const part of named[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      const imported = as[0].trim();
      const local = (as[1] ?? as[0]).trim();
      importMap.set(local, { spec, imported });
    }
  }
}

function importsOf(text) {
  const hits = [];
  for (const [local, info] of importMap) {
    if (!new RegExp(`(?<![.\\w$])${local.replace(/\$/g, '\\$')}(?![\\w$])`).test(text)) continue;
    hits.push({ local, ...info });
  }
  // 同源模块合并成一条 import，避免生成十几行 import { x } from 'node:fs'
  const bySpec = new Map();
  for (const h of hits) {
    if (!bySpec.has(h.spec)) bySpec.set(h.spec, []);
    bySpec.get(h.spec).push(h);
  }
  const out = [];
  for (const [spec, list] of bySpec) {
    const target = spec.startsWith('.') ? '../../' + spec.replace(/^\.\//, '') : spec;
    const defaults = list.filter((h) => h.default);
    const named = list.filter((h) => !h.default);
    const parts = [];
    if (defaults.length) parts.push(defaults[0].local);
    if (named.length) {
      parts.push('{ ' + named.map((h) => (h.imported === h.local ? h.local : `${h.imported} as ${h.local}`)).join(', ') + ' }');
    }
    out.push(`import ${parts.join(', ')} from '${target}';`);
  }
  return out;
}

// ---- 4c. 写回规则 ----
// 状态变量搬到路由侧后，`X = ...` 只改到解构出来的副本，原作用域仍是旧值。
// 后果不是「看起来不对」，而是真实的数据丢失：
//   · slangEntries：赋值后紧跟 saveSlangStore()，存的是**旧数组** —— 删掉的黑话重启又回来；
//   · snowlumaPanelCache：整对象重新赋值，缓存永远不命中，每 3 秒真打一次上游；
//   · consoleToken：改了令牌但旧令牌还能用。
// 所以凡是「整体重新赋值」的状态，一律改成写回原作用域的形式。
const REWRITES = [
  [/consoleToken = newToken;/g, 'setConsoleToken(newToken);'],
  [/^(\s*)snowlumaPanelCache = \{ at, value: info \};$/gm,
   '$1snowlumaPanelCache.at = at;\n$1snowlumaPanelCache.value = info;'],
  [/^(\s*)slangEntries = (.+);$/gm, '$1setSlangEntries(slangEntries = $2);']
];

function rewriteText(text) {
  return REWRITES.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

// ---- 5. 分组生成 ----
const byDomain = new Map();
for (const unit of units) {
  const domain = domainOf(unit);
  if (!byDomain.has(domain)) byDomain.set(domain, []);
  byDomain.get(domain).push(unit);
}

// 从单元的首行里读出方法、精确路径、前缀
function describe(unit) {
  let method = '';
  const exact = new Set();
  const prefix = new Set();
  for (const b of unit) {
    const head = lines[b.start - 1].replace(/\\\//g, '/');
    const m = head.match(/req\.method === '([A-Z]+)'/);
    if (m && !method) method = m[1];
    for (const p of head.matchAll(/url\.pathname === '([^']+)'/g)) exact.add(p[1]);
    for (const p of head.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)) prefix.add(p[1]);
  }
  return { method: method || 'ANY', exact: [...exact], prefix: [...prefix] };
}

// 缩进保持原样（8 空格）：原块在请求入口 `try {`（6 空格）里，而 handler 声明也是
// 6 空格、函数体就是 8 空格——两者层级相同，不需要调整。
function unitText(unit) {
  const out = [];
  for (const b of unit) out.push(...lines.slice(b.start - 1, b.end));
  return out;
}

const outDir = path.join(root, 'src/http/routes');
if (!dry) fs.mkdirSync(outDir, { recursive: true });

const manifest = [];

for (const [domain, domainUnits] of [...byDomain].sort((a, b) => b[1].length - a[1].length)) {
  const allText = domainUnits.map((u) => u.map(textOf).join('\n')).join('\n');
  const imports = importsOf(allText);
  const importedNames = new Set(imports.map((line) => line.split(/\s+/)[1]));
  const sharedUsed = HTTP_SHARED.filter((n) => new RegExp(`(?<![.\\w$])${n}(?![\\w$])`).test(allText));
  // 令牌热更新：consoleToken 现在由 server.js 持有，直接赋值只会改到解构副本，
  // 表现为「改了令牌但旧令牌还能用」。改成显式 setter。
  const rewritten = rewriteText(allText);
  const extraDeps = /setConsoleToken\(/.test(rewritten) && !sharedUsed.includes('setConsoleToken') ? ['setConsoleToken'] : [];
  // setSlangEntries 由桥接提供（它要写回 bridge 的 let），不属于 server 自造的 shared
  const bridgeExtra = /setSlangEntries\(/.test(rewritten) ? ['setSlangEntries'] : [];
  // deps = 桥接层提供；shared = server.js 自己创建。两者混用会让桥接侧清单里
  // 出现 agentTokenOk 这类不存在于桥接作用域的名字，接线时直接 ReferenceError。
  const globalsUsed = INJECTED_GLOBALS.filter((n) => new RegExp(`(?<![.\\w$])${n}\\s*\\(`).test(allText));
  const deps = [...new Set([
    ...depsOf(allText).filter((n) => !importedNames.has(n) && !LIVE_NAMES.has(n)),
    ...globalsUsed,
    ...bridgeExtra
  ])].sort();
  const shared = [...new Set([...sharedUsed, ...extraDeps])].filter((n) => !deps.includes(n)).sort();
  const allBindings = [...deps, ...shared].sort();
  const liveUsed = [...LIVE_NAMES].filter((n) => new RegExp(`(?<![.\\w$])${n}(?![\\w$])`).test(allText)).sort();
  const camel = domain.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const head = `create${camel[0].toUpperCase()}${camel.slice(1)}Routes`;
  const out = [];

  out.push(`// ${domain} 域的 HTTP 端点。`);
  out.push('// 由 scripts/split-http.mjs 从 src/bridge.js 的 startConsoleServer 中切出。');
  out.push('// 每个 handler 内部保留原来的 if 判断，路由表只做粗筛——行为与原实现逐字一致，');
  out.push('// 这样 else 分支、return 语义、块间共享的请求内局部量都不会被改写破坏。');
  out.push('');
  if (imports.length) {
    out.push(...imports);
    out.push('');
  }
  out.push(`export function ${head}(deps) {`);
  if (allBindings.length) {
    out.push('  const {');
    for (let i = 0; i < allBindings.length; i += 6) {
      out.push('    ' + allBindings.slice(i, i + 6).join(', ') + ',');
    }
    out.push('  } = deps;');
  }
  out.push('  return [');

  for (const unit of domainUnits) {
    const d = describe(unit);
    out.push('    {');
    out.push(`      method: '${d.method}',`);
    if (d.exact.length === 1) out.push(`      path: '${d.exact[0]}',`);
    else if (d.exact.length > 1) out.push(`      paths: [${d.exact.map((p) => `'${p}'`).join(', ')}],`);
    if (d.prefix.length === 1) out.push(`      prefix: '${d.prefix[0]}',`);
    else if (d.prefix.length > 1) out.push(`      prefixes: [${d.prefix.map((p) => `'${p}'`).join(', ')}],`);
    const params = ['req', 'res', 'url', 'sendJson', 'readBody', ...liveUsed].join(', ');
    out.push(`      async handler({ ${params} }) {`);
    out.push(...rewriteText(unitText(unit).join('\n')).split('\n'));
    out.push('      }');
    out.push('    },');
  }

  out.push('  ];');
  out.push('}');

  manifest.push({
    domain,
    file: `src/http/routes/${domain}.js`,
    factory: head,
    deps,
    shared,
    live: liveUsed,
    units: domainUnits.length,
    blocks: domainUnits.reduce((s, u) => s + u.length, 0),
    routes: domainUnits.map((u) => describe(u))
  });
  if (!dry) fs.writeFileSync(path.join(outDir, `${domain}.js`), out.join('\n') + '\n');
}

console.log(`领域 ${byDomain.size} 个，合并单元 ${units.length} 个，语句块 ${blocks.length} 个\n`);
for (const m of manifest.sort((a, b) => b.blocks - a.blocks)) {
  console.log(`${m.domain.padEnd(12)} ${String(m.blocks).padStart(3)} 块 / ${String(m.units).padStart(3)} 单元 / 依赖 ${String(m.deps.length).padStart(3)} 项`);
}
fs.writeFileSync(path.join(root, 'state/http-manifest.json'), JSON.stringify(manifest, null, 2));
