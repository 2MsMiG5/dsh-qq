"""小葱音色验收：合成几句台词，算 speaker embedding 相似度。

两个指标：
  1. ref_vs_out：参考音与每条合成输出的 cosine。低于 0.7 说明音色跑偏，
     0.8+ 属于可接受，0.85+ 算好用。
  2. out_vs_out：几条输出之间两两 cosine。看音色稳不稳定——
     同一句话换不同文本，音色如果忽高忽低，说明参考音条件太散。

用法: python tools/xiaocong_trial.py [voice_id]
"""
import json
import os
import sys
import time
import urllib.request

import numpy as np
import soundfile as sf

ROOT = r"C:\dsh-qq\dafiyu-voice"
OUT = os.path.join(ROOT, "out", "xiaocong")
API = "http://127.0.0.1:3210"

sys.path.insert(0, os.path.join(ROOT, "index-tts"))
import torch  # noqa: E402
import torchaudio  # noqa: E402
from indextts.s2mel.modules.campplus.DTDNN import CAMPPlus  # noqa: E402

CAMPP = os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "campplus", "campplus_cn_common.bin")

# 覆盖不同语气：冷淡 / 强硬 / 别扭 / 疑惑。别只用一种腔调，否则测不出稳定性。
SENTS = [
    ("cold", "……谁准你随便叫我的名字了。"),
    ("proud", "本小姐出手，当然是最优解。"),
    ("tsun", "哼，才不是特意来帮你的。"),
    ("soft", "别盯着看，很没礼貌。"),
]


def post_tts(text, voice):
    body = json.dumps({"text": text, "format": "wav", "voice": voice}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API + "/tts", data=body,
                                 headers={"Content-Type": "application/json", "User-Agent": "xiaocong-trial"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read(), time.time() - t0


def load_model():
    m = CAMPPlus(feat_dim=80, embedding_size=192)
    m.load_state_dict(torch.load(CAMPP, map_location="cpu"))
    m.eval()
    return m


def emb(x, sr, model):
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


def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def main(voice, outdir="xiaocong"):
    OUT = os.path.join(ROOT, "out", outdir)
    os.makedirs(OUT, exist_ok=True)
    model = load_model()

    ref_path = os.path.join(ROOT, "ref", "voices", voice, "ref.wav")
    rx, rsr = sf.read(ref_path, dtype="float32", always_2d=False)
    if rx.ndim > 1:
        rx = rx.mean(axis=1)
    ref_e = emb(rx, rsr, model)

    rows = []
    for tag, text in SENTS:
        wav, secs = post_tts(text, voice)
        p = os.path.join(OUT, f"{tag}.wav")
        with open(p, "wb") as f:
            f.write(wav)
        x, sr = sf.read(p, dtype="float32", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        e = emb(x, sr, model)
        rows.append(dict(tag=tag, text=text, path=p, sim=cos(ref_e, e),
                         dur=round(len(x) / sr, 2), secs=round(secs, 1), emb=e))
        print(f"[{tag:5s}] {secs:5.1f}s  合成 {len(x)/sr:4.1f}s  与本人相似度 {rows[-1]['sim']:.3f}  {text}")

    embs = [r["emb"] for r in rows]
    pairs = [cos(embs[i], embs[j]) for i in range(len(embs)) for j in range(i + 1, len(embs))]
    avg = float(np.mean([r["sim"] for r in rows]))
    print(f"\n平均（参考 vs 输出）: {avg:.3f}")
    print(f"输出间两两 cosine   : min={min(pairs):.3f} avg={sum(pairs)/len(pairs):.3f} max={max(pairs):.3f}")
    verdict = "很好" if avg >= 0.85 else ("可用" if avg >= 0.78 else ("勉强" if avg >= 0.70 else "跑偏，需换参考音"))
    print(f"结论: {verdict}")
    print(f"试听目录: {OUT}")
    return 0 if avg >= 0.78 else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "xiaocong",
                  sys.argv[2] if len(sys.argv) > 2 else "xiaocong"))
