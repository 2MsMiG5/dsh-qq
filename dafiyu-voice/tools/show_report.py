import json
p = r"C:\dsh-qq\dafiyu-voice\tmp\incoming\voice2_report.json"
d = json.load(open(p, encoding="utf-8"))
for c in d["candidates"]:
    print("==", c["id"], c["label"], "combined", c["combined"], c["combined_metrics"])
    print("   combined_sim", c["combined_sim"])
    for r in c["per_sentence"]:
        print("   ", r["sentence"], "lat", r["latency"], "dur", r["dur"], "rms", r["rms_dbfs"],
              "sil", r["silence"], "sim", r["sim"])
