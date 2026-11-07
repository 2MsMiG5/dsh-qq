"""Iteratively import the IndexTTS-2 inference chain and auto-install missing modules."""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import pip_get  # noqa: E402

PY = sys.executable

MODULE_TO_PKG = {
    "docstring_parser": "docstring-parser",
    "yaml": "pyyaml",
    "PIL": "pillow",
    "sklearn": "scikit-learn",
    "cv2": "opencv-python",
    "IPython": "ipython",
    "mdurl": "mdurl",
    "absl": "absl-py",
    "google": "protobuf",
    "markdown_it": "markdown-it-py",
    "pydub": "pydub",
    "pyworld": "pyworld",
    "onnxruntime": "onnxruntime",
    "tensorboard": "tensorboard",
    "google.protobuf": "protobuf",
    "weather": "",
}

CHECK = r"""
import sys, traceback
sys.path.insert(0, r"C:\dsh-qq\dafiyu-voice\index-tts")
import os
os.environ.setdefault("MPLCONFIGDIR", r"C:\dsh-qq\dafiyu-voice\tmp\mpl")
mods = [
    "indextts.infer_v2",
]
ok = []
fail = None
for m in mods:
    try:
        __import__(m)
        ok.append(m)
    except Exception:
        traceback.print_exc()
        fail = m
        break
if fail is None:
    print("CHAIN_OK")
"""


def run_check():
    r = subprocess.run([PY, "-u", "-c", CHECK], capture_output=True, text=True, timeout=600)
    out = (r.stdout or "") + "\n" + (r.stderr or "")
    return out


def main():
    for it in range(20):
        out = run_check()
        if "CHAIN_OK" in out:
            print("IMPORT CHAIN OK")
            return 0
        m = re.search(r"ModuleNotFoundError: No module named '([^']+)'", out)
        if not m:
            print("NON-IMPORT FAILURE:\n", out[-4000:])
            return 1
        mod = m.group(1)
        pkg = MODULE_TO_PKG.get(mod) or mod.split(".")[0].replace("_", "-")
        print(f"[{it}] missing module {mod!r} -> installing {pkg!r}", flush=True)
        if not pip_get.install(pkg):
            print("install failed, giving up")
            return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
