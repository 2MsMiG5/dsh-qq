"""Download IndexTTS-2 weights from ModelScope mirrors.

ModelScope direct resolve URL works at ~4-5 MB/s from this host.
HuggingFace is blocked, hf-mirror.com is unreliable -> only ModelScope.
"""
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = r"C:\dsh-qq\dafiyu-voice"
MS = "https://modelscope.cn/models/{repo}/resolve/master/{path}"

# repo -> destination dir, list of files
JOBS = [
    (
        "IndexTeam/IndexTTS-2",
        os.path.join(ROOT, "models", "IndexTTS-2"),
        [
            "config.yaml",
            "bpe.model",
            "feat1.pt",
            "feat2.pt",
            "wav2vec2bert_stats.pt",
            "gpt.pth",
            "s2mel.pth",
        ],
    ),
    (
        "IndexTeam/IndexTTS-2",
        os.path.join(ROOT, "models", "IndexTTS-2", "qwen0.6bemo4-merge"),
        [
            "qwen0.6bemo4-merge/Modelfile",
            "qwen0.6bemo4-merge/added_tokens.json",
            "qwen0.6bemo4-merge/chat_template.jinja",
            "qwen0.6bemo4-merge/config.json",
            "qwen0.6bemo4-merge/generation_config.json",
            "qwen0.6bemo4-merge/merges.txt",
            "qwen0.6bemo4-merge/model.safetensors",
            "qwen0.6bemo4-merge/special_tokens_map.json",
            "qwen0.6bemo4-merge/tokenizer.json",
            "qwen0.6bemo4-merge/tokenizer_config.json",
            "qwen0.6bemo4-merge/vocab.json",
        ],
    ),
]

# aux models (mirrors of the HF repos the code expects), all on ModelScope
AUX = [
    (
        "AI-ModelScope/w2v-bert-2.0",
        os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "w2v-bert-2.0"),
        [
            "config.json",
            "preprocessor_config.json",
            "model.safetensors",
        ],
    ),
    (
        "amphion/MaskGCT",
        os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "maskgct_semantic"),
        ["semantic_codec/model.safetensors"],
    ),
    (
        "iic/speech_campplus_sv_zh-cn_16k-common",
        os.path.join(ROOT, "models", "IndexTTS-2", "hf_cache", "campplus"),
        ["campplus_cn_common.bin"],
    ),
]


def size_of(path):
    return os.path.getsize(path) if os.path.isfile(path) else -1


def download(repo, dest_dir, path, expected=None):
    print(f">> downloading {repo}/{path}", flush=True)
    # strip leading dir component that duplicates dest (e.g. qwen0.6bemo4-merge/)
    rel = path
    for prefix in ("qwen0.6bemo4-merge/", "semantic_codec/"):
        if rel.startswith(prefix) and dest_dir.endswith(prefix.rstrip("/")):
            rel = rel[len(prefix):]
    out = os.path.join(dest_dir, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    url = MS.format(repo=repo, path=path)
    tmp = out + ".part"
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                done = 0
                last = time.time()
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if time.time() - last > 15:
                        rate = done / max(1e-9, time.time() - last)
                        print(f"   {os.path.basename(out)} {done/1e6:.0f}/{total/1e6:.0f} MB", flush=True)
                        last = time.time()
            os.replace(tmp, out)
            print(f">> OK {out} {os.path.getsize(out)/1e6:.1f} MB", flush=True)
            return out, True, size_of(out)
        except Exception as e:  # noqa: BLE001
            print(f">> retry {attempt+1} {path}: {e}", flush=True)
            time.sleep(3)
    return out, False, -1


def main():
    jobs = []
    for repo, dest, files in JOBS:
        for f in files:
            jobs.append((repo, dest, f))
    for repo, dest, files in AUX:
        for f in files:
            jobs.append((repo, dest, f))

    # small files first for a quick sanity check, then big ones in parallel
    jobs.sort(key=lambda j: 0 if j[2] in (
        "config.yaml", "bpe.model", "wav2vec2bert_stats.pt", "feat1.pt", "feat2.pt",
        "campplus_cn_common.bin", "config.json", "preprocessor_config.json") else 1)

    results = []
    t0 = time.time()
    # 4 parallel streams; ModelScope per-connection is fast but total BW limited
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(download, *j) for j in jobs]
        for fu in as_completed(futs):
            results.append(fu.result())
            print(f"   [{time.time()-t0:.0f}s] {sum(1 for r in results if r[1])}/{len(jobs)} done", flush=True)

    bad = [r for r in results if not r[1]]
    total = sum(max(0, r[2]) for r in results)
    print(f"DONE ok={len(results)-len(bad)}/{len(results)} total={total/1e9:.2f} GB in {time.time()-t0:.0f}s")
    for b in bad:
        print("FAILED", b[0])


if __name__ == "__main__":
    main()
