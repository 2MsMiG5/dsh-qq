"""用「独立锚」评估音色：锚取自长素材里未被用作参考音的段落。

为什么需要它：比较两个参考音时，各自算「输出 vs 自己那条参考音」是不公平的——
参考音越长越接近真值，自评分自然更高。这里把锚固定在素材中**其它**人声段上，
所有候选都在同一把尺子上量。

用法: python tools/eval_anchor.py <长音频> <目录1> [目录2 ...]
目录里约定有 cold/proud/tsun/soft.wav
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

ROOT = r"C:\dsh-qq\dafiyu-voice"
sys.path.insert(0, os.path.join(ROOT, "index-tts"))
import torch  # noqa: E402
import torchaudio  # noqa: E402
from indextts.s2mel.modules.campplus.DTDNN import CAMPPlus  # noqa: E402

CAMPP = os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "campplus", "campplus_cn_common.bin")
# 高位簇里除 630.60（被选作新参考音）之外的段落，覆盖音频不同时间点
ANCHOR_SEGS = [(622.32, 5.0), (585.38, 5.0), (492.86, 5.0), (391.66, 5.0), (312.48, 5.0)]
TAGS = ["cold", "proud", "tsun", "soft"]


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


def emb(x, sr, model):
    x = resample(np.asarray(x, dtype=np.float32), sr, 16000)
    t = torch.from_numpy(x).unsqueeze(0)
    feat = torchaudio.compliance.kaldi.fbank(t, num_mel_bins=80, dither=0, sample_frequency=16000)
    feat = feat - feat.mean(dim=0, keepdim=True)
    with torch.no_grad():
        e = model(feat.unsqueeze(0))[0]
    return (e / e.norm()).numpy()


def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def main(long_path, dirs):
    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(CAMPP, map_location="cpu"))
    model.eval()

    sr_file = sf.info(long_path).samplerate
    embs = []
    for start, dur in ANCHOR_SEGS:
        x, sr = sf.read(long_path, start=int(start * sr_file), frames=int(dur * sr_file),
                        dtype="float32", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        embs.append(emb(x, sr, model))
    anchor = np.mean(embs, axis=0)
    anchor /= np.linalg.norm(anchor)
    # 锚内部一致性：这些段彼此够像，锚才算可信
    pairs = [cos(embs[i], embs[j]) for i in range(len(embs)) for j in range(i + 1, len(embs))]
    print(f"锚: {len(ANCHOR_SEGS)} 段，内部两两 cosine min={min(pairs):.3f} avg={sum(pairs)/len(pairs):.3f}")
    print(f"{'候选':<22}{'cold':>7}{'proud':>7}{'tsun':>7}{'soft':>7}{'平均':>8}")
    summary = {}
    for d in dirs:
        vals = []
        cells = []
        for t in TAGS:
            p = os.path.join(d, t + ".wav")
            if not os.path.isfile(p):
                cells.append("  -  ")
                continue
            x, sr = sf.read(p, dtype="float32", always_2d=False)
            if x.ndim > 1:
                x = x.mean(axis=1)
            v = cos(anchor, emb(x, sr, model))
            vals.append(v)
            cells.append(f"{v:7.3f}")
        if vals:
            avg = sum(vals) / len(vals)
            summary[d] = avg
            print(f"{os.path.basename(d):<22}{''.join(cells)}{avg:8.3f}")
    if summary:
        best = max(summary, key=summary.get)
        print(f"\n更接近本人: {os.path.basename(best)}（{summary[best]:.3f}）")
    out = os.path.join(ROOT, "tmp", "xiaocong_anchor_eval.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({os.path.basename(k): v for k, v in summary.items()}, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
