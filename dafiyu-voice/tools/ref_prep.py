"""Pick 4-8s clean clips from samples/, convert to 24kHz mono wav into ref/."""
import array
import glob
import math
import os
import sys

import numpy as np
import soundfile as sf

ROOT = r"C:\dsh-qq\dafiyu-voice"
SAMPLES = os.path.join(ROOT, "samples")
REF = os.path.join(ROOT, "ref")
TARGET_SR = 24000

CANDIDATES = ["tts_003", "tts_013", "tts_038", "tts_048", "tts_001", "tts_007", "tts_011",
              "tts_023", "tts_026", "tts_034", "tts_040", "tts_044", "tts_047", "tts_055",
              "tts_057", "tts_065", "tts_070", "tts_071", "tts_072", "tts_073"]


def stats(x, sr):
    d = len(x) / sr
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if len(x) else 0.0
    db_peak = 20 * math.log10(peak) if peak > 0 else -120
    db_rms = 20 * math.log10(rms) if rms > 0 else -120
    # silence ratio: frames of 20ms whose rms < -45 dBFS
    win = int(sr * 0.02)
    if win <= 0 or len(x) < win:
        sil = 0.0
    else:
        n = len(x) // win
        frames = x[: n * win].reshape(n, win).astype(np.float64)
        frms = np.sqrt(np.mean(frames ** 2, axis=1))
        sil = float(np.mean(frms < 10 ** (-45 / 20)))
    return d, db_peak, db_rms, sil


def main():
    os.makedirs(REF, exist_ok=True)
    rows = []
    for name in CANDIDATES:
        p = os.path.join(SAMPLES, name + ".mp3")
        if not os.path.isfile(p):
            continue
        x, sr = sf.read(p, dtype="float32", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        d, pk, rms, sil = stats(x, sr)
        rows.append((name, sr, d, pk, rms, sil))
        print(f"{name}: sr={sr} dur={d:.2f}s peak={pk:.1f}dBFS rms={rms:.1f}dBFS silence={sil*100:.0f}%")

    # rank: prefer 4.0-7.5s, low silence, healthy rms
    def score(r):
        name, sr, d, pk, rms, sil = r
        s = 0.0
        s -= abs(d - 5.5) * 0.35
        s -= sil * 6.0
        s -= abs(rms + 18.0) * 0.6
        if d < 3.8 or d > 8.0:
            s -= 10
        return -s

    rows.sort(key=lambda r: -score(r))
    print("\nranked:")
    for r in rows[:10]:
        print(f"  {r[0]} dur={r[2]:.2f}s rms={r[4]:.1f}dBFS sil={r[5]*100:.0f}%")

    # Fixed, human-vetted picks (per brief: tts_003 / tts_013 / tts_038 / tts_048 family).
    # primary = longest clean one; extras kept as alternates for A/B on quality.
    WANT = ["tts_048", "tts_003", "tts_013", "tts_026"]
    by_name = {r[0]: r for r in rows}
    picked = [by_name[n] for n in WANT if n in by_name]

    for i, r in enumerate(picked):
        name = r[0]
        p = os.path.join(SAMPLES, name + ".mp3")
        x, sr = sf.read(p, dtype="float32", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        # resample to 24k (linear is fine for 24k->24k; use soxr if available)
        if sr != TARGET_SR:
            try:
                import soxr
                x = soxr.resample(x, sr, TARGET_SR, quality="HQ")
            except Exception:
                # polyphase fallback via scipy
                from math import gcd
                from scipy.signal import resample_poly
                g = gcd(int(sr), TARGET_SR)
                x = resample_poly(x, TARGET_SR // g, int(sr) // g)
        # trim leading/trailing silence to keep the clip dense
        thr = 10 ** (-45 / 20)
        idx = np.where(np.abs(x) > thr)[0]
        if len(idx) > 0:
            a = max(0, idx[0] - int(0.03 * TARGET_SR))
            b = min(len(x), idx[-1] + int(0.08 * TARGET_SR))
            x = x[a:b]
        x = np.clip(x, -1.0, 1.0)
        # normalize peak to -1 dBFS
        peak = float(np.max(np.abs(x))) or 1.0
        x = x * (10 ** (-1 / 20) / peak)
        out = os.path.join(REF, f"dafiyu_ref_{i+1}.wav")
        sf.write(out, x.astype(np.float32), TARGET_SR, subtype="PCM_16")
        d, pk, rms, sil = stats(x.astype(np.float32), TARGET_SR)
        print(f"wrote {out} dur={d:.2f}s peak={pk:.1f}dBFS rms={rms:.1f}dBFS silence={sil*100:.0f}%")

    # primary reference = first picked
    if picked:
        import shutil
        shutil.copyfile(os.path.join(REF, "dafiyu_ref_1.wav"), os.path.join(REF, "dafiyu_ref.wav"))
        print("primary ref ->", os.path.join(REF, "dafiyu_ref.wav"))


if __name__ == "__main__":
    main()
