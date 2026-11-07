"""VRAM helpers for running IndexTTS-2 on an 8 GB laptop GPU shared with other apps."""
import os


def put_semantic_on_cpu(tts):
    """Move the 2.3 GB w2v-bert-2.0 feature extractor to CPU.

    It is only used once per reference clip (the result is cached), so running it
    on CPU costs ~1-2 s once while freeing ~2.3 GB of VRAM - which is the
    difference between usable and WDDM-paging-into-system-RAM on this box.
    """
    import torch

    tts.semantic_model = tts.semantic_model.to("cpu").float()
    tts.semantic_mean = tts.semantic_mean.detach().cpu().float()
    tts.semantic_std = tts.semantic_std.detach().cpu().float()

    def get_emb(input_features, attention_mask):
        with torch.no_grad():
            vq = tts.semantic_model(
                input_features=input_features.to("cpu").float(),
                attention_mask=attention_mask.to("cpu"),
                output_hidden_states=True,
            )
            feat = vq.hidden_states[17]
            feat = (feat - tts.semantic_mean) / tts.semantic_std
            return feat.to(tts.device)

    tts.get_emb = get_emb
    _free()


def _free():
    import gc

    import torch

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


def vram_report(tag=""):
    import torch

    if not torch.cuda.is_available():
        return
    free, total = torch.cuda.mem_get_info()
    alloc = torch.cuda.memory_allocated() / 2**20
    peak = torch.cuda.max_memory_allocated() / 2**20
    print(
        "[vram%s] alloc=%.0fMB peak=%.0fMB free=%.0fMB total=%.0fMB"
        % (tag, alloc, peak, free / 2**20, total / 2**20),
        flush=True,
    )


def optimize(tts, semantic_on_cpu=None):
    """Apply VRAM optimizations; semantic_on_cpu defaults to env TTS_SEMANTIC_GPU!=1."""
    if semantic_on_cpu is None:
        semantic_on_cpu = os.environ.get("TTS_SEMANTIC_GPU", "0") != "1"
    if semantic_on_cpu:
        put_semantic_on_cpu(tts)
        print(">> semantic model (w2v-bert) moved to CPU to save ~2.3GB VRAM", flush=True)
    _free()
    vram_report(" after-optimize")
