// qq-chat-lite 的「无工具」守卫：让轻量聊天内核的模型**一个工具都看不到**。
//
// 为什么需要单独一份（不直接复用历史的白名单守卫）：
//   旧版 qq-chat / qq-chat-v2 白名单守卫已随两代仿真预设一起删除（2026-10-28），
//   那条路径放行「QQ MCP 命名空间」与少量模型侧工具；qq-chat-lite 则是**零工具**：
//   不挂 MCP 工具、不挂 tool-web / ask-user / todo，也不挂 compaction。
//   目标是把每轮固定前缀压到最小，因此工具 schema 必须完全为空。
//
// 本文件自包含（不再从任何别的守卫模块 import 名单），只依赖 DSH 的 tools 服务。
//
// 两道防线：
//   ① 注册期 `ctx.tools.restrict({ allow: [] })`：allow 是「只保留这些」，空集合就是
//      「继承来的全局工具一个都不要」——这是真正把 schema 清空的那一刀，连未来才
//      connect 上来的外部工具也一起挡（restriction 在读取视图时生效，不依赖注册先后）。
//   ② 兜底逐个 `restrict({ deny: [name] })`：显式 deny 已知的危险全局/本地执行工具
//      （防 allow:[] 在某些 DSH 版本上不可用）。名字不存在时 restrict 会抛错，
//      这里逐个 try/catch 并只在 allow:[] 失败时落诊断。
//      时序事实：preset 行在 DSH 启动时挂载，部分全局工具可能还没注册，
//      此时逐名 deny 会抛 "unknown global tool" 并被吞掉；零工具保证靠 ① 而非 ②。
//   ③ 执行期 `ctx.tools.guard(...)`：任何工具调用一律拒绝，返回中文原因。restrict 只
//      隐藏 schema，guard 才是执行期的硬闸门；两道都要有。
//
// 名单维护：`RESTRICTED_TOOL_NAMES` 与旧守卫同源（危险本地执行面 + 开发注入器 +
// 插件装载权 + 无人值守调度），对账工具 `node scripts/scan-dsh-tool-names.mjs`
// 从已安装的 DSH 包里抽真实工具名求差，防止拼错的假名静默失效。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'qq-tool-restrict-lite'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：轻量会话**不得**拥有。
 *
 * 名字按 DSH 0.2.1-rc.2 实际注册的工具名逐个核对（来源包见每条注释），
 * 不是凭印象列举。教训：`tools.restrict()` 对未知名字会抛错、被逐个 try/catch 吞掉，
 * 于是坏名字**静默失效**。对账工具（scripts/scan-dsh-tool-names.mjs）会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 来源包（0.2.1-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *
 * 2026-10-22 针对 0.2.1-rc.2 的对账结论（`node scripts/scan-dsh-tool-names.mjs`）：
 *   · 全局层默认挂 `working-directory` / `tool-working-directory` ⇒ `working_directory`
 *     与 MCP 资源工具一样属于全局继承，必须从 schema 隐藏；
 *   · 新增终端能力 `dsh-tool-terminal`（terminal_open|send|read|signal|close|list）= 直接 shell；
 *   · 新增会话历史检索 `dsh-tool-session-query`（session_search|trace、session_event_*）；
 *   · 装载权入口：plugin_market / create_worktree / wait_agent；
 *   · `subagent_codex` / `subagent_claude_code` 自 0.2.1 起是**按需安装**的可选插件，
 *     默认不存在（restrict 必然抛错），但仍保留在名单里作为回归网（装上就要挡），
 *     扫描器与测试把这一组排除在「拼错假名」判定之外。
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账：全局层默认启用 / 派生 agent / 插件装载权 / 无人值守调度
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账：全局层继承 / 终端 / 会话历史检索 / 装载权 / team 同族
  'working_directory',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'plugin_market', 'create_worktree',
  'wait_agent',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/**
 * 0.2.1 起改为「按需安装」的可选能力包里才会注册的全局工具名。
 *
 * 它们默认**不存在**于安装树里，`tools.restrict()` 对它们必然抛错——守卫逐个 try/catch
 * 正是为这种名字设计的。保留的收益：用户装上 Codex / Claude Code 组合包后，名字回到
 * 全局层时**立刻**被挡，不必等下一次对账。
 *
 * 扫描器与测试用这一组把「可选项」和「拼错的假名」区分开：只有不在本组、又扫不到的
 * 名字才判成假名。
 */
