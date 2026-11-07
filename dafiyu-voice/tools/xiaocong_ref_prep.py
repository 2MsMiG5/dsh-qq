"""把小葱的原始语音做成 IndexTTS 参考音。

源素材只有 8.8s、实际语音约 4.8s，中间被一个 1.44s 的大停顿劈成两半。
直接整段喂进去条件太散，所以：
  1. 裁掉首尾静音（保留 0.15s 余量，避免切掉字头）；
  2. 超过 0.5s 的停顿压到 0.30~0.40s（保留呼吸感的自然断句，不硬切）；
  3. 拼缝处 20ms 交叉淡化，防止波形不连续产生爆音；
  4. 峰值归一到 -1 dBFS，重采样 24kHz，单声道 PCM16。

用法: python tools/xiaocong_ref_prep.py <输入mp3> <输出wav> [保留停顿秒数]

保留停顿传 0 表示完全不动原始停顿（只裁首尾），适合做对照组。
"""
import sys

import numpy as np
import soundfile as sf

TARGET_SR = 24000
FRAME = 0.02          # 能量分析帧长（秒）
SIL_DB = -45.0        # 低于这个视为静音
MAX_GAP = 0.50        # 超过这个长度的停顿才压
GAP_KEEP = 0.34       # 压缩后保留的停顿长度
HEAD_PAD = 0.15       # 首尾保留的静音余量
TAIL_PAD = 0.25
XFADE = 0.02          # 拼缝交叉淡化长度（秒）
PEAK_DB = -1.0


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


def frame_db(x, sr):
    win = int(sr * FRAME)
    n = len(x) // win
    fr = x[: n * win].reshape(n, win).astype(np.float64)
    rms = np.sqrt(np.mean(fr ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-12)), win


def voiced_segments(x, sr):
    """返回 [(kind, start_sample, end_sample)]，kind 为 'v' / 'g'。"""
    dbf, win = frame_db(x, sr)
    mask = dbf >= SIL_DB
    segs = []
    cur, start = bool(mask[0]), 0
    for i in range(1, len(mask)):
        if bool(mask[i]) != cur:
            segs.append((cur, start * win, i * win))
            cur, start = bool(mask[i]), i
    segs.append((cur, start * win, min(len(x), len(mask) * win)))
    return segs


def main(src, dst, gap_keep=None):
    if gap_keep is not None:
        global GAP_KEEP, MAX_GAP
        if gap_keep <= 0:
            # 对照组：不压停顿，只裁首尾
            MAX_GAP = float("inf")
        else:
            GAP_KEEP = gap_keep
    x, sr = sf.read(src, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)

    segs = voiced_segments(x, sr)
    # 只保留「第一段有声」到「最后一段有声」，其余首尾静音丢掉
    v_idx = [i for i, s in enumerate(segs) if s[0]]
    first, last = v_idx[0], v_idx[-1]
    body = segs[first:last + 1]

    xf = int(XFADE * sr)
    pieces = []
    for i, (voiced, a, b) in enumerate(body):
        if voiced:
            pieces.append(x[a:b])
            continue
        gap_sec = (b - a) / sr
        keep = gap_sec if gap_sec <= MAX_GAP else GAP_KEEP
        keep = max(keep, XFADE * 2)          # 太短会和淡化冲突
        keep_n = int(keep * sr)
        # 从停顿中点取，两侧对称，听感上更像一次自然换气
        mid = (a + b) // 2
        s = max(a, mid - keep_n // 2)
        pieces.append(x[s:s + keep_n])

    # 逐段拼接，接缝做线性交叉淡化
    out = np.zeros(0, dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, xf, dtype=np.float32)
    for p in pieces:
        if len(out) == 0:
            out = p.copy()
            continue
        n = min(xf, len(out), len(p))
        if n < 4:
            out = np.concatenate([out, p])
            continue
        r = np.linspace(0.0, 1.0, n, dtype=np.float32)
        tail = out[-n:] * (1 - r) + p[:n] * r
        out = np.concatenate([out[:-n], tail, p[n:]])

    # 首尾补一点静音，给模型一个明确的起止边界
    out = np.concatenate([
        np.zeros(int(HEAD_PAD * sr), dtype=np.float32), out,
        np.zeros(int(TAIL_PAD * sr), dtype=np.float32),
    ])

    out = resample(out, sr, TARGET_SR)
    out = np.clip(out, -1.0, 1.0)
    peak = float(np.max(np.abs(out))) or 1.0
    out = out * (10 ** (PEAK_DB / 20) / peak)

    sf.write(dst, out.astype(np.float32), TARGET_SR, subtype="PCM_16")

    dbf, win = frame_db(out, TARGET_SR)
    sil = float(np.mean(dbf < SIL_DB))
    print(f"wrote {dst}")
    print(f"  dur={len(out)/TARGET_SR:.2f}s  sr={TARGET_SR}  peak={PEAK_DB}dBFS  "
          f"silence={sil*100:.0f}%  speech={len(out)/TARGET_SR*(1-sil):.2f}s")
    return 0


if __name__ == "__main__":
    gap = float(sys.argv[3]) if len(sys.argv) > 3 else None
    sys.exit(main(sys.argv[1], sys.argv[2], gap))
