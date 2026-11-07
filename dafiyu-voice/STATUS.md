# 大肥鱼 TTS 本地复刻 — 交付状态

引擎：**IndexTTS-2**（零样本音色克隆，B 站 Index 团队）· 服务 `http://127.0.0.1:3210`
完成时间：2026-10-25 23:05（单音色）· 2026-10-26 09:05 **升级为多音色（dafiyu / voice2）**
状态：**已交付，桥接契约自检全绿**

---

## 1. 最终结论

| 项 | 结果 |
|---|---|
| 模型 | IndexTTS-2（gpt 3.48GB + s2mel 1.2GB + BigVGAN 449MB + MaskGCT semantic codec 177MB + w2v-bert-2.0 2.32GB + campplus 28MB） |
| 精度 / 设备 | fp16 / cuda（RTX 5060 Laptop, sm_120, torch 2.8.0+cu128） |
| 服务 | `127.0.0.1:3210`：GET `/health`、GET `/voices`、POST `/voice`、POST `/tts`，输出 24kHz 单声道 PCM16 wav |
| 音色 | 2 个：`dafiyu`（大肥鱼，原云端音色）/ `voice2`（音色2，来自 `incoming-voice.mp3` 637.3-648.1s） |
| 契约自检 | `node test-service.mjs` → **全部通过：TTS 服务符合桥接契约**（多音色改造后 2026-10-26 回归仍全绿） |
| 端到端 | Lead 已用本服务在 QQ 私聊 + 群 123456789 各发一条，用户确认可正常播放、音色可接受 |
| 磁盘占用 | `dafiyu-voice\` 合计 **16.6GB**（env 8.08G + models 8.26G + 源码/下载 0.3G），C 盘剩余 48GB |

## 2. 关键指标（实测）

**启动耗时**（冷启动，含模型加载 + warmup 预热）
- 模型加载 **33.0s**（读 8.2GB 权重 + 搬显存）+ warmup **24.9s**（第一次合成，含参考音特征提取与 kernel autotune）+ 进程/import ≈ 6s
- **冷启动总计 57~64s**，期间 `/health` 不可用；`start-tts.bat` 会轮询到 ready（最长等 300s）

**显存**
- 加载期峰值（torch 统计）**5183MB**；优化后常驻分配约 **2931MB**，合成时约 3.3GB
- `nvidia-smi` 全卡占用 ~5.3GB / 8.15GB（含其它 App 约 2.2GB），合成时仍余 ~2.5GB
- 关键措施：把 2.3GB 的 w2v-bert 特征提取器放 **CPU**（每段参考音只算一次并缓存），否则 8GB 卡会被 WDDM 分页到内存，实测降到 **31s/个 token** 的不可用状态

**单句耗时**（chars = 汉字数，latency = HTTP 往返，含 wav 重采样）

| 文本 | 字数 | 耗时 | 音频时长 |
|---|---|---|---|
| 刚才在想你哦。 | 7 | 3.42~3.72s | 1.53~1.67s |
| 晚上好呀，我是大肥鱼。 | 11 | 4.09~6.74s | 2.28~2.55s |
| 别闹啦，快点回来陪我。 | 11 | 4.97~6.04s | 2.43~2.64s |
| （19 字测试句） | 19 | 6.62s | — |
| （26 字测试句） | 26 | 8.61s | — |

RTF 约 **1.5~2.5**（首次调用会多 ~20s，已被 warmup 吸收）；3~10 字短句稳定 **3.5~5s**，20~40 字约 **7~10s**。

**音频质量客观指标**（无法试听，用能量/静音/频谱统计判断）
- 采样率 **24000Hz 单声道 16bit**（模型原生 22.05kHz，服务内重采样到 24k）
- peak -0.1 ~ -4.4 dBFS，RMS -15.9 ~ -19.4 dBFS，静音比例 14~21%，有效发声帧 75~84%，谱质心 1.8~2.8kHz、ZCR 0.07~0.15（符合人声特征）→ **不是静音、不是噪声、时长合理**
- 样音：`out\test-1.wav`（2.55s）、`out\test-2.wav`（1.67s）、`out\test-3.wav`（2.64s）为桥接自检产物；`out\sample_1..3.wav` 为同文本的另一轮；`out\probe_*.wav` 为调参过程产物

## 3. 怎么启动 / 停止

**默认由 DSH 托管**（2026-10-25 晚加入）：`qq-agent` bundle 的 `lib/autostart.js` 里有
`ensureDafiyuTts()` / `stopDafiyuTtsOwned()`——DSH 启动时后台拉起本服务，DSH 退出时连进程树一起收掉。
目录/端口从 `qq-bridge/config.json` 的 `socialV2.voice.tts.serviceDir` / `baseUrl` 推导，
禁用可给 `snowluma-autostart` 那一行加 `autoStartDafiyuTts: false`。

手动方式（DSH 没跑、或临时排障时）：

```bat
:: 后台启动（隐藏窗口，写 logs\tts.pid，轮询 /health 直到 ready）
C:\dsh-qq\dafiyu-voice\start-tts.bat

