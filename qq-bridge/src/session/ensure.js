// ensure.js — 从 src/bridge.js 抽取的函数簇（2 个函数）。
//
// 采用「延迟绑定」：工厂先返回可调用的函数，boot 装配完成后再 bind 一次依赖。
// 原因是这些函数依赖 bot / handles 等在 boot 尾部才创建的对象，在工厂创建时解构会撞 TDZ。
//
// 三条规则（违反任一条都会静默出错）：
//   1) 可变状态必须 bind **取值函数**，不能 bind 值快照——否则模块看到的是永久冻结的旧状态。
//   2) 函数体与原实现逐字一致，只把闭包引用改为 bind 进来的局部变量。
//   3) 凡是能被测试/调用方替换的能力（抓取、外部服务调用），一律走 bind，不要在这里 import。
//      原实现从 boot 外层作用域取这些名字，调用方通过注入同名绑定来替换；改成直接 import
//      会绕过那个注入点——调用方以为自己换了实现，实际跑的还是真模块（假绿）。

import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';

export function createSessionEnsurer() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let DSH_CONTROL_TIMEOUT_MS, REASONING_EFFORT_DEFAULT, STATE_DIR, api, cfg, isCurrentSession, isSessionAllowedInCurrentMode, log, modePreset, modelAppliedSessions, modelsWithoutReasoningEffort, retireSession, reverse, saveState, sessionPolicy, sessionPromises, sleep, socialV2, state, withTimeout;
  // 下面四项在 bridge 里是 let，运行时会被改写（切模式 / reset 递增代际 / 控制台换预设 /
  // 控制台切模型后递增代号）。必须 bind 取值函数：传值的话本模块永远按启动那一刻判断，
  // 典型症状是切了模式却仍用旧 preset 建会话、以及 reset 之后旧会话"复活"。
  let getCurrentMode, getDshPresetIds, getSessionEpoch, getModelSelectionEpoch;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ DSH_CONTROL_TIMEOUT_MS, REASONING_EFFORT_DEFAULT, STATE_DIR, api, cfg, isCurrentSession, isSessionAllowedInCurrentMode, log, modePreset, modelAppliedSessions, modelsWithoutReasoningEffort, retireSession, reverse, saveState, sessionPolicy, sessionPromises, sleep, socialV2, state, withTimeout, getCurrentMode, getDshPresetIds, getSessionEpoch, getModelSelectionEpoch } = deps);
  }

  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === getModelSelectionEpoch()) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    const modelKey = `${provider}/${model}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // 不支持思考档位的模型（反代 qoder 的全线模型都是）必须省略该字段：
        // 传了 DSH 会直接拒绝 selectModel，会话就静默留在旧模型上。
        const request = { sessionId, provider, model };
        const omitEffort = modelsWithoutReasoningEffort.has(modelKey);
        if (!omitEffort) request.reasoningEffort = effort;
        const result = unwrap(await api.sessions.selectModel(request), 'session.selectModel');
        modelAppliedSessions.set(sessionId, getModelSelectionEpoch());
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? (omitEffort ? '该模型不支持思考档位，已省略' : '默认')})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        const message = String(error?.message ?? error);
        // 档位不兼容不是真失败：记住后立刻重试（不占退避时间），换一种握手方式再选一次。
        if (!modelsWithoutReasoningEffort.has(modelKey) && /does not support reasoning effort/i.test(message)) {
          modelsWithoutReasoningEffort.add(modelKey);
          log(`模型 ${modelKey} 不支持思考档位 ${effort}，改为省略 reasoningEffort 重新选择（${message}）`);
          continue;
        }
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${message}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, getModelSelectionEpoch());
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = getSessionEpoch();
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== getSessionEpoch() || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const mode = getCurrentMode();
      const preset = modePreset(key, mode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = mode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${mode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${getDshPresetIds().join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${getCurrentMode()}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== getSessionEpoch() || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== getSessionEpoch() || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${getCurrentMode()}，preset: ${modePreset(key, getCurrentMode(), cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  return { bind, ensureChatModel, ensureSession };
}
