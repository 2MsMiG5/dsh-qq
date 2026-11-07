"""从长素材里提取参考音：取指定段 → 裁首尾静音 → 归一化 → 24k 单声道。

与 xiaocong_ref_prep 的区别：那份要处理「碎片+大停顿」的重排，
这份素材本身是连续语流，重排只会平白制造拼缝，所以只做裁切和归一化。

用法:
  python tools/extract_ref.py <音频> <输出wav> --start 630.60 --dur 9.74
  python tools/extract_ref.py <音频> <输出wav> --segs 630.60:4,622.32:4   # 多段拼接
"""
import argparse
import sys

import numpy as np
import soundfile as sf

TARGET_SR = 24000
PEAK_DB = -1.0
HEAD_PAD = 0.10
TAIL_PAD = 0.20
SIL_DB = -45.0
XFADE = 0.03


def resample(x, sr_in, sr_out):
    if sr_in == sr_out:
        return x
    try:
        import soxr
        return soxr.resample(x, sr_in, sr_out, quality="HQ")
    except Exception:
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(int(sr_in), int(sr_out))
        return resample_poly(x, sr_out // g, sr_in // g)


def trim(x, sr):
    thr = 10 ** (-45 / 20)
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(0.05 * sr))
    b = min(len(x), idx[-1] + int(0.10 * sr))
    return x[a:b]


def grab(path, start, dur, sr_file):
    x, sr = sf.read(path, start=int(start * sr_file), frames=int(dur * sr_file),
                    dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return trim(x, sr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--start", type=float)
    ap.add_argument("--dur", type=float)
    ap.add_argument("--segs", default="")   # 形如 "630.6:4,622.32:4"
    args = ap.parse_args()

    sr_file = sf.info(args.src).samplerate
    if args.segs:
        pieces = []
        for item in args.segs.split(","):
            s, d = item.split(":")
            pieces.append(grab(args.src, float(s), float(d), sr_file))
        out = np.zeros(0, dtype=np.float32)
        n = int(XFADE * sr_file)
        for p in pieces:
            if len(out) == 0:
                out = p.copy()
                continue
            k = min(n, len(out), len(p))
            r = np.linspace(0, 1, k, dtype=np.float32)
            out = np.concatenate([out[:-k], out[-k:] * (1 - r) + p[:k] * r, p[k:]])
        x = out
    else:
        if args.start is None or args.dur is None:
            print("需要 --start/--dur 或 --segs")
            return 2
        x = grab(args.src, args.start, args.dur, sr_file)

    x = resample(x, sr_file, TARGET_SR)
    x = np.concatenate([np.zeros(int(HEAD_PAD * TARGET_SR), dtype=np.float32), x,
                        np.zeros(int(TAIL_PAD * TARGET_SR), dtype=np.float32)])
    x = np.clip(x, -1.0, 1.0)
    peak = float(np.max(np.abs(x))) or 1.0
    x = x * (10 ** (PEAK_DB / 20) / peak)
    sf.write(args.dst, x.astype(np.float32), TARGET_SR, subtype="PCM_16")

    win = int(TARGET_SR * 0.02)
    n = len(x) // win
    fr = x[: n * win].reshape(n, win).astype(np.float64)
    fdb = 20 * np.log10(np.maximum(np.sqrt(np.mean(fr ** 2, axis=1)), 1e-12))
    sil = float(np.mean(fdb < SIL_DB))
    print(f"wrote {args.dst}  dur={len(x)/TARGET_SR:.2f}s  silence={sil*100:.0f}%  "
          f"speech={len(x)/TARGET_SR*(1-sil):.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