:: 前台启动（调试用，Ctrl+C 停止）
start-tts.bat --fg

:: 停止（按 pid 杀进程树，pid 失效时按命令行兜底）
C:\dsh-qq\dafiyu-voice\stop-tts.bat
```

生命周期自检：`node autostart-selftest.mjs`（8 项：冷启动/重复拉起/停止释放端口/重新接管/health）。

- 日志：`logs\server.log`（结构化）、`logs\stdout.log` / `logs\stderr.log`
- 健康检查：`curl http://127.0.0.1:3210/health` → `{"ok":true,"engine":"IndexTTS-2","voice":"dafiyu","device":"cuda","current":"dafiyu","voices":2}`
- 合成：`curl -X POST -H "Content-Type: application/json" -d "{\"text\":\"晚上好呀\",\"format\":\"wav\"}" -o a.wav http://127.0.0.1:3210/tts`
- 指定音色合成：`-d "{\"text\":\"...\",\"format\":\"wav\",\"voice\":\"voice2\"}"`（省略 voice = 当前音色）
- 音色列表：`curl http://127.0.0.1:3210/voices`
- 切换音色：`curl -X POST -H "Content-Type: application/json" -d "{\"voice\":\"voice2\"}" http://127.0.0.1:3210/voice`
- 注意：**同一时间只能有一个实例**（端口独占）；重复启动会因端口占用失败

## 4. 参考音（音色仓库）

音色不再是单文件，改为仓库：`ref\voices\<id>\ref.wav` + `meta.json`（`{id,name,source,createdAt,notes,engine}`），当前音色持久化在 `ref\voices\current.json`。

| id | name | 参考音 | 时长 | 指标 |
|---|---|---|---|---|
| `dafiyu` | 大肥鱼 | 原 `ref\dafiyu_ref.wav`（迁入，samples/tts_048） | 6.20s | peak -1.0 / RMS -18.3 dBFS，静音 15%，谱质心 2184Hz |
| `voice2` | 音色2 | `incoming-voice.mp3` 637.3-648.1s | 10.80s | peak -1.0 / RMS -18.5 dBFS，静音 17%，谱质心 2805Hz |

新增/换音色：`env\Scripts\python.exe tools\register_voice.py <id> <name> <ref.wav> [--source ...] [--notes ...] [--no-set-current]`；服务会在下一次 `/voices`、`/voice`、`/tts` 请求时自动重新扫描目录，**新增音色不需要重启**（模型只加载一次，参考音特征按音色缓存，切换不重载模型）。改已有音色的 `ref.wav` 后仍需重启（缓存按路径命中）。

`ref\dafiyu_ref_1..4.wav` 是旧单音色时代的备用参考（tts_048/003/013/026），仍保留可作 A/B；详见 §6-Q2。

## 5. 已知局限

1. **非实时**：RTF 1.5~2.5，单句 3~10s；不能流式返回（服务是一次性返回整段 wav）。桥接一次 120 字以内没问题，更长文本会被前端/服务按 200 字上限拒绝。
2. **单实例串行**：全局锁 + 单卡，请求排队处理；并发多句时总延迟叠加。
3. **情绪文本控制关闭**（`use_qwen_emo=False`，为省显存）：`use_emo_text=True` 不可用；需要时改用 `emo_vector` 或按 §6-Q1 打开 Qwen。
4. **8GB 显存与其它程序共享**：其它 App 占满显存时会退化成 WDDM 分页，速度断崖（31s/token）。若发现突然变慢，先看 `nvidia-smi`，必要时关掉吃显存的软件。
5. **依赖 CPU 侧 w2v-bert**：每个新参考音首次合成多花 ~1~2s（之后缓存），换来 2.3GB 显存余量。
6. **无鉴权**：只绑定 127.0.0.1，别暴露到 0.0.0.0。
7. **不做 CPU 回退**：`torch.cuda.is_available()` 为 False 时服务直接拒绝启动。
8. 输出统一重采样到 24k（模型原生 22.05k），有一次极轻的插值损耗。
9. 拼音/音素级发音控制是 IndexTTS-2.5 的能力，本版本未启用；中英混读支持，但小语种（日/西/阿）不在本模型能力内。

