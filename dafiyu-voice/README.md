# 大肥鱼语音 · QQ 版

让 QQ 里的 AI（小鲸鱼 / 群聊机器人）用「噗哩噗哩」里大肥鱼的声音发语音条。

音色来源：从噗哩噗哩桌面端本地缓存里导出的 73 段大肥鱼云端 TTS 语音（`samples/`，共约 416 秒，LAME mp3，响度一致）。用它们做**零样本克隆**的参考音，在本机跑 IndexTTS-2，不借用任何账号、不上传音频。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| 参考音 | `dafiyu-voice\samples\` + `ref\` | 73 段大肥鱼原始语音；`ref\` 里是转成 24k 单声道的克隆参考音 |
| 本地 TTS 服务 | `dafiyu-voice\server.py`（端口 3210） | `POST /tts {"text":"…"}` → wav；模型启动时加载一次，常驻 |
| 桥接发送链路 | `qq-bridge\src\bridge.js` | 识别 `[语音]` 前缀 → 调 TTS → 落盘 `audio/.tts/` → 走原有语音条发送（审计/白名单/限流/SILK 转码） |
| 提示词注入 | `qq-bridge\src\bridge.js`（`buildWakePromptV2` / `/api/socialV2/prompt`） | 告诉 AI 有这个能力、怎么用、什么时候用 |

## 数据流

```
QQ 里有人要语音
  → AI 调 qq_send_message，其中一条写成 "[语音]晚上好呀"
  → 桥接 sendMessagesV2 拆成 文本片段 / 语音片段
  → POST http://127.0.0.1:3210/tts {"text":"晚上好呀"}
  → IndexTTS-2 用大肥鱼参考音合成 wav
  → 写入 qq-bridge/audio/.tts/（保留最近 30 个）
  → SnowLuma record 段 → 网关转 SILK → QQ 语音条
  → get_msg 回读确认 record 真的落地
```

## 怎么用

在 QQ 里直接说就行，例如：

- 「用语音说一句晚上好」
- 「发条语音，叫我起床」
- 「我想听你的声音」

AI 只会把**那一条**消息转成语音；平时照旧文字。提示词里写了「只在对方明确要语音/想听你说话时才用，平时以文字为主」。

**两处提示词约束**（`qq-bridge/src/bridge.js`）：
1. 每次唤醒都带一行【语音】说明（能力 + 前缀 + 上限 + 别滥用）；
2. 如果**触发这次唤醒的那条消息**里出现「语音/声音/说话/说句/开口/念一下/读一下/听你」等词，会额外插入一行【对方在要语音】，明确要求这次必须用 `[语音]` 前缀开口，避免模型继续打字。

标记容错（模型写歪了也不会把标记当文字发出去）：全角 `［语音］`、英文 `[voice]` / `[VOICE]`、被引号包裹的 `"「[语音]晚安」"` 都能识别；标记后跟冒号/空格也能剥掉。

换参考音后必须重启 TTS 服务（参考音特征按路径缓存在进程里）：`stop-tts.bat` → 覆盖 `ref\dafiyu_ref.wav` → 重启 DSH 或 `start-tts.bat`。

## 启动 / 停止（跟随 DSH）

**默认由 DSH 托管**：`qq-agent` bundle 的自启模块（`qq-bridge/plugins/qq-agent/lib/autostart.js`）在 DSH 启动时顺带拉起 TTS，
DSH 退出时把 TTS 一起停掉（`ctx.effect` 的 cleanup；硬杀由进程树 + 端口兜底）。
也就是说：**开 DSH = TTS 自动就绪（约 60 秒加载），关 DSH = 显存自动释放**，不用再记着开 `start-tts.bat`。

| 场景 | 做法 |
|---|---|
| 正常使用 | 什么都不用做，跟着 DSH 起停 |
| 只想临时开/关（不改 DSH） | `start-tts.bat` / `stop-tts.bat` |
| 前台排障 | `start-tts.bat --fg`（Ctrl+C 停止） |
| 不想要 DSH 托管 | profile 的 `cordis.patch.yml` 里 `snowluma-autostart` 行加 `autoStartDafiyuTts: false` |
| 改过本文件 / autostart.js | 重启 DSH 生效（bundle 的 JS 在启动时加载） |

```bat
:: QQ 桥接（改过 bridge.js 或 config.json 后需要重启；由 DSH 托管时同理）
C:\path\to\qq-bridge\restart.bat

