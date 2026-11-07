"""Download the best compatible wheel (or sdist) for a requirement from the aliyun
mirror and install it into the venv with --no-deps. Used to patch missing imports."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import solve_wheels as sw  # noqa: E402
from packaging.requirements import Requirement  # noqa: E402


def install(spec, no_deps=True):
    req = Requirement(spec)
    c = sw.pick(req.name, req.specifier)
    if not c:
        print("NO CANDIDATE", spec)
        return False
    ver, fn, url, kind = c
    dest = os.path.join(sw.OUT, fn)
    print(f">> {spec} -> {fn}", flush=True)
    sw.download((url, dest))
    args = [sys.executable, "-u", "-m", "pip", "install", "--no-index",
            "--no-build-isolation", "--no-cache-dir", "--disable-pip-version-check"]
    if no_deps:
        args.append("--no-deps")
    args.append(dest)
    r = subprocess.run(args, capture_output=True, text=True)
    ok = r.returncode == 0
    tail = (r.stdout or "").strip().splitlines()[-3:] + (r.stderr or "").strip().splitlines()[-3:]
    print(("   OK " if ok else "   FAIL ") + " | ".join(tail), flush=True)
    return ok


if __name__ == "__main__":
    ok = 0
    for s in sys.argv[1:]:
        ok += 1 if install(s) else 0
    print(f"installed {ok}/{len(sys.argv)-1}")
