"""Resolve + download wheels for the IndexTTS-2 venv.

pip's own HTTP layer stalls on this box (connections hang with no timeout), so we
resolve dependencies ourselves against the aliyun pypi mirror, download wheels
with curl, and hand them to `pip install --no-index --no-deps --find-links`.
"""
import html
import importlib.metadata as md
import os
import re
import subprocess
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import InvalidVersion, Version

ROOT = r"C:\dsh-qq\dafiyu-voice"
OUT = os.path.join(ROOT, "downloads", "wheels")
CACHE = os.path.join(ROOT, "downloads", "index-cache")
INDEX = "https://mirrors.aliyun.com/pypi/simple/"
MIRROR_BASE = "https://mirrors.aliyun.com"
UA = {"User-Agent": "Mozilla/5.0 (dafiyu-tts)"}

os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

_tag_set = {str(t) for t in sys_tags()}
ENV = default_environment()

# packages already in the venv that must NOT be replaced unless pinned in roots
INSTALLED = {}
for d in md.distributions():
    try:
        nm = canonicalize_name(d.metadata["Name"])
        INSTALLED[nm] = d.version
    except Exception:
        pass


def fetch(url, timeout=90, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1 + i * 2)
    raise last


def index_page(name):
    name = canonicalize_name(name)
    p = os.path.join(CACHE, name + ".html")
    if os.path.isfile(p) and os.path.getsize(p) > 100:
        return open(p, "rb").read().decode("utf-8", "replace")
    data = fetch(INDEX + name + "/")
    with open(p, "wb") as f:
        f.write(data)
    return data.decode("utf-8", "replace")


LINK_RE = re.compile(r'<a[^>]+href="([^"#]+)')


def candidates(name):
    name = canonicalize_name(name)
    page = index_page(name)
    wheels, sdists = [], []
    for m in LINK_RE.finditer(page):
        href = html.unescape(m.group(1))
        fn = href.rsplit("/", 1)[-1]
        if href.startswith("../../"):
            url = MIRROR_BASE + "/pypi/" + href[6:]
        elif href.startswith("http"):
            url = href
        else:
            url = INDEX + name + "/" + href
        if fn.endswith(".whl"):
            try:
                wname, wver, _build, wtags = parse_wheel_filename(fn)
            except Exception:
                continue
            if canonicalize_name(wname) != name:
                continue
            if not (_tag_set & {str(t) for t in wtags}):
                continue
            wheels.append((wver, fn, url))
        elif fn.endswith((".tar.gz", ".zip")):
            base = fn[:-7] if fn.endswith(".tar.gz") else fn[:-4]
            if "-" not in base:
                continue
            nm, ver = base.rsplit("-", 1)
            if canonicalize_name(nm) != name:
                continue
            try:
                v = Version(ver)
            except InvalidVersion:
                continue
            sdists.append((v, fn, url))
    return wheels, sdists


def pick(name, spec):
    wheels, sdists = candidates(name)
    if not wheels and not sdists:
        return None
    allv = sorted({c[0] for c in wheels} | {c[0] for c in sdists}, reverse=True)
    for v in allv:
        if v.is_prerelease:
            continue
        if spec and not spec.contains(str(v)):
            continue
        for c in wheels:
            if c[0] == v:
                return (c[0], c[1], c[2], "wheel")
        for c in sdists:
            if c[0] == v:
                return (c[0], c[1], c[2], "sdist")
    return None


def download(job):
    url, dest = job
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return dest, os.path.getsize(dest), "cached"
    tmp = dest + ".part"
    for _ in range(4):
        r = subprocess.run(
            ["curl.exe", "-L", "-s", "-o", tmp, "--max-time", "600", url],
            capture_output=True,
        )
        if r.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            os.replace(tmp, dest)
            return dest, os.path.getsize(dest), "ok"
        time.sleep(2)
    return dest, 0, "FAIL"


