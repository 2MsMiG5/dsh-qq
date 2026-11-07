# qq-bridge · QQ ↔ DeepSeek Harness 智能体桥

把 QQ 变成一个大模型智能体的聊天界面：QQ 消息进来自动变成 agent 的提示词，agent 的回复、表情包、图片、语音再自动回到 QQ 里。

仓库同时还带了两个配套件：本地零样本 TTS 服务（`dafiyu-voice`）、Pixeval MCP 连接配置（`pixeval-mcp`）。

> 单进程 24/7 常驻 · Node ESM 无框架 · 零工具聊天预设（成本优先）· 控制台可视化运维

---

## 目录

1. [项目简介与用途](#1-项目简介与用途)
2. [核心功能与特性](#2-核心功能与特性)
3. [技术栈与依赖](#3-技术栈与依赖)
4. [目录结构与模块说明](#4-目录结构与模块说明)
5. [环境配置与安装](#5-环境配置与安装)
6. [运行与使用](#6-运行与使用)
7. [配置项说明](#7-配置项说明)
8. [控制台](#8-控制台)
9. [安全设计](#9-安全设计)
10. [常见问题与排查](#10-常见问题与排查)
11. [已知现状](#11-已知现状)
12. [许可证](#12-许可证)

---

## 1. 项目简介与用途

### 1.1 它是什么

`qq-bridge` 是一个**进程内双向桥接器**，夹在两个外部组件之间：

```
QQ 用户
   │  QQ 消息
   ▼
SnowLuma（OneBot v11 网关，独立进程，闭源）
   │  WebSocket 上行 / HTTP 下行
   ▼
qq-bridge（本项目，Node 进程）
   │  HTTP + WS
   ▼
DeepSeek Harness（DSH，agent 运行时）
   │  模型调用
   ▼
DeepSeek / 任意 OpenAI 兼容模型
```

它的职责不是"做一个 QQ 机器人"，而是**把一个通用 agent 运行时伪装成一个真实的群友**：负责唤醒时机、说话节奏、分条、潜水、记人、发表情、看图和听语音——这些都不是模型本身该操心的事，全部由桥接层代劳。

### 1.2 为什么这么设计

模型每轮 prompt 都是有成本的。传统做法（`qq-chat` 一类带完整工具面的预设）每轮固定前缀约 **23k token**，其中大部分是 49 个 MCP 工具的 schema——而这些工具在"回一句群聊"的场景里基本用不上。

本项目采用的取舍是：**把能力从模型的工具面挪到桥接侧**。

| 能力 | 传统做法 | 本项目做法 |
| --- | --- | --- |
| 发消息 / 分条 | 模型调 `qq_send_message` 工具 | 模型输出纯文本，桥接按行切分发送 |
| 发表情包 | 模型调工具挑表情 | 模型写 `[STICKER:编号]`，桥接查本地表情库 |
| 看图 | 模型调工具取图 | 桥接先调视觉 API 转成文字，再注入 prompt |
| 听语音 | 模型调工具转写 | 桥接先跑 SenseVoice 转写，再注入 prompt |
| 潜水 / 下次唤醒 | 模型调工具设置 | 模型写 `[SILENT]`（全场景）或 `[WAKE:30m]`（仅私聊），桥接记账 |

结果：每轮固定前缀压到 **约 3k token**，模型完全**没有任何工具**（不挂 MCP、不挂文件/命令工具），安全面也同步收窄——模型连"想读本机文件"的可能性都没有。

### 1.3 适用场景

- 想让 AI 以"群友"身份长期待在自己的 QQ 群/私聊里，而不是一个命令式 bot
- 在意每轮 token 成本，希望按条计费而不是按会话计费
- 需要拟人化输出：分条、停顿、表情包、语音条、拍一拍、引用回复
- 需要长期记忆：记得住每个人的称呼、喜好、近况
- 单机自用（Windows 优先），不打算做成多租户 SaaS

### 1.4 不适用场景

- 需要模型执行代码/读写文件/操作系统的场景（聊天预设刻意零工具）
- 需要横向扩展、多实例负载均衡的场景（单实例 + 文件锁，见 `state/bridge.lock`）
- 非 Windows 环境（大量 `.bat` / PowerShell / `icacls` 依赖，逻辑可移植但脚本不行）

---

## 2. 核心功能与特性

### 2.1 双引擎聊天

桥接有两条出话路径，按可用性自动降级：

| 引擎 | 触发条件 | 实现 | 特点 |
| --- | --- | --- | --- |
| **直连**（Track 3） | `socialV2.liteChat.engine` 为 `auto`/`direct` 且有 API Key | 一次 `chat/completions` | 最快最省，无会话开销 |
| **DSH 轻量会话**（Track 2） | 直连不可用或显式指定 `engine: dsh` | `session/create` → `prompt` → `remote.mux` 事件流 | 兜底，保留 DSH 侧的模型路由与日志 |

降级顺序在 `src/lite/direct.js` 头部有明确注释，**顺序不能乱**：直连失败计数超过阈值后整体切到 DSH 会话，DSH 也失败才回 `[SILENT]`。

### 2.2 群聊唤醒与潜水

群聊里的"什么时候该说话"是一套四道闸门的调度（`src/social/wake.js`）：

1. **模式/暂停闸门** —— 当前模式必须是 `reserved2` 且未暂停
2. **防重入** —— 会话已有在途 turn 或排队投递时，只记录 `pendingWakeReasons`，不重复投递
3. **限频** —— 超限时**延后重试**而不是丢弃（丢弃会让有限潜水永久卡在静默态）
4. **批量窗口** —— 6 秒内的连续消息合并成一次唤醒

默认策略是"一直潜水"（`infinite: true`）：只有被 @、被拍一拍、命中唤醒词时才醒，普通消息不触发，也不做概率唤醒。

`[WAKE:30m]` **只在私聊生效**。群聊的 `wakeConfig.mode` 被固定为 `diving`（`src/lite-chat.js` 的 `liteWakeConfig`），`handleLiteTurnEnd` 会直接丢弃这条指令，提示词也不会再教模型写它。这是刻意的：否则模型一句 `[WAKE:30m]` 就能把"一直潜水"改回限时潜水，绕过配置里关掉的普通消息唤醒。

### 2.3 拟人化输出

- **分条**：模型一行一条，桥接按 `send.burstMaxMessages` 与间隔区间发送，带随机长间隔（模拟"想一想"）
- **长文切分**：`src/text/segment.js` 做长度上限与中文空格识别告警，不会把句子从中间劈开
- **节流**：每分钟/每小时发送配额、跨目标发送配额
- **表情包**：本地表情知识库（`state/stickers.json`），支持按 `emoji_id`/`md5`/`url`/备注/标签检索；库内容来自 QQ 账号收藏的同步
- **图片**：两种来源——本地图库随机（带去重轮换）、Pixeval MCP 插图预览
- **语音条**：TTS 合成 → 落盘 → 审计 → 限流 → SILK 转码 → 发送 → 回读确认
- **拍一拍**、**引用回复**：都可作为行内指令由模型触发

### 2.4 多模态输入

| 输入类型 | 处理方式 | 模块 |
| --- | --- | --- |
| 图片 | 归一化（尺寸/格式/GIF 抽帧）→ 视觉 API 转文字 | `media-normalize.js` / `vision-client.js` |
| 语音 | OneBot 取 record → WAV 规整成 16k 单声道 PCM16 → SenseVoice 转写 | `voice-asr.js` / `canonical-wav.js` |
| 视频链接 | B 站/抖音等：元数据 + 字幕 + 弹幕 + 评论 + 音轨 ASR | `video-link.js` |
| 合并转发 | 提取 forward id → 递归展开 → 格式化成紧凑结构 | `forward.js` |
| 分享卡片 | 解析卡片 JSON，识别标题/封面/来源 | `video-link.js` |

### 2.5 记忆系统

分两层，成本递增、命中率递减：

| 层 | 存储 | 注入策略 | 维护者 |
| --- | --- | --- | --- |
| **人物档案** | `state/bridge.db`（`person_profiles` + `person_timeline`） | 每轮只预取当前说话人的**三段概况**，时间线按需读 | AI + 人工 |
| **初始提示词** | `state/initial-prompts.json` | 每个会话首次唤醒时注入 | 操作者手写 |

人物档案的正文在 2026-11 拆成了**结构化字段**（schema v3）：`section_who / section_traits / section_notes` 三列存概况，时间线单开一张 `person_timeline` 表、一条事实一行。这样「预取概况」和「追加一条事实」都不必重写整份档案。控制台提供编辑器；要人工翻查或导出，用 `npm run store:export` 吐回 `.md`。设计意图：记忆越写越多，但每轮 prompt 成本基本不变。

> **两个名字类字段别填混**：`tags` 装**他自己**（称呼、外号、`owner` / `爸爸` 这类关系称谓，以及 `人物` / `群友` / 群号这类分类）；`people` 只装**和他相关的人**（`DarLing`、`信马鸣枪`），是关系网，**不含他自己**。AI 写档案时靠名字找目标，它只查 `tags` 与标题、不查 `people`——因为同一个外号可能既是某人的自称、又是另一个人的关系人，用 `people` 定位必然指错人。

写入分工是刻意的：
- **主回复**只写时间线（`[PERSON:note:<QQ>] 一句话事实`）——它手里只有这一轮，写不出「这个人是谁」；
- **纪要兼职**（每 `summaryEveryTurns` 轮压缩对话时顺带）负责归纳三段概况（`[PERSON:who/traits/notes:<QQ>]`），因为它手里有整段对话和旧概况。

> 旧的 `memory/person-<QQ>.md` 是迁移前快照，**已于 2026-11-04 删除**（副本在 `backups/memory-2026-11-04/`）。库是唯一数据源——在 `memory/` 里放文件也不会再被读取（`person_import_v1` 栅栏已打）。

### 2.6 成本可视化

`src/token-ledger.js` + `src/model-prices.js`：把 DSH 会话事件里的 provider usage 落成"按会话 × 按回合"的可查明细，读取时按 DeepSeek 官方价目表折算金额，**区分高峰/空闲时段**（高峰单价为空闲 2 倍）。

### 2.7 可运维性

- 控制台 HTTP 服务（10 个页面，见 [第 8 节](#8-控制台)）
- 单实例锁（`state/bridge.lock`），双开会直接退出码 2
- 崩溃自动重启（`start.bat` 守护循环，5 秒间隔）
- 离线补投队列（DSH 挂掉期间的消息攒起来，恢复后补发）
- 诊断日志：`state/bridge.log`、`state/qq-activity.log`

### 2.8 QQ 空间动态（授权发布）

让 AI 把群里真实发生的事写成"说说"，但**发不发、发给谁看由操作者决定**。这条链路刻意分成三段，任何一段断了都不会有内容跑到公网：

```
AI（会话令牌）── 提交素材 ──┐
                            ├─ 桥接闸门：授权 / 时段 / 配额 / 审计 ─→ SnowLuma send_qzone_msg
操作者（控制台/CLI）── 批准 ─┘
```

- **授权**是操作者的显式动作（控制台「QQ 空间」页或 `node scripts/qzone.mjs grant`），可设有效期、允许的可见范围、每日/每小时配额、最短间隔、安静时段。AI 只能提交素材，**无法给自己授权、无法改策略、无法覆盖审批开关**——这三条是服务端强制的，不靠前端不显示按钮。
- **待批**是默认状态：AI 提交后挂进队列（默认 10 分钟过期），操作者点"批准"才真的调 `send_qzone_msg`；拒绝只留审计记录。
- **审计**：每次发布/拒绝都追加到 `state/qzone-posts.jsonl`（`state/` 已整体不入库）。

发布参数（AI 与手动发布共用同一套，`src/qzone/index.js` 校验）：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 是 | 正文。渲染后长度 ≤ `maxChars`（默认 1000）。**桥接不改写事实** |
| `topic` | string | 否 | 主题/话题，≤40 字，渲染成 `#话题#` 放在正文最前 |
| `images` | string[] | 否 | 最多 `maxImages`（默认 9）。本地路径须在 `socialV2.image.dirs` 内；也接受 `http(s)://` 与 `base64://` |
| `visibility` | string | 否 | 可见范围（见下表），默认 `defaultVisibility`；必须是已授权的范围 |
| `targetUins` | string[] | 16/128 时必填 | 权限作用 QQ 号数组（可见名单 / 不可见名单） |
| `key` | string | 否 | 会话标识（如 `group:123456`）；仅用于来源标注与记账 |
| `requireApproval` | boolean | 否 | **仅操作者**可传。AI 传了会被静默忽略 |

**可见范围 → `ugc_right`**（取值来自 SnowLuma catalog，不能自己发明）：

| `visibility` | `ugc_right` | 含义 | 需要 `targetUins` |
| --- | --- | --- | --- |
| `public` | 1 | 所有人可见 | 否 |
| `friends` | 4 | 好友可见 | 否 |
| `partial_show` | 16 | 部分好友可见 | 是 |
| `partial_hide` | 128 | 部分好友不可见 | 是 |
| `private` | 64 | 仅自己可见 | 否 |

**渲染规则**：`[#topic#]` + 换行 + `content`，**仅此而已**。渲染做了什么都写在响应的 `notes` 里回给调用方，预览与实际发布走同一个函数，所以"预览看到的就是会发出去的"。

> 情绪参数（`mood`）已于 2026-11-01 移除：它只会在结尾挂一个 emoji，手动发布时纯装饰，AI 起草时又和「语气」提示重复。现在传 `mood` 会直接返回 **400 `MOOD_REMOVED`**（不静默忽略——静默会让调用方以为语气被控制了）。语气请写进正文。

**边界**：正文先过 `SENSITIVE_RE`（本机路径/凭据）与已知会话令牌精确拦截；本地图片只认图库白名单目录（`realpath` 解析，挡软链接逃逸）；图片 URL 走 `safe-fetch` 的 SSRF 预检；发布受每日/每小时配额、最短间隔与安静时段约束。

> **为什么不让 AI 直接调网关**：那样鉴权、审计、限频会散落在模型侧，模型一次幻觉就能连发九宫格。放在桥接侧还有个现实原因——`send_qzone_msg` 只有 `content/images/ugc_right/target_uins` 四个参数，**网关不认识"主题"**，这个话题概念必须在桥接侧渲染进正文。

调用示例（操作者 / CLI；AI 工具面已下线，不再接受会话令牌）：

```bash
curl -X POST http://127.0.0.1:3100/api/qzone/publish \
  -H 'content-type: application/json' \
  -H 'x-console-token: <控制台令牌>' \
  -d '{"key":"group:123456","content":"今天群里聊到很晚，谁也没提睡。","topic":"日常","visibility":"friends"}'
```

操作者侧用 CLI 更省事（凭据自动读 `state/console-token`）：

```bash
node scripts/qzone.mjs grant --hours 24 --approval --visibility friends,private
node scripts/qzone.mjs preview --content "今天群里聊到很晚。" --topic 日常
node scripts/qzone.mjs pending          # 看待批
node scripts/qzone.mjs approve <id>     # 批了才发
node scripts/qzone.mjs revoke --reason "先停一停"
```

**AI 起草**（`POST /api/qzone/draft`）：把素材交给模型写成一条说说。它**不要求发布授权**——没有外部副作用，只是多一次模型调用；真正落地仍要走 `publish` 的完整闸门（授权 / 时段 / 配额 / 审批）。模型写出来的文本同样过 `SENSITIVE_RE`，不会因为"是 AI 写的"就免检。

起草参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `hint` | 否 | 素材：今天真实发生了什么。留空＝让它自己写一条日常 |
| `topic` | 否 | 写作方向。**不写进正文**——`#话题#` 仍由桥接渲染 |
| `style` | 否 | 这一次的附加要求（更克制 / 更俏皮） |
| `role` | 否 | 指定人格名（存在 `state/bridge.db` 的 `roles` 表）。**留空＝当前激活的人格卡** |
| `persona` | 否 | 这一次追加的人设补充，**叠加**在人格卡之上 |
| `key` | AI 必填 | 会话标识，用于校验令牌归属 |

**人设从哪来**：三层叠加——① 人格卡（当前激活的那张，与聊天注入的是**同一份文本**，同一套 `〔一代〕/〔二代〕` 筛选与注入上限截断）；② `socialV2.qzone.aiDraft.persona` 长期补充；③ 本次请求的 `persona`。响应里的 `meta.persona` 会写明用了谁、多少字、来源是 `current` / `role` / `config` / `none`。

> **为什么 `persona` 只能叠加、不能替换人格卡**：人格卡是"这个人是谁"，不是一次性设定。允许一次调用把它整个换掉，等于让任何人都能顶着它的名义发说说。要换人就用 `role` 显式指定——那是操作者的决定，不是调用方的。

```bash
node scripts/qzone.mjs draft --hint "群里聊到很晚，谁也没提睡" --topic 日常
node scripts/qzone.mjs draft --hint "…" --role 傲娇助手      # 换一张人格卡来写
node scripts/qzone.mjs draft --hint "…" --publish            # 写完后自动提交（照旧进待批）
```

> **为什么聊天用 low、起草用 high**：聊天每轮只说一句话，high 的边际收益很低，纯粹烧 token；而一条说说会挂在空间里被所有人看见，是一次性、低频、重质量的任务。两者共用同一个 `reasoningEffort` 只会互相拖累，所以起草单独配 `socialV2.qzone.aiDraft.reasoningEffort`（默认 `high`）。

离线自检：`npm run check:qzone` —— `check-qzone.mjs` 52 条（闸门与 HTTP 鉴权）+ `check-qzone-draft.mjs` 62 条（起草档位、人设来源、清洗与花费归属）。都不联网、不碰真实 QQ。

> **接入前提（重要，别跳过）**：`reserved2`（群聊仿真）是**零工具**预设，模型本身没有任何工具，也调不到 HTTP。AI 工具面（含 `/api/qzone/*` 的 agent 通道）已于 2026-11-06 随工具面一起下线。所以 QQ 空间只保留**操作者路径**：
>
> 1. 控制台「QQ 空间」页：起草、预览、发布、授权、审批；
> 2. `scripts/qzone.mjs`：命令行等价入口。
>
> 零工具模式下**不要**在人格卡或提示词里写"你可以发说说"：模型没有工具，只会用文字声称自己发了，实际上什么也不会发生。

---

## 3. 技术栈与依赖

### 3.1 运行时

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.13.0** | 见 `package.json` 的 `engines` |
| 模块系统 | 纯 ESM | `"type": "module"`，全部 `import` |
| 操作系统 | Windows 10/11（推荐） | 脚本层重度依赖 `.bat` / PowerShell / `icacls` |
| 内存 | ≥ 2 GB 可用 | 桥接本身很轻；TTS 服务另需约 5 GB 显存 |

### 3.2 Node 依赖

```jsonc
{
  "@deepseek-ai/dsh-host-apiproxy": "0.1.1-rc.2",  // DSH Web API 客户端基类（dsh-client.js 继承它）
  "@deepseek-ai/schemastery":       "^3.18.1",    // DSH 插件配置 schema（qq-agent bundle 用）
  "@snowluma/sdk":                  "^1.14.20",   // SnowLuma OneBot 客户端（12 处 import）
  "js-yaml":                        "^4.3.2"      // patch / 预设 YAML
}
```

依赖只有四个。`@snowluma/mcp`（旧 QQ MCP 工具面）已随工具面一起移除，`@modelcontextprotocol/sdk` 与 `zod` 也随之不再安装——代码里从来没有 import 过它们。

> Pixeval 图源（`src/image-source.js`）是**手写的** Streamable HTTP 客户端（自己解 JSON/SSE 帧），没有走官方 MCP SDK。

**`postinstall` 会自动跑 `scripts/patch-snowluma-sdk.mjs`**：修复 `@snowluma/*` 包 `dist` 内相对导入缺 `.js` 扩展名的问题（bundler 能解析、纯 Node ESM 不能）。这是必需的，不跑会直接 `ERR_MODULE_NOT_FOUND`。

`.npmrc` 里设了 `legacy-peer-deps=true`，避免 peer 依赖冲突阻断安装。

### 3.3 外部组件

| 组件 | 作用 | 必需性 |
| --- | --- | --- |
| **SnowLuma** | OneBot v11 网关，负责登录 QQ、收发消息 | **必需**（闭源，需自行安装并登录） |
| **DeepSeek Harness（DSH）** | agent 运行时：会话、prompt、事件流、settings | **必需**（DSH 直连引擎可降级，但 settings/预设仍需它） |
| **ffmpeg / ffprobe** | 音频探测、转码、视频音轨抽取 | 语音/视频功能需要 |
| **IndexTTS-2**（自行 clone 到 `dafiyu-voice/index-tts/`） | 本地零样本 TTS | 可选（语音条功能需要） |
| **Pixeval**（`pixeval-mcp/`） | 插图搜索/排行榜/收藏，供发图用 | 可选 |

### 3.4 大模型

| 用途 | 默认 | 配置键 |
| --- | --- | --- |
| 聊天（直连引擎） | `deepseek-flash` | `socialV2.liteChat.model` |
| 聊天（DSH 兜底） | `deepseek-flash` | `dsh.model` |
| 识图 | `deepseek-flash` | `vision.model` |
| 语音转写 | SenseVoice（本地） | `voice.asr.providerId` |

API Key 支持三种来源，优先级从高到低：配置文件里的 `apiKey` → 环境变量（如 `DEEPSEEK_API_KEY`）→ DSH 侧凭据。

### 3.5 Python 侧（`dafiyu-voice`，可选）

IndexTTS-2 源码**不随本仓库分发**（其许可是 bilibili Model Use License，不是 MIT）。先 clone 到 `dafiyu-voice/index-tts/`：

```bash
cd dafiyu-voice
git clone https://github.com/index-tts/index-tts.git
```

推理依赖见 `dafiyu-voice/requirements-dafiyu.txt`：`torch` + `torchaudio`（cu128 wheel，需单独装）、`transformers==4.52.1`、`librosa`、`numba==0.63.0`、`wetext`、`cn2an` 等。刻意**不含** `deepspeed` / `flash-attn` / `WeTextProcessing`——Windows 上装不动。

---

## 4. 目录结构与模块说明

### 4.1 仓库整体

```
C:\dsh-qq\                          # 仓库根（git 仓库在这里）
├── qq-bridge\                      # ★ 主项目：QQ ↔ DSH 桥接
├── dafiyu-voice\                   # 配套：本地零样本 TTS 服务
│   └── index-tts\                  # 第三方模型源码（自行 clone，不入库）
├── pixeval-mcp\                    # 配套：Pixeval MCP 连接配置（无 JS 代码）
└── .gitignore                      # 仓库级忽略规则
```

### 4.2 `qq-bridge/` 顶层

```
qq-bridge/
├── src\                            # 全部源码（71 个文件，约 30.3k 行）
├── scripts\                        # 运维/探测/校验脚本（48 个文件，约 9.9k 行）
├── plugins\qq-agent\               # 唯一的 DSH bundle（预设 + 守卫 + 模式 + 自启）
├── dsh\agent-presets\qq-chat-lite\ # agent preset 权威源（YAML）
├── public\console.html             # 控制台单页（约 5.9k 行，零构建）
├── roles\                          # 人格卡（已迁入 SQLite；这里的 .md 是迁移前快照）
├── state\                          # 运行时状态（不入库，含 bridge.db）
├── memory\                         # 人物档案目录（只剩 .trash/ 删除备份；旧 .md 已清空）
├── audio\                          # 语音素材与 TTS 缓存（不入库）
├── config.json                     # 本机配置（不入库）
├── config.example.json             # 配置模板（入库）
├── package.json                    # 依赖与脚本
├── LICENSE                         # MIT
├── start.bat                       # 启动（带守护循环）
├── restart.bat                     # 重启（先杀干净再起）
├── stop-qq-bridge.cmd / .mjs       # 彻底停止（连守护窗口一起杀）
├── start-dsh-desktop.cmd           # DSH Desktop 场景专用启动（先同步端口）
└── sync-dsh-port.mjs               # 把 config.dsh.baseUrl 对齐到 DSH 实际端口
```

### 4.3 `src/` 分层

`src/bridge.js` 是装配层（约 3.1k 行），负责：读配置 → 建服务 → 绑依赖 → 连 SnowLuma → 进事件泵。**业务逻辑已按领域拆到子模块**，装配层只做接线。

```
src/
├── bridge.js                 装配与总控（boot / main）
├── dsh-client.js             DSH Web API 客户端（slash-RPC + Cookie 鉴权 + remote.mux）
├── model-client.js           DeepSeek 直连客户端（chat/completions）
├── vision-client.js          识图客户端（OpenAI 兼容视觉 API）
├── voice-asr.js              语音转写（SenseVoice）
├── canonical-wav.js          WAV 规整成 16k mono PCM16
├── video-link.js             视频链接理解（B 站/抖音/分享卡片）
├── safe-fetch.js             SSRF 安全的只读 HTTP 抓取 + 共享 withTimeout
├── sensitive.js              敏感信息审计正则（路径/凭据）
├── md-to-plain.js            Markdown → QQ 纯文本
├── forward.js                合并转发解析
├── image-source.js           图片来源（本地图库 / Pixeval）
├── media-normalize.js        媒体归一化（体积/像素/GIF 抽帧）
├── diag-log.js               用户反馈日志读写
├── model-prices.js           价目表与峰谷分时
├── token-ledger.js           token 账本
├── preset-prompt.js          仿真提示词的读取与安全改写
├── role-card.js              人格卡解析与按模式取用
├── role-store.js             人格卡存储（SQLite 表 roles）
├── person-memory.js          人物档案（SQLite 表 person_profiles + 格式化）
├── db.js                     SQLite 连接、建表、schema 迁移与事务
├── person-sections.js        档案正文的结构化拆分/渲染（纯函数：三段 + 时间线）
├── sticker-lib.js            表情库
├── voice-core.js             语音发送共享内核（纯工具，无副作用；唯一实现）
├── v2-wait.js                等待/结束回合的轻量判断
├── lite-chat.js              轻量聊天纯函数（回复解析/快照/唤醒配置）
├── lite-context.js           上下文压缩（历史裁剪/滚动纪要）
├── snowluma-conn.js          SnowLuma 连接自发现（token 按账号分文件）
├── snowluma-panel.js         SnowLuma 只读面板数据
├── self-test.js              DSH 链路自测（不依赖 QQ）
├── state-acl.mjs             state/ 目录 ACL 收紧（唯一实现）
│
├── conn\monitor.js           连接存活探测（DSH 端口重发现 / SnowLuma 健康）
├── mux\ingest.js             ★ 入站：QQ 消息 → DSH / 仿真状态
├── mux\pump.js               ★ 出站主循环：DSH 事件流 → QQ 消息
│
├── lite\direct.js            直连引擎（不建 DSH 会话）
├── lite\media.js             lite 引擎的媒体层（识图/转写/表情索引）
├── lite\prompt.js            唤醒提示词组装
│
├── send\index.js             发送函数簇（延迟绑定）
├── send\outbound.js          出站文本：审计 → 分段 → 发送链 → 失败标记
├── send\queue.js             出站发送链（全进程唯一，保证顺序）
├── send\retry-queue.js       离线补投队列（DSH 不可用时攒消息）
│
├── social\wake.js            唤醒调度与投递
├── social\proactive.js       主动私聊（与群聊 proactive 分开，语义相反）
├── social\v2-store.js        二代状态层（social-v2.json 唯一读写出口）
├── social\v2-read.js         已读水位原语
├── social\record.js          社交记录
├── social\mention.js         「是不是在跟 AI 说话」的纯文本判定
│
├── session\ensure.js         会话保障（建会话 / 选模型）
├── session\usage.js          会话用量与断线回合重建
├── mode\index.js             ★ 模式总开关（chat/closed-agent/reserved/reserved2 → 会话策略）
├── person\index.js           人物档案这一层（索引/focus/读写，存储走 bridge.db）
├── sticker\index.js          表情服务
├── voice\send.js             语音条全链路（合成→落盘→审计→限流→发送→回读）
├── voice\tts.js              TTS 合成、缓存轮转、「[语音]」标记解析
├── text\segment.js           文本整形（分条规划/长段切分/中文空格）
├── initial-prompt\index.js   初始提示词存储
│
└── http\                     控制台 HTTP 层（从单体拆出）
    ├── server.js             入口、安全闸门、分发、监听
    ├── router.js             两段式路由（精确 Map + 动态前缀）
    ├── auth.js               令牌比对
    ├── security-headers.js   统一安全响应头
    └── routes\
        ├── social-v2.js      12 个 /api/socialV2/* 控制台端点（AI 工具端点已下线）
        ├── platform.js       模式/会话/发送/重启等平台端点
        ├── media.js          试发与语音发送（操作者通道）
        ├── persona.js        人格卡、人物档案与预设提示词端点
        └── dsh.js            DSH 模型/思考强度/预设端点
```

### 4.4 关键模块补充说明

**`mux/pump.js`（主循环）** —— 唯一一个永不返回的函数。把 mux 帧翻译成 QQ 消息，同时维护 turn 生命周期（`session/snapshot`、`session/event`、`tool/call`、`tool/result`、turn 收尾）。这是整个仓库最难读、最容易被误改的一处。

**`mux/ingest.js`（入站分叉）** —— `handleIncoming` 单函数 345 行、阅读 28 个闭包状态，私聊/群聊、@ 与回复、好友申请、视频链接、媒体、黑名单、唤醒触发、排队退避全在这里分叉。

**`mode/index.js`（总开关）** —— 决定用哪个 preset 建会话、哪些 key 允许收发、旧会话该不该退役。判定逻辑分散在 DSH settings、`state/mode.json`、环境变量、控制台四个入口，所以必须集中。

**延迟绑定模式** —— `send/`、`social/record.js`、`media/inbound.js`、`sticker/`、`session/ensure.js` 这些"函数簇"模块采用工厂 + `bind(deps)`：因为它们的依赖（`bot`、`handles`）要到 boot 尾部才创建，工厂创建时解构会撞 TDZ。

### 4.5 `state/` 运行时数据

**全部不入库**，删掉相当于重置 AI 的上下文。但 `bridge.db` 例外——它存着人物档案与人格卡，删掉就是**永久丢失**（删前先 `npm run store:export` 导出一份）。

| 文件 | 内容 | 可否删除 |
| --- | --- | --- |
| `bridge.db` | **SQLite 主库**：人物档案（`person_profiles`）与人格卡（`roles`） | 会丢长期记忆与人格卡 |
| `sessions.json` | QQ 会话 ↔ DSH sessionId 映射 | 会丢上下文 |
| `social-v2.json` | 二代仿真状态：消息缓冲、唤醒配置、滚动纪要 | 会丢上下文与人味 |
| `initial-prompts.json` | 操作者手写的初始提示词 | **别删**（配置类） |
| `mode.json` | 当前模式（DSH 不可用时的本地回退） | 安全 |
| `current-role.json` | 当前启用的人格卡 | 安全 |
| `stickers.json` | 表情库 | 会丢收藏 |
| `token-usage.jsonl` | token 账本（JSONL） | 会丢花费记录 |
| `feedback.json` | 用户反馈 | 安全 |
| `bridge.lock` | 单实例锁（内容为 PID） | 仅在确认无进程时删 |
| `console-token` | 控制台令牌（自动生成） | 会重新生成 |
| `bridge.log` / `qq-activity.log` | 运行日志 | 安全 |

### 4.6 `scripts/` 常用脚本

**安装与装配**

| 脚本 | 作用 |
| --- | --- |
| `setup-dsh.mjs [profile]` | 把 `qq-agent` bundle 装进 DSH profile（幂等，会备份被覆盖的文件） |
| `build-agent-preset-patches.mjs` | 从 `dsh/agent-presets/` 权威源生成 patch |
| `render-bundle-patch.mjs` | 生成 bundle 的 `cordis.patch.yml` |
| `patch-snowluma-sdk.mjs` | postinstall：修 `@snowluma/*` 的 ESM 扩展名 |

**校验与审计**

| 脚本 | 作用 |
| --- | --- |
| `audit-bridge-harness.mjs` | 在临时目录 + 假 peer 上跑真实 bridge 初始化（不碰生产配置/QQ/DSH） |
| `verify-dsh-021-adaptation.mjs` | DSH 协议适配校验 |
| `verify-persona-config.mjs` | 人格配置校验 |
| `privacy-scan.mjs` | 发布前隐私扫描（扫真实 QQ 号/路径/令牌，**离线只读**） |
| `diagnose-acl.mjs` / `harden-state-acl.mjs` | `state/` 目录 ACL 诊断与收紧 |

**探测与运维**

| 脚本 | 作用 |
| --- | --- |
| `check-onebot-status.mjs` | SnowLuma 连通性 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | DSH 协议与设置探测 |
| `probe-auth.mjs` / `probe-models.mjs` / `probe-workspace.mjs` | 鉴权 / 模型清单 / 工作区 |
| `probe-snowluma-heartbeat.mjs` | SnowLuma 心跳 |
| `probe-pixeval.mjs` | Pixeval MCP 连通性 |
| `send-test-group.mjs` / `send-voice.mjs` | 测试发消息 / 发语音 |
| `scan-dsh-tool-names.mjs` | 抽取 DSH 全部工具名（升级对账用） |
| `analyze-coupling.mjs` / `analyze-http.mjs` | 耦合度 / HTTP 分层分析 |

**重构辅助**（一批一次性工具，保留供复用）

`extract-module.mjs`、`plan-extract.mjs`、`check-extract.mjs`、`split-http.mjs`、`check-http-split.mjs`、`gen-wiring-manifest.mjs`、`plan-state-ownership.mjs`、`build-http-server.mjs`。

### 4.7 `plugins/qq-agent/`（唯一的 DSH bundle）

一个包同时提供四件事：

| 模块 | 作用 |
| --- | --- |
| `presets/qq-chat-lite.patch.yml` | 轻量聊天预设（零工具、约 3k 前缀） |
| `qq-tool-restrict-lite.mjs` | 零工具守卫：注册期 `allow:[]` 清空工具面，执行期拒绝任何工具调用 |
| `lib/mode.js` | `qq-mode` 设置命名空间（DSH 设置页里切模式 / 配 ownerQQ） |
| `lib/autostart.js` | DSH 启动时拉起 SnowLuma + 桥接 + TTS，退出时一起停 |

`autostart.js` 有两条硬约束：`apply()` 必须**立刻返回**（TTS 要加载约 60 秒，只能后台跑），任何异常都必须**吞掉**（自启失败不能让 DSH 起不来）。它只启动"用户自己已经装好"的副本，不修改 SnowLuma 配置、不做部署——SnowLuma 的 EULA 禁止后者。

### 4.8 配置与代码的分层

| 层 | 位置 | 管什么 | 谁维护 | 生效时机 |
| --- | --- | --- | --- | --- |
| 仿真提示词 | `dsh/agent-presets/qq-chat-lite/agent.cordis.yml` 的 `persona.prefix` | **行为**：怎么输出、怎么分条、怎么潜水、怎么像真人 | 开发者 | 直连下一轮 / 重启 DSH |
| 人格卡 | `state/bridge.db` 的 `roles` 表（正文仍是 Markdown） | **人设**：是谁、什么性格、什么语气、什么梗 | 操作者 / 控制台 | **下一条消息即生效** |
| 运行配置 | `config.json` | 引擎、模型、开关、限额 | 操作者 / 控制台 | 部分需重启桥接 |
| 会话状态 | `state/*.json` | 唤醒、配额、待批、账本 | 桥接 / 控制台 | 实时 |

**行为只写仿真层，人设只写人格卡。** 同一条规则写两处，模型会挑好演的那条执行——`persona.prefix` 里的 `【像真人】` 段是行为规则的唯一出处（说话长度、分条、潜水、括号内心戏、AI 腔黑名单都在那里），人格卡只保留身份与语气。详细规范见 `roles/README.md`。

---

## 5. 环境配置与安装

### 5.1 前置准备

#### ① Node.js ≥ 22.13.0

```bash
node -v   # 必须 v22.13.0 或更高
```

#### ② SnowLuma

1. 下载并安装 SnowLuma（闭源，自行获取）
2. 启动并**登录你的 QQ 账号**
3. 打开 OneBot v11 服务：HTTP 监听 `3000`，WebSocket 监听 `3001`（可改，但要同步配置）
4. 记录对应账号的 `accessToken`（OneBot 配置在 `<SnowLuma>/config/onebot_<QQ号>.json`）

> 换账号后 token 会变。桥接有自发现机制（`src/snowluma-conn.js`），但仍建议确认一下。

#### ③ DeepSeek Harness（DSH）

1. 安装 DSH（Desktop 版或 Web 版）
2. 启动，确认 Web API 可访问（Desktop 版是随机端口，见下）
3. 记录 DSH 根目录（默认 `~/.dsh`，即 `C:\Users\<你>\.dsh`）

**Desktop 版注意**：DSH Desktop 用 `--port 0` 启动，**每次启动端口都不同**。桥接是外部进程，只能按 `config.json` 的 `dsh.baseUrl` 找它。所以要用 `start-dsh-desktop.cmd`（它会先跑 `sync-dsh-port.mjs` 对齐端口），或者依赖桥接自己的"端口自动跟随"。

#### ④ ffmpeg（语音/视频功能需要）

```bash
ffmpeg -version
ffprobe -version
```

没进 `PATH` 的话，在 `config.json` 里填 `socialV2.voice.ffmpegPath` 与 `video.ffmpegPath`，或设环境变量 `FFMPEG_PATH` / `FFPROBE_PATH`。

### 5.2 安装步骤

```bash
# 1. 进入主项目
cd C:\dsh-qq\qq-bridge

# 2. 安装依赖（postinstall 会自动修补 @snowluma 的 ESM 导入）
npm install

# 3. 生成配置文件
copy config.example.json config.json
#    然后编辑 config.json，至少填：snowluma.accessToken、allow.private / allow.groups

# 4. 把 qq-agent bundle 装进 DSH profile
node scripts/setup-dsh.mjs web
#    DSH_HOME 不是默认值时：set DSH_HOME=C:\path\to\.dsh && node scripts/setup-dsh.mjs web

# 5. 自检 DSH 链路（不依赖 QQ）
node src/self-test.js

# 6. 启动
start.bat
```

`setup-dsh.mjs` 是**幂等**的，会做四件事：重新生成 patch 文件、注册 `qq-agent` 到 profile 的 `package.json`、清理历史遗留的 MCP 条目、维护 `node_modules` junction。重复跑不会坏事，每次覆盖前会打时间戳备份（保留最近 5 份）。

### 5.3 可选组件安装

**本地 TTS（`dafiyu-voice`）**

```bash
cd C:\dsh-qq\dafiyu-voice

# 第三方模型源码不在仓库里，先 clone
git clone https://github.com/index-tts/index-tts.git

# Python 环境（建议 3.10/3.11）
python -m venv env
env\Scripts\activate

# torch 单独装 cu128 wheel（见 PyTorch 官网），然后：
pip install -r requirements-dafiyu.txt

# 放模型与参考音
#   models\IndexTTS-2\    ← 模型权重
#   ref\voices\<id>\ref.wav + meta.json   ← 参考音

# 启动（监听 127.0.0.1:3210）
env\Scripts\python.exe server.py
```

装好后**不必手动启**——`qq-agent` 的自启模块会在 DSH 启动时拉起它，DSH 退出时一起停。也可以在 `config.json` 里关掉 `socialV2.voice.tts.enabled`。

**Pixeval MCP（`pixeval-mcp`）**

1. Pixeval ≥ 5.0.0（Avalonia 重写版才有 MCP）
2. Pixeval → 设置 → **MCP** → 打开「启用 MCP 服务器」（默认关闭），端口默认 `52163`
3. 把 `pixeval-mcp` 作为 bundle 装进 DSH profile

详见 `pixeval-mcp/README.md`。

---

## 6. 运行与使用

### 6.1 启动

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 日常（DSH Desktop） | `start-dsh-desktop.cmd` | 先同步 DSH 端口，再启桥接 |
| 日常（DSH Web / 固定端口） | `start.bat` | 带守护循环，崩溃 5 秒后重启 |
| DSH 托管 | 不用管 | DSH 启动时自动拉起 SnowLuma + 桥接 + TTS |
| 前台调试 | `node src/bridge.js` | 日志直接打到终端，Ctrl+C 停止 |

**启动顺序**（自动化时注意）：SnowLuma → DSH → qq-bridge。桥接会在 DSH 不可用时限频重试，所以顺序错了也能自己恢复，只是慢一点。

### 6.2 停止

```bash
stop-qq-bridge.cmd            # 或 node stop-qq-bridge.mjs
```

必须用这个，不要只关窗口：`start.bat` 的守护循环会在 5 秒后把桥接重新拉起来。

脚本的顺序是**先停桥接、再杀守护，最后清锁文件**：它先 `POST /api/shutdown` 请桥接自己体面退出（走正常的 `process.exit(0)`），等进程真的消失后才 `taskkill` 守护循环——顺序反了的话，`taskkill /T` 会把还没退完的桥接一起强杀。这一步不只是礼貌：SQLite 的 WAL 只在正常关闭时 checkpoint，强杀会让真实数据全留在 `state/bridge.db-wal` 里（主库只有 1 页/4 KB），此时只拷 `bridge.db` 的备份等于拿到空壳。

端点不可用（没有 `state/console-token`、端口不通）时脚本会退回强杀，并明确提示 WAL 可能残留。

### 6.3 重启

```bash
restart.bat
```

改过 `config.json` 或 `src/` 下的代码后用它。它会先按 PID（读 `state/bridge.lock`）+ 命令行的 `*bridge.js*` 兜底两条路杀干净，确认进程真的退出后才删锁、再启新的——避免双实例互相抢消息、互相覆盖 `state/`。

### 6.4 首次使用检查清单

- [ ] 日志里出现 `控制台 http://127.0.0.1:3100`
- [ ] 日志里没有 `白名单为空且 allowAllWhenEmpty=false`
- [ ] 控制台「总览」页三个指标都是绿的（DSH / SnowLuma / 模式）
- [ ] 私聊机器人发一句「在吗」，能收到回复
- [ ] 群里 @ 一下，能收到回复

### 6.5 白名单（最容易踩的坑）

**默认不响应任何人。** `allow.private` / `allow.groups` 为空且 `allowAllWhenEmpty: false` 时，桥接不会处理任何 QQ 消息。

```jsonc
{
  "allow": {
    "private": [123456789],      // 允许私聊的 QQ 号
    "groups": [987654321]        // 允许的群号
  },
  "deny": {
    "private": [],
    "groups": []
  },
  "allowAllWhenEmpty": false
}
```

`deny` 优先级高于 `allow`。测试期可以临时把 `allowAllWhenEmpty` 设成 `true`，但**别长期开着**。

### 6.6 切换模式

两种有效模式（历史拼写会自动归一）：

| 模式 | 含义 | 会话 preset |
| --- | --- | --- |
| `reserved2`（别名 `chat` / `reserved` / `simulation`） | 群聊仿真：潜水 + 唤醒 + 人味输出 | `qq-chat-lite`（零工具） |
| `closed-agent` | 封闭 agent：**仅管理员私聊**可用，带完整工具 | DSH 默认 preset |

切换方式（三选一，优先级从高到低）：控制台「总览」页 → DSH 设置页的 `qq-mode` → `state/mode.json`。

> `ownerQQ` 留空表示**保留 `config.json` 里的值**，不会被设置页抹掉。

### 6.7 启用人格卡

对机器人说 `进入角色扮演：<角色名>`，或在控制台「人格与角色」页点选/新建。

人格卡存在 `state/bridge.db` 的 `roles` 表里，**角色名就是表的主键**（中英文均可，不能用 `README` 或 Windows 保留名）。默认每条消息最多注入 8000 字符（`role.maxInjectChars`）。写卡规范见 `roles/README.md`。

**一个人格 = 一套人设 + 一套声音。** 音色（TTS）与唤醒词都在「人格与角色」页随人格设置，存在 `roles` 表的同一条记录里：

- 人格设了音色 → AI 发语音就用它，`voiceTtsCfg()` 读取时叠加，不写回 `config.json`；
- 人格设了唤醒词 → 作为该人格的默认唤醒条件（新建会话、以及仍用默认唤醒配置的会话）；
- 任一项留空 → 跟随 `config.json` 的全局默认（`socialV2.voice.tts.voice` / `socialV2.wake.recommendedKeywords`）。

切换人格时只刷新「还在用默认唤醒配置」的会话；AI 或管理员显式设过唤醒条件的会话保持原样。改名会连声音设定一起搬走，删除人格则一并消失。

> 改造前放在 `roles/*.md` 的卡已自动导入，原文件保留但不再被读取。要人工编辑或版本对比，用 `npm run store:export` 导出成 `.md`。

### 6.8 常用运维命令

```bash
node src/self-test.js                    # DSH 链路自测（建临时会话，跑完归档删除）
node scripts/check-onebot-status.mjs     # SnowLuma 连通性
node scripts/audit-bridge-harness.mjs    # 全链路静态审计（临时目录，不碰生产）
node scripts/privacy-scan.mjs            # 发布前隐私扫描
node scripts/diagnose-acl.mjs            # state/ 权限诊断
node scripts/send-test-group.mjs         # 发一条测试群消息
```

---

## 7. 配置项说明

配置全部集中在 `qq-bridge/config.json`（由 `config.example.json` 复制而来，不入库）。下面按分组说明，**默认值取自 `config.example.json`**。

### 7.1 DSH 连接

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dsh.baseUrl` | `http://127.0.0.1:3080` | DSH Web API 地址。Desktop 版每次启动端口会变 |
| `dsh.provider` | `deepseek-official` | provider 标识 |
| `dsh.model` | `deepseek-flash` | DSH 侧默认模型 |
| `dsh.reasoningEffort` | `low` | 思考强度（`low`/`high`/`max`） |
| `dsh.authToken` | `""` | 留空则自动发现（环境变量 `DSH_LAUNCH_TOKEN` → 启动日志里的 `?token=`） |
| `dsh.authHeader` | `authorization` | 鉴权头名 |
| `dsh.authPrefix` | `Bearer` | 鉴权头前缀 |
| `dsh.allowRemote` | `false` | 是否允许连非本机 DSH（**默认禁**，安全边界） |

### 7.2 SnowLuma 连接

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | OneBot WebSocket（上行） |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | OneBot HTTP（下行） |
| `snowluma.accessToken` | `""` | 按账号分文件、HTTP 与 WS 的 token 还不一样；留空则尝试自发现 |
| `snowluma.followDiscoveredEndpoint` | `true` | 是否跟随自发现的端点 |
| `snowluma.silenceWarnMs` | `600000` | 上游静默多久打警告（10 分钟） |
| `snowluma.launcherPath` / `homeDir` | `""` | SnowLuma 安装位置（自启用） |

### 7.3 访问控制

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `allow.private` / `allow.groups` | `[]` | 白名单。**空 + `allowAllWhenEmpty=false` = 不响应任何人** |
| `deny.private` / `deny.groups` | `[]` | 黑名单，优先级高于白名单 |
| `allowAllWhenEmpty` | `false` | 白名单为空时是否放行全部（**别长期开**） |
| `ownerQQ` | `null` | 管理员 QQ，`closed-agent` 模式与审批/提问都必须有它 |
| `security.interceptNotify` | `true` | 拦截入站的系统通知类消息 |

### 7.4 会话与输出

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `agentPreset` | `qq-chat-lite` | 建会话用的 preset |
| `workspaceTitle` | `QQ 聊天` | DSH 工作区标题 |
| `sessionCwd` | `""` | 会话工作目录（留空用 DSH 默认） |
| `ackMessage` | `🤔 收到，正在思考…` | 兜底路径的"已收到"提示，留空则不发 |
| `sendDelayMs` | `300` | 单条发送间隔基数（毫秒） |
| `questionTimeoutMs` | `300000` | 向用户提问的等待上限（5 分钟） |
| `role.maxInjectChars` | `8000` | 人格卡每条消息注入上限（1000~20000） |

### 7.5 控制台

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `consolePort` | `3100` | 控制台监听端口 |
| `consoleToken` | `""` | 留空则自动生成并持久化到 `state/console-token`。配置了就必须 16~128 位 `[A-Za-z0-9_-]` |

### 7.6 成本核算

| 键 | 说明 |
| --- | --- |
| `pricing.models.<模型名>` | 自定义价目表，单位元/百万 token。形如 `{ label, off: { cacheHit, cacheMiss, output }, peak?: {...} }` |

DeepSeek 官方模型已内置价目表（见 `src/model-prices.js`），这里只用于中转/自建模型。

### 7.7 聊天引擎（`socialV2.liteChat`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `engine` | `auto` | `auto` / `direct` / `dsh`。`auto` 时有 key 走直连，失败降级 |
| `model` | `deepseek-flash` | 直连模型 |
| `apiKey` | `""` | 留空则找 `DEEPSEEK_API_KEY` |
| `keys` | `[]` | 多 key 轮换（配额用尽时切换） |
| `thinking.private` / `thinking.group` | `low` | 思考强度，私聊/群聊分开配 |
| `maxTokens` | `0` | 0 = 跟思考状态自动（开 4096 / 关 2048） |
| `maxMessages` / `historyMessages` | `2` / `36` | 单轮最多发几条 / 带多少条历史 |
| `historyMaxAgeMs` / `historyMaxChars` | `7200000` / `5000` | 历史窗口的时间与字符预算 |
| `summaryEnabled` | `true` | 滚动对话纪要（保连续性，省 token） |
| `summaryEveryTurns` / `summaryMaxChars` | `8` / `300` | 每 8 轮压一次纪要，纪要上限 300 字 |
| `groupWakeProbability` | `0` | 群聊概率唤醒（默认关，潜水策略） |
| `maxImagesPerReply` / `maxVoicesPerReply` 等 | `1` | 每次回复的各类媒体上限 |

### 7.8 唤醒与潜水（`socialV2.wake`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultMode` | `diving` | 默认策略：潜水 |
| `batchWindowMs` | `6000` | 连续消息合并窗口 |
| `maxWakePerMinute` / `maxWakePerHour` | `1` / `12` | 唤醒限频（超限延后，不丢弃） |
| `preSleepWaitEnabled` / `preSleepWaitMs` | `true` / `300000` | 睡前的"再看一眼"等待 |
| `staleChatMinutes` / `staleSilentMinutes` | `10` / `120` | 判定会话冷掉的阈值 |
| `sleepMinMs` / `sleepMaxMs` | `60000` / `0` | 有限潜水的睡眠区间（`max=0` 表示不设上限） |
| `noActionLimit` | `3` | 连续 N 次无动作后收敛 |
| `recommendedKeywords` | 见配置 | 全局唤醒词（"小鲸鱼"、"DeepSeek"、"D老师"…）；**当前人格设了自己的唤醒词时以人格为准** |
| `recommendedAtMention` / `recommendedPoke` | `true` / `true` | @ 和拍一拍是否唤醒 |

> `recommendedHint` 那段中文是**写给模型看的默认策略说明**，会进 prompt。改默认值时要连这段一起改，否则模型的自述会和实际策略打架。

### 7.9 发送节奏（`socialV2.send`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `burstEnabled` | `true` | 分条发送 |
| `burstMaxMessages` | `8` | 一次最多拆几条 |
| `burstIntervalMinMs` / `MaxMs` | `1000` / `3000` | 条间间隔区间 |
| `longGapProbability` | `0.2` | 长间隔概率 |
| `longGapMinMs` / `MaxMs` | `5000` / `10000` | 长间隔区间 |
| `maxSendPerMinute` / `maxSendPerHour` | `8` / `60` | 发送配额 |
| `maxMessageChars` | `500` | 单条上限 |
| `gapBaseMs` / `gapPerCharMs` | `800` / `20` | 打字节奏模型（按字数加时） |

### 7.10 等待（`socialV2.wait`）

决定"发完这句之后，等多久算群安静了"。**没有 `[WAIT]` 指令**——lite 路径的协议里不存在这个标记（全仓库无解析点），模型无法主动指定等待时长，节奏由这三项与 `send` 的打字节奏共同决定。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxMs` | `600000` | 静默判定上限（实际生效时会被夹到 120000，见 `src/send/index.js`） |
| `defaultQuietMs` | `8000` | 默认静默判定 |
| `minQuietAfterNewMs` | `10000` | 有新消息后最短重新静默 |
| `defaultMs` / `minMs` | `30000` / `5000` | 保留键，当前没有读取点 |

### 7.11 媒体能力

**表情（`socialV2.sticker`）**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `syncTtlMs` | `60000` | 与 QQ 收藏同步的 TTL |
| `maxListCount` | `100` | 列表上限 |
| `includeInPrompt` / `promptMaxStickers` | `true` / `8` | 是否把表情索引注入 prompt |

**图片（`socialV2.image`）**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `dirs` | `["...\\Pictures\\绘画参考"]` | 本地图库目录（递归；**都写错才报错**，少一个只是少一个库） |
| `maxBytes` / `maxSendBytes` | 10 MB / 12 MB | 单图上限 / 发送上限 |
| `maxPerMinute` / `maxPerHour` | `6` / `30` | 发送限频 |
| `crossTargetPerMinute` / `PerHour` | `3` / `20` | **跨目标**发送限频（防止在多个群刷同一张图） |
| `minBookmarks` | `300` | Pixeval 图的最低收藏数 |
| `pixevalMcpUrl` | `http://127.0.0.1:52163/mcp` | Pixeval MCP 地址 |
| `pixevalSize` | `not_cropped` | 取图尺寸 |

**语音（`socialV2.voice`）**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 语音条总开关 |
| `dir` | `audio` | 语音素材目录 |
| `maxSeconds` / `maxBytes` | `300` / 20 MB | 单条时长与体积上限 |
| `maxPerMinute` / `maxPerHour` | `2` / `10` | 发送限频 |
| `allowAbsolutePath` | `false` | 是否允许绝对路径（**默认禁**，防越权读文件） |
| `ffmpegPath` | `""` | 留空则找 PATH 或 `FFMPEG_PATH` |
| `autoReadback` | `true` | 发后回读确认 record 真的落地 |
| `tts.enabled` | `false` | TTS 合成开关 |
| `tts.baseUrl` | `http://127.0.0.1:3210` | TTS 服务地址 |
| `tts.voice` / `voiceName` | `dafiyu` / `大肥鱼` | **全局默认**音色 ID / 显示名；当前人格设了音色时以人格为准 |
| `tts.maxChars` | `120` | 单次合成字数上限 |
| `tts.marker` | `[语音]` | 触发词（全角、`[voice]`、带引号等容错见 `src/voice/tts.js`） |
| `tts.cacheDir` / `keepFiles` | `audio/.tts` / `30` | 缓存目录与保留数量 |
| `tts.requireAsk` / `askWindowMs` | `false` / `1800000` | 是否要求先询问过才允许合成 |

**媒体归一化（`socialV2.media`）**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxBytes` / `maxFetchBytes` | 8 MB / 16 MB | 下载与读取上限 |
| `maxPixels` | `64000000` | 像素上限（防解压炸弹） |
| `normalize` | `true` | 是否归一化后送模型 |
| `maxModelBytes` / `maxLongEdge` | 1 MB / `1280` | 送模型的体积与长边上限 |
| `gifFrames` / `gifTile` | `6` / `240` | GIF 抽帧数量与拼图边长 |

### 7.12 主动行为

**主动私聊（`socialV2.proactivePrivate`）**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `dailyQuota` | `2` | 每人每日配额 |
| `activeHours` | `[9, 23]` | 允许打扰的时段 |
| `minIntervalMs` | `14400000` | 两次主动之间的最短间隔（4 小时） |
| `idleThresholdMs` | `7200000` | 对方多久没说话才算"可以找了"（2 小时） |
| `onlyKnownContacts` | `true` | 只找聊过的人 |
| `backoff.enabled` / `maxMultiplier` | `true` / `8` | 被无视后指数退避 |

**群聊主动（`socialV2.proactive`）**：`checkIntervalMinMs` ~ `MaxMs` 随机检查，`probability: 0.3`，`idleThresholdMs: 900000`。语义与私聊相反（群聊是"凑热闹"，沉默是常态），所以刻意不复用同一套实现。

### 7.13 上下文（`socialV2.context`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `recentLimit` / `unreadLimit` | `100` / `30` | 会话缓冲与未读缓冲 |
| `contextWindow` | `20` | 进 prompt 的窗口条数 |
| `wakeMessageLimit` / `wakeRecentLimit` | `12` / `4` | 唤醒时带的触发消息与最近消息数 |
| `wakeMaxChars` | `6000` | 唤醒 prompt 字符上限 |

另有 `socialV2.initialPromptMaxChars`（默认 `2000`）控制初始提示词注入上限。

### 7.14 识图（`vision`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `baseUrl` / `model` | `https://api.deepseek.com` / `deepseek-flash` | 视觉 API |
| `apiKey` / `apiKeyEnv` | `""` / `IMAGE_PATHIFY_API_KEY` | Key 与回退环境变量 |
| `maxTokens` / `disableThinking` | `2048` / `true` | 输出上限、关思考 |
| `maxImages` / `timeoutMs` | `4` / `90000` | 单次图片数与超时 |
| `maxPerMinute` / `maxPerHour` | `6` / `60` | 调用限频 |

### 7.15 语音转写（`voice.asr`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `providerId` | `sensevoice-local` | 转写后端 |
| `language` | `auto` | `auto` 或指定语言（见 `ASR_LANGUAGES`） |
| `maxBytes` / `maxDurationSeconds` | 4 MB / `120` | 单条上限 |
| `fallbackToQqAsr` | `true` | 本地失败时回退 QQ 自带 ASR |
| `timeoutMs` | `120000` | 超时 |

### 7.16 视频理解（`video`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `maxPerMinute` / `maxPerHour` | `4` / `20` | 限频 |
| `metaTimeoutMs` / `fetchTimeoutMs` | `3500` / `20000` | 元数据/正文超时 |
| `maxDurationSeconds` | `1800` | 视频时长上限（30 分钟） |
| `asrMaxSeconds` / `asrChunkSeconds` | `300` / `120` | 音轨转写的总时长与分片 |
| `transcriptMaxChars` | `6000` | 转写文本上限 |
| `commentLimit` / `commentMaxChars` | `8` / `120` | 评论采样 |
| `danmakuSample` | `30` | 弹幕采样条数 |
| `cacheTtlMs` / `cacheMaxEntries` | `600000` / `50` | 结果缓存 |
| `bilibili.cookie` / `fetchSubtitles` / `fetchAiSummary` | `""` / `true` / `true` | B 站侧选项 |

### 7.17 人物档案（`personMemory`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` / `dir` | `true` / `memory` | 开关；`dir` 现在只作旧 `.md` 的导入来源、删除备份（`.trash/`）与导出目标，不再是运行时存储 |
| `injectIndex` / `injectMax` | `true` / `12` | 注入索引，最多 12 份 |
| `injectSummary` / `injectSummaryMax` / `injectSummaryChars` | `true` / `6` / `160` | 摘要注入策略 |
| `injectPinnedOnly` | `true` | 只注入被 pin 的摘要 |
| `injectFocusBody` / `focusMaxChars` / `focusMaxPeople` | `true` / `1500` / `2` | 预取当前说话人的**三段概况**（不含时间线）；预算不够时按 `待续·注意 > 是谁 > 性格` 的顺序保留 |
| `readMaxChars` / `searchLimit` | `3000` / `8` | `[PERSON:read]` 读全文（概况 + 时间线，从新到旧）与搜索上限 |
| `maxProfiles` / `maxProfileChars` | `300` / 200000 | 档案总数与总字数护栏（三段 + 时间线合计） |

### 7.18 环境变量

大部分配置可以不走 `config.json` 而用它兜底：

| 变量 | 作用 |
| --- | --- |
| `DSH_HOME` | DSH 根目录（默认 `~/.dsh`） |
| `DSH_BASE_URL` | 覆盖 `dsh.baseUrl` |
| `DSH_LAUNCH_TOKEN` | 覆盖 DSH 进程启动 token |
| `DSH_PROFILE` / `DSH_MODULES` / `DSH_TOOL_PACKAGES` | DSH profile 与模块目录 |
| `SNOWLUMA_HOME` / `SNOWLUMA_TOKEN` / `SNOWLUMA_HTTP_URL` | SnowLuma 位置、令牌与地址 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | ffmpeg 工具路径 |
| `QQ_CONSOLE_TOKEN` | 覆盖控制台令牌 |
| `DEEPSEEK_API_KEY` | 聊天与搜索/识图的 Key 兜底 |
| `QQ_BRIDGE_VOICE_TOOL_DIR` | 语音工具目录 |
| `QQ_BRIDGE_PORT_WAIT_ATTEMPTS` | DSH 端口发现的等待次数 |
| `QQ_BRIDGE_PRIVACY_DEBUG` | 隐私扫描的调试输出 |

### 7.19 人格卡格式

人格卡的**正文**仍是纯 Markdown，存在 `state/bridge.db` 的 `roles` 表（一行一张卡）；桥接会按当前模式筛小节后注入。控制台新建/编辑，或用 `npm run store:export` 导出查看。

```markdown
# 角色卡：<角色名>

## 一、你是谁
- 身份、自我认知、别人怎么称呼你、你的雷点。

## 二、说话风格
- 句子长短、口头禅、标点习惯。
- 写「不要什么」通常比写「要什么」更有效。

## 三、性格与反应 〔二代〕      ← 模式标记：只注入给 reserved2
## 三、性格与反应 〔一代〕      ← 只注入给 reserved（历史兼容）

## 四、回复示例
- 几条「群友说 → 你回」的例子，只示范语气与长度。
```

支持的标记写法：`〔二代〕` / `[v2]` / `（reserved2）` / `〔2 代〕`（一代同理 `〔一代〕` / `[v1]` / `（reserved）`）。标记在注入前会被去掉，模型看到的是干净标题。**没有标记的小节 = 通用人设，所有模式都注入。**

### 7.20 QQ 空间（`socialV2.qzone`）

`config.json` 里只有一个总开关；运行策略落在 `state/qzone-policy.json`（控制台维护，改完即时生效，**不用重启桥接**）。之所以不全塞进 `config.json`：授权是有时效的动作，写进主配置会让"改了 `.env` 忘了重启导致授权没生效"变成常态。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `socialV2.qzone.enabled` | `true` | 功能总开关。`false` 时所有发布请求一律 403（控制台仍可查看历史） |

AI 起草（`socialV2.qzone.aiDraft`）——**这里才是"发空间那个 AI"的思考强度**，与 `socialV2.liteChat.thinking` 完全独立：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 起草开关。`false` 时 `/api/qzone/draft` 返回 503，不烧 token |
| `reasoningEffort` | `high` | 思考强度，`low` / `high` / `max`。**默认 high**：聊天求快用 low，写一条要发出去的话值得多想几步。写错不报错，回退 high 并告警 |
| `maxTokens` | `4096` | 输出上限。开思考时推理与正文**共用**这个额度，给低了会出现"只有思考没有正文" |
| `minChars` / `maxChars` | `20` / `120` | 提示词里的字数区间（不是硬校验；发布时的硬上限是策略里的 `maxChars`） |
| `temperature` | `0.9` | 采样温度 |
| `model` | 跟随 `dsh.model` | 起草用的模型，可单独指定 |
| `persona` | 空 | **附加**在人格卡之后的人设补充。真正的「是谁」来自当前激活的 `roles/<名>.md`（与聊天同一份），这个字段只做长期微调 |

> 起草**不占发布配额、不需要已授权**：它没有外部副作用，只是多一次模型调用。要不要发、发给谁看，仍然由 `publish` 那道闸门决定。
>
> 但**它是要花钱的**：每次起草都会进 token 账本，归属见 [10.8](#108-花费对不上)。

`state/qzone-policy.json` 的 `settings`（控制台表单可改）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `requireApproval` | `true` | 每条都挂起等人工批准。关掉＝AI 在授权范围内可直接发 |
| `dailyQuota` / `hourlyQuota` | `3` / `2` | 每日 / 每小时发布上限（只计成功发布） |
| `minIntervalMs` | `600000` | 两条之间最短间隔（10 分钟） |
| `defaultVisibility` | `friends` | 未指定可见范围时的默认值 |
| `allowedVisibilities` | `["friends","private"]` | **授权范围上界**。AI 只能在这几档里挑，越界直接 403 |
| `allowImages` / `maxImages` | `true` / `9` | 是否允许带图、最多几张（九宫格上限） |
| `maxChars` | `1000` | 渲染后正文长度上限（QQ 空间本身约 2000） |
| `allowTopic` | `true` | 是否允许主题标签（`#话题#`）。情绪符号已随 `mood` 参数一并移除 |
| `quietHours` | `[1, 7]` | 安静时段（本地时间，支持 `[23,7]` 跨零点；`[]` 为不限制） |
| `pendingTtlMs` | `600000` | 待批条目存活时间（10 分钟） |

授权字段（**只由 grant / revoke 写**，控制台不提供直接编辑）：

| 键 | 说明 |
| --- | --- |
| `enabled` | 是否已授权 |
| `grantId` | 授权凭证 id，出现在审计记录里 |
| `grantedAt` / `grantedBy` | 发放时间与来源（固定 `console`） |
| `expiresAt` | 到期时间；`null` 表示长期有效（仍可随时撤销） |
| `revokedAt` / `revokeReason` | 撤销时间与原因 |
| `lastUsedAt` | 上次成功发布的时间 |

审计文件：`state/qzone-posts.jsonl`，一行一条（`action` 为 `publish`/`reject`，含 `ok`、`tid`、可见范围、图片数、字数、失败原因）。只保留最近 500 条在内存里做配额统计，文件本身不截断。

---

## 8. 控制台

启动后访问 `http://127.0.0.1:3100`。首次访问会重定向并带上 `?token=`，前端把令牌存进 `localStorage`，后续请求走 `x-console-token` 头。

### 8.1 页面

| 页面 | 主要功能 |
| --- | --- |
| **总览** | 三个连接指标（DSH / SnowLuma / 模式）、当前会话、待处理请求、最近活动 |
| **对话引擎** | 模型、思考强度（私聊/群聊分开）、max_tokens、上下文压缩参数、实时摘要 |
| **人格与角色** | 人格卡列表/编辑/启用、注入字符统计与超限提示、仿真提示词编辑与备份恢复、**每个人格的音色与唤醒词**（含试听） |
| **话题** | 初始提示词、人物档案 |
| **会话** | 会话列表、消息详情、手动发消息（文本/图片/语音/表情/拍一拍） |
| **访问** | 白名单、令牌管理、安全开关 |
| **用量** | token 账本：累计/逐轮、缓存命中率、按峰谷折算的金额 |
| **运维** | SnowLuma 上游只读面板、重启、诊断日志、用户反馈 |
| **Lite** | 直连引擎的健康度与失败计数 |
| **QQ 空间** | AI 起草（思考档位独立配置，默认 high）、授权 AI 发布说说（有效期 / 可见范围 / 配额 / 安静时段）、待批队列的批准与拒绝、手动发布与预览、发布记录 |

### 8.2 鉴权模型

两条完全不同的路径：

| 调用方 | 凭据 | 能力 |
| --- | --- | --- |
| 操作者（浏览器） | `x-console-token` | 全部管理接口 |
| AI / agent | — | **工具面已下线**：任何带 `x-agent-token` / `x-agent-call` 的请求一律 403 |

安全闸门全部**失败关闭**：令牌为空时**拒绝启动**控制台，而不是放行。这一点是刻意改的——原实现"令牌为空就放行"是一条失败开放的分支，一旦写盘异常被吞，控制台上那些改配置/发消息/读聊天记录的接口就变成完全免鉴权。

### 8.3 前端

`public/console.html` 是单文件 SPA（约 5.9k 行），**零构建、零依赖**：手写 CSS 变量主题（明/暗）、原生 `fetch`、无框架。这样做的好处是改一行刷新即见，坏处是文件确实大——但运维页面的变更频率远低于业务代码，这个取舍是划算的。

---

## 9. 安全设计

这一层是刻意做厚的，因为桥接默认跑在一台真机上、连着一个真实 QQ 号。

### 9.1 模型侧

- **零工具预设**：`qq-chat-lite` 优先用注册期 `allow:[]` 清空全部工具（含未来 connect 上来的外部工具）；当前 DSH 版本若报 `allow 不支持`，会退回逐名 deny 已知危险工具（82 个本地执行/派生 agent 名）。执行期再用 guard 拒绝任何工具调用。三层里至少有一层生效，"预设里没写"和"真的没有"是两件事。
- **不暴露路径与凭据**：模型看不到 `config.json`、看不到 `state/`、看不到系统信息。
- **人格由桥接注入**：群友口头宣布"换角色"无效，只有管理员能改。

### 9.2 网络侧

- **SSRF 防护**（`src/safe-fetch.js`）：仅 http/https；禁 localhost / `.local` / 私有 IP / 环回 / 链路本地 / CGNAT；域名先 DNS 解析并校验**全部**结果（防 DNS rebinding）；手动跟随重定向，**每一跳重新校验**。
- **控制台只监听环回**，且校验 `Host` 头（挡 DNS rebinding）。
- **`dsh.allowRemote` 默认 false**：桥接默认只肯连本机 DSH。

### 9.3 内容侧

- **敏感信息审计**（`src/sensitive.js`）：拦截本机路径（含 UNC）、凭据特征（要求带赋值关系，避免误伤正常聊天）。这是一道**启发式**闸门，不能替代权限控制——注释里写得很清楚。
- **审计顺序**：必须在分段**之前**做，否则跨段拼接的令牌会漏掉（这是踩过的坑）。

### 9.4 文件侧

- **`state/` ACL 收紧**（`src/state-acl.mjs`）：Windows 上限制为仅当前用户可写。它是**唯一实现**，桥接进程和安装脚本共用同一份——历史上两份实现带着同一个 bug（`icacls` 参数顺序导致权限没真正收紧）。
- **密钥落盘**：`state/console-token`、`config.json`、`memory/`、`audio/` 全部在 `.gitignore` 里。
- **发布前扫描**：`scripts/privacy-scan.mjs` 扫描"将要被提交的内容"，命中即失败，且**只打印脱敏片段**（绝不回显凭据本身）。

### 9.5 发布前检查清单

```bash
node scripts/privacy-scan.mjs        # 必须通过
git status --short                   # 确认没有 config.json / state/ / memory/ / qq-chat-archive/
```

规则文件是 `scripts/privacy-rules.json`（**含你机器上的真实标识，不入库**，模板见 `privacy-rules.example.json`）。

---

## 10. 常见问题与排查

### 10.1 桥接起来了但群里不回复

按顺序查：

1. `state/bridge.log` 里有没有 `白名单为空且 allowAllWhenEmpty=false` → 填 `allow.groups`
2. 控制台「总览」的模式是不是 `reserved2`
3. 群消息有没有真的到了 SnowLuma（`state/qq-activity.log`）
4. 唤醒是否被限频（日志里会有"延后重试"）
5. 模型是不是回了 `[SILENT]`（这是正常行为，不是 bug）

### 10.2 DSH 连不上

```
[bridge] DSH 不可用
```

- Desktop 版端口每次启动都变 → 用 `start-dsh-desktop.cmd`，或手动 `node sync-dsh-port.mjs`
- 检查 `config.json` 的 `dsh.baseUrl` 与 DSH 实际端口
- 鉴权失败（401）：`dsh.authToken` 留空让桥接自己发现，或显式填

### 10.3 SnowLuma 401 / 1006 断线

- 换过 QQ 账号 → OneBot 配置是按账号分文件的，token 也变了
- 桥接有自愈（`src/account/index.js` 的令牌自愈），但需要它能读到 SnowLuma 的配置目录
- 检查 `snowluma.homeDir` 是否指对

### 10.4 语音发不出去

1. `socialV2.voice.enabled` 是不是还开着 `false`
2. `http://127.0.0.1:3210/health` 能不能通（TTS 服务活着吗）
3. ffmpeg / ffprobe 在不在 PATH
4. 日志里有没有"合成结果不是音频头就拒发"（这是防线，说明 TTS 返回了错误页而不是音频）

### 10.5 出现双实例

症状：日志里两个进程同时加入 DSH 事件流，`social-v2.json` 被旧快照覆盖。

用 `restart.bat` 或 `stop-qq-bridge.cmd`，**不要手动关窗口**。桥接有锁文件（`state/bridge.lock`），第二个实例会以退出码 2 直接退出。

### 10.6 `npm install` 失败

- `@snowluma/*` 的 peer 冲突 → `.npmrc` 已设 `legacy-peer-deps=true`，确认它还在
- `ERR_MODULE_NOT_FOUND` 指向 `@snowluma/sdk/dist/...` → `postinstall` 没跑，手动执行 `node scripts/patch-snowluma-sdk.mjs`

### 10.7 人格卡不生效

- 文件名 = 角色名，且不能是 `README` 或 Windows 保留名（`CON`/`NUL`/`COM1`…）
- 超了 `role.maxInjectChars` 会被截断（控制台会标"超出上限"）
- 写了工具用法的小节会被整行过滤（见 `roles/README.md`）

### 10.8 花费对不上

token 账本的**累计总量**取自 DSH 的 `tokenUsage` 投影（整条会话日志的权威累计），**逐轮明细**由 `assistant/message` 的 usage 折叠而来。两者口径不同，逐轮能追溯到多深取决于会话开场快照带回的历史条数——所以早期回合的明细可能缺失，但总量是准的。

**空间起草的开销单独归属，不混在会话回复里**（2026-11-01 补上，此前整条链路漏记）：

| 发起方式 | 账本 sid | 控制台显示 |
| --- | --- | --- |
| AI 在某个群/私聊里发起（`key=group:123`） | `qzone-draft:group:123` | 算到该会话头上 |
| 控制台手动起草 / CLI 直接起草（无会话来源） | `qzone-draft:internal:空间起草` | 「内部」类型的独立条目 |

- 关键词是 **`qzone-draft:`**：账本的 `resolveKey` 靠它反解归属，漏了这个前缀就会掉进「未归属:xxxx」。前缀与映射只定义在 `src/qzone/draft.js`（`qzoneDraftSessionId` / `qzoneDraftOwner`），装配层与账本共用一份。
- **失败也记账**：模型答了但清洗后为空（`EMPTY_DRAFT`），token 已经烧了，照样入账。只有请求根本没成功（无 `usage` 可拿）才不记——这种开销上游不返回数字，账本无法凭空造一笔。
- 思考 token 计入输出的 `completion_tokens`（官方口径如此），`reasoning` 桶只作明细展示，**不重复计价**。high 档贵在输出，不在额外的推理费。

### 10.9 说说发不出去

先看错误码，`node scripts/qzone.mjs status` 与接口返回里都有：

1. `NOT_GRANTED` / `EXPIRED` / `REVOKED` —— 授权问题。控制台「QQ 空间」页重新授权（或 `qzone.mjs grant`）
2. `DAILY_QUOTA` / `HOURLY_QUOTA` / `TOO_SOON` / `QUIET_HOURS` —— 限频。`status` 里能看到今日/本小时用量与"下一条最早时间"
3. `VISIBILITY_NOT_ALLOWED` —— AI 想要的可见范围没在授权里勾选。这是授权边界，不是 bug
4. `IMAGE_OUTSIDE_WHITELIST` —— 本地图片不在 `socialV2.image.dirs` 里。想发图就把目录加进图库，别指望放宽这条
5. `SENSITIVE_CONTENT` / `TOKEN_LEAK` —— 正文命中路径/凭据特征或会话令牌
6. 网关侧报错（`send_qzone_msg` 失败）—— 确认 SnowLuma 已登录、`snowluma.httpUrl` 指向 OneBot **HTTP** 端口（3000），且该版本支持空间接口（`_snowluma-catalog.json` 里有 `send_qzone_msg`）

> 发出去但空间里看不到：先确认可见范围。`friends` 只对好友可见，`private` 只有自己能看到；另外 `ugc_right=16/128` 的名单里如果没填人，网关会直接拒绝。

---

## 11. 已知现状

写在这里是为了让新接手的人少踩坑，不是为了免责。

1. **`package.json` 只保留真实可跑的脚本。** 历史提交 `fb9f087「简化代码」` 删掉了 `scripts/test-*.mjs`（共 82 个文件），但 scripts 段还留着 33 个失效条目——现在已全部移除。同一轮里删掉的还有 `voice-gui` / `voice-cli`（指向仓库外不存在的 `../voice-tool`）。

   现在 `npm run` 能跑的是 14 个：`start`、`self-test`、`postinstall`、`send-voice`、`preview:console`、`privacy-scan`、`diagnose:acl`、`harden-acl`、`verify:adaptation`、`verify:persona`、`probe:protocol`、`probe:settings`、`probe:heartbeat`、`scan:tool-names`。要恢复单测覆盖，需要从历史提交里捡回来或重写。

2. **`src/v2-wait.js`、`src/qq-model-view.js` 是"小而窄"的模块，刻意没有并进别的文件。** 前者 50 行，两个调用方（`http/routes/social-v2.js`、`send/index.js`）；后者 140 行，唯一调用方是 `lite/prompt.js`。

   `qq-model-view.js` 之所以不合并：`scripts/audit-bridge-harness.mjs` 会把它的**源码整体**放进 vm 沙箱里执行，好让它看到与真实桥接消息相同的对象原型。合并进 `lite/prompt.js` 后，那段源码会带 import 语句，无法再按文件粒度载入。

3. **一次性重构工具仍在 `scripts/` 里。** `extract-module.mjs`、`plan-extract.mjs`、`check-extract.mjs`、`split-http.mjs`、`check-http-split.mjs`、`gen-wiring-manifest.mjs`、`plan-state-ownership.mjs`、`build-http-server.mjs` 合计约 1.27k 行，是历次模块拆分的生成器与校验器，不参与运行时。它们依赖 `state/coupling.json`、`state/http-blocks.json` 这两个快照——删脚本前先想清楚还要不要重跑拆分。

4. **文档引用有失效链接。** 多处注释指向 `docs/design/*.md`、`docs/guides/*.md`（如 `PERSON_PROFILES_SPEC.md`、`VIDEO_LINKS_SPEC.md`、`IMAGE_SENDING.md`），但 `docs/` 目录不在公开仓库里（`.gitignore` 明确排除了 `docs/design/`、`docs/audits/` 等内部文档）。看注释时请注意这个前提。

5. **`src/voice-core.js` 的注释还提到 `../voice-tool/`。** 那是语音工具曾经独立成仓的形态；现在桥接与独立工具共用同一份实现，但独立工具目录本身不在本仓库中。看到这段注释不等于目录存在。

6. **Windows 优先。** 逻辑层是跨平台的，但 `restart.bat`、`stop-qq-bridge.mjs`、`sync-dsh-port.mjs`、`harden-state-acl.mjs` 都直接调 PowerShell 或 `icacls`，Linux/macOS 上需要重写这几处。

---

## 12. 许可证

### 12.1 本项目

```
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
```

完整文本见 [`LICENSE`](LICENSE)（`qq-bridge/LICENSE` 同文）。简单说：可以商用、可以改、可以再分发，保留版权声明即可，**不提供任何担保**。

### 12.2 第三方组件

| 组件 | 许可 | 注意 |
| --- | --- | --- |
| **SnowLuma** | 专有（闭源） | **未包含在任何分发中**，需自行安装。其 EULA 禁止「并入第三方安装包或 Docker 镜像、通过自动化脚本部署」——本项目的 `autostart.js` 只启动用户**自己已装好**的副本，且明确不做部署/更新 |
| **DeepSeek Harness** | 见其自身协议 | 外部依赖，未包含 |
| **IndexTTS-2** | **bilibili Model Use License Agreement** | ⚠️ **不是 MIT，且不随本仓库分发**（需自行 clone）。仅供技术研究与合法的创意应用；禁止合成政治人物/公众人物/未经授权的个人声音；禁止用于诋毁、欺诈、身份盗用等。使用前请完整阅读其 `LICENSE` 与 `DISCLAIMER` |
| **Pixeval** | 见其自身协议 | 外部依赖，未包含 |
| `@snowluma/*`、`@deepseek-ai/*`、`zod`、`js-yaml` 等 | 各自许可 | 见 `node_modules/<包>/LICENSE` |

### 12.3 数据与素材

- `dafiyu-voice/samples/`、`ref/` 里的参考音取材自第三方应用缓存，**仅供本机个人使用**，已加入 `.gitignore`，不随项目分发。
- `qq-chat-archive/` 含真实聊天内容（含私聊），**仅保存在本机**，已加入 `.gitignore`。
- `roles/` 里的人格卡是个人创作，随项目以 MIT 发布；内含的角色梗与设定请自行确认无版权争议。

---

*最后更新：2026-11-01*
