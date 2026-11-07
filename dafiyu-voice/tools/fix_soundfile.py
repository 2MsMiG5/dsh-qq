import html, os, re, subprocess, sys, urllib.request
OUT = r"C:\dsh-qq\dafiyu-voice\downloads\wheels"
url = "https://mirrors.aliyun.com/pypi/simple/soundfile/"
page = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"m"}), timeout=60).read().decode()
want = "soundfile-0.14.0-py2.py3-none-win_amd64.whl"
href = None
for m in re.finditer(r'<a[^>]+href="([^"#]+)', page):
    h = html.unescape(m.group(1))
    if h.rsplit("/",1)[-1] == want:
        href = h; break
u = "https://mirrors.aliyun.com/pypi/" + href[6:] if href.startswith("../../") else href
dest = os.path.join(OUT, want)
data = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"m"}), timeout=120).read()
open(dest,"wb").write(data)
print("saved", dest, len(data))
r = subprocess.run([sys.executable,"-m","pip","install","--no-index","--no-deps","--no-cache-dir","--force-reinstall","--disable-pip-version-check",dest], capture_output=True, text=True)
print(r.stdout[-300:], r.stderr[-300:])