export const OPTIONAL_BUNDLE_TOOL_NAMES = Object.freeze([
  'subagent_codex',
  'subagent_claude_code',
])

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // 按需安装的可选能力包（0.2.1 起默认不存在；装上就要挡）
  ...OPTIONAL_BUNDLE_TOOL_NAMES,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期 guard。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

/**
 * 「已知危险全局工具」名单（唯一权威数组，供测试/扫描器对账）。
 * 这是本守卫要显式 deny 的全部全局层工具；执行期 guard 则一律拒绝（fail-closed）。
 */
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

/** lite 预设要显式 deny 的全部工具名（= 危险全局工具；没有任何 QQ MCP 工具面）。 */
export const DENIED_TOOL_NAMES = Object.freeze([...RESTRICTED_TOOL_NAMES])

// 诊断落盘：只有 allow:[] 这一刀失败（配置/版本问题）时才写，避免正常回合打日志。
// 测试可用 QQ_TOOL_RESTRICT_LITE_LOG 改到临时文件。
const DIAG_FILE = (() => {
  if (process.env.QQ_TOOL_RESTRICT_LITE_LOG) return path.resolve(process.env.QQ_TOOL_RESTRICT_LITE_LOG)
  try {
    // 本文件位于 <repo>/plugins/qq-agent/，往上两层就是仓库根
    return fileURLToPath(new URL('../../state/tool-restrict-lite.log', import.meta.url))
  } catch {
    return ''
  }
})()

function appendDiagnostics(lines) {
  if (!DIAG_FILE || lines.length === 0) return
  try {
    const trim = (line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line)
    const previous = (() => {
      try { return fs.readFileSync(DIAG_FILE, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    })()
    // 有界：只保留最近 20 条
    const next = [...previous, ...lines.map(trim)].slice(-20)
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true })
    fs.writeFileSync(DIAG_FILE, `${next.join('\n')}\n`, 'utf8')
  } catch {
    // 诊断失败不能影响预设装配
  }
}

export function apply(ctx) {
  const stamp = new Date().toISOString()
  const failed = []

  // ① 全量隐藏：allow: [] = 继承来的全局工具一个都不保留。
  let blanketHidden = false
  try {
    ctx.tools.restrict({ allow: [] })
    blanketHidden = true
  } catch (error) {
    failed.push({ phase: 'allow:[]', name: '*', message: String(error?.message ?? error) })
  }

  // ② 显式 deny：即使全量隐藏不可用也能挡住已知工具（名字不存在时 restrict 会抛错，忽略）。
  for (const toolName of DENIED_TOOL_NAMES) {
    try {
      ctx.tools.restrict({ deny: [toolName] })
    } catch (error) {
      failed.push({ phase: 'deny', name: toolName, message: String(error?.message ?? error) })
    }
  }

  const blanketFailed = !blanketHidden
  if (blanketFailed) {
    const reasons = [...new Set(failed.filter((f) => f.phase === 'allow:[]').map((f) => f.message))]
    console.error(`[qq-tool-restrict-lite] allow:[] 失败，零工具保证降级为显式 deny：${reasons.join(' | ')}`)
    appendDiagnostics([
      `${stamp} allow:[] 失败: ${reasons.join(' | ')}`,
      `${stamp} 显式 deny 失败 ${failed.filter((f) => f.phase === 'deny').length}/${DENIED_TOOL_NAMES.length}（名字不存在属正常，allow:[] 已兜底）`,
    ])
    // 时序兜底：个别全局工具可能在 preset apply 之后才注册，3 秒后重试失败的 deny 名字。
    const missing = failed.filter((f) => f.phase === 'deny')
    if (missing.length > 0) {
      const timer = setTimeout(() => {
        let ok = 0
        for (const { name: toolName } of missing) {
          try { ctx.tools.restrict({ deny: [toolName] }); ok += 1 } catch { /* 仍然不存在，忽略 */ }
        }
        if (ok > 0) console.error(`[qq-tool-restrict-lite] 延迟重试补藏成功 ${ok} 个工具`)
      }, 3000)
      timer?.unref?.()
    }
  }

  // ③ 执行期兜底：lite 预设不允许任何工具调用。
  ctx.tools.guard((exec) => {
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    return `轻量聊天预设没有可用工具${toolName ? `（"${toolName}"）` : ''}，本次调用已被拒绝；`
      + '请直接输出要发到 QQ 的文本（一行一条，不想说话输出 [SILENT]）'
  })
}
