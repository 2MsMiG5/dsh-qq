import soundfile as sf, numpy as np, traceback
p = r"C:\dsh-qq\dafiyu-voice\incoming-voice.mp3"
try:
    info = sf.info(p)
    print("sf.info:", info)
except Exception as e:
    print("sf.info failed:", e)
try:
    x, sr = sf.read(p, dtype="float32", frames=48000*10, always_2d=True)
    print("read ok:", x.shape, sr, "peak", float(np.max(np.abs(x))))
except Exception as e:
    print("read failed:", type(e).__name__, e)
