"""Analyse candidate segments of incoming-voice.mp3:
metrics (loudness/silence/centroid/L-R correlation/low-band ratio) + CAMPPlus speaker
embeddings + pairwise cosine, so we can tell same-speaker from multi-speaker material.
"""
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

ROOT = r"C:\dsh-qq\dafiyu-voice"
MP3 = os.path.join(ROOT, "incoming-voice.mp3")
WORK = os.path.join(ROOT, "tmp", "incoming")
os.makedirs(WORK, exist_ok=True)
sys.path.insert(0, os.path.join(ROOT, "index-tts"))

import torch  # noqa: E402
import torchaudio  # noqa: E402

CAMPP = os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "campplus", "campplus_cn_common.bin")

# (start, end) seconds, from lead's silencedetect pass
RANGES = [
    (637.3, 648.1),
    (308.8, 319.6),
    (148.8, 159.2),
    (600.6, 610.6),
    (45.5, 55.3),
    (545.3, 554.3),
    (1138.2, 1147.0),
    (250.6, 259.0),
    (30.0, 38.1),
    (474.3, 482.4),
]


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


def metrics(x, sr):
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if len(x) else 0.0
    db_p = 20 * math.log10(peak) if peak > 0 else -120
    db_r = 20 * math.log10(rms) if rms > 0 else -120
    win = int(sr * 0.02)
    n = len(x) // win
    frames = x[: n * win].reshape(n, win).astype(np.float64)
    frms = np.sqrt(np.mean(frames ** 2, axis=1))
    dbf = 20 * np.log10(np.maximum(frms, 1e-12))
    silence = float(np.mean(dbf < -45))
    active = float(np.mean(dbf > -40))
    # spectral stats on the loudest 5s
    seg = x[: min(len(x), sr * 5)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    centroid = float(np.sum(freqs * spec) / max(np.sum(spec), 1e-9))
    tot = float(np.sum(spec ** 2)) or 1e-9
    low = float(np.sum(spec[freqs < 150] ** 2) / tot)
    flat = float(np.exp(np.mean(np.log(spec + 1e-9))) / max(np.mean(spec), 1e-9))
    zcr = float(np.mean(np.abs(np.diff(np.signbit(seg).astype(np.int8)))))
    return dict(dur=len(x) / sr, peak_dbfs=round(db_p, 1), rms_dbfs=round(db_r, 1),
                silence=round(silence, 2), active=round(active, 2),
                centroid=round(centroid), low_ratio=round(low, 3), flatness=round(flat, 4),
                zcr=round(zcr, 3))


def lr_corr(stereo, sr):
    """Channel correlation: speech (often centered) -> high; wide BGM -> low."""
    if stereo.shape[1] < 2:
        return None
    a = stereo[:, 0].astype(np.float64)
    b = stereo[:, 1].astype(np.float64)
    if a.std() < 1e-6 or b.std() < 1e-6:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def main():
    from indextts.s2mel.modules.campplus.DTDNN import CAMPPlus

    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(CAMPP, map_location="cpu"))
    model.eval()

    rows = []
    embs = []
    for i, (a, b) in enumerate(RANGES):
        with sf.SoundFile(MP3) as f:
            sr = f.samplerate
            f.seek(int(a * sr))
            stereo = f.read(int((b - a) * sr), dtype="float32", always_2d=True)
        mono = stereo.mean(axis=1)
        corr = lr_corr(stereo, sr)
        x24 = resample(mono, sr, 24000)
        # trim leading/trailing silence (-45 dBFS)
        thr = 10 ** (-45 / 20)
        idx = np.where(np.abs(x24) > thr)[0]
        if len(idx) > 0:
            s = max(0, idx[0] - int(0.05 * 24000))
            e = min(len(x24), idx[-1] + int(0.12 * 24000))
            x24t = x24[s:e]
        else:
            x24t = x24
        # loudness normalise to about -18 dBFS RMS (peak-limited)
        rms = float(np.sqrt(np.mean(x24t.astype(np.float64) ** 2))) or 1.0
        target = 10 ** (-18 / 20)
        gain = target / rms
        peak = float(np.max(np.abs(x24t))) or 1.0
        if peak * gain > 10 ** (-1 / 20):
            gain = 10 ** (-1 / 20) / peak
        x24n = np.clip(x24t * gain, -1.0, 1.0)
        out = os.path.join(WORK, f"cand_{i}_{a:.1f}-{b:.1f}.wav")
        sf.write(out, x24n, 24000, subtype="PCM_16")
        m = metrics(x24n, 24000)
        m.update(idx=i, start=a, end=b, file=out, lr_corr=round(corr, 3) if corr is not None else None,
                 raw_dur=round(len(mono) / sr, 2))
        rows.append(m)

        x16 = resample(mono, sr, 16000)
        t = torch.from_numpy(x16.astype(np.float32)).unsqueeze(0)
        feat = torchaudio.compliance.kaldi.fbank(t, num_mel_bins=80, dither=0, sample_frequency=16000)
        feat = feat - feat.mean(dim=0, keepdim=True)
        with torch.no_grad():
            emb = model(feat.unsqueeze(0))[0]
        embs.append(emb / emb.norm())
        print(f"[{i}] {a:.1f}-{b:.1f}s dur={m['dur']:.2f}s rms={m['rms_dbfs']:.1f} "
              f"sil={m['silence']*100:.0f}% centroid={m['centroid']}Hz low={m['low_ratio']:.3f} "
              f"lr={m['lr_corr']}", flush=True)

    E = torch.stack(embs)
    sim = (E @ E.T).numpy()
    print("\n=== CAMPPlus cosine similarity ===")
    hdr = "     " + " ".join(f"{i:6d}" for i in range(len(rows)))
    print(hdr)
    for i in range(len(rows)):
        print(f"{i:4d} " + " ".join(f"{sim[i][j]:6.3f}" for j in range(len(rows))))

    off = sim[np.triu_indices(len(rows), 1)]
    print(f"\npairwise cosine: min={off.min():.3f} mean={off.mean():.3f} max={off.max():.3f}")

    with open(os.path.join(WORK, "analysis.json"), "w", encoding="utf-8") as f:
        json.dump({"segments": rows, "cosine": sim.tolist()}, f, ensure_ascii=False, indent=2)
    print("\nsaved", os.path.join(WORK, "analysis.json"))


if __name__ == "__main__":
    main()