## 6. 两个参数问答

**Q1：以后想加情绪控制，`use_qwen_emo=True` 显存还够吗？**
够，但紧。Qwen0.6B 情绪模型是 fp16 + `device_map=auto`，约 **+0.6~0.8GB 显存**，加载时间 +2~4s。打开后全卡占用会到 ~6.0GB / 8.15GB，剩 ~2GB——只要不吃显存的软件不额外膨胀就安全；**不要再把 w2v-bert 放回 GPU**（那会 +2.3GB 直接顶爆）。
建议：只是想要"高兴/难过/平静"这类控制时，优先用 `infer(..., emo_vector=[...])`（8 维：[高兴,愤怒,悲伤,恐惧,反感,低落,惊讶,自然]，总和 ≤0.8，代码里会做 bias 归一），**零额外显存、零额外耗时**；只有"用一句话描述情绪"的 `emo_text` 才需要开 Qwen。

**Q2：`ref\dafiyu_ref.wav` 之外 3 段备用的特点**（无法试听，给客观指标 + 听感推测）

| 文件 | 来源 | 时长 | peak/RMS | 静音 | 有效发声 | 谱质心 | ZCR | 特点推测 |
|---|---|---|---|---|---|---|---|---|
| `dafiyu_ref.wav` | tts_048 | 6.20s | -1.0 / -18.3 dBFS | 15% | 84% | 2184Hz | 0.121 | 默认。段最长、静音少、能量最标准 → 克隆最稳 |
| `ref_2.wav` | tts_003 | 5.93s | -1.0 / -18.2 | 21% | 74% | 2205Hz | 0.129 | 与默认最接近，静音略多；可作为"同音色不同句子"的 A/B |
| `ref_3.wav` | tts_013 | 4.11s | -1.0 / -17.7 | 9% | 89% | 2823Hz | 0.168 | 最短最"满"，高频能量与过零率最高 → 听感大概率更亮/更脆/更活泼；想让声音年轻一点可先试它 |
| `ref_4.wav` | tts_026 | 5.95s | -1.0 / -18.6 | 18% | 79% | 2249Hz | 0.119 | 与默认接近，质心略高、整体能量略低 → 听感可能更平/更稳 |

换音色时建议保持 4~8s、句首句尾别截断、单句完整；以上 4 段都已统一 -1dBFS 归一 + 24kHz 单声道。

## 7. 环境与网络备忘（便于日后重装）

| 资源 | 可用通道 | 不可用 |
|---|---|---|
| GitHub 源码 | `fastly.jsdelivr.net/gh/index-tts/index-tts@main/<path>` | codeload zip（7KB/s）、git fetch（卡死）、raw.githubusercontent |
| IndexTTS-2 权重 | `modelscope.cn/models/IndexTeam/IndexTTS-2/resolve/master/<f>`（4.6MB/s） | HuggingFace |
| w2v-bert / MaskGCT / campplus | ModelScope：`AI-ModelScope/w2v-bert-2.0`、`amphion/MaskGCT`、`iic/speech_campplus_sv_zh-cn_16k-common` | HF |
| NVIDIA BigVGAN 449MB | `aifasthub.com/nvidia/bigvgan_v2_22khz_80band_256x/resolve/main/bigvgan_generator.pt` | ModelScope 无；hf-mirror 302→被墙的 xet；GitCode hf_mirrors 对 LFS 403 |
| pypi | `mirrors.aliyun.com/pypi/simple/`（文件 ~500KB/s，但 pip 自身 HTTP 会挂死） | pypi.org / files.pythonhosted（20KB/s） |
| torch cu128 | `mirrors.nju.edu.cn/pytorch/whl/cu128`（15MB/s） | download.pytorch.org 单流 500KB/s |