:: 手动兜底（DSH 没跑或临时调试时）
C:\dsh-qq\dafiyu-voice\start-tts.bat
C:\dsh-qq\dafiyu-voice\stop-tts.bat
```

`enable-autostart.bat` / `disable-autostart.bat` 是「不依赖 DSH 的登录自启」老方案，现在**不推荐**（DSH 已经托管）；留着只作备选。

TTS 服务没开也不会把消息弄丢：桥接会自动降级成普通文字发出去，并在工具响应里带 `voiceFallback` 告诉 AI「这条本想发语音、失败了」。

## 实测数据（RTX 5060 Laptop 8GB / IndexTTS-2 fp16）

| 项目 | 数值 |
|---|---|
| 模型加载 | 29.9s（含 warmup 冷启动总计 57~144s，视磁盘/显存而定） |
| 合成耗时 | 7 字 ≈ 3.7s；11 字 ≈ 4.9s；26 字 ≈ 8.6s（串行，一次一句） |
| QQ 端到端 | 9.8s（合成 → SILK 转码 → 发送 → get_msg 回读校验） |
| 显存峰值 | 5183 MB / 8124 MB（其余程序常占 2~3GB，注意别同时开游戏） |
| 参考音 | `ref\dafiyu_ref.wav`（samples 里的 tts_048，约 6.2s，24kHz 单声道） |
| 并发 | 推理串行加锁，多人同时要语音会排队 |

已实测可用：QQ 私聊 + 群 123456789 各成功发出过合成语音，用户确认「能正常播放、音色可接受」。

## 多音色 + 控制台切换（2026-10-26 起）

音色仓库：`ref\voices\<id>\`（`ref.wav` + `meta.json`），当前音色存在 `ref\voices\current.json`。
服务每次请求都会**轻量重扫**仓库——**新增音色不用重启**；切换音色也不重载模型（参考音条件按音色缓存，后台预热）。

| 现有音色 | 来源 | 参考音 |
|---|---|---|
| `dafiyu` / 大肥鱼 | 噗哩噗哩缓存里的 73 段云端 TTS（tts_048） | 6.2s |
| `voice2` / 音色2 | 用户给的 `incoming-voice.mp3`（20:36 Bilibili 音轨）637.3–648.1s | 10.8s |
| `xiaocong` / 小葱 | 用户给的 `11月4日 (1).mp3`（14.1min 完整素材）630.60s + 622.32s 两段拼接 | 10.27s |

`voice2` 的客观校验（详见 `voice2-report.md`）：
- **同人**：10 个候选段 CAMPPlus 两两 cosine，9 段成簇 0.75~0.88；第 8 段（30.0-38.1s）0.42~0.59 异人，已排除。
- **干净**：无 BGM（<150Hz 能量 0、停顿底噪 p5 −57~−95dBFS）、单声道（L/R 相关 1.000）、无削波（peak ≤ −1.0dBFS）。
- **选段依据**：合成输出 vs 参考的自我相似度，推荐段逐句 0.802/0.814/0.859、合并 **0.906**（另两候选 0.896/0.874）。备选试听：`out\voice2-cand045.wav`、`out\voice2-cand250.wav`。

`xiaocong`（小葱）—— 最终版用 **14.1 分钟长素材**（`11月4日 (1).mp3`）：
- **素材条件**：48kHz 立体声，全长 14.1min，语音段 **555s / 175 段**（最长 9.74s），20–150Hz 能量 0.01%（无 BGM），2–6kHz 能量 8%+（高频完整）。
- **同人确认**：拿早期 4.8s 参考音当锚筛全片，41 个候选段与锚的 cosine 中位数 0.815、最高 0.870，高位簇内部两两 0.87 —— 确认整段同一个人。
- **锚点评估**（用长素材里**别的段落**当「她本人」，与候选参考音完全独立）：

  | 候选参考音 | 时长 | 锚相似度 |
  |---|---|---|
  | 早期 4.8s 素材版（已弃用） | 6.47s | 0.770 |
  | 单段最佳 630.60s | 10.04s | 0.803 |
  | **两段拼接 630.60s + 622.32s（采用）** | **10.27s** | **0.826** |
  | 三段拼接 630.60 + 585.38 + 492.86 | 9.10s | 0.804（soft 掉到 0.706，拼太多会散） |

- **线上复测**（正式音色 `xiaocong` 实际服务合成）：参考vs输出 **0.846**、锚相似度 **0.849**，四句全部优于早期版。
- 试听：`out\xiaocong_v2\xiaocong-preview.wav`（四句合集），单句见同目录 `cold/proud/tsun/soft.wav`。
- 复现脚本：`tools/long_probe.py`（长素材结构普查）、`tools/select_from_long.py`（锚点筛同人段）、`tools/extract_ref.py`（按时间轴/多段拼提取参考音）、`tools/eval_anchor.py`（独立锚评估）、`tools/xiaocong_trial.py`（合成 + 自相似度）。

早期 8.8s 素材的剪法对比（**已弃用**，仅存档）：

  | 剪法 | 参考音时长 | 参考vs输出 | 输出间一致性 |
  |---|---|---|---|
  | 停顿 0.20s（紧） | 5.72s | 0.769 | 0.792 |
  | 停顿 0.45s（曾采用） | 6.47s | 0.796 | 0.835 |
  | 停顿 0.34s | 6.14s | 0.798 | 0.803 |
  | 不压停顿（原样） | 7.84s | 0.787 | 0.852 |

  `tools/xiaocong_probe.py`（体检）、`tools/xiaocong_ref_prep.py`（剪参考音，第三个参数＝保留停顿秒数，传 0 表示不压）。

> ⚠️ **换参考音必须重启服务**：参考音条件按**路径**缓存，覆盖同名 `ref.wav` 后服务仍用旧特征。
> 但 `start-tts.bat` 偶发启动失败（返回空的 `pid=`、`/health` 一直不通、`logs\stderr.log` 为空）。
> 兜底：直接 `env\Scripts\python.exe server.py`（可后台），起来后把进程号写进 `logs\tts.pid` 即可让 `stop-tts.bat` 正常工作。
> 注意 venv 里 `python.exe` 是启动器，真正的监听进程是它的子进程，杀的时候按父 pid + `/T` 树杀。

### 控制台切换

`qq-bridge` 控制台（默认 `http://127.0.0.1:3100`）→「二代仿真」页 → 展开 **「TTS 音色（AI 开口说话用）」**：

