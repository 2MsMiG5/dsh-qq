// 把任意 PCM WAV 规整成 DSH SenseVoice 服务要求的「canonical 16 kHz mono PCM16 WAV」。
//
// 为什么需要这个模块：
//   SnowLuma 的 OneBot `get_record out_format=wav` 会把 QQ 语音（amr/silk/mp3…）
//   转成 WAV，但采样率随来源而定（实测 QQ 语音多是 24 kHz 单声道 PCM16）。
//   DSH 的 speech-to-text API（speech/transcribe）只接受 **16 kHz 单声道 PCM16 WAV**，
//   差一个条件都会直接报 transcription-failed。所以这里负责：解析 WAV → 混音为单声道 →
//   重采样到 16 kHz → 写出标准 PCM16 WAV。
//
// 纯 Node 实现、零依赖：解析只认 PCM（int8/16/24/32、float32、WAVE_FORMAT_EXTENSIBLE），
// 重采样用窗函数 sinc（Kaiser）FIR，对语音转写足够干净，且 120 秒内一次转换 < 1s。
import fs from 'node:fs';

const RIFF = 'RIFF';
const WAVE = 'WAVE';
const FMT = 'fmt ';
const DATA = 'data';

function readU16(buf, off) { return buf.readUInt16LE(off); }
function readU32(buf, off) { return buf.readUInt32LE(off); }

/**
 * 解析 WAV 头，返回结构信息与原始样本（Float32，多声道保持原样）。
 * @param {Buffer} buf
 * @returns {{ok:true, audioFormat:number, channels:number, sampleRate:number, bitsPerSample:number, dataOffset:number, dataLength:number, samples:Float32Array, durationSeconds:number}|{ok:false,error:string}}
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return { ok: false, error: '音频不是有效的 WAV（太短）' };
  if (buf.toString('ascii', 0, 4) !== RIFF || buf.toString('ascii', 8, 12) !== WAVE) {
    return { ok: false, error: '音频不是有效的 WAV（缺少 RIFF/WAVE 标记）' };
  }
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = readU32(buf, off + 4);
    const body = off + 8;
    if (id === FMT) {
      fmt = { offset: body, size };
    } else if (id === DATA) {
      data = { offset: body, size };
      break;
    }
    // chunk 按偶数边界对齐；0 大小防死循环
    const step = 8 + size + (size % 2);
    if (step <= 0) break;
    off += step;
  }
  if (!fmt) return { ok: false, error: 'WAV 缺少 fmt 块' };
  if (!data) return { ok: false, error: 'WAV 缺少 data 块' };

  const f = fmt.offset;
  let audioFormat = readU16(buf, f);
  const channels = readU16(buf, f + 2);
  const sampleRate = readU32(buf, f + 4);
  let bitsPerSample = readU16(buf, f + 14);
  // WAVE_FORMAT_EXTENSIBLE：真正的格式在 SubFormat GUID 的前 2 字节
  if (audioFormat === 0xFFFE && fmt.size >= 40) {
    audioFormat = readU16(buf, f + 24);
  }
  const bytesPerSample = Math.max(1, bitsPerSample / 8);
  const dataLength = Math.min(data.size, buf.length - data.offset);
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));

  if (![1, 3].includes(audioFormat)) return { ok: false, error: `不支持的 WAV 编码格式 audioFormat=${audioFormat}` };
  if (channels < 1 || channels > 8) return { ok: false, error: `不支持的声道数 ${channels}` };
  if (!(sampleRate > 0 && sampleRate <= 192000)) return { ok: false, error: `采样率异常 ${sampleRate}` };
  if (frameCount <= 0) return { ok: false, error: 'WAV 没有可解码的音频数据' };

  const samples = new Float32Array(frameCount * channels);
  const d = data.offset;
  if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < frameCount * channels; i++) samples[i] = buf.readFloatLE(d + i * 4);
  } else if (bitsPerSample === 16) {
    for (let i = 0; i < frameCount * channels; i++) samples[i] = buf.readInt16LE(d + i * 2) / 32768;
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < frameCount * channels; i++) samples[i] = (buf[d + i] - 128) / 128;
  } else if (bitsPerSample === 24) {
    for (let i = 0; i < frameCount * channels; i++) {
      const b = d + i * 3;
      let v = buf[b] | (buf[b + 1] << 8) | (buf[b + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      samples[i] = v / 8388608;
    }
  } else if (bitsPerSample === 32 && audioFormat === 1) {
    for (let i = 0; i < frameCount * channels; i++) samples[i] = buf.readInt32LE(d + i * 4) / 2147483648;
  } else {
    return { ok: false, error: `不支持的位深 bitsPerSample=${bitsPerSample}` };
  }

  return {
    ok: true,
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    dataOffset: data.offset,
    dataLength,
    samples,
    durationSeconds: frameCount / sampleRate,
  };
}

/** Kaiser 窗（beta 默认 8，旁瓣约 -80dB）。 */
function kaiserWindow(x, beta) {
  const ax = Math.abs(x);
  if (ax >= 1) return 0;
  const t = beta * Math.sqrt(1 - ax * ax);
  // 近似 I0：用级数展开，精度足够
  let sum = 1;
  let term = 1;
  for (let k = 1; k <= 32; k++) {
    term *= (t * t) / (4 * k * k);
    sum += term;
    if (term < 1e-12) break;
  }
  const i0t = sum;
  // I0(beta) 归一化
  let s2 = 1; let t2 = 1;
  const tb = beta;
  for (let k = 1; k <= 32; k++) {
    t2 *= (tb * tb) / (4 * k * k);
    s2 += t2;
    if (t2 < 1e-12) break;
  }
  return i0t / s2;
}

