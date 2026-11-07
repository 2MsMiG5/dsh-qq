"""小葱参考音体检：时长/声道/响度/静音/BGM 嫌疑/削波/频段分布。

用法: python tools/xiaocong_probe.py <mp3 或 wav>
只读，不改文件。
"""
import sys

import numpy as np
import soundfile as sf


def db(x):
    return 20 * np.log10(max(float(x), 1e-12))


def main(path):
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    if x.ndim > 1:
        lr = x
        x = x.mean(axis=1)
        corr = float(np.corrcoef(lr[:, 0], lr[:, 1])[0, 1])
        ch = lr.shape[1]
    else:
        corr, ch = 1.0, 1

    dur = len(x) / sr
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))

    # 20ms 帧能量
    win = int(sr * 0.02)
    n = len(x) // win
    fr = x[: n * win].reshape(n, win).astype(np.float64)
    frms = np.sqrt(np.mean(fr ** 2, axis=1))
    fdb = 20 * np.log10(np.maximum(frms, 1e-12))
    silence = float(np.mean(frms < 10 ** (-45 / 20)))

    # 停顿底噪：最安静 10% 帧的均值
    noise_floor = float(np.percentile(fdb, 10))

    # 频谱能量分布，判断有没有持续低频（BGM 的鼓/贝斯）
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    total = float(np.sum(spec ** 2)) or 1e-12
    bands = [(20, 150), (150, 400), (400, 2000), (2000, 6000), (6000, 12000), (12000, sr / 2)]
    print(f"file        : {path}")
    print(f"duration    : {dur:.2f}s   sr={sr}  channels={ch}  L/R corr={corr:.3f}")
    print(f"peak        : {db(peak):.1f} dBFS   rms={db(rms):.1f} dBFS")
    print(f"silence<45dB: {silence*100:.0f}%   p10 floor={noise_floor:.1f} dBFS")
    print(f"clipping    : {float(np.mean(np.abs(x) > 0.999))*100:.3f}% samples at full scale")
    print("band energy :")
    for lo, hi in bands:
        if lo >= sr / 2:
            continue
        m = (freqs >= lo) & (freqs < hi)
        e = float(np.sum(spec[m] ** 2)) / total
        print(f"  {lo:5d}-{int(min(hi, sr/2)):5d} Hz : {e*100:6.2f}%")
    # 有声段起止，方便裁切
    thr = 10 ** (-45 / 20)
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx):
        print(f"voiced span : {idx[0]/sr:.2f}s -> {idx[-1]/sr:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
