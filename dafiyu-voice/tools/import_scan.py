import ast, os, sys, collections
root = r"C:\dsh-qq\dafiyu-voice\index-tts\indextts"
mods = collections.Counter()
where = collections.defaultdict(set)
for dp, dn, fn in os.walk(root):
    for f in fn:
        if not f.endswith(".py"): continue
        p = os.path.join(dp, f)
        try:
            t = ast.parse(open(p, encoding="utf-8", errors="replace").read())
        except Exception as e:
            print("PARSEFAIL", p, e); continue
        for n in ast.walk(t):
            if isinstance(n, ast.Import):
                for a in n.names:
                    top = a.name.split(".")[0]; mods[top]+=1; where[top].add(os.path.relpath(p, root))
            elif isinstance(n, ast.ImportFrom):
                if n.level: continue
                if n.module:
                    top = n.module.split(".")[0]; mods[top]+=1; where[top].add(os.path.relpath(p, root))
std = set(sys.stdlib_module_names)
for m, c in sorted(mods.items(), key=lambda x: -x[1]):
    if m in std or m in ("indextts",): continue
    print(f"{m:28s} {c:3d}  e.g. {sorted(where[m])[:3]}")
