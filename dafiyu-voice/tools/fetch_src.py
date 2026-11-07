"""Fetch index-tts source files from jsdelivr CDN (GitHub blocked for raw)."""
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = r"C:\dsh-qq\dafiyu-voice"
DEST = os.path.join(ROOT, "index-tts")
LIST = os.path.join(ROOT, "ghmeta", "filelist.txt")
BASES = [
    "https://fastly.jsdelivr.net/gh/index-tts/index-tts@main/",
    "https://gcore.jsdelivr.net/gh/index-tts/index-tts@main/",
]


def fetch(path):
    out = os.path.join(DEST, path.replace("/", os.sep))
    if os.path.isfile(out):
        return path, os.path.getsize(out), "cached"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    last = None
    for base in BASES:
        url = base + path
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                tmp = out + ".part"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, out)
                return path, len(data), "ok"
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(1.5 * (attempt + 1))
    return path, 0, f"FAIL {last}"


def main():
    paths = []
    with open(LIST, encoding="utf-8") as f:
        for line in f:
            if "\t" not in line:
                continue
            paths.append(line.split("\t")[0].strip())
    print(f"total {len(paths)} files", flush=True)
    ok = fail = 0
    fails = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(fetch, p) for p in paths]
        for i, fu in enumerate(as_completed(futs), 1):
            p, n, st = fu.result()
            if st.startswith("FAIL"):
                fail += 1
                fails.append((p, st))
            else:
                ok += 1
            if i % 40 == 0 or i == len(paths):
                print(f"{i}/{len(paths)} ok={ok} fail={fail} {time.time()-t0:.0f}s", flush=True)
    for p, st in fails:
        print("FAILED:", p, st)
    print(f"DONE ok={ok} fail={fail} in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
