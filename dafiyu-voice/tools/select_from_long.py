"""长素材选段：用已有的小葱参考音做「锚」，在同一个人里挑最好的段落。

为什么要锚：14 分钟素材可能混了多个说话人（剧情对话/PV）。
CAMPPlus 的 speaker embedding 能把「同一个人」聚出来，锚点直接给出
「这段到底是不是她」的相似度，比纯聚类少一步人工判断。

用法: python tools/select_from_long.py <音频> <probe.json> [锚wav]
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
MAX_REF = 10.0        # 参考音超过这个长度没有额外收益，只增加条件噪声
MIN_REF = 4.0


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


def main(path, probe_json, anchor_wav):
    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(CAMPP, map_location="cpu"))
    model.eval()

    ax, asr = sf.read(anchor_wav, dtype="float32", always_2d=False)
    if ax.ndim > 1:
        ax = ax.mean(axis=1)
    anchor = emb(ax, asr, model)
    print(f"锚点: {os.path.basename(anchor_wav)} ({len(ax)/asr:.2f}s)")

    with open(probe_json, encoding="utf-8") as f:
        segs = json.load(f)["segs"]
    sr_file = sf.info(path).samplerate

    # 只挑够长的段：短段拼不出 4s 以上参考音
    cands = [s for s in segs if s["dur"] >= MIN_REF]
    print(f"候选段 {len(cands)} 个（>= {MIN_REF}s）\n")

    rows = []
    for s in cands:
        dur = min(s["dur"], MAX_REF)
        x, sr = sf.read(path, start=int(s["start"] * sr_file), frames=int(dur * sr_file),
                        dtype="float32", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        e = emb(x, sr, model)
        # 段内静音比：数字静音的字间隙不算问题，但大面积空白会稀释条件
        win = int(sr * 0.02)
        n = len(x) // win
        fr = x[: n * win].reshape(n, win).astype(np.float64)
        fdb = 20 * np.log10(np.maximum(np.sqrt(np.mean(fr ** 2, axis=1)), 1e-12))
        rows.append(dict(start=s["start"], end=s["end"], dur=round(dur, 2),
                         sim=cos(anchor, e), silence=float(np.mean(fdb < -45)),
                         rms=s["rms"], e=e))

    rows.sort(key=lambda r: -r["sim"])
    print(f"{'start':>8} {'dur':>5} {'与锚相似':>9} {'静音%':>6} {'rms':>7}")
    for r in rows[:12]:
        print(f"{r['start']:8.2f} {r['dur']:5.2f} {r['sim']:9.3f} {r['silence']*100:6.0f} {r['rms']:7.1f}")

    # 同人判定：和锚的相似度分布
    sims = np.array([r["sim"] for r in rows])
    print(f"\n相似度分布: max={sims.max():.3f} p90={np.percentile(sims,90):.3f} "
          f"median={np.median(sims):.3f} min={sims.min():.3f}")
    same = [r for r in rows if r["sim"] >= np.percentile(sims, 80)]
    print(f"高位簇（前 20%）{len(same)} 段，均值 {np.mean([r['sim'] for r in same]):.3f}")

    # 簇内两两一致性：高位簇如果彼此也很像，说明确实是同一个人的多段语音
    embs = [r["e"] for r in same[:12]]
    pairs = [cos(embs[i], embs[j]) for i in range(len(embs)) for j in range(i + 1, len(embs))]
    if pairs:
        print(f"高位簇内两两 cosine: min={min(pairs):.3f} avg={sum(pairs)/len(pairs):.3f} max={max(pairs):.3f}")

    out = os.path.join(ROOT, "tmp", "xiaocong_long_cands.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump([{k: v for k, v in r.items() if k != "e"} for r in rows[:20]], f,
                  ensure_ascii=False, indent=1)
    print(f"\n前 20 名已写入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2],
                  sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, "ref", "voices", "xiaocong", "ref.wav")))
