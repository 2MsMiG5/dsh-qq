// TTS 服务契约自检：健康检查 + 合成 3 句 + 保存 wav 到 out/ + 用 ffmpeg 量时长/音量。
// 用法：node test-service.mjs [baseUrl]
// 说明：这是「桥接侧视角」的测试 —— 桥接只认 POST /tts 返回 200 + 真音频字节。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const OUT = path.join(ROOT, 'out');
const FFMPEG = process.env.FFMPEG_PATH || 'C:\\Program Files\\Krita (x64)\\bin\\ffmpeg.exe';
const TEXTS = [
  '晚上好呀，我是大肥鱼。',
  '刚才在想你哦。',
  '别闹啦，快点回来陪我。'
];

let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  ✅ ${name}${extra ? `  — ${extra}` : ''}`);
  else { fail += 1; console.error(`  ❌ ${name}${extra ? `  — ${extra}` : ''}`); }
};

fs.mkdirSync(OUT, { recursive: true });

console.log(`## 健康检查 ${BASE}/health`);
try {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => null);
  ok(res.ok && body?.ok === true, 'GET /health 返回 ok', JSON.stringify(body).slice(0, 160));
} catch (error) {
  ok(false, 'GET /health 可达', error?.message ?? String(error));
  process.exit(1);
}

for (let i = 0; i < TEXTS.length; i += 1) {
  const text = TEXTS[i];
  console.log(`## 合成 ${i + 1}/${TEXTS.length}「${text}」`);
  const t0 = Date.now();
  let buf;
  try {
    const res = await fetch(`${BASE}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, format: 'wav' }),
      signal: AbortSignal.timeout(300000)
    });
    ok(res.ok, `HTTP ${res.status}`);
    ok(String(res.headers.get('content-type') || '').includes('audio'), 'Content-Type 是音频', res.headers.get('content-type') || '');
    buf = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    ok(false, 'POST /tts 可达', error?.message ?? String(error));
    continue;
  }
  const head = buf.subarray(0, 4).toString('latin1');
  ok(['RIFF', 'OggS', 'ID3'].includes(head) || head.charCodeAt(0) === 0xff, '返回真音频字节', head);
  const file = path.join(OUT, `test-${i + 1}.wav`);
  fs.writeFileSync(file, buf);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ok(buf.length > 20000, '音频不是空壳', `${(buf.length / 1024).toFixed(0)} KB，耗时 ${elapsed}s`);
  if (fs.existsSync(FFMPEG)) {
    const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
    const info = String(probe.stderr || '');
    const dur = (info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/) || []).slice(1);
    const seconds = dur.length ? Number(dur[0]) * 3600 + Number(dur[1]) * 60 + Number(dur[2]) : null;
    ok(seconds != null && seconds > 0.3, '时长可解析', seconds != null ? `${seconds.toFixed(2)}s` : 'n/a');
    const vol = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' });
    const mean = /mean_volume: (-?[\d.]+) dB/.exec(String(vol.stderr || ''));
    ok(mean && Number(mean[1]) > -45, '不是静音', mean ? `mean ${mean[1]} dB` : 'n/a');
  }
  console.log(`  → ${file}`);
}

console.log(fail === 0 ? '\n全部通过：TTS 服务符合桥接契约。' : `\n有 ${fail} 项失败。`);
process.exit(fail === 0 ? 0 : 1);
