import sys, time, traceback
sys.path.insert(0, r"C:\dsh-qq\dafiyu-voice\index-tts")
t0 = time.time()
try:
    import torch
    print("torch", torch.__version__, "cuda avail", torch.cuda.is_available())
    from indextts.infer_v2 import IndexTTS2
    print("IMPORT OK in %.1fs" % (time.time()-t0))
except Exception:
    traceback.print_exc()
    # find first missing module
    import re
    m = re.search(r"No module named '([^']+)'", traceback.format_exc())
    print("MISSING:", m.group(1) if m else "unknown")
