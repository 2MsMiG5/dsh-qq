"""Load IndexTTS-2, report timing/VRAM, and synthesize a few sample lines."""
import os
import sys
import time

os.environ.setdefault("MPLCONFIGDIR", r"C:\dsh-qq\dafiyu-voice\tmp\mpl")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

ROOT = r"C:\dsh-qq\dafiyu-voice"
sys.path.insert(0, os.path.join(ROOT, "index-tts"))
MODEL_DIR = os.path.join(ROOT, "models", "IndexTTS-2")
REF = os.path.join(ROOT, "ref", "dafiyu_ref.wav")
OUT = os.path.join(ROOT, "out")
os.makedirs(OUT, exist_ok=True)
os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)

LINES = sys.argv[1:] or [
    "晚上好呀，我是大肥鱼。",
    "刚才在想你哦。",
    "别闹啦，快点回来陪我。",
    "今天也要开开心心的呀。",
]

import torch  # noqa: E402

print("torch", torch.__version__, "cuda", torch.cuda.is_available(), flush=True)
if torch.cuda.is_available():
    free, total = torch.cuda.mem_get_info()
    print("VRAM free %.0f MB / total %.0f MB" % (free / 2**20, total / 2**20), flush=True)

from indextts.infer_v2 import IndexTTS2  # noqa: E402

aux_paths = {
    "w2v_bert": os.path.join(MODEL_DIR, "hf_cache", "w2v-bert-2.0"),
    "semantic_codec": os.path.join(MODEL_DIR, "hf_cache", "maskgct_semantic", "semantic_codec", "model.safetensors"),
    "campplus": os.path.join(MODEL_DIR, "hf_cache", "campplus", "campplus_cn_common.bin"),
    "bigvgan": os.path.join(MODEL_DIR, "hf_cache", "bigvgan"),
}

t0 = time.time()
tts = IndexTTS2(
    cfg_path=os.path.join(MODEL_DIR, "config.yaml"),
    model_dir=MODEL_DIR,
    use_fp16=True,
    device="cuda",
    use_cuda_kernel=False,
    use_deepspeed=False,
    use_qwen_emo=False,
    aux_paths=aux_paths,
)
load_s = time.time() - t0
torch.cuda.synchronize()
peak = torch.cuda.max_memory_allocated() / 2**20
print("LOADED in %.1fs, peak VRAM %.0f MB" % (load_s, peak), flush=True)
free, total = torch.cuda.mem_get_info()
print("VRAM free now %.0f MB" % (free / 2**20), flush=True)

for i, line in enumerate(LINES):
    out = os.path.join(OUT, f"sample_{i+1}.wav")
    t = time.time()
    tts.infer(REF, line, out)
    dt = time.time() - t
    size = os.path.getsize(out) if os.path.isfile(out) else -1
    print("SYNTH %d chars=%d %.2fs -> %s (%d bytes)" % (i + 1, len(line), dt, out, size), flush=True)

torch.cuda.synchronize()
print("PEAK VRAM total %.0f MB" % (torch.cuda.max_memory_allocated() / 2**20), flush=True)
print("DONE")