- **刷新音色列表** → 下拉选音色 → **切换音色**（写 `config.json` 的 `voice/voiceName`，唤醒提示词里的音色名同步更新）；
- **试听当前音色**：输入一句话点试听，桥接合成后以 base64 回给页面播放（`/api/socialV2/tts-preview`），只在本机，不发 QQ；
- 三个接口都只在控制台可用（`adminOnlyV2Paths`），AI 侧拿不到。

命令行等价：

```bash
# 列音色
curl -H "x-console-token: <token>" http://127.0.0.1:3100/api/socialV2/tts-voices
# 切换
curl -X POST -H "content-type: application/json" -H "x-console-token: <token>" \
     -d '{"voice":"voice2"}' http://127.0.0.1:3100/api/socialV2/tts-voice
# 试听（返回 base64 wav）
curl -X POST -H "content-type: application/json" -H "x-console-token: <token>" \
     -d '{"text":"晚上好呀"}' http://127.0.0.1:3100/api/socialV2/tts-preview
```

改名：改 `ref\voices\voice2\meta.json` 的 `name` 字段即可（下次请求自动生效，不用重启）。

## 配置（`qq-bridge\config.json`）

```jsonc
"socialV2": {
  "tools": { "voiceTts": true },          // 总开关
  "voice": {
    "enabled": true,                      // 语音通道总闸
    "tts": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:3210", // 本地 TTS 服务
      "serviceDir": "C:\\path\\to\\dafiyu-voice", // DSH 自启模块按这个找服务
      "voice": "voice2",                  // 当前音色 id（控制台切换时自动写）
      "voiceName": "音色2",               // 当前音色名（提示词里用这个称呼）
      "timeoutMs": 180000,                // 单句合成超时（CPU/首次加载会慢）
      "maxChars": 120,                    // 单条语音文本上限
      "marker": "[语音]",                  // 触发前缀（全角［语音］/ [voice] 也认）
      "maxPerMinute": 2,                  // 每会话合成语音限流
      "maxPerHour": 10,
      "cacheDir": "audio/.tts",           // 合成产物（自动裁剪到最近 30 个）
      "keepFiles": 30,
      "requireAsk": true,                 // 只在对方明确要语音时才允许开口
      "askWindowMs": 900000               // 「要了语音」的时间窗（15 分钟）
    }
  }
}
```

想临时关掉：把 `socialV2.voice.tts.enabled` 改成 `false`，重启桥接即可（AI 就只会发文字）。

## 安全边界

- 语音只会发到 `allow.private` / `allow.groups` 白名单里的会话，和文字发送同一套闸门。
- 模型只能递「一句话」给桥接，**拿不到任何音频路径 / URL / base64 入口**，不存在拿本机文件外发的通道。
- 合成语音有独立限流（每会话 2/分钟、10/小时），和文字、语音库语音分开计数。
- 音频只在本机生成、存放在本机；参考音来自用户本机缓存，不上传第三方。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| AI 说发了语音但只收到文字 | TTS 服务没开或 OOM：看 `dafiyu-voice\logs\`，`curl http://127.0.0.1:3210/health` |
| 语音内容对不上文字 | 可能还挂着占位 stub（`dafiyu-voice\tts-stub.mjs`），确认真实服务已启动 |
| 音色不像 | 换 `ref\` 里的参考音（`samples/` 里 4~8 秒、语气平稳的段落效果最好） |
| 显存不足 / 合成很慢 | 见 `STATUS.md` 的显存与耗时记录；可降级 IndexTTS-1.5 或 CosyVoice2 |
| 改了 bridge.js 不生效 | `qq-bridge\restart.bat`（提示词注入会随下一次唤醒生效，不需要重启 DSH） |
