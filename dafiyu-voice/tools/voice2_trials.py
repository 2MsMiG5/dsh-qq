"""Task B: synthesise 3 sentences with each candidate reference, measure objective
quality and speaker similarity (CAMPPlus cosine between reference and output).
"""
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np
import soundfile as sf

ROOT = r"C:\dsh-qq\dafiyu-voice"
OUT = os.path.join(ROOT, "out")
WORK = os.path.join(ROOT, "tmp", "incoming")
sys.path.insert(0, os.path.join(ROOT, "index-tts"))

import torch  # noqa: E402
import torchaudio  # noqa: E402
from indextts.s2mel.modules.campplus.DTDNN import CAMPPlus  # noqa: E402

CAMPP = os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "campplus", "campplus_cn_common.bin")
API = "http://127.0.0.1:3210"

SENTS = ["晚上好呀，我是大肥鱼。", "刚才在想你哦。", "别闹啦，快点回来陪我。"]
CANDS = [
    ("cand637", "637.3-648.1s", 10.80),
    ("cand045", "45.5-55.3s", 9.80),
    ("cand250", "250.6-259.0s", 8.40),
]


def post_tts(text, voice):
    body = json.dumps({"text": text, "format": "wav", "voice": voice}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API + "/tts", data=body,
                                 headers={"Content-Type": "application/json", "User-Agent": "tts-trial"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
        ctype = r.headers.get("Content-Type")
    return data, time.time() - t0, ctype


def metrics(x, sr):
    peak = float(np.max(np.abs(x))) or 0.0
    rms = float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))
    win = int(sr * 0.02)
    n = len(x) // win
    fr = x[: n * win].reshape(n, win).astype(np.float64)
    frms = np.sqrt(np.mean(fr ** 2, axis=1))
    db = 20 * np.log10(np.maximum(frms, 1e-12))
    return dict(dur=round(len(x) / sr, 2),
                peak_dbfs=round(20 * math.log10(peak) if peak > 0 else -120, 1),
                rms_dbfs=round(20 * math.log10(rms) if rms > 0 else -120, 1),
                silence=round(float(np.mean(db < -45)), 2),
                active=round(float(np.mean(db > -40)), 2))


def emb_of(x, sr, model):
    if sr != 16000:
        try:
            import soxr
            x = soxr.resample(x, sr, 16000, quality="HQ")
        except Exception:
            from math import gcd
            from scipy.signal import resample_poly
            g = gcd(int(sr), 16000)
            x = resample_poly(x, 16000 // g, int(sr) // g)
        sr = 16000
    t = torch.from_numpy(np.asarray(x, dtype=np.float32)).unsqueeze(0)
    feat = torchaudio.compliance.kaldi.fbank(t, num_mel_bins=80, dither=0, sample_frequency=16000)
    feat = feat - feat.mean(dim=0, keepdim=True)
    with torch.no_grad():
        e = model(feat.unsqueeze(0))[0]
    return (e / e.norm()).numpy()


def concat_wavs(paths, out_path, gap=0.35, sr=24000):
    chunks = []
    for p in paths:
        x, s = sf.read(p, dtype="float32", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        chunks.append(x)
        chunks.append(np.zeros(int(gap * sr), dtype=np.float32))
    y = np.concatenate(chunks[:-1])
    sf.write(out_path, y, sr, subtype="PCM_16")
    return out_path


def main():
    os.makedirs(OUT, exist_ok=True)
    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(CAMPP, map_location="cpu"))
    model.eval()

    # reference embeddings (source segments) and dafiyu reference
    src_emb = {}
    for vid, label, _dur in CANDS:
        x, sr = sf.read(os.path.join(ROOT, "ref", "voices", vid, "ref.wav"), dtype="float32", always_2d=False)
        src_emb[vid] = emb_of(x, sr, model)
    xd, srd = sf.read(os.path.join(ROOT, "ref", "voices", "dafiyu", "ref.wav"), dtype="float32", always_2d=False)
    src_emb["dafiyu"] = emb_of(xd, srd, model)

    report = {"sentences": SENTS, "candidates": []}
    for vid, label, dur in CANDS:
        rows = []
        outs = []
        for i, text in enumerate(SENTS):
            data, dt, ctype = post_tts(text, vid)
            p = os.path.join(OUT, f"voice2-{vid}-s{i+1}.wav")
            with open(p, "wb") as f:
                f.write(data)
            x, sr = sf.read(p, dtype="float32", always_2d=False)
            if x.ndim > 1:
                x = x.mean(axis=1)
            m = metrics(x, sr)
            e = emb_of(x, sr, model)
            sims = {k: round(float(np.dot(e, v)), 3) for k, v in src_emb.items()}
            rows.append(dict(sentence=text, file=p, ctype=ctype, latency=round(dt, 2), sr=sr, **m, sim=sims))
            outs.append(p)
            print(f"{vid} s{i+1}: {m['dur']}s lat={dt:.2f}s rms={m['rms_dbfs']} sim_self={sims[vid]} sim_dafiyu={sims['dafiyu']}", flush=True)
        combo = concat_wavs(outs, os.path.join(OUT, f"voice2-{vid}.wav"))
        xc, src = sf.read(combo, dtype="float32", always_2d=False)
        mc = metrics(xc, src)
        ec = emb_of(xc, src, model)
        sims_c = {k: round(float(np.dot(ec, v)), 3) for k, v in src_emb.items()}
        report["candidates"].append(dict(id=vid, label=label, ref_dur=dur, per_sentence=rows,
                                         combined=combo, combined_metrics=mc, combined_sim=sims_c))
        print(f"  -> combined {combo} {mc['dur']}s sim_self={sims_c[vid]}", flush=True)

    # cross similarity between the three references themselves
    ids = [c[0] for c in CANDS]
    print("\n=== reference-vs-reference cosine ===")
    for i in ids:
        print(i, {j: round(float(np.dot(src_emb[i], src_emb[j])), 3) for j in ids + ["dafiyu"]})
    report["ref_cosine"] = {i: {j: round(float(np.dot(src_emb[i], src_emb[j])), 3)
                                for j in ids + ["dafiyu"]} for i in ids}

    with open(os.path.join(WORK, "voice2_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\nsaved", os.path.join(WORK, "voice2_report.json"))


if __name__ == "__main__":
    main()
