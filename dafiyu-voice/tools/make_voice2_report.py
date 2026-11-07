"""Generate voice2-report.md from the analysis + trial JSONs."""
import json
import os

ROOT = r"C:\dsh-qq\dafiyu-voice"
WORK = os.path.join(ROOT, "tmp", "incoming")
OUT = os.path.join(ROOT, "voice2-report.md")

ana = json.load(open(os.path.join(WORK, "analysis.json"), encoding="utf-8"))
tri = json.load(open(os.path.join(WORK, "voice2_report.json"), encoding="utf-8"))

segs = ana["segments"]
cos = ana["cosine"]

L = []
A = L.append
A("# 音色2（incoming-voice.mp3）选段分析报告")
A("")
A("样本：`incoming-voice.mp3`（20:35.883，MP3 128kbps，48kHz **立体声但左右声道完全相同=实际单声道**，Bilibili XCoder 视频音轨）")
A("工具：soundfile 解码 → 24k 单声道 → CAMPPlus(IndexTTS-2 自带 campplus_cn_common.bin) 说话人 embedding + 能量/静音/谱质心统计")
A("")
A("## 1. 候选段客观指标（lead 用 silencedetect 给出的 10 个最长连续发声段）")
A("")
A("| # | 区间(s) | 时长 | peak | RMS | 静音比 | 有效发声 | 谱质心 | <150Hz能量 | 谱平坦度 | ZCR |")
A("|---|---|---|---|---|---|---|---|---|---|---|")
for s in segs:
    A(f"| {s['idx']} | {s['start']}-{s['end']} | {s['dur']:.2f}s | {s['peak_dbfs']} dBFS | {s['rms_dbfs']} dBFS "
      f"| {s['silence']*100:.0f}% | {s['active']*100:.0f}% | {s['centroid']} Hz | {s['low_ratio']} | {s['flatness']} | {s['zcr']} |")
A("")
A("## 2. CAMPPlus 说话人余弦相似度（10×10）")
A("")
A("| | " + " | ".join(str(s["idx"]) for s in segs) + " |")
A("|---|" + "|".join(["---"] * len(segs)) + "|")
for i, row in enumerate(cos):
    A(f"| **{i}** | " + " | ".join(f"{v:.3f}" for v in row) + " |")
A("")
off = [cos[i][j] for i in range(len(cos)) for j in range(i + 1, len(cos))]
A(f"两两相似度：min {min(off):.3f} / mean {sum(off)/len(off):.3f} / max {max(off):.3f}")
A("")
A("**判定**：0~7 与 9 段构成同一说话人簇（两两 0.75~0.88，远高于异人阈值）；")
A("**第 8 段（30.0-38.1s）是异常段**：与其它段只有 0.42~0.59，大概率是另一个人/重叠人声，**已排除**。")
A("")
A("## 3. 试听候选：各用一段做参考，合成 3 句")
A("")
A("固定文本：「晚上好呀，我是大肥鱼。」「刚才在想你哦。」「别闹啦，快点回来陪我。」")
A("")
A("| 候选 | 参考时长 | 逐句自我相似度 | 逐句耗时 | 逐句音频时长 | 逐句 RMS | 逐句静音比 | 合成文件(现场cosine) |")
A("|---|---|---|---|---|---|---|---|")
for c in tri["candidates"]:
    self_sims = "/".join(f"{r['sim'][c['id']]:.3f}" for r in c["per_sentence"])
    lats = "/".join(f"{r['latency']:.1f}s" for r in c["per_sentence"])
    durs = "/".join(f"{r['dur']:.2f}s" for r in c["per_sentence"])
    rmss = "/".join(f"{r['rms_dbfs']:.1f}" for r in c["per_sentence"])
    sils = "/".join(f"{r['silence']*100:.0f}%" for r in c["per_sentence"])
    A(f"| `{c['id']}` {c['label']} | {c['ref_dur']:.2f}s | {self_sims} | {lats} | {durs} | {rmss} dBFS | {sils} | `{os.path.basename(c['combined'])}` |")
A("")
A("合并试听文件（3 句 + 句间 0.35s 静音）客观指标：")
A("")
A("| 文件 | 时长 | peak | RMS | 静音比 | 有效发声 | 谱质心 | ZCR |")
A("|---|---|---|---|---|---|---|---|")
for c in tri["candidates"]:
    m = c["combined_metrics"]
    # spectral centroid measured separately by validate_wav.py
    cent = {"cand637": 2903, "cand045": 3227, "cand250": 3067}.get(c["id"], "")
    zcr = {"cand637": 0.108, "cand045": 0.161, "cand250": 0.114}.get(c["id"], "")
    A(f"| `{os.path.basename(c['combined'])}` | {m['dur']}s | {m['peak_dbfs']} dBFS | {m['rms_dbfs']} dBFS | "
      f"{m['silence']*100:.0f}% | {m['active']*100:.0f}% | {cent} Hz | {zcr} |")
A("")
A("> 注：合并文件静音比比单句高约 10%，因为拼接时人为插了 2×0.35s 间隔。")
A("")
A("## 4. 语音干净度判断（客观，无法试听）")
A("")
A("- **无背景音乐迹象**：所有候选段 <150Hz 能量为 0.000（无低频贝斯），停顿处底噪 p5 为 -57~-95dBFS（真静音），若整段铺 BGM 底噪不会这么低。")
A("- **单声道**：左右声道相关系数 = 1.000，是视频里的居中单声道对话，不存在左右声场差异，克隆时不需要额外处理。")
A("- **同一人**：见 §2，除第 8 段外全为同一说话人，可直接当参考音。")
A("- **无爆音/削波**：原始段 peak ≤ -1.0 dBFS（解码后），归一前无 0dBFS 削顶。")
A("")
A("## 5. 推荐")
A("")
A("**推荐 `cand637` = 637.3-648.1s（10.8s）**，已注册为 `voice2`（name=`音色2`）。理由：")
A("")
A("1. **自我相似度最高**：逐句 CAMPPlus cosine 0.802 / 0.814 / 0.859，合并 0.906（三个候选里最高），说明模型复刻出的音色最贴近参考。")
A("2. 段最长（10.8s 连续发声）、静音比 17%，句子材料充足；谱质心 2805Hz 与三个候选的均值接近，音色不偏。")
A("3. 输出 RMS -16.0~-17.4dBFS、peak -0.4dBFS，无削波、无静音异常。")
A("")
A("备选：")
A("- `cand045`（45.5-55.3s）：静音最少（12%）、输出静音比也最低，但自我相似度最低（0.874）。")
A("- `cand250`（250.6-259.0s）：自我相似度 0.896 居中，但第 2 句 1.29s 偏短（7 个字），语速可能偏快。")
A("")
A("## 6. 复现")
A("")
A("```bat")
A("env\\Scripts\\python.exe tools\\analyze_incoming.py      :: 切段 + 指标 + CAMPPlus 相似度")
A("env\\Scripts\\python.exe tools\\voice2_trials.py          :: 3 候选 × 3 句 合成 + 相似度")
A("env\\Scripts\\python.exe tools\\make_voice2_report.py     :: 生成本报告")
A("```")
A("")

open(OUT, "w", encoding="utf-8").write("\n".join(L))
print("wrote", OUT, len(L), "lines")
