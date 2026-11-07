import html, os, re, urllib.request
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version
OUT = r"C:\dsh-qq\dafiyu-voice\downloads\wheels"
tagset = {str(t) for t in sys_tags()}
def best(name):
    url = "https://mirrors.aliyun.com/pypi/simple/%s/" % canonicalize_name(name)
    page = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"m"}), timeout=60).read().decode()
    cands = []
    for m in re.finditer(r'<a[^>]+href="([^"#]+)', page):
        href = html.unescape(m.group(1)); fn = href.rsplit("/",1)[-1]
        if not fn.endswith(".whl"): continue
        try: wn, wv, _, wt = parse_wheel_filename(fn)
        except Exception: continue
        if canonicalize_name(wn) != canonicalize_name(name): continue
        if not (tagset & {str(t) for t in wt}): continue
        cands.append((wv, fn, href))
    if not cands: return None
    wv, fn, href = sorted(cands, key=lambda c: c[0], reverse=True)[0]
    url2 = "https://mirrors.aliyun.com/pypi/" + href[6:] if href.startswith("../../") else href
    dest = os.path.join(OUT, fn)
    data = urllib.request.urlopen(urllib.request.Request(url2, headers={"User-Agent":"m"}), timeout=120).read()
    open(dest,"wb").write(data)
    print("got", fn, len(data))
    return dest
p = best("wheel")
print(p)
