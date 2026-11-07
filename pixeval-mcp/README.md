# Pixeval MCP 连接（DSH 插件 / bundle）

把**本机运行中的 Pixeval 桌面端**自带的 MCP 服务端接到 DSH，让 agent（含 QQ 聊天 AI）能直接调用
搜图、排行榜、画师、作品详情、评论、收藏、下载队列等能力。

- 包名：`@local/pixeval-mcp`（配置型 bundle，无 JS 代码）
- 实际生效行：`mcp-pixeval` → `@deepseek-ai/dsh-mcp-client`
- 工具名：`mcp__pixeval__<工具名>`（共 49 个：38 只读 + 11 写入）

## 前置条件（Pixeval 侧）

| 项 | 说明 |
|---|---|
| Pixeval 版本 | ≥ 5.0.0（Avalonia 重写版才有 MCP；4.x/WinUI 没有）。当前机器是 5.0.13 |
| 启用服务端 | Pixeval → 设置 → **MCP** → 打开「启用 MCP 服务器」。**默认是关的**；改了立即生效，不用重启 Pixeval |
| 端口 | 默认 `52163`，可改。改了要同步本目录 `cordis.patch.yml` 的 `url` |
| 写入工具 | 设置 → MCP →「启用写入工具」决定 11 个写入工具能否真正执行（工具本身仍会列出） |
| 登录 | 除 `status` / `capabilities` / `help` / `history` 等少数工具外，其余需要 Pixeval 已登录 Pixiv |

服务端特征（来自 Pixeval 源码审计，见 `qq-bridge/docs/research/PIXEVAL_MCP_SPEC.md`）：
Streamable HTTP、**stateless**（不返回 `Mcp-Session-Id`）、只监听 `127.0.0.1`、无鉴权、
协议版本 `2025-11-25`。

## 本插件做了什么

`cordis.patch.yml` 插入一行 `@deepseek-ai/dsh-mcp-client`：

```yaml
serverName: pixeval
transport: streamable-http
url: http://127.0.0.1:52163/mcp
failOnStartupError: false   # Pixeval 没开也不影响 DSH 启动
reconnect: { maxAttempts: 1000, maxDelayMs: 20000 }  # Pixeval 后启动/重启后约 20s 自动接上
```

装进 `desktop` profile 后，**所有会话**（桌面 GUI、标准 preset、QQ 会话）都能看到这批工具。

## QQ 聊天 AI 侧

QQ 会话的安全边界在 qq-bridge 仓库的
`plugins/qq-agent/qq-tool-restrict.mjs`：`SAFE_PREFIXES` 已加入 `'mcp__pixeval__'`，
`qq-chat-v2` / `qq-chat` 人格里也补了使用指引（见 qq-bridge 仓库改动）。
改动合入后需要**重启一次 DSH 桌面端**（preset/守卫是启动期加载的），新开的 QQ 会话才带这批工具。

## 搜索 + 发图到 QQ

QQ 聊天 AI 侧另有桥接工具 `qq_send_image`（`qq-bridge` 仓库）：

- **要 Pixiv 图**：AI 先用 `mcp__pixeval__ranking` / `recommended_works` / `bookmarks`（或 `search_illustrations`
  默认排序）挑到作品 id，再 `qq_send_image(illustId=…, key=…, token=…)`；桥接调用 Pixeval MCP 的
  `pixeval://illust/{id}/thumbnail/{size}` 取图（默认 `not_cropped`，1200px 级）后直接发到 QQ。
  **默认只发收藏数（赞）≥1000 的作品**：桥接在取图前按 `totalBookmarks` 判定，不足直接拒绝并报实际收藏数；
  用户要求更高时用 `minBookmarks`（如 5000），0 = 不限制。注意 `search_illustrations` 的
  `sort=popular_desc` 需要 Pixiv Premium，非会员会直接报错——高赞图走 `ranking` / `recommended_works` / `bookmarks`。
- **没指定要什么**：不传 `illustId`，从 `socialV2.image.dirs`（默认
  `C:\path\to\画师图库`，递归）随机挑一张发。
- 一次一张、不能配文字（先发文字再发图）；只认「Pixeval MCP 预览图」与「配置图库」两种来源，
  **不接受任意本地路径 / URL / base64**，所以模型无法借发图读本机文件。
- 详见 qq-bridge 的 [guides/IMAGE_SENDING.md](../../qq-bridge/docs/guides/IMAGE_SENDING.md)。

## 成本提示

49 个工具的 schema 约 **29 KB**（name + description + inputSchema），折算每轮请求约
**8k–13k tokens**，QQ 会话里每轮都会带上。如果更在意成本，可以在
`qq-tool-restrict.mjs` 里用 `ctx.tools.restrict({ deny: [...] })` 隐藏不常用的工具，例如只留：

```js
for (const name of ['mcp__pixeval__help', 'mcp__pixeval__extensions', 'mcp__pixeval__settings_summary',
  'mcp__pixeval__analyze_download_macro', 'mcp__pixeval__analyze_work_filter',
  'mcp__pixeval__set_download_macro', 'mcp__pixeval__sync_subscriptions',
  'mcp__pixeval__control_download', 'mcp__pixeval__download_tasks']) {
  ctx.tools.restrict({ deny: [name] })
}
```

（注意 `restrict` 只影响注册期可见性；`mcp__pixeval__` 前缀的执行期 guard 仍然全放行。）

## 验证

```powershell
cd C:\path\to\qq-bridge
node ..\dsh-plugins\probe-host-pixeval.mjs                                   # host 级：调 mcp__pixeval__status
$env:PROBE_PROMPT='请调用 mcp__pixeval__capabilities 工具一次'
node ..\dsh-plugins\probe-host-pixeval.mjs                                   # host 级：读 writeToolsEnabled / port
node scripts/probe-pixeval.mjs                                              # QQ 级：qq-chat-v2 会话里调用
```

`probe-host-pixeval.mjs` 会在后台建一个临时会话/工作区跑一轮，结束后归档并删除。
需要 DSH 正在运行（默认 `http://127.0.0.1:61058`，可用 `DSH_BASE_URL` 覆盖）。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 工具完全不出现 | Pixeval 没开或「启用 MCP 服务器」没开 → 打开后等 ≤20s（插件会自己重连）；或端口不是 52163 → 改 `cordis.patch.yml` 的 `url` |
| `Connection refused` | 同上。用 `curl http://127.0.0.1:52163/mcp` + `Mcp-Method: tools/list` 自检 |
| 工具在、一调就报错 | 看报错文本：`Pixeval has no active Pixiv account...`（需登录）、`Pixeval MCP write tools are disabled in settings.`（写入开关没开） |
| 装完立刻有、之后消失 | 重连预算耗尽（10 次连续失败后工具会被移除）——本插件把 `maxAttempts` 调到 1000，正常不会遇到；改配置行会原地重连 |
| QQ 会话仍然拒绝 | 守卫文件没被重新加载：重启 DSH 桌面端 |

## 卸载

```powershell
# 在 DSH 里用 plugin_manager action=remove_bundle target=@local/pixeval-mcp
```

本目录是「链接安装」（profile 直接链接这份 checkout），改这里的文件在下次启动生效。
