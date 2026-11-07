"""Parallel ranged downloader for large files over flaky/slow links."""
import os
import sys
import time
import threading
import urllib.request

URL = None
OUT = None
THREADS = 8
CHUNK = 4 * 1024 * 1024


def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"]), r.geturl()


def worker(url, size, idx, n, out_fh, progress):
    start = size * idx // n
    end = size * (idx + 1) // n - 1
    pos = start
    attempt = 0
    while pos <= end:
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0", "Range": f"bytes={pos}-{end}"}
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                while pos <= end:
                    data = r.read(min(CHUNK, end - pos + 1))
                    if not data:
                        break
                    out_fh.seek(pos)
                    out_fh.write(data)
                    pos += len(data)
                    with progress["lock"]:
                        progress["done"] += len(data)
            attempt = 0
        except Exception as e:  # noqa: BLE001
            attempt += 1
            if attempt > 8:
                print(f"[w{idx}] giving up at {pos}: {e}", flush=True)
                raise
            time.sleep(2 * attempt)


def main(url, out, threads=None):
    global THREADS
    if threads:
        THREADS = threads
    size, final = head(url)
    print(f"size={size/1e6:.1f}MB final={final[:80]}", flush=True)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".part"
    with open(tmp, "wb") as fh:
        fh.truncate(size)
        progress = {"done": 0, "lock": threading.Lock()}
        ts = [
            threading.Thread(target=worker, args=(final, size, i, THREADS, fh, progress), daemon=True)
            for i in range(THREADS)
        ]
        t0 = time.time()
        for t in ts:
            t.start()
        while any(t.is_alive() for t in ts):
            time.sleep(10)
            el = time.time() - t0
            done = progress["done"]
            print(f"  {done/1e6:.0f}/{size/1e6:.0f} MB  {(done/1e6)/max(el,1e-9):.2f} MB/s", flush=True)
    if os.path.getsize(tmp) != size:
        print("SIZE MISMATCH", os.path.getsize(tmp), size)
        return 1
    os.replace(tmp, out)
    print(f"DONE {out} {size/1e6:.1f}MB in {time.time()-t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else None))
