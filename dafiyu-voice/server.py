#!/usr/bin/env python
"""dafiyu zero-shot TTS local HTTP service (IndexTTS-2), multi-voice.

Endpoints
  GET  /health  -> {"ok":true,"engine":"IndexTTS-2","voice":"dafiyu","device":"cuda",
                    "current":"dafiyu","voices":2}
  GET  /voices  -> {"ok":true,"current":"dafiyu",
                    "voices":[{"id","name","refSeconds","engine"}, ...]}
  POST /voice   body {"voice":"<id>"} -> {"ok":true,"current":"<id>"}   (persisted)
  POST /tts     body {"text":"...","format":"wav","voice":"<id>"}     -> audio/wav
                    (voice omitted -> current voice)

Voice repo: ref/voices/<id>/ref.wav + meta.json {id,name,source,createdAt,notes,engine}
Current voice: ref/voices/current.json

Run:  env\\Scripts\\python.exe server.py
"""
import argparse
import datetime
import io
import json
import logging
import os
import shutil
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX_TTS_DIR = os.path.join(ROOT, "index-tts")
MODEL_DIR = os.path.join(ROOT, "models", "IndexTTS-2")
REF_DIR = os.path.join(ROOT, "ref")
VOICES_DIR = os.path.join(REF_DIR, "voices")
LEGACY_REF = os.path.join(REF_DIR, "dafiyu_ref.wav")
CURRENT_JSON = os.path.join(VOICES_DIR, "current.json")
TMP_DIR = os.path.join(ROOT, "tmp")
LOG_DIR = os.path.join(ROOT, "logs")

HOST = "127.0.0.1"
PORT = 3210
MAX_CHARS = 200
TARGET_SR = 24000
ENGINE_NAME = "IndexTTS-2"
DEFAULT_VOICE_ID = "dafiyu"
DEFAULT_VOICE_NAME = "大肥鱼"

# IndexTTS2 caches reference-audio conditioning in these attributes; we snapshot
# them per voice so switching voices does not reload the model nor recompute.
CACHE_ATTRS = (
    "cache_spk_cond",
    "cache_s2mel_style",
    "cache_s2mel_prompt",
    "cache_spk_audio_prompt",
    "cache_emo_cond",
    "cache_emo_audio_prompt",
    "cache_mel",
)

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.makedirs(TMP_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)
# matplotlib has no writable home dir on this box -> point its cache somewhere sane
os.environ.setdefault("MPLCONFIGDIR", os.path.join(TMP_DIR, "mpl"))
os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)

log = logging.getLogger("tts")


