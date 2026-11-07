import json, numpy as np, soundfile as sf, os
p = r"C:\dsh-qq\dafiyu-voice\tmp\incoming\analysis.json"
d = json.load(open(p, encoding="utf-8"))
for s in d["segments"]:
    print(f"[{s['idx']}] {s['start']}-{s['end']}s dur={s['dur']:.2f} rms={s['rms_dbfs']} peak={s['peak_dbfs']} sil={s['silence']} cent={s['centroid']} low={s['low_ratio']} flat={s['flatness']} zcr={s['zcr']}")

# background floor during pauses for a few segments
MP3 = r"C:\dsh-qq\dafiyu-voice\incoming-voice.mp3"
print("\n=== pause / noise floor ===")
for a,b in [(30,38.1),(45.5,55.3),(148.8,159.2),(250.6,259.0),(637.3,648.1)]:
    with sf.SoundFile(MP3) as f:
        sr=f.samplerate; f.seek(int(a*sr)); x=f.read(int((b-a)*sr), dtype="float32", always_2d=True).mean(axis=1)
    win=int(sr*0.02); n=len(x)//win; fr=x[:n*win].reshape(n,win).astype(np.float64)
    rms=np.sqrt(np.mean(fr**2,axis=1)); db=20*np.log10(np.maximum(rms,1e-12))
    q=np.percentile(db,[5,25,50,75,95])
    print(f"{a}-{b}s percentiles(framerms dBFS) p5={q[0]:.0f} p25={q[1]:.0f} p50={q[2]:.0f} p75={q[3]:.0f} p95={q[4]:.0f}")
