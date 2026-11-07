import os, sys, time
os.environ.setdefault("MPLCONFIGDIR", r"C:\dsh-qq\dafiyu-voice\tmp\mpl")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
ROOT = r"C:\dsh-qq\dafiyu-voice"
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "index-tts"))
import torch
from engine_utils import optimize, vram_report
from indextts.infer_v2 import IndexTTS2
MODEL_DIR = os.path.join(ROOT, "models", "IndexTTS-2")
aux = {
    "w2v_bert": os.path.join(MODEL_DIR, "hf_cache", "w2v-bert-2.0"),
    "semantic_codec": os.path.join(MODEL_DIR, "hf_cache", "maskgct_semantic", "semantic_codec", "model.safetensors"),
    "campplus": os.path.join(MODEL_DIR, "hf_cache", "campplus", "campplus_cn_common.bin"),
    "bigvgan": os.path.join(MODEL_DIR, "hf_cache", "bigvgan"),
}
t0 = time.time()
tts = IndexTTS2(cfg_path=os.path.join(MODEL_DIR, "config.yaml"), model_dir=MODEL_DIR,
                use_fp16=True, device="cuda", use_cuda_kernel=False, use_deepspeed=False,
                use_qwen_emo=False, aux_paths=aux)
print("LOAD %.1fs" % (time.time()-t0), flush=True)
vram_report(" loaded")
optimize(tts)
os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
for i, line in enumerate(["你好呀。", "晚上好呀，我是大肥鱼。"]):
    out = os.path.join(ROOT, "out", "probe_%d.wav" % i)
    t = time.time()
    tts.infer(os.path.join(ROOT, "ref", "dafiyu_ref.wav"), line, out)
    print("SYNTH %.2fs -> %s %d bytes" % (time.time()-t, out, os.path.getsize(out) if os.path.isfile(out) else -1), flush=True)
    vram_report(" after-synth")