def setup_logging(level=logging.INFO):
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    root = logging.getLogger()
    root.setLevel(level)
    if not root.handlers:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        root.addHandler(sh)
    fh = logging.FileHandler(os.path.join(LOG_DIR, "server.log"), encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def wav_seconds(path):
    try:
        with wave.open(path, "rb") as w:
            return round(w.getnframes() / float(w.getframerate()), 2)
    except Exception:
        return None


# ---------------------------------------------------------------- voice repo
class VoiceStore:
    """ref/voices/<id>/{ref.wav,meta.json} + current.json"""

    def __init__(self):
        self.lock = threading.RLock()
        self.voices = {}
        self.current = None
        self._migrate_legacy()
        self.reload()

    # -- migration: old single reference -> voices/dafiyu
    def _migrate_legacy(self):
        d = os.path.join(VOICES_DIR, DEFAULT_VOICE_ID)
        ref = os.path.join(d, "ref.wav")
        if os.path.isdir(d) and os.path.isfile(ref):
            return
        if not os.path.isfile(LEGACY_REF):
            return
        os.makedirs(d, exist_ok=True)
        shutil.copyfile(LEGACY_REF, ref)
        meta = {
            "id": DEFAULT_VOICE_ID,
            "name": DEFAULT_VOICE_NAME,
            "source": "samples/tts_048.mp3 (云端 TTS 输出，用户确认的原大肥鱼音色)",
            "createdAt": now_iso(),
            "notes": "初始音色；24kHz 单声道，6.2s，peak -1.0dBFS / rms -18.3dBFS，静音 15%",
            "engine": ENGINE_NAME,
        }
        with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        log.info("migrated legacy reference into voices/%s", DEFAULT_VOICE_ID)

    def reload(self):
        with self.lock:
            voices = {}
            if os.path.isdir(VOICES_DIR):
                for name in sorted(os.listdir(VOICES_DIR)):
                    d = os.path.join(VOICES_DIR, name)
                    ref = os.path.join(d, "ref.wav")
                    if not (os.path.isdir(d) and os.path.isfile(ref)):
                        continue
                    meta = {}
                    mp = os.path.join(d, "meta.json")
                    if os.path.isfile(mp):
                        try:
                            meta = json.load(open(mp, encoding="utf-8"))
                        except Exception:
                            log.warning("bad meta.json in %s", d)
                    meta.setdefault("id", name)
                    meta.setdefault("name", name)
                    meta.setdefault("engine", ENGINE_NAME)
                    meta["ref"] = ref
                    meta["dir"] = d
                    meta["refSeconds"] = wav_seconds(ref)
                    voices[meta["id"]] = meta
            self.voices = voices
            self.current = self._read_current() or (sorted(voices)[0] if voices else None)
            os.makedirs(VOICES_DIR, exist_ok=True)
            if self.current and self.current not in voices:
                self.current = sorted(voices)[0] if voices else None
            return voices

    def _read_current(self):
        try:
            with open(CURRENT_JSON, encoding="utf-8") as f:
                return json.load(f).get("current")
        except Exception:
            return None

    def persist_current(self):
        with self.lock:
            payload = {"current": self.current, "updatedAt": now_iso()}
            tmp = CURRENT_JSON + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp, CURRENT_JSON)

    def get(self, vid=None):
        with self.lock:
            vid = vid or self.current
            return self.voices.get(vid)

    def set_current(self, vid):
        with self.lock:
            if vid not in self.voices:
                raise KeyError(vid)
            self.current = vid
        self.persist_current()
        return vid

    def public_list(self):
        with self.lock:
            out = []
            for vid in sorted(self.voices):
                v = self.voices[vid]
                out.append({
                    "id": v["id"],
                    "name": v.get("name", vid),
                    "refSeconds": v.get("refSeconds"),
                    "engine": v.get("engine", ENGINE_NAME),
                })
            return out


