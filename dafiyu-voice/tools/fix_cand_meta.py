import json, os
ROOT = r"C:\dsh-qq\dafiyu-voice\ref\voices"
names = {"cand637": "候选637s(10.8s)", "cand045": "候选045s(9.8s)", "cand250": "候选250s(8.4s)"}
for vid, nm in names.items():
    p = os.path.join(ROOT, vid, "meta.json")
    d = json.load(open(p, encoding="utf-8"))
    d["name"] = nm
    d["notes"] = "任务B 试听候选；未确认前勿作为正式音色"
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("fixed", vid, d["name"], d["refSeconds"])
