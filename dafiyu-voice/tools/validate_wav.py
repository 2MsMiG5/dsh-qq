"""Validate TTS output wavs: duration, peak/RMS dBFS, silence ratio, basic speech sanity."""
import glob
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

ROOT = r"C:\dsh-qq\dafiyu-voice"


def analyse(path):
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    dur = len(x) / sr
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if len(x) else 0.0
    db_peak = 20 * math.log10(peak) if peak > 0 else -120.0
    db_rms = 20 * math.log10(rms) if rms > 0 else -120.0
    win = int(sr * 0.02)
    if len(x) >= win > 0:
        n = len(x) // win
        frames = x[: n * win].reshape(n, win).astype(np.float64)
        frms = np.sqrt(np.mean(frames ** 2, axis=1))
        dbf = 20 * np.log10(np.maximum(frms, 1e-12))
        silence_ratio = float(np.mean(dbf < -45))
        # fraction of 20ms frames with speech-level energy
        active_ratio = float(np.mean(dbf > -40))
    else:
        silence_ratio = 1.0
        active_ratio = 0.0
    # zero crossing rate (rough voicing proxy) and spectral centroid
    zcr = float(np.mean(np.abs(np.diff(np.signbit(x).astype(np.int8))))) if len(x) > 1 else 0.0
    if len(x) > 1024:
        spec = np.abs(np.fft.rfft(x[: min(len(x), sr * 5)] * np.hanning(min(len(x), sr * 5))))
        freqs = np.fft.rfftfreq(min(len(x), sr * 5), 1.0 / sr)
        centroid = float(np.sum(freqs * spec) / max(np.sum(spec), 1e-9))
    else:
        centroid = 0.0
    return {
        "file": os.path.basename(path),
        "sr": sr,
        "duration_s": round(dur, 2),
        "peak_dbfs": round(db_peak, 1),
        "rms_dbfs": round(db_rms, 1),
        "silence_ratio": round(silence_ratio, 2),
        "active_ratio": round(active_ratio, 2),
        "zcr": round(zcr, 3),
        "spectral_centroid_hz": round(centroid, 0),
        "verdict": "OK" if (dur > 0.5 and db_peak > -12 and db_rms > -32 and active_ratio > 0.25) else "SUSPECT",
    }


def main():
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "out", "*.wav"))) + \
        sorted(glob.glob(os.path.join(ROOT, "ref", "*.wav")))
    rows = [analyse(f) for f in files if os.path.isfile(f)]
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    bad = [r for r in rows if r["verdict"] != "OK"]
    print(f"\n{len(rows)} files, {len(bad)} suspect", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
