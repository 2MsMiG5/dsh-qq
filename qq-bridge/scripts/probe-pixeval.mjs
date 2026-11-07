// 端到端探针：验证 QQ 会话（默认 preset=qq-chat-v2）能否调用 Pixeval 桌面端 MCP
// （host 层 serverName = `pixeval`，公开工具名 `mcp__pixeval__<工具名>`）。
//
// 为什么单独一个探针
// ------------------
// `tools.guard` 的白名单通过（test-tool-restrict-guard.mjs）只证明「不会拒绝」，
// preset 里写了工具名只证明「提示词提到过」。真正要证明的是三件事同时成立：
//   ① 模型看得到 `mcp__pixeval__*` 的工具 schema（host 层的 dsh-mcp-client 已加载
//      serverName=pixeval 且连上了 127.0.0.1:52163）；
//   ② 模型愿意按提示词去调；
//   ③ 执行期 guard 放行、Pixeval 真的返回结果（不是 isError）。
// 只有活的 DSH 才能验证，所以本文件不进离线回归套件，由人/Lead 在装好 bundle 后手动跑。
//
// 结构完全照抄 probe-tools.mjs（同一套鉴权/RPC/mux 引导，见 probe-auth.mjs 头部）：
//   workspace/create → session/create(agentPreset) → session/prompt
//   → 观察 tool/call & tool/result → 归档会话/删工作区。
//
// 用法（在 qq-bridge 仓库根目录）：
//   node scripts/probe-pixeval.mjs            # 默认 preset = qq-chat-v2
//   node scripts/probe-pixeval.mjs qq-chat    # 指定 preset
//
// 判定：观测到一条 `mcp__pixeval__*` 的 tool/result 且不是错误 ⇒ 通过（exit 0）；
// 超时、没观测到调用、调用报错、或 preset 挂载失败 ⇒ 失败（exit 1）。
// 最终文本会打印出来便于排查（模型被要求只回复「完成」）。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * DSH 基址：显式 DSH_BASE_URL 优先，否则读 config.json 的 dsh.baseUrl（桥接生产配置）。
 * probe-auth.mjs 的默认值是 3080，但本机实际网关注册在别处（如 61058），
 * 直接用它会让探针 ECONNREFUSED —— 所以这里按桥接自己的配置解析。
 */
function resolveBase() {
  if (process.env.DSH_BASE_URL) return process.env.DSH_BASE_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    if (cfg?.dsh?.baseUrl) return cfg.dsh.baseUrl;
  } catch {}
  return 'http://127.0.0.1:3080';
}
const BASE = resolveBase();

// 鉴权与 RPC 引导统一走 probe-auth.mjs（用手上的 browser-session 签名密钥离线铸 Cookie；
// 旧的「从 guard 日志抓 launch token」在 DSH 0.1.7 起已失效，会让探针一律 401）。
const cookie = probeCookie({ base: BASE });
const rpc = probeRpc(cookie, { base: BASE });

const PRESET = process.argv[2] || 'qq-chat-v2';
const PROMPT = '请调用 mcp__pixeval__status 工具一次，然后只回复：完成';
// 探测工作区建在系统临时目录：state/ 的 ACL 被收紧过，沙箱里写不进去。
const dir = probeWorkspaceDir('pixeval');

/** 清理用：无论成功失败都要归档会话/删工作区，别在 DSH 侧栏留垃圾。 */
let wsId = null;
let sessionId = null;
async function cleanup() {
  try { if (sessionId) await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
  try { if (wsId) await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const ws = await rpc('workspace/create', { request: { path: dir } });
if (!ws?.ok) {
  console.error(`❌ workspace/create 失败: ${ws?.error?.code}: ${ws?.error?.message}`);
  await cleanup();
  process.exit(1);
}
wsId = ws.value.workspace.workspaceId;

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) {
  console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`);
  await cleanup();
  process.exit(1);
}
sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET}, base=${BASE})`);

// 模型切换（桥接 ensureChatModel 的等价操作）
const sm = await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
console.log('selectModel ->', sm.ok ? JSON.stringify(sm.value.selected) : `FAIL ${sm.error.code}: ${sm.error.message}`);

const socket = probeMuxSocket(cookie, { base: BASE });
const streamId = randomUUID();
const eventStreamId = randomUUID();
/** callId → 工具名：tool/result 事件本身不带 name，只有 message.source.callId。 */
const callNames = new Map();
const toolCalls = [];
const toolResults = [];
let text = '';

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 120_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: {
          sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: PROMPT }]
        }
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 120));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    const d = e.data ?? {};
    if (e.type === 'assistant/message') for (const b of d?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') {
      const name = d.name ?? d.toolName;
      const callId = d.callId ?? d.toolCallId ?? d.message?.source?.callId;
      if (callId) callNames.set(callId, name);
      toolCalls.push({ name, args: d.arguments ?? d.args });
    }
    if (e.type === 'tool/result') {
      const callId = d.toolCallId ?? d.callId ?? d.message?.source?.callId;
      const name = callNames.get(callId) ?? d.name ?? d.toolName;
      const contentText = (d.message?.content ?? d.content ?? []).map((b) => b?.text ?? '').join('\n');
      toolResults.push({
        name,
        callId,
        isError: d.isError === true || d.error !== undefined || d.message?.isError === true,
        preview: contentText.slice(0, 500),
      });
    }
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 200)));
console.log('tool/call:', JSON.stringify(toolCalls));
console.log('tool/result:', JSON.stringify(toolResults));

const PIXEVAL_PREFIX = 'mcp__pixeval__';
const calledPixeval = toolCalls.some((c) => String(c.name).startsWith(PIXEVAL_PREFIX));
const pixevalResults = toolResults.filter((r) => String(r.name).startsWith(PIXEVAL_PREFIX));
const pixevalOk = pixevalResults.some((r) => !r.isError);
const pixevalFailed = pixevalResults.filter((r) => r.isError);

console.log('\n判定:');
console.log(`  调用了 mcp__pixeval__* 工具     : ${calledPixeval ? '✅' : '❌ 未观测到调用（工具不可见 / 模型没按提示调 / guard 拒绝）'}`);
console.log(`  mcp__pixeval__* 结果非错误     : ${pixevalOk ? '✅' : '❌ 未观测到成功的 tool/result'}`);
if (pixevalFailed.length > 0) console.log(`  ❌ 报错的 pixeval 结果: ${JSON.stringify(pixevalFailed)}`);
if (!pixevalOk && text) console.log(`  提示：最终文本可能包含模型对失败原因的描述（见上）`);

try { socket.close(); } catch {}
await cleanup();
console.log('[cleanup] session archived, probe workspace deleted');
process.exit(pixevalOk ? 0 : 1);
