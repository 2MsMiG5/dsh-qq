// tts.js — 本地 TTS 服务的合成、缓存轮转与「[语音]」标记解析。
//
// 为什么单独成文件：这些函数全部围绕一个 `tc`（语音配置）入参自包含，不碰
// bot / handles / 仿真状态机。留在 boot 里时，测试想验证「合成结果不是音频头
// 就拒发」这条防线，只能把整段源码抠出来 eval。
//
// 状态归属：无。缓存目录由 tc 传入，本模块不持有任何可变状态。
//
// ⚠️ `fetch` 是**可替换能力**，必须走 bind 而不是用全局：
//   审计 harness 往 VM 里注入了记录型假 fetch（用它断言发出去的段内容、模拟
//   "TTS 服务挂了"）。模块里直接调全局 fetch 会绕过那个注入点 —— 测试以为自己在
//   打桩，实际打的是真网络（假绿，且离线必挂）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeJoinLibrary } from '../voice-core.js';

export function createVoiceTts() {
  let fetch;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ fetch } = deps);
  }

  /**
   * 识别「[语音]…」标记：只认整条消息最前面的标记，标记后面的内容就是要说的话。
   * 全角「［语音］」也接受（模型偶尔会打全角括号）；英文 `[voice]` 作为等价写法一并认。
   * 都是为了「标记写歪了就漏判、最后把标记当文字发进群」这类事故。
   */
  function voiceMarkerText(tc, msg) {
    // 模型偶尔会把整条消息包在引号里（"「[语音]晚安」"），引号本身不该影响标记识别。
    const raw = String(msg ?? '').trim().replace(/^["'“”「『（(]+/, '').trim();
    if (!raw) return null;
    const marker = tc.marker;
    const variants = [marker, marker.replace(/^\[/, '［').replace(/\]$/, '］'), '[voice]', '[VOICE]'];
    for (const m of variants) {
      if (!m || !raw.startsWith(m)) continue;
      const text = raw.slice(m.length)
        .replace(/^[\s:：，。]+/, '')
        .replace(/[\s:：，。]+$/, '')
        .replace(/["'“”‘’「」『』（）)]+$/g, '')
        .trim();
      return text || null;
    }
    return null;
  }

  function pruneTtsCache(tc) {
    try {
      const files = fs.readdirSync(tc.cacheDir)
        .filter((n) => n.startsWith('tts-') && n.endsWith('.wav'))
        .map((n) => ({ name: n, path: path.join(tc.cacheDir, n), mtimeMs: fs.statSync(path.join(tc.cacheDir, n)).mtimeMs }));
      if (files.length <= tc.keepFiles) return;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of files.slice(0, files.length - tc.keepFiles)) {
        try { fs.unlinkSync(f.path); } catch {}
      }
    } catch {}
  }

  /**
   * 调本地 TTS 服务合成一句音频，落到 .tts 缓存目录，返回文件路径。
   * 服务契约：POST {baseUrl}/tts  JSON {text, format:"wav", voice:"<音色 id>"} → 200 音频字节。
   * 只接受真正的音频字节（RIFF/ID3/MP3/OggS 头），防止服务异常时把 JSON 错误页当音频发出去。
   */
  async function synthesizeVoiceFile(text, tc) {
    let res;
    try {
      res = await fetch(`${tc.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, format: 'wav', voice: tc.voice }),
        signal: AbortSignal.timeout(tc.timeoutMs)
      });
    } catch (error) {
      throw new Error(`本地语音合成服务不可用（${tc.baseUrl}，检查 TTS 服务是否已启动）：${error?.message ?? error}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`语音合成失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('语音合成返回空音频');
    const head = buf.subarray(0, 4).toString('latin1');
    if (head !== 'RIFF' && head !== 'OggS' && head !== 'ID3' && head.charCodeAt(0) !== 0xff) {
      throw new Error('语音合成返回的不是可识别音频（不支持 wav/mp3/ogg）');
    }
    fs.mkdirSync(tc.cacheDir, { recursive: true });
    const file = path.join(tc.cacheDir, `tts-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`);
    fs.writeFileSync(file, buf);
    pruneTtsCache(tc);
    return { file, bytes: buf.length };
  }

  /**
   * 调 TTS 服务的 JSON 接口（控制台列音色 / 切换音色用）。
   * 返回 { ok, body, status, error }，不抛异常——控制台面板要能显示"服务没开"而不是 500。
   */
  async function ttsServiceJson(tc, method, pathname, payload) {
    // 「连不上」和「连上了但响应形状不对」必须分开报。
    //
    // 旧实现把 fetch / res.json / 读 body.s 全包在同一个 try 里，于是**任何**形状问题
    // 都会被 catch 改写成「连不上本地 TTS 服务」。实测（2026-10-27）：服务在 3210 上
    // 200 正常返回扁平 { ok: true, voices: [...] }，而这里读的是 body.s.ok ——
    // TypeError 被当成离线，控制台三个音色接口（列/切/试听）全部 502「连不上」。
    // 排查方向完全被带偏，所以这里按错误性质拆开。
    let res;
    try {
      res = await fetch(`${tc.baseUrl}${pathname}`, {
        method,
        headers: payload ? { 'content-type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(Math.min(tc.timeoutMs, 30000))
      });
    } catch (error) {
      return { ok: false, status: 0, error: `连不上本地 TTS 服务（${tc.baseUrl}）：${error?.message ?? error}` };
    }
    const raw = await res.json().catch(() => null);
    // 成功响应是扁平的 { ok: true, ... }（/health、/voices 实测如此）；
    // 早期版本用 { s: { ok } } 包一层，两种都认，并把 body 归一成扁平形状给调用方。
    const wrapped = raw && typeof raw === 'object' && raw.s && typeof raw.s === 'object' ? raw.s : null;
    const body = wrapped ?? (raw && typeof raw === 'object' ? raw : {});
    const okFlag = typeof body.ok === 'boolean' ? body.ok : undefined;
    if (!res.ok || okFlag === false) {
      const detail = body.error ?? null;
      return {
        ok: false,
        status: res.status,
        error: detail || (res.ok ? `TTS 服务返回 ok:false（${pathname}）` : `TTS 服务返回 HTTP ${res.status}`)
      };
    }
    return { ok: true, status: res.status, body };
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  return { bind, ttsServiceJson, synthesizeVoiceFile, voiceMarkerText, pruneTtsCache, voicePathInsideLibrary };
}
