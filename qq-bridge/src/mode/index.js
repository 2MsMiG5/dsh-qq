// mode/index.js — 模式（chat / closed-agent / reserved / reserved2）与由它派生的会话策略。
//
// 为什么单独成文件：这是整个桥接的**总开关**。它决定用哪个 preset 建会话、哪些 key 允许
// 收发、旧会话该不该退役——而判定逻辑分散在四五个入口（DSH settings、本地 mode.json、
// 环境变量、控制台）里。混在装配代码里时，「为什么这个群没被唤醒」只能靠猜。
//
// 状态归属：**四个模式变量仍留在桥接侧**，模块拿到的是取值函数 + 写入函数。
// 不搬过来的原因是 `getCurrentMode` 这类取值函数已经被 6 个模块当成入参在用，
// 一旦把变量本身搬进这里，桥接侧那 40 多处直接引用就要全部改写成取值调用——
// 收益是「更纯」，代价是动一大片本来验证过的事件分发路径。这里选稳。
// 「preset 缺失只告警一次」是纯本域状态，直接留在模块内。
//
// bind 时机：`pending` / `modelAppliedSessions` / `social` / `socialV2` 都在本段之后声明，
// 尾部 bind 只适用于 bot/handles；这些容器必须等它们出现后才能交出去。
//
// ⚠️ 四个模式变量是 `let` 且会被这里改写。传值 = 切模式后模块仍按旧模式判断，
//    症状是「控制台切了模式，QQ 那边行为不变」，且没有任何报错。

import path from 'node:path';
import crypto from 'node:crypto';
import { unwrap } from '../dsh-client.js';

export function createModeService() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  // 「preset 缺失」只告警一次的标记：纯本域状态，不需要外人知道。
  let litePresetMissingWarned = false;

  let DSH_CONTROL_TIMEOUT_MS, MODE_INPUT_ALIASES, STATE_DIR, activeWaits, allowed, api,
    cancelPendingEntry, cfg, clearSocialV2Timers, collectors, disarmPendingWakeLease,
    feedbackTimes, lastSendFailed, getClosedAgentPreset, getCurrentMode, getDshDefaultPreset, getDshPresetIds, liteChatEnabled,
    liteKeyEnabled, log, modelAppliedSessions, normalizeModeInput, normalizeOwnerQQ, pending,
    pendingSendToolCalls, pendingWakeKeys, queuedHintAt, readJsonSafe, rememberAgentToken, reverse,
    saveSocialV2State, saveState, sendToolSucceededSessions, sessionModels, setClosedAgentPreset, setCurrentMode,
    setDshDefaultPreset, setDshPresetIds, settingFromDshNamespace, social, socialV2,
    state, toolCallNames, turnLeaseNoted, v2TurnStartAt, withTimeout;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({
      DSH_CONTROL_TIMEOUT_MS, MODE_INPUT_ALIASES, STATE_DIR, activeWaits, allowed, api,
      cancelPendingEntry, cfg, clearSocialV2Timers, collectors, disarmPendingWakeLease,
      feedbackTimes, lastSendFailed, getClosedAgentPreset, getCurrentMode, getDshDefaultPreset, getDshPresetIds, liteChatEnabled,
      liteKeyEnabled, log, modelAppliedSessions, normalizeModeInput, normalizeOwnerQQ, pending,
      pendingSendToolCalls, pendingWakeKeys, queuedHintAt, readJsonSafe, rememberAgentToken, reverse,
      saveSocialV2State, saveState, sendToolSucceededSessions, sessionModels, setClosedAgentPreset, setCurrentMode,
      setDshDefaultPreset, setDshPresetIds, settingFromDshNamespace, social, socialV2,
      state, toolCallNames, turnLeaseNoted, v2TurnStartAt, withTimeout
    } = deps);
  }

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        setDshDefaultPreset(defaultPreset);
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        setCurrentMode(fromDsh);
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-agent 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 getClosedAgentPreset()；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          setClosedAgentPreset(localPreset.closedAgentPreset);
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) setCurrentMode(fromLocal);
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      setClosedAgentPreset(local.closedAgentPreset);
    }
  }

  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      setDshPresetIds(list.map((p) => String(p.id)));
      if (!getDshDefaultPreset()) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) setDshDefaultPreset(String(marked.id));
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 带 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (getDshDefaultPreset() || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (getDshPresetIds().length === 0) return strict ? '' : wanted;
    if (getDshPresetIds().includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${getDshPresetIds().join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return getDshDefaultPreset() || '';
  }

  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(getClosedAgentPreset());
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    // 轻量聊天（Track 2）：reserved2 下打开 liteChat 时改用无工具预设。
    // 预设名变化会让 reconcileSessionPolicies() 温和地退役旧会话（agentToken 轮换、DSH 会话归档），
    // 下一次唤醒自动重建——所以开关是"热"的，不需要重启桥接。
    if (mode === 'reserved2' && liteChatEnabled() && liteKeyEnabled(key)) {
      const litePreset = cfg.socialV2?.liteChat?.preset || 'qq-chat-lite';
      // 兜底：DSH 还没装 qq-chat-lite 时不要把所有会话卡死（strict 会直接拒绝建会话）。
      // 已知预设清单存在但缺 lite → 暂时回退到原 agentPreset，并在日志里提示（只提示一次）。
      if (getDshPresetIds().length > 0 && !getDshPresetIds().includes(litePreset)) {
        if (!litePresetMissingWarned) {
          litePresetMissingWarned = true;
          log(`⚠️ liteChat 已开启，但 DSH 没有预设 "${litePreset}"（现有：${getDshPresetIds().join(', ')}）；本轮回退 ${cfg.socialV2?.agentPreset || cfg.agentPreset}。请重启 DSH 让新预设生效。`);
        }
      } else {
        return resolvePresetName(litePreset, { strict: true }) || undefined;
      }
    }
    const wanted = mode === 'reserved2'
      ? (cfg.socialV2?.agentPreset || cfg.agentPreset)
      : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, getCurrentMode());
  }

  function sessionPolicy(key) {
    return JSON.stringify([getCurrentMode(), modePreset(key, getCurrentMode(), cfg) ?? '', getCurrentMode() === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    feedbackTimes.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `getDshPresetIds()`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (getDshPresetIds().length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  return { bind, refreshMode, refreshPresetList, modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode, sessionPolicy, isCurrentSession, stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies };
}
