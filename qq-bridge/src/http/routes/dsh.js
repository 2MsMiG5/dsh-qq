// dsh 域的 HTTP 端点。

import path from 'node:path';
import { summaryFreshness } from '../../lite-context.js';
import { liteThinkingForKey } from '../../lite-chat.js';

/**
 * 把 `liteChat.thinking` 解析成「实际生效的档位」字符串，供控制台展示。
 *
 * 为什么不在前端解析：配置有两种写法（统一字符串 / 按类型对象），
 * 前端各写一遍必然和 `liteThinkingForKey` 跑偏；这里直接复用同一份规则。
 * 传 `private:0` / `group:0` 只是借前缀选分支，QQ 号本身不参与判断。
 */
function thinkingLevelOf(raw, kind) {
  const parsed = liteThinkingForKey(`${kind}:0`, raw);
  return parsed.thinking === 'disabled' ? 'disabled' : parsed.effort;
}

export function createDshRoutes(deps) {
  const {
    DSH_CONTROL_TIMEOUT_MS, REASONING_EFFORT_DEFAULT, REASONING_EFFORT_OPTIONS, ROOT, allowed, allowedEffortsFor,
    api, atomicWriteJson, cancelPendingEntry, cfg, clearSocialV2Timers,
    clearTimeout, collectors, currentRoleHintLite, drainPromptQueue, ensureChatModel, ensureSession,
    forgetAgentToken, liteDirectActive, liteEngine, liteModelKey, loadConfig, loadDshCatalog,
    log, messageMediaStore, modelAppliedSessions, modelCatalogErrorLogged, modelSelection, normalizeReasoningEffort,
    pending, pendingSendToolCalls, pendingWakeKeys, queued, queuedHintAt, readConfigObject,
    readRoleState, resolveImageDirs, reverse, saveSocialV2State, saveState, seenForwardIds,
    sendToolSucceededSessions, sessionPromises, social,
    socialV2, state, stickerEnabled, tokenLedger, toolCallNames, turnLeaseNoted,
    v2TurnStartAt, videoCallTimes, visionCallTimes, voiceTtsCfg, withTimeout,
  } = deps;
  return [
    {
      method: 'GET',
      path: '/api/lite/summary',
      async handler({ req, res, url, sendJson, readBody, currentMode, liteDirectBroken, liteDirectFailures, sessionEpoch, stickerEntries }) {
        try {
          const lite = cfg.socialV2?.liteChat ?? {};
          const keyInfo = liteModelKey();
          let ledger = null;
          try {
            const s = tokenLedger.summary({ limit: 200 });
            const byKey = new Map();
            for (const row of Array.isArray(s?.conversations) ? s.conversations : []) {
              if (row && typeof row.key === 'string') byKey.set(row.key, row);
            }
            ledger = { totals: s?.totals ?? null, byKey };
          } catch {}
          const now = Date.now();
          const conversations = [];
          for (const [key, st] of socialV2.conversations.entries()) {
            if (!st) continue;
            const wc = st.wakeConfig ?? {};
            const tr = wc.triggers ?? {};
            const trig = [];
            if (tr.atMention) trig.push('@');
            if (tr.nameMention) trig.push('名字');
            if (tr.question) trig.push('提问');
            if (tr.poke) trig.push('拍一拍');
            if (tr.anyMessage) trig.push('任意消息');
            if (Array.isArray(tr.keywords) && tr.keywords.length) trig.push(`关键词${tr.keywords.length}`);
            if (Number(tr.probability) > 0) trig.push(`概率${tr.probability}`);
            if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) trig.push(`指定成员${tr.speakerIds.length}`);
            const row = ledger?.byKey?.get(key) ?? null;
            conversations.push({
              key,
              engine: liteDirectActive(key) ? 'direct' : 'dsh',
              unread: Array.isArray(st.unread) ? st.unread.length : 0,
              wake: {
                mode: wc.mode === 'active' ? 'active' : 'diving',
                infinite: wc.infinite !== false,
                sleepUntil: wc.sleepUntil ?? null,
                triggers: trig,
                wakeCount: Number(wc.wakeCount) || 0
              },
              lastIncomingAgoMs: Number(st.lastIncomingAt) > 0 ? Math.max(0, now - Number(st.lastIncomingAt)) : null,
              lastAiReplyAgoMs: Number(st.lastAiReplyAt) > 0 ? Math.max(0, now - Number(st.lastAiReplyAt)) : null,
              pendingWake: pendingWakeKeys.has(key),
              cost: row?.cost ?? 0,
              turns: row?.turnCount ?? row?.turns ?? null,
              imageSendsLastHour: Array.isArray(st.imageSendTimes) ? st.imageSendTimes.filter((x) => now - x < 3600000).length : 0,
              summary: String(st.liteSummary?.text || ''),
              summaryAt: Number(st.liteSummary?.updatedAt) || 0,
              summaryFresh: summaryFreshness(st.liteSummary?.updatedAt, now)
            });
          }
          conversations.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.unread - a.unread);
          // 当前人格：让控制台能直接看到「人设卡片有没有真的进提示词」。
          let roleInfo = { name: null, chars: 0 };
          try {
            const rs = readRoleState();
            if (rs?.role) roleInfo = { name: String(rs.role), chars: currentRoleHintLite().length };
          } catch {}
          let imageDirCount = 0;
          // 注意：发图配置只存在于 cfg.socialV2.image（loadConfig 里合并的默认值也在这里），
          // 曾经误写成 cfg.image，导致 dirs 永远为空、lite 发图 100% 失败、控制台也显示 0 张。
          try { imageDirCount = resolveImageDirs(cfg.socialV2?.image ?? {}).length; } catch {}
          let tts = { enabled: false, voiceName: '', maxChars: 120 };
          try { const tc = voiceTtsCfg(); tts = { enabled: tc.enabled === true, voiceName: tc.voiceName ?? '', maxChars: tc.maxChars }; } catch {}
          sendJson({
            ok: true,
            at: now,
            mode: currentMode,
            role: roleInfo,
            engineInfo: {
              selected: liteEngine(),
              keySource: keyInfo?.source ?? null,
              model: lite.model || cfg.dsh?.model || 'deepseek-flash',
              preset: lite.preset || 'qq-chat-lite',
              directBroken: liteDirectBroken,
              directFailures: liteDirectFailures
            },
            behavior: {
              maxMessages: Number(lite.maxMessages) || 2,
              historyMessages: Number(lite.historyMessages) || 12,
              historyMaxAgeMs: Number(lite.historyMaxAgeMs) || 7200000,
              historyMaxChars: Number(lite.historyMaxChars) || 2400,
              summaryEnabled: lite.summaryEnabled !== false,
              summaryEveryTurns: Number(lite.summaryEveryTurns) || 8,
              summaryMaxChars: Number(lite.summaryMaxChars) || 300,
              groupWakeProbability: Number.isFinite(Number(lite.groupWakeProbability)) ? Number(lite.groupWakeProbability) : 0,
              wakeMaxPerHour: Number(cfg.socialV2?.wake?.maxWakePerHour) || 0,
              batchWindowMs: Number(cfg.socialV2?.wake?.batchWindowMs) || 0,
              nativeImages: lite.nativeImages !== false,
              maxImagesPerWake: Number(lite.maxImagesPerWake) || 1,
              maxVoicesPerWake: Number(lite.maxVoicesPerWake) || 1,
              maxVideosPerWake: Number(lite.maxVideosPerWake) || 1,
              maxImagesPerReply: Number(lite.maxImagesPerReply) || 1,
              maxPokesPerReply: Number(lite.maxPokesPerReply) || 1,
              maxVoicesPerReply: Number(lite.maxVoicesPerReply) || 1,
              stickerMax: Number(lite.stickerMax) || 6,
              maxStickers: Number(lite.maxStickers) || 2,
              // 思考档位按会话类型各返回一份解析结果（不是配置原值）：
              // 控制台要显示"实际生效的档位"，配置写错时也要能看出落到了 disabled。
              thinking: {
                private: thinkingLevelOf(lite.thinking, 'private'),
                group: thinkingLevelOf(lite.thinking, 'group')
              },
              maxTokens: Number(lite.maxTokens) || 0
            },
            capabilities: {
              vision: { enabled: cfg.vision?.enabled !== false, native: lite.nativeImages !== false, usedLastHour: visionCallTimes.length },
              asr: { enabled: cfg.voice?.asr?.enabled !== false },
              video: { enabled: cfg.video?.enabled !== false, usedLastHour: videoCallTimes.length },
              tts,
              stickers: { enabled: stickerEnabled(), count: Array.isArray(stickerEntries) ? stickerEntries.length : 0 },
              image: {
                enabled: cfg.socialV2?.image?.enabled !== false,
                dirCount: imageDirCount,
                pixevalUrl: cfg.socialV2?.image?.pixevalMcpUrl ?? null,
                minBookmarks: Number(cfg.socialV2?.image?.minBookmarks) || 0
              },
              poke: { enabled: true }
            },
            keys: Array.isArray(lite.keys) ? lite.keys : [],
            paused: socialV2.paused === true,
            ledger: ledger?.totals ?? null,
            conversations
          });
          return;
        } catch (error) {
          sendJson({ ok: false, error: `读取轻量聊天现状失败：${error?.message ?? error}` }, 500);
          return;
        }
      }
    },
    {
      method: 'GET',
      path: '/api/sessions',
      async handler({ req, res, url, sendJson, readBody, currentMode, liteDirectBroken, liteDirectFailures, sessionEpoch, stickerEntries }) {
        const list = [];
        for (const [key, sessionId] of Object.entries(state.sessions)) {
          list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
        }
        sendJson({ sessions: list });
        return;
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
      }
    },
    {
      method: 'GET',
      path: '/api/dsh/model',
      async handler({ req, res, url, sendJson, readBody, currentMode, liteDirectBroken, liteDirectFailures, sessionEpoch, stickerEntries }) {
        const provider = String(cfg.dsh?.provider || 'deepseek-official');
        const model = String(cfg.dsh?.model || 'deepseek-flash');
        // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
        let options = REASONING_EFFORT_OPTIONS.slice();
        let labels = {};
        let providerDefault = null;
        let catalogSource = 'fallback';
        // 模型在 DSH 目录里、但一条思考档位都没声明（反代 qoder 的模型正是如此）。
        // 这种模型传 reasoningEffort 会被 DSH 拒绝，控制台不能假装能调。
        let reasoningUnsupported = false;
        // 供控制台的「提供商 / 模型」下拉使用：只回展示需要的字段。
        let catalogGroups = [];
        try {
          const catalog = await loadDshCatalog();
          catalogGroups = (catalog?.groups ?? []).map((g) => ({
            id: String(g?.id ?? ''),
            name: String(g?.name ?? g?.id ?? ''),
            models: (g?.models ?? []).map((m) => ({
              id: String(m?.id ?? ''),
              name: String(m?.name ?? m?.id ?? ''),
              description: String(m?.description ?? ''),
              efforts: (m?.reasoning?.efforts ?? []).map((e) => ({
                id: String(e?.id ?? ''),
                name: String(e?.name ?? ''),
                description: String(e?.description ?? '')
              })).filter((e) => e.id),
              defaultEffort: m?.reasoning?.defaultEffort ?? null
            })).filter((m) => m.id)
          })).filter((g) => g.id);
          const group = catalogGroups.find((g) => g.id === provider);
          const entry = (group?.models ?? []).find((m) => m.id === model);
          const efforts = entry?.efforts ?? [];
          // 档位以目录为准（openai 系有 minimal / medium / xhigh），只剔除 'off'。
          const advertised = efforts.map((e) => e.id).filter((id) => id !== 'off');
          if (advertised.length) {
            options = advertised;
            labels = Object.fromEntries(efforts.map((e) => [e.id, { name: e.name ?? '', description: e.description ?? '' }]));
            providerDefault = entry.defaultEffort ?? null;
            catalogSource = 'dsh';
          } else if (entry) {
            // 目录里有这个模型、但它没声明任何档位：如实返回「不支持」，
            // 而不是回落到内置清单让管理员点一个切了也不生效的档位。
            options = [];
            labels = {};
            providerDefault = null;
            catalogSource = 'dsh';
            reasoningUnsupported = true;
          }
        } catch (error) {
          // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
          const reason = String(error?.message ?? error);
          if (!modelCatalogErrorLogged.has(reason)) {
            modelCatalogErrorLogged.add(reason);
            log(`读取 DSH 模型能力失败（控制台模型切换与思考强度档位都会受影响）：${reason}`);
          }
        }
        sendJson({
          provider,
          model,
          // 不支持档位的模型回 null：此时 config.json 里的 reasoningEffort 不生效，
          // 报一个具体档位只会误导（控制台会把它当成"当前生效值"）。
          reasoningEffort: reasoningUnsupported ? null : String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
          options,
          labels,
          default: REASONING_EFFORT_DEFAULT,
          providerDefault,
          catalogSource,
          reasoningUnsupported,
          // 控制台的提供商/模型下拉就靠这份目录；读取失败时是空数组（前端据此停用切换）。
          catalog: catalogGroups,
          // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
          // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
          globalSideEffect: true,
        });
        return;
        // ── 切换提供商 / 模型（写 config.json，已在运行的会话于下一条消息生效） ──
      }
    },
    {
      method: 'POST',
      path: '/api/dsh/model',
      async handler({ req, res, url, sendJson, readBody, currentMode, liteDirectBroken, liteDirectFailures, sessionEpoch, stickerEntries }) {
        const body = await readBody();
        const provider = String(body.provider ?? '').trim();
        const model = String(body.model ?? '').trim();
        if (!provider || !model) {
          sendJson({ ok: false, error: 'provider 和 model 不能为空' }, 400);
          return;
        }
        // 必须命中 DSH 模型目录：名字差一个字符 selectModel 就永远失败，而 ensureSession 只在
        // not-found 时退役会话——表现就是「控制台说切了、实际回复还来自旧模型」，最难查的那种。
        let providerName = provider;
        let entry = null;
        try {
          const catalog = await loadDshCatalog();
          const group = (catalog?.groups ?? []).find((g) => String(g?.id ?? '') === provider);
          if (!group) {
            sendJson({ ok: false, error: `DSH 里没有提供商 "${provider}"（可能未安装对应插件或未登录）` }, 400);
            return;
          }
          providerName = String(group?.name ?? provider);
          entry = (group?.models ?? []).find((m) => String(m?.id ?? '') === model) ?? null;
          if (!entry) {
            sendJson({ ok: false, error: `提供商 ${providerName}（${provider}）下没有模型 "${model}"` }, 400);
            return;
          }
        } catch (error) {
          // 拿不到目录就无法校验：拒绝写入，免得把 DSH 不认识的组合落进 config.json。
          sendJson({ ok: false, error: `读取 DSH 模型清单失败，未做修改：${error?.message ?? error}` }, 503);
          return;
        }
        // 换模型时顺手校正思考档位：新模型若不支持原档位，selectModel 会被 DSH 直接拒绝，
        // 而失败会被 ensureSession 静默吞掉（继续用旧模型），所以这里必须先把档位调对。
        const currentEffort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
        // 只认该模型自己声明、且桥接允许下发的档位（'off' 不在其中，QQ 助手依赖思考）。
        const advertised = allowedEffortsFor(entry);
        let nextEffort = currentEffort;
        let effortChanged = false;
        if (advertised.length && !advertised.includes(currentEffort)) {
          const defaultEffort = entry.reasoning?.defaultEffort;
          // 优先用模型自己的默认档；默认档是 'off' 或不在可选范围里时退到第一个可用档。
          const preferred = [defaultEffort, ...advertised]
            .find((id) => typeof id === 'string' && advertised.includes(id.trim().toLowerCase()));
          nextEffort = preferred ?? advertised[0];
          effortChanged = nextEffort !== currentEffort;
        }
        const configFile = path.join(ROOT, 'config.json');
        // fail-fast：配置损坏时直接 500，绝不回写（与白名单/档位接口同语义）
        const file = readConfigObject(configFile);
        const previous = {
          provider: String(cfg.dsh?.provider ?? ''),
          model: String(cfg.dsh?.model ?? '')
        };
        const patch = { provider, model, ...(effortChanged ? { reasoningEffort: nextEffort } : {}) };
        file.dsh = { ...(file.dsh ?? {}), ...patch };
        atomicWriteJson(configFile, file);
        cfg.dsh = { ...(cfg.dsh ?? {}), ...patch };
        // 递增代号：所有已在运行的会话在下一条消息重新 selectModel（无需重启桥接或 DSH）。
        modelSelection.epoch += 1;
        log(`控制台：DSH 模型已切换 ${previous.provider || '-'}/${previous.model || '-'} -> ${provider}/${model}`
          + (effortChanged ? `（思考强度 ${currentEffort} -> ${nextEffort}：新模型不支持原档位）` : '')
          + '（对已有会话于下一条消息生效）');
        sendJson({
          ok: true,
          provider,
          providerName,
          model,
          previous,
          reasoningEffort: nextEffort,
          effortChanged,
          // 该模型没声明任何档位：config 里的 reasoningEffort 对它不生效，应用时会省略该字段。
          reasoningUnsupported: advertised.length === 0,
          globalSideEffect: true
        });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/dsh/effort',
      async handler({ req, res, url, sendJson, readBody, currentMode, liteDirectBroken, liteDirectFailures, sessionEpoch, stickerEntries }) {
        const body = await readBody();
        // 档位是否合法取决于当前模型：能读到目录就用目录声明的档位，读不到退回内置词表。
        let allowed = REASONING_EFFORT_OPTIONS;
        let entry = null;
        let provider = String(cfg.dsh?.provider || 'deepseek-official');
        let model = String(cfg.dsh?.model || 'deepseek-flash');
        try {
          const catalog = await loadDshCatalog();
          entry = (catalog?.groups ?? []).find((g) => g?.id === provider)?.models?.find((m) => m?.id === model) ?? null;
          const declared = allowedEffortsFor(entry);
          if (declared.length) allowed = declared;
        } catch {
          // 读不到能力清单时按内置词表校验；是否真的生效由 ensureChatModel 的日志暴露。
        }
        let effort;
        try { effort = normalizeReasoningEffort(body.reasoningEffort, allowed); }
        catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
        // 模型自己不支持档位时直接拒绝：写进 config.json 也不会生效，
        // 反而会让控制台显示一个从来不生效的「当前档位」（见 GET /api/dsh/model 的 reasoningUnsupported）。
        if (entry && !allowedEffortsFor(entry).length) {
          sendJson({ ok: false, error: `当前模型 ${provider}/${model} 不支持思考强度档位，设置不会生效` }, 409);
          return;
        }
        const configFile = path.join(ROOT, 'config.json');
        // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
        const file = readConfigObject(configFile);
        file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
        atomicWriteJson(configFile, file);
        cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
        // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
        modelSelection.epoch += 1;
        log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
        sendJson({ ok: true, reasoningEffort: effort });
        return;

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
      }
    },
    {
      method: 'POST',
      path: '/api/session/reset',
      async handler({ req, res, url, sendJson, readBody, bumpSessionEpoch, currentMode, liteDirectBroken, liteDirectFailures, sessionEpoch, stickerEntries }) {
        const body = await readBody();
        const key = String(body.key ?? '');
        // 直连引擎不建 DSH 会话（state.sessions 里没有这个 key），但会话状态、未读、
        // 纪要、定时器全在 socialV2.conversations 里。旧版判定「!state.sessions[key] ⇒ 404」
        // 让控制台的「清除上下文」在直连下 100% 报「会话不存在」，等于按钮是死的。
        const hasDshSession = !!state.sessions[key];
        const hasSocialState = socialV2.conversations.has(key);
        if (!key || (!hasDshSession && !hasSocialState)) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
        bumpSessionEpoch();
        const oldSessionId = hasDshSession ? state.sessions[key] : null;
        if (oldSessionId) delete state.sessions[key];
        modelAppliedSessions.delete(oldSessionId);
        // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
        delete state.sessionPolicies[key];
        reverse.delete(oldSessionId);
        collectors.delete(oldSessionId);
        sendToolSucceededSessions.delete(oldSessionId);
        pendingSendToolCalls.delete(oldSessionId);
        v2TurnStartAt.delete(oldSessionId);
        turnLeaseNoted.delete(oldSessionId);
        toolCallNames.delete(oldSessionId);
        const pe = pending.get(key);
        if (pe) {
          clearTimeout(pe.timer);
          cancelPendingEntry(pe).catch(() => {});
        }
        pending.delete(key);
        queued.delete(key);
        queuedHintAt.delete(key);
        sessionPromises.delete(key);
        drainPromptQueue(key, '会话已重置');
        messageMediaStore.delete(key);
        social.silentTurns.delete(oldSessionId);
        clearSocialV2Timers(key);
        pendingWakeKeys.delete(key);
        forgetAgentToken(key);
        socialV2.conversations.delete(key);
        seenForwardIds.delete(key);
        saveSocialV2State();
        saveState();
        // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
        // 直连引擎没有 DSH 会话（oldSessionId 为 null），跳过这一段即可。
        if (oldSessionId) {
          try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
        } else {
          log(`控制台：已清除会话上下文 ${key}（直连引擎，无 DSH 会话可归档）`);
        }
        sendJson({ ok: true, key, archived: oldSessionId });
        return;
      }
    },
  ];
}