def wheel_requires(path):
    try:
        with zipfile.ZipFile(path) as z:
            meta = [n for n in z.namelist() if n.endswith(".dist-info/METADATA")]
            if not meta:
                return []
            txt = z.read(meta[0]).decode("utf-8", "replace")
    except Exception:
        return []
    out = []
    for line in txt.splitlines():
        if line.startswith("Requires-Dist:"):
            out.append(line.split(":", 1)[1].strip())
    return out


def main():
    roots = []
    with open(os.path.join(ROOT, "requirements-dafiyu.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.split("#")[0].strip()
            if line:
                roots.append(line)

    pinned = {canonicalize_name(Requirement(r).name) for r in roots}
    chosen = {}   # name -> (version, filename, url, kind)
    specs = {}    # name -> combined SpecifierSet (string form)
    pending = [Requirement(r) for r in roots]
    expanded = set()

    def combine(name, spec):
        cur = specs.get(name, "")
        if not spec:
            return cur
        if cur:
            return cur + "," + str(spec)
        return str(spec)

    for rnd in range(60):
        if not pending:
            break
        nxt = []
        for req in pending:
            name = canonicalize_name(req.name)
            combined = combine(name, req.specifier)
            specs[name] = combined
            spec_obj = SpecifierSet(combined) if combined else SpecifierSet("")
            if name in chosen:
                if not spec_obj.contains(str(chosen[name][0])):
                    c = pick(name, spec_obj)
                    if c:
                        print(f"   REPICK {name}: {chosen[name][0]} -> {c[0]} (need {combined})", flush=True)
                        chosen[name] = c
                        expanded.discard(name)
                    else:
                        print(f"!! CONFLICT {name}: have {chosen[name][0]} need {combined}", flush=True)
                continue
            if name in INSTALLED and name not in pinned:
                if spec_obj.contains(INSTALLED[name]):
                    continue
            c = pick(name, spec_obj)
            if not c:
                print(f"!! NO CANDIDATE {req}", flush=True)
                continue
            chosen[name] = c
            print(f"   pick {name}=={c[0]} ({c[3]})", flush=True)
        # download everything chosen that we haven't downloaded
        todo = []
        for name, (v, fn, url, kind) in chosen.items():
            dest = os.path.join(OUT, fn)
            if not (os.path.isfile(dest) and os.path.getsize(dest) > 0):
                todo.append((url, dest))
        if todo:
            with ThreadPoolExecutor(max_workers=6) as ex:
                for dest, size, st in ex.map(download, todo):
                    print(f"   dl {os.path.basename(dest)} {size/1e6:.1f}MB {st}", flush=True)
        # expand wheel deps
        for name, (v, fn, url, kind) in list(chosen.items()):
            if name in expanded:
                continue
            expanded.add(name)
            if kind != "wheel":
                continue
            dest = os.path.join(OUT, fn)
            if not os.path.isfile(dest):
                continue
            for rline in wheel_requires(dest):
                try:
                    r = Requirement(rline)
                except Exception:
                    continue
                if r.marker is not None:
                    ev = dict(ENV)
                    ev["extra"] = ""
                    try:
                        if not r.marker.evaluate(ev):
                            continue
                    except Exception:
                        continue
                if canonicalize_name(r.name) in chosen and canonicalize_name(r.name) in specs:
                    # still queue it: the loop re-checks the combined constraint and repicks
                    pass
                nxt.append(r)
        pending = nxt

    files = []
    missing = []
    for name, (v, fn, url, kind) in sorted(chosen.items()):
        p = os.path.join(OUT, fn)
        if os.path.isfile(p) and os.path.getsize(p) > 0:
            files.append(p)
        else:
            missing.append(f"{name}=={v}")
    print(f"\nRESOLVED {len(chosen)} packages / {len(files)} files; missing={missing}", flush=True)
    with open(os.path.join(ROOT, "downloads", "wheel-list.txt"), "w", encoding="utf-8") as f:
        for p in files:
            f.write(p + "\n")


if __name__ == "__main__":
    main()