/**
 * 窗函数 sinc 重采样。把 input（任意采样率、已混音为单声道）重采样到 dstRate。
 * @param {Float32Array} input
 * @param {number} srcRate
 * @param {number} dstRate
 * @param {number} tapsPerSide 每侧抽头数（默认 16 → 33 抽头）
 * @returns {Float32Array}
 */
export function resampleSinc(input, srcRate, dstRate, tapsPerSide = 16) {
  const ratio = dstRate / srcRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  // 低通截止（归一化到输入采样率，cycles/sample）
  const fc = 0.5 * Math.min(1, ratio);
  const center = tapsPerSide;
  const M = tapsPerSide * 2;
  const kernel = new Float32Array(M + 1);
  let kernelSum = 0;
  for (let k = 0; k <= M; k++) {
    const t = k - center;
    const win = kaiserWindow(t / tapsPerSide, 8);
    const h = win * (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t));
    kernel[k] = h;
    kernelSum += h;
  }
  if (kernelSum > 0) for (let k = 0; k <= M; k++) kernel[k] /= kernelSum;

  for (let n = 0; n < outLen; n++) {
    const pos = n / ratio;
    const ip = Math.floor(pos);
    let acc = 0;
    for (let k = 0; k <= M; k++) {
      const idx = ip + k - center;
      if (idx >= 0 && idx < input.length) acc += input[idx] * kernel[k];
    }
    out[n] = acc;
  }
  return out;
}

/**
 * 规整成 canonical 16 kHz mono PCM16 WAV。
 * @param {Buffer} input 任意 PCM WAV（可由 SnowLuma get_record 产出）
 * @returns {{ok:true, buffer:Buffer, sourceRate:number, sourceChannels:number, durationSeconds:number, note?:string}|{ok:false,error:string}}
 */
export function toCanonicalWav16k(input) {
  const parsed = parseWav(input);
  if (!parsed.ok) return parsed;
  const { channels, sampleRate, samples, durationSeconds } = parsed;

  // 已经符合条件 → 原样返回（必须是 16-bit PCM；8bit/24bit/float 也要走重编码）
  if (sampleRate === 16000 && channels === 1 && parsed.bitsPerSample === 16) {
    return { ok: true, buffer: input, sourceRate: sampleRate, sourceChannels: channels, durationSeconds, note: '已是 16kHz 单声道' };
  }

  // 混音为单声道
  let mono;
  if (channels === 1) {
    mono = samples;
  } else {
    const frames = samples.length / channels;
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
      mono[i] = sum / channels;
    }
  }

  // 重采样（16k 输入时不用重采样，只混音）
  let resampled = mono;
  if (sampleRate !== 16000) {
    resampled = resampleSinc(mono, sampleRate, 16000);
  }

  // 写 canonical WAV：PCM16 单声道 16kHz
  const pcm = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    let v = Math.round(resampled[i] * 32768);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    pcm[i] = v;
  }
  const dataSize = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, 44);

  const note = [sampleRate !== 16000 ? `${sampleRate}Hz→16kHz` : '', channels !== 1 ? `${channels}声道→单声道` : ''].filter(Boolean).join('，');
  return { ok: true, buffer, sourceRate: sampleRate, sourceChannels: channels, durationSeconds, note: note || '已转码' };
}

/** 读文件 → 规整（供测试/CLI 用）。 */
export function canonicalWavFromFile(filePath) {
  try {
    const input = fs.readFileSync(filePath);
    return toCanonicalWav16k(input);
  } catch (error) {
    return { ok: false, error: `读取文件失败：${error?.message ?? error}` };
  }
}