- venv：`env\`（uv 的 CPython 3.12.14）。官方 pyproject 写 `<3.12`，但 3.12 实测全链路可用。
- 依赖装法：pip 联网会挂死（0 CPU、无输出），所以用 `tools\solve_wheels.py` 自己做依赖解析 + aliyun 下载 wheel，再 `pip install --no-index --no-deps` 本地装；缺的模块用 `tools\auto_fix.py` / `tools\pip_get.py` 补。
- 关键补丁：`engine_utils.py` 的 `optimize()` 把 w2v-bert 移 CPU 并替换 `get_emb`——**没有它服务会慢 10 倍**，换机/重装时务必保留。

## 8. 目录结构

```
dafiyu-voice\
├─ server.py              # HTTP 服务（/health, /voices, /voice, /tts）
├─ engine_utils.py        # 显存优化补丁（w2v-bert→CPU、get_emb 替换）
├─ start-tts.bat / stop-tts.bat
├─ STATUS.md              # 本文件
├─ voice2-report.md       # 音色2 选段分析报告（相似度表/候选对比/推荐）
├─ env\                   # 独立 venv（8.1GB）
├─ index-tts\             # 源码（indextts/）
├─ models\IndexTTS-2\     # 全部权重（8.3GB）
├─ ref\
│  ├─ dafiyu_ref*.wav     # 旧单音色参考（保留）
│  └─ voices\<id>\        # 音色仓库：ref.wav + meta.json；current.json 记当前音色
├─ out\                   # 样音：test-*.wav(桥接自检) / voice2-cand*.wav(试听) / voice2-sample.wav
├─ logs\                  # server.log / stdout / stderr / tts.pid
└─ tools\                 # 下载、解析、转换、校验、选段、注册音色、自检脚本
```

## 9. 多音色改造 + 音色2（2026-10-26）

### 9.1 API 契约（与桥接约定一致，字段名未改）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | — | `{"ok":true,"engine":"IndexTTS-2","voice":"<current>","device":"cuda","current":"<current>","voices":2}` |
| GET | `/voices` | — | `{"ok":true,"current":"dafiyu","voices":[{"id","name","refSeconds","engine"},…]}` |
| POST | `/voice` | `{"voice":"<id>"}` | `{"ok":true,"current":"<id>"}`（持久化到 `ref\voices\current.json`） |
| POST | `/tts` | `{"text":"…","format":"wav","voice":"<id>"}`（voice 省略=当前） | 200 `audio/wav` 二进制（`X-Voice` 头回显实际音色）；未知音色 404、空文本/超 200 字 400 |

实现要点：单模型实例 + 全局串行锁；参考音条件（`cache_spk_cond` / `cache_s2mel_style` / `cache_s2mel_prompt` / `cache_mel` / emo 条件）**按音色快照缓存**，切换音色不重载模型、第二次访问同一音色直接命中缓存；`/voice` 返回后后台线程异步预热新音色（不阻塞接口）。

### 9.2 实测（2026-10-26 09:00）

- 冷启动 **61.8s**（加载 33.6s + warmup 22.9s，warmup 用当前音色 `dafiyu`）
- 首次用某音色合成：+约 4~5s（计算该音色参考音条件，后台 warm 后会消失）
- 同音色连续合成 11 字：**4.4~7.8s**（波动来自自回归生成的音频长度不同：2.1s~2.8s 音频，RTF≈2）
- 显存峰值仍 **5183MB**，全卡占用 ~5.3~6.3GB/8.15GB
- 回归：`node test-service.mjs` 全绿；未知音色 404、空文本 400、201 字 400 均正确

### 9.3 音色2 选段结论（详见 `voice2-report.md`）

- 样本 20:35、128kbps/48kHz、左右声道完全相同（实际单声道）、B 站视频音轨；10 个候选段 CAMPPlus 两两 cosine 0.42~0.88。
- **10 段里 9 段是同一人**（0.75~0.88）；**第 8 段（30.0-38.1s）是异人/异常**（0.42~0.59），已排除。
- 客观判断「干净」：无 BGM（<150Hz 能量 0、停顿底噪 p5 -57~-95dBFS）、无削波（peak ≤ -1.0dBFS）、无左右声场问题。
- 3 个候选各合成 3 句并算「输出 vs 参考」的 CAMPPlus cosine：**cand637 = 0.802/0.814/0.859（合并 0.906，最高）**、cand250 = 0.807/0.777/0.831（0.896）、cand045 = 0.786/0.810/0.821（0.874）。
- **推荐并已注册 `voice2` = 637.3-648.1s（10.8s）**；试听文件 `out\voice2-cand637.wav`（3 句合并）、单句 `out\voice2-cand637-s1..3.wav`。
- 临时候选音色（cand637/cand045/cand250）已从仓库清理，`/voices` 只保留 `dafiyu` + `voice2`；如需 A/B 可用 `tools\register_voice.py` 把 `tmp\incoming\cand_*.wav` 重新注册。