# ---------------------------------------------------------------- engine
class Engine:
    """One IndexTTS-2 instance + serialized inference + per-voice ref cache."""

    def __init__(self, store):
        self.store = store
        self.tts = None
        self.device = "cuda"
        self.lock = threading.Lock()
        self.voice_cache = {}
        self.load_seconds = None
        self.warmup_seconds = None
        self.calls = 0
        self.last_seconds = None
        self.peak_vram_mb = None
        self.boot_seconds = None

    # ---- model lifecycle
    def load(self):
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("torch.cuda.is_available() is False - refusing to start")
        self.device = "cuda"
        log.info("torch %s | CUDA %s | GPU %s", torch.__version__, torch.version.cuda,
                 torch.cuda.get_device_name(0))

        sys.path.insert(0, INDEX_TTS_DIR)
        sys.path.insert(0, ROOT)
        t0 = time.time()
        from indextts.infer_v2 import IndexTTS2
        from engine_utils import optimize

        aux_paths = {
            "w2v_bert": os.path.join(MODEL_DIR, "hf_cache", "w2v-bert-2.0"),
            "semantic_codec": os.path.join(
                MODEL_DIR, "hf_cache", "maskgct_semantic", "semantic_codec", "model.safetensors"
            ),
            "campplus": os.path.join(MODEL_DIR, "hf_cache", "campplus", "campplus_cn_common.bin"),
            "bigvgan": os.path.join(MODEL_DIR, "hf_cache", "bigvgan"),
        }
        for k, p in aux_paths.items():
            if not os.path.exists(p):
                raise FileNotFoundError(f"aux model missing: {k} -> {p}")
        if not self.store.voices:
            raise FileNotFoundError(f"no voices registered under {VOICES_DIR}")

        self.tts = IndexTTS2(
            cfg_path=os.path.join(MODEL_DIR, "config.yaml"),
            model_dir=MODEL_DIR,
            use_fp16=True,
            device="cuda",
            use_cuda_kernel=False,
            use_deepspeed=False,
            use_qwen_emo=False,
            aux_paths=aux_paths,
        )
        self.load_seconds = time.time() - t0
        torch.cuda.synchronize()
        self.peak_vram_mb = round(torch.cuda.max_memory_allocated() / 1024 / 1024)
        log.info("model loaded in %.1fs, torch peak VRAM %.0f MB", self.load_seconds, self.peak_vram_mb)

        # 8GB laptop GPU shared with other apps: move the 2.3GB w2v-bert to CPU,
        # otherwise the driver pages VRAM into system RAM and inference crawls.
        optimize(self.tts)
        torch.cuda.empty_cache()

        # warm-up with the CURRENT voice: first call touches autotune + ref cache
        t1 = time.time()
        try:
            cur = self.store.current
            if cur:
                self._infer("你好呀。", cur)
            self.warmup_seconds = time.time() - t1
            log.info("warmup done in %.2fs (voice=%s)", self.warmup_seconds, cur)
        except Exception:
            log.exception("warmup failed (service still starts)")
        torch.cuda.synchronize()
        self.peak_vram_mb = round(torch.cuda.max_memory_allocated() / 1024 / 1024)
        log.info("torch peak VRAM after warmup %.0f MB", self.peak_vram_mb)

    # ---- per-voice conditioning cache
    def _cache_reset(self):
        self.tts.cache_spk_cond = None
        self.tts.cache_emo_cond = None
        self.tts.cache_spk_audio_prompt = None
        self.tts.cache_emo_audio_prompt = None

    def _apply_voice(self, vid):
        ref = self.store.get(vid)["ref"]
        if self.tts.cache_spk_cond is not None and self.tts.cache_spk_audio_prompt == ref:
            return
        snap = self.voice_cache.get(vid)
        if snap and snap.get("cache_spk_audio_prompt") == ref and snap.get("cache_spk_cond") is not None:
            for k in CACHE_ATTRS:
                setattr(self.tts, k, snap[k])
            log.info("voice %s: reused cached reference conditioning", vid)
        else:
            self._cache_reset()
            log.info("voice %s: reference conditioning will be computed", vid)

    def _snapshot_voice(self, vid):
        self.voice_cache[vid] = {k: getattr(self.tts, k) for k in CACHE_ATTRS}

    # ---- inference
    def _infer(self, text, vid):
        import soundfile as sf

        ref = self.store.get(vid)["ref"]
        self._apply_voice(vid)
        out = os.path.join(TMP_DIR, "tts_%d_%d.wav" % (os.getpid(), int(time.time() * 1000)))
        try:
            self.tts.infer(ref, text, out)
            if not os.path.isfile(out):
                raise RuntimeError("inference produced no output wav")
            with open(out, "rb") as f:
                data = f.read()
            self._snapshot_voice(vid)
            # IndexTTS-2 emits 22.05kHz; the service contract says 24kHz mono PCM16.
            x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
            if x.ndim > 1:
                x = x.mean(axis=1)
            if sr != TARGET_SR:
                try:
                    import soxr
                    x = soxr.resample(x, sr, TARGET_SR, quality="HQ")
                except Exception:
                    from math import gcd
                    from scipy.signal import resample_poly
                    g = gcd(int(sr), TARGET_SR)
                    x = resample_poly(x, TARGET_SR // g, int(sr) // g)
                buf = io.BytesIO()
                sf.write(buf, x, TARGET_SR, format="WAV", subtype="PCM_16")
                data = buf.getvalue()
            return data
        finally:
            if os.path.isfile(out):
                try:
                    os.remove(out)
                except OSError:
                    pass

    def synth(self, text, vid=None):
        import torch

        vid = vid or self.store.current
        if not vid:
            raise RuntimeError("no current voice")
        with self.lock:
            t0 = time.time()
            data = self._infer(text, vid)
            self.last_seconds = time.time() - t0
            self.calls += 1
            if torch.cuda.is_available():
                self.peak_vram_mb = round(torch.cuda.max_memory_allocated() / 1024 / 1024)
            log.info("synth ok voice=%s chars=%d %.2fs bytes=%d", vid, len(text),
                     self.last_seconds, len(data))
            return data

    def switch_voice(self, vid):
        self.store.set_current(vid)
        log.info("current voice -> %s", vid)

        def _warm():
            try:
                with self.lock:
                    if self.store.current != vid:
                        return
                    t = time.time()
                    self._infer("嗯。", vid)
                    log.info("voice %s warmed in %.2fs", vid, time.time() - t)
            except Exception:
                log.exception("voice warm-up failed for %s", vid)

        threading.Thread(target=_warm, name="voice-warm", daemon=True).start()

    def health(self):
        return {
            "ok": True,
            "engine": ENGINE_NAME,
            "voice": self.store.current,
            "device": self.device,
            "current": self.store.current,
            "voices": len(self.store.voices),
        }


# ---------------------------------------------------------------- HTTP
STORE = VoiceStore()
ENGINE = Engine(STORE)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "dafiyu-tts/2.0"

    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, "invalid body"
        if length <= 0 or length > 1 << 20:
            return None, "invalid body"
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return None, "invalid json"
        if not isinstance(payload, dict):
            return None, "invalid json"
        return payload, None

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        if ENGINE.tts is None:
            self._send_json(503, {"ok": False, "error": "model not loaded"})
            return
        if path == "/health":
            self._send_json(200, ENGINE.health())
        elif path == "/voices":
            STORE.reload()  # pick up voices added to ref/voices since startup
            self._send_json(200, {"ok": True, "current": STORE.current, "voices": STORE.public_list()})
        elif path == "/":
            self._send_json(200, {
                "ok": True,
                "service": "dafiyu-tts",
                "endpoints": ["/health", "/voices", "/tts", "/voice"],
            })
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path == "/voice":
            self._handle_voice()
        elif path == "/tts":
            self._handle_tts()
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def _handle_voice(self):
        payload, err = self._read_json()
        if err:
            self._send_json(400, {"ok": False, "error": err})
            return
        vid = payload.get("voice")
        if not isinstance(vid, str) or not vid.strip():
            self._send_json(400, {"ok": False, "error": "missing voice"})
            return
        vid = vid.strip()
        if ENGINE.tts is None:
            self._send_json(503, {"ok": False, "error": "model not loaded"})
            return
        STORE.reload()  # pick up voices added to ref/voices since startup
        try:
            ENGINE.switch_voice(vid)
        except KeyError:
            self._send_json(404, {"ok": False, "error": f"unknown voice: {vid}",
                                  "voices": [v["id"] for v in STORE.public_list()]})
            return
        self._send_json(200, {"ok": True, "current": vid})

    def _handle_tts(self):
        payload, err = self._read_json()
        if err:
            self._send_json(400, {"ok": False, "error": err})
            return
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            self._send_json(400, {"ok": False, "error": "empty text"})
            return
        text = text.strip()
        if len(text) > MAX_CHARS:
            self._send_json(400, {"ok": False, "error": f"text too long ({len(text)} > {MAX_CHARS})"})
            return
        fmt = (payload.get("format") or "wav").lower()
        if fmt not in ("wav", "pcm16-wav", "wav16"):
            self._send_json(400, {"ok": False, "error": f"unsupported format: {fmt}"})
            return
        vid = payload.get("voice")
        if vid is not None and not isinstance(vid, str):
            self._send_json(400, {"ok": False, "error": "invalid voice"})
            return
        STORE.reload()  # pick up voices added to ref/voices since startup
        vid = (vid or "").strip() or STORE.current
        if STORE.get(vid) is None:
            self._send_json(404, {"ok": False, "error": f"unknown voice: {vid}",
                                  "voices": [v["id"] for v in STORE.public_list()]})
            return
        if ENGINE.tts is None:
            self._send_json(503, {"ok": False, "error": "model not loaded"})
            return
        try:
            data = ENGINE.synth(text, vid)
        except Exception as e:  # noqa: BLE001
            log.exception("synthesis failed")
            self._send_json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Engine", ENGINE_NAME)
        self.send_header("X-Voice", vid)
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    setup_logging()
    log.info("loading engine (cwd=%s, voices=%s, current=%s)",
             ROOT, len(STORE.voices), STORE.current)

    t0 = time.time()
    ENGINE.load()
    ENGINE.boot_seconds = time.time() - t0

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    log.info("listening on http://%s:%d  (boot %.1fs, voices=%d)",
             args.host, args.port, ENGINE.boot_seconds, len(STORE.voices))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
