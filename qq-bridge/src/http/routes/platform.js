// platform 域的 HTTP 端点。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { text } from '@snowluma/sdk';
import { unwrap } from '../../dsh-client.js';
import { collectSnowlumaPanelInfo } from '../../snowluma-panel.js';
import { manualDirCommand } from '../../state-acl.mjs';
import { SECURITY_HEADERS } from '../security-headers.js';

export function createPlatformRoutes(deps) {
  const {
    ACTIVITY_LOG, CONVERSATION_TOKENS, DSH_CONTROL_TIMEOUT_MS, KNOWN_AGENT_TOKENS, MODE_INPUT_ALIASES, ROOT,
    SNOWLUMA_PANEL_CACHE_MS, STATE_DIR, VALID_MODES, addConsoleNote, agentTokenOk, allowed,
    api, appendActivity, atomicWriteJson, atomicWriteText, buildWakePromptLite,
    cancelPendingEntry, cfg, clearAllSocialV2Timers, clearTimeout, collectors,
    deliverPrompt, drainAllPromptQueues, ensureSession, getSocialV2State, handleLiteTurnEnd, hardenStateDirAcl,
    isConversationBusyV2, liteEngine, liteKeyEnabled, log, messageMediaStore, modeAllowed,
    normalizeModeInput, normalizeOwnerQQ, pending, pendingSendToolCalls, priceTable, queued,
    queuedHintAt, readActivityTail, readConfigObject, readJsonSafe, readRoleState, reconcileSessionPolicies,
    refreshMode, releaseLock, replayPendingWakeReasonsV2, reverse, saveSocialV2State, saveState,
    scheduleProactiveCheckV2, seenForwardIds, sendToolSucceededSessions, sendWakePromptV2, sessionPromises, setConsoleToken,
    setTimeout, setupSleepTimerV2, snowlumaHealthSnapshot,
    snowlumaHomeDir, social, socialV2, startConsoleServer, state, stateDirHardened,
    tokenLedger, toolCallNames, v2TurnStartAt, withTimeout,
  } = deps;
  return [
    {
      method: 'GET',
      path: '/',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        try {
          res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
        } catch {
          res.end('控制台页面缺失：qq-bridge/public/console.html');
        }
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/status',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const rs = readRoleState();
        // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
        // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
        // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
        // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
        // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
        // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
        // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
        if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
          sendJson({
            mode: currentMode,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            socialV2Paused: socialV2.paused,
          });
          return;
        }
        sendJson({
          mode: currentMode,
          closedAgentPreset,
          role: rs.role ?? null,
          roleMode: rs.mode ?? 'active',
          dshReady,
          // 对话引擎是当前最重要的运行状态：直连（direct）时 DSH 没运行是**正常**的，
          // 控制台不能再把「DSH 未连接」当成故障展示（旧版总览页就是这么误报的）。
          engine: liteEngine(),
          engineModel: cfg.socialV2?.liteChat?.model || cfg.dsh?.model || 'deepseek-flash',
          engineDirectBroken: liteDirectBroken,
          // 活跃会话数取 socialV2 的会话表：直连引擎不建 DSH 会话，state.sessions 会一直是空的，
          // 旧版「已建立会话」指标因此长期显示 0，与实际情况不符。
          conversationCount: socialV2.conversations.size,
          ownerQQ: cfg.ownerQQ ?? null,
          allowGroups: cfg.allow?.groups ?? [],
          allowPrivate: cfg.allow?.private ?? [],
          socialV2Paused: socialV2.paused,
          // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
          // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图
          snowluma: snowlumaHealthSnapshot(),
          activity: readActivityTail(100)
        });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/snowluma/info',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        // 控制台「SnowLuma 上游」卡片的只读数据源。
        // ⚠️ 边界：这里**只读**（runtime.json / logs / OneBot 探活 / 端口探测），
        // 没有任何启动/停止/改配置路径 —— SnowLuma 是闭源专有组件，EULA §5.4 禁止
        // 「通过自动化脚本部署」，仓库安全基线 L6 也是「只探测、不部署」。
        // 管理端专用：带 agent token 的调用在下面总白名单里就被拒了（不在 agentAllowed）。
        const fresh = url.searchParams.get('fresh') === '1';
        const at = Date.now();
        if (!fresh && snowlumaPanelCache.value && at - snowlumaPanelCache.at < SNOWLUMA_PANEL_CACHE_MS) {
          sendJson({ ...snowlumaPanelCache.value, cached: true });
          return;
        }
        const info = await collectSnowlumaPanelInfo({
          cfg,
          homeDir: snowlumaHomeDir(),
          upstream: snowlumaHealthSnapshot(),
          fetchImpl: fetch,
          logLines: 40,
        });
        snowlumaPanelCache.at = at;
        snowlumaPanelCache.value = info;
        sendJson({ ...info, cached: false });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/mode',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, setClosedAgentPreset, setMode, snowlumaPanelCache, stickerStoreWritable }) {
        const body = await readBody();
        // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
        const requestedMode = normalizeModeInput(body.mode);
        if (!requestedMode) {
          sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
          return;
        }
        const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
        const next = {
          mode: requestedMode,
          // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
          ...(body.closedAgentPreset !== undefined
            ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
            : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
        };
        atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
        // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
        setClosedAgentPreset(next.closedAgentPreset);
        // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
        // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
        // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
        // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
        let dshSynced = false;
        try {
          // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
          // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
          unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
          dshSynced = true;
        } catch (error) {
          log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
        }
        // 下面这个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
        // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
        if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        setMode(requestedMode);
        reconcileSessionPolicies();
        if (requestedMode === 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
        sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/pending',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const list = [];
        for (const [key, p] of pending.entries()) {
          list.push({
            key,
            kind: p.kind,
            sessionId: p.sessionId,
            ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
            ...(p.kind === 'question' ? { questions: p.questions } : {})
          });
        }
        sendJson({ pending: list });
        return;
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
      }
    },
    {
      method: 'GET',
      path: '/api/whitelist',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/whitelist',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const body = await readBody();
        const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
        const configFile = path.join(ROOT, 'config.json');
        // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
        const file = readConfigObject(configFile);
        const allow = {
          private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
          groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
        };
        const deny = {
          private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
          groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
        };
        // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
        let ownerQQ = cfg.ownerQQ ?? null;
        if (body.ownerQQ !== undefined) {
          try {
            ownerQQ = normalizeOwnerQQ(body.ownerQQ);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
            return;
          }
        }
        file.allow = allow;
        file.deny = deny;
        file.ownerQQ = ownerQQ;
        atomicWriteJson(configFile, file);
        cfg.allow = { private: allow.private, groups: allow.groups };
        cfg.deny = { private: deny.private, groups: deny.groups };
        cfg.ownerQQ = ownerQQ;
        reconcileSessionPolicies();
        log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
        sendJson({ ok: true, allow, deny, ownerQQ });
        return;

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
      }
    },
    {
      method: 'GET',
      path: '/api/security',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        sendJson({
          security: cfg.security ?? { interceptNotify: true },
          // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
          // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
          // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
          // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
          stateDir: {
            hardened: stateDirHardened,
            path: STATE_DIR,
            manualCommand: process.platform === 'win32'
              ? manualDirCommand(STATE_DIR)
              : `chmod 700 "${STATE_DIR}"`
          }
        });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/security',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const body = await readBody();
        // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
        if (body.rehardenStateDir === true) {
          stateDirHardened = null;
          hardenStateDirAcl();
          sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
          return;
        }
        const configFile = path.join(ROOT, 'config.json');
        const file = readConfigObject(configFile);
        const next = { ...(file.security ?? {}), ...body };
        if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
        else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
        file.security = next;
        atomicWriteJson(configFile, file);
        cfg.security = { ...(cfg.security ?? {}), ...next };
        log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
        sendJson({ ok: true, security: cfg.security });
        return;
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
      }
    },
    {
      method: 'POST',
      path: '/api/console/token',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const body = await readBody();
        let newToken = String(body.token ?? '').trim();
        const generated = !newToken;
        if (generated) {
          newToken = crypto.randomBytes(24).toString('hex');
        }
        if (newToken.length < 16) {
          sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
          return;
        }
        if (newToken.length > 128) {
          sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
          return;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
          sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
          return;
        }
        const configFile = path.join(ROOT, 'config.json');
        const file = readConfigObject(configFile);
        // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
        file.consoleToken = generated ? '' : newToken;
        atomicWriteJson(configFile, file);
        cfg.consoleToken = generated ? '' : newToken;
        atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
        setConsoleToken(newToken);
        log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
        sendJson({ ok: true, token: newToken, generated });
        return;
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
      }
    },
    {
      method: 'POST',
      path: '/api/console/notify-ai',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const message = String(body.message ?? '').trim();
        if (!key || !message) {
          sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
          return;
        }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) {
          sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
          return;
        }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0) {
          sendJson({ ok: false, error: 'id 无效' }, 400);
          return;
        }
        if (!modeAllowed(key, kind, id, cfg, currentMode)) {
          sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
          return;
        }
        if (!state.sessions[key] && !allowed(kind, id, cfg)) {
          sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
          return;
        }
        // ── 主链路是 lite：提醒写进会话状态，并**当场唤醒一次** ──────────────
        // 直连引擎压根不建 DSH 会话，「投递一条 prompt」这个动作在 lite 下不存在。
        // 统一落点是会话状态的 consoleNotes 队列（注入见 buildWakePromptLite，
        // 消费见 handleLiteTurnEnd）。提醒不是「等下次有人说话才生效」：
        // 会话正在潜水、没有未读、连 DSH 都没起，都要能把它叫醒一次。
        // 只看「这个会话归不归 lite 管」，不看引擎此刻到底是直连还是 DSH 兜底：
        // 直连断了、DSH 刚重启还没重建 sessionPolicies，都不该让提醒落到「DSH 不可用」的
        // 503 上 —— 提醒进队列等着，引擎恢复后第一次唤醒就会带上它。
        const liteOwned = liteKeyEnabled(key);
        if (liteOwned) {
          const note = addConsoleNote(key, message);
          if (!note) {
            sendJson({ ok: false, error: '提醒内容为空，或与已有一条待生效提醒完全相同' }, 409);
            return;
          }
          const stV2 = getSocialV2State(key);
          // 和手动唤醒同一套规矩：首轮唤醒必须是 bootstrap，否则操作者预写的
          // 「初始提示词」会随着 bootstrapSent 置真永久丢掉。
          const firstWake = !stV2.bootstrapSent;
          const wakeReason = firstWake ? 'bootstrap' : 'console';
          // 四种落点都回报给控制台：管理员必须能看出这一下到底醒没醒，而不是看到
          // 「已写入」却什么也没发生。
          let wakeMode = 'immediate';
          if (socialV2.paused || cfg.socialV2?.enabled === false) {
            // AI 被暂停：提醒照样记下，但不违背暂停去叫它；也**不能**吃掉首轮名额，
            // 否则解除暂停后那条会话再也拿不到操作者预写的初始提示词。
            wakeMode = 'paused';
          } else {
            if (firstWake) { stV2.bootstrapSent = true; saveSocialV2State(); }
            if (stV2.pendingWakeTimer) {
              // 已经在 6 秒合并窗口里排着一枪（通常是有新消息刚进来）：不改排队结构，
              // 只把这个排队唤醒的原因升成 console（优先级最高）—— 6 秒后那一枪
              // 既带【未读消息】也带【后台提醒】，一次唤醒两件事都办完。
              stV2.pendingWakeReason = wakeReason;
              saveSocialV2State();
              wakeMode = 'merged';
            } else {
              // 空闲就直接投，不走合并窗口（sendWakePromptV2 本身就是立即投递）。
              // 会话正在跑回合时会自行暂存，回合结束由 replayPendingWakeReasonsV2 补放
              // —— console 属「与未读无关」的唤醒原因，不会被未读水位判断吞掉。
              if (isConversationBusyV2(key, stV2)) wakeMode = 'deferred';
              void sendWakePromptV2(key, wakeReason)
                .catch((error) => log(`[console] ${key} 提醒唤醒异常：${error?.message ?? error}`));
            }
          }
          const wakeLabel = {
            immediate: '已立即唤醒',
            merged: '并入 6 秒合并窗口（那一枪带上提醒）',
            deferred: '已排队，等当前回合结束后立刻补放',
            paused: 'AI 已暂停，只记录不唤醒'
          }[wakeMode];
          log(`控制台：后台提醒已写入 ${key}（lite 注入通道，${wakeLabel}，原因 ${wakeReason}）`);
          appendActivity(`${key} 控制台后台提醒（lite 注入）：${message.slice(0, 80)}`);
          sendJson({ ok: true, key, channel: 'lite', reason: wakeReason, noteId: note.id, firstWake, wake: wakeMode, wakeLabel });
          return;
        }
        if (!dshReady) {
          sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
          return;
        }
        const isV2 = currentMode === 'reserved2';
        const roleState = readRoleState();
        const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
        // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
        let tokenLine = '';
        if (isV2) {
          const stV2 = getSocialV2State(key);
          tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
        }
        const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
        let sessionId = null;
        let popSilent = null;
        try {
          sessionId = await ensureSession(key);
          const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const arr = social.silentTurns.get(sessionId) ?? [];
          social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
          popSilent = () => {
            const list = social.silentTurns.get(sessionId) ?? [];
            const next = list.filter((x) => x.id !== silentId);
            if (next.length > 0) social.silentTurns.set(sessionId, next);
            else social.silentTurns.delete(sessionId);
          };
          const result = await deliverPrompt(key, promptText, { silent: true });
          if (result.ok) {
            log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
            appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
            sendJson({ ok: true, key, sessionId });
          } else {
            popSilent();
            sendJson({ ok: false, error: result.error || '投递失败' }, 500);
          }
        } catch (error) {
          if (popSilent) popSilent();
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
        return;
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
      }
    },
    {
      method: 'ANY',
      path: '/api/tokens/summary',
      prefix: '/api/tokens/',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
      }
    },
    {
      method: 'POST',
      path: '/api/authorize/read',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const token = String(body.token ?? '').trim();
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!token || !agentTokenOk(key, token)) {
          // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
          // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
          // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
          sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
          return;
        }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
          sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
          return;
        }
        sendJson({ ok: true, key });
        return;
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
      }
    },
    {
      method: 'POST',
      path: '/api/workspace/reset',
      async handler({ req, res, url, sendJson, readBody, bumpSessionEpoch, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        bumpSessionEpoch();
        let archivedCount = 0;
        let stoppedCount = 0;
        try {
          // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
          // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
          const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
          const stateDir = path.resolve(STATE_DIR);
          const statePrefix = path.normalize(stateDir + path.sep);
          const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
          const isUnderState = (cwd) => process.platform === 'win32'
            ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
            : cwd.startsWith(statePrefix);
          for (const item of list.items ?? []) {
            if (item.origin === 'subagent' || item.parentSessionId) continue;
            const cwd = normPath(item.cwd);
            if (isUnderState(cwd)) {
              // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
              try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
              catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
              try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
            }
          }
        } catch {}
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          cancelPendingEntry(entry).catch(() => {});
        }
        pending.clear();
        queued.clear();
        queuedHintAt.clear();
        sessionPromises.clear();
        drainAllPromptQueues('工作区已清空');
        messageMediaStore.clear();
        seenForwardIds.clear();
        social.silentTurns.clear();
        clearAllSocialV2Timers();
        // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
        socialV2.conversations.clear();
        CONVERSATION_TOKENS.clear();
        KNOWN_AGENT_TOKENS.clear();
        saveSocialV2State();
        state.sessions = {};
        state.sessionPolicies = {};
        reverse.clear();
        collectors.clear();
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        saveState();
        try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
        log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
        sendJson({ ok: true, archivedCount, stoppedCount });
        return;
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
      }
    },
    {
      method: 'POST',
      path: '/api/restart',
      async handler({ req, res, url, sendJson, readBody, closedAgentPreset, currentMode, dshReady, lastMode, liteDirectBroken, sessionEpoch, snowlumaPanelCache, stickerStoreWritable }) {
        sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
        setTimeout(() => {
          log('控制台：重启桥接');
          // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
          // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
          try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
          try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
          releaseLock();
          process.exit(0);
        }, 500);
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/shutdown',
      async handler({ req, res, url, sendJson }) {
        // 为什么需要这个端点：Windows 上没法给另一个进程投递可被捕获的信号
        // （process.kill / taskkill 都是 TerminateProcess，'exit' 钩子不会跑），
        // 而 taskkill /F 强杀会让 SQLite 的 -wal 留在盘上 —— 之后只拷 state/bridge.db
        // 的备份就是一个 4 KB 的空壳（真实数据全在 WAL 里，见 db.js 的 WAL 说明）。
        // 所以停服改走「控制台 HTTP 端点 + 正常 process.exit(0)」，
        // 让 exit 钩子里的 flushSocialV2State() / closeBridgeDb() 有机会执行。
        //
        // 鉴权：控制台令牌与回环 Host 校验在 src/http/server.js 统一做；带 x-agent-token
        // 的智能体调用命中默认拒绝白名单（见 server.js 的 agentAllowed），拿不到这个端点。
        sendJson({ ok: true, message: '正在停止桥接（优雅退出）…' });
        // 先回响应再退出：让调用方（stop-qq-bridge.mjs）确认请求已被接受，
        // 500ms 足够 response 刷出，也给排期中的 setImmediate 落盘留一点余量。
        setTimeout(() => {
          log('控制台：停止桥接');
          try { saveState(); } catch (error) { log('停止前保存会话映射失败:', error?.message ?? error); }
          try { saveSocialV2State(); } catch (error) { log('停止前保存二代会话状态失败:', error?.message ?? error); }
          releaseLock();
          process.exit(0);
        }, 500);
        return;
      }
    },
  ];
}
