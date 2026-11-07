// qq-agent autostart 模块里「TTS 跟随 DSH 生命周期」这部分的自检。
// 直接 import 插件模块（不启动 DSH），验证四条关键路径：
//   0) 冷启动：ensureDafiyuTts 拉起服务并等到端口就绪
//   1) 重复拉起：已在跑/正在加载时返回 already-running/starting，不起第二份
//   2) DSH 退出路径：stopDafiyuTtsOwned 真的把进程停掉、端口释放
//   3) 停止后重新接管：ensure 能再次拉起，/health 正常
// 用法：node autostart-selftest.mjs
//
// 注意：本脚本是在一次性控制台里跑的，Windows 下子进程会随控制台关闭而收到 close 信号，
// 所以“脚本退出后服务还在”这件事在这里测不了，也不该测——DSH 运行时子进程跟着 DSH 主进程，
// 正常退出由 ctx.effect 的 cleanup 收尾，硬杀由进程树兜底。
import net from 'node:net';

const MODULE = 'file:///C:/dsh-qq/qq-bridge/plugins/qq-agent/lib/autostart.js';
const TTS_DIR = 'C:\\dsh-qq\\dafiyu-voice';
const PORT = 3210;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? `  — ${extra}` : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? `  — ${extra}` : ''}`); }
};

function isPortOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; socket.destroy(); resolve(v); } };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitReady(timeoutSec = 200) {
  for (let i = 0; i < timeoutSec; i += 1) {
    if (await isPortOpen(PORT)) return true;
    await sleep(1000);
  }
  return false;
}

const m = await import(MODULE);
console.log('## 模块导出');
ok(typeof m.ensureDafiyuTts === 'function' && typeof m.stopDafiyuTtsOwned === 'function', '导出 ensureDafiyuTts / stopDafiyuTtsOwned');

console.log('## 0) 冷启动');
const started = await m.ensureDafiyuTts({ dir: TTS_DIR, port: PORT });
ok(started?.ok === true, 'ensureDafiyuTts 返回 ok', JSON.stringify(started));
ok(await waitReady(), '端口在限时内就绪');

console.log('## 1) 已在运行时重复拉起');
const again = await m.ensureDafiyuTts({ dir: TTS_DIR, port: PORT });
ok(again?.ok === true && ['already-running', 'starting'].includes(again?.reason), '重复调用不拉第二份', JSON.stringify(again));

console.log('## 2) DSH 退出路径：stopDafiyuTtsOwned');
m.stopDafiyuTtsOwned(TTS_DIR, PORT);
await sleep(3000);
ok(!(await isPortOpen(PORT)), '端口已释放（进程被停）');

console.log('## 3) 停止后重新接管');
const re = await m.ensureDafiyuTts({ dir: TTS_DIR, port: PORT });
ok(re?.ok === true && ['started', 'starting'].includes(re?.reason), '能重新拉起', JSON.stringify(re));
ok(await waitReady(), '重新拉起后端口就绪');
if (await isPortOpen(PORT)) {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()).catch(() => null);
  ok(res?.ok === true, '/health 返回 ok', JSON.stringify(res));
}

console.log(fail === 0 ? `\n结果：${pass} 通过，0 失败` : `\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
