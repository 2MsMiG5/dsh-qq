"""长音频结构普查：切语音段、算每段指标，为挑参考音做准备。

不整段做 FFT（14 分钟会把内存吃掉），改成按块读 + 分段算指标。
用法: python tools/long_probe.py <音频> [--json 输出路径]
"""
import json
import sys

import numpy as np
import soundfile as sf

FRAME = 0.02
SIL_DB = -40.0
MIN_SPEECH = 1.2      # 短于此的有声段当噪声丢掉
MERGE_GAP = 0.80      # 字间隙/换气也低于阈值，小于这个的窟窿要补上，否则一句话会被剁成碎片


def db(x):
    return 20 * np.log10(max(float(x), 1e-12))


def frame_energy(x, sr):
    win = int(sr * FRAME)
    n = len(x) // win
    fr = x[: n * win].reshape(n, win).astype(np.float64)
    rms = np.sqrt(np.mean(fr ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-12)), win


def segments(mask, win, min_frames):
    out = []
    cur, start = bool(mask[0]), 0
    for i in range(1, len(mask)):
        if bool(mask[i]) != cur:
            out.append((cur, start * win, i * win))
            cur, start = bool(mask[i]), i
    out.append((cur, start * win, len(mask) * win))

    voiced = [(a, b) for v, a, b in out if v]
    # 合并间隔小于 MERGE_GAP 的有声段：干净素材的字间隙是数字静音，
    # 不补窟窿的话一句话会被拆成十几个 0.2s 的碎片。
    merged = []
    for a, b in voiced:
        if merged and a - merged[-1][1] <= MERGE_GAP * win / FRAME:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return [(a, b) for a, b in merged if (b - a) >= min_frames * win]


def metrics(x, sr):
    peak = float(np.max(np.abs(x))) or 1e-9
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    # 低频占比：有 BGM 的话鼓/贝斯会在这带堆能量
    seg = x[: min(len(x), sr * 8)] * np.hanning(min(len(x), sr * 8))
    spec = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    tot = float(np.sum(spec ** 2)) or 1e-12
    low = float(np.sum(spec[(freqs >= 20) & (freqs < 150)] ** 2)) / tot
    return dict(dur=round(len(x) / sr, 2), peak=round(db(peak), 1), rms=round(db(rms), 1),
                low_ratio=round(low * 100, 2))


def main(path):
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    corr = 1.0
    if x.ndim > 1:
        corr = float(np.corrcoef(x[:, 0], x[:, 1])[0, 1])
        x = x.mean(axis=1)
    print(f"sr={sr} channels={'stereo' if corr != 1.0 else 'mono-ish'} L/R_corr={corr:.3f} dur={len(x)/sr:.1f}s")

    dbf, win = frame_energy(x, sr)
    silence = float(np.mean(dbf < SIL_DB))
    print(f"整体: 静音帧 {silence*100:.0f}%  p10={np.percentile(dbf,10):.1f}dB  p90={np.percentile(dbf,90):.1f}dB")

    segs = segments(dbf >= SIL_DB, win, int(MIN_SPEECH / FRAME))
    print(f"语音段: {len(segs)} 段，累计 {sum(b-a for a,b in segs)/sr:.1f}s")

    rows = []
    for a, b in segs:
        m = metrics(x[a:b], sr)
        m["start"] = round(a / sr, 2)
        m["end"] = round(b / sr, 2)
        rows.append(m)

    rows.sort(key=lambda r: -r["dur"])
    print("\n最长的 15 段:")
    print(f"{'start':>8} {'end':>8} {'dur':>6} {'rms':>7} {'peak':>7} {'低频%':>6}")
    for r in rows[:15]:
        print(f"{r['start']:8.2f} {r['end']:8.2f} {r['dur']:6.2f} {r['rms']:7.1f} {r['peak']:7.1f} {r['low_ratio']:6.2f}")

    low_all = float(np.mean([r["low_ratio"] for r in rows])) if rows else 0.0
    print(f"\n语音段平均低频占比: {low_all:.2f}%  "
          f"({'可能有 BGM/底噪' if low_all > 3 else '基本干净，无持续低频伴奏'})")

    out = dict(sr=sr, corr=corr, total=round(len(x) / sr, 2), silence=silence, segs=rows)
    p = path.rsplit(".", 1)[0] + "-probe.json"
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n明细已写入 {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
