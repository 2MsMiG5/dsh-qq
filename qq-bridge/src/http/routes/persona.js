// persona 域的 HTTP 端点。

import fs from 'node:fs';
import path from 'node:path';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from '../../preset-prompt.js';
import { roleCharStats, roleSectionReport } from '../../role-card.js';
import { text } from '@snowluma/sdk';
import { unwrap } from '../../dsh-client.js';
import { formatConversationDigest } from '../../person-memory.js';

export function createPersonaRoutes(deps) {
  const {
    PRESET_BACKUP_DIR, PRESET_NAMES, ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX, ROOT, agentTokenOk,
    api, applyRoleInjectLimit, atomicWriteJson, atomicWriteText, backupPresetFile, cfg,
    getSocialV2State, installedPresetYaml, knownPresetName, listPresetBackups, log, personStore,
    presetSourceYaml, presetStatus, readConfigObject, readPresetPromptText, readRoleContent, readRoleProfile,
    readRoleState, refreshAllDefaultWakeConfigsV2, regeneratePresetPatch, roleDelete, roleExists, roleRename,
    roleSummaries, roleWarnings, sanitizeRoleName, v2SessionAllowed, validateRoleContent,
    validateRoleName, writeRoleContent, writeRoleProfile, writeRoleState,
    // 自拍图库：检查人格目录能否用、里面有多少张图（控制台「形象与声音」用）。
    inspectSelfieDirs,
  } = deps;

  // 当前生效的唤醒词：人格设了用自己的，没设回落到全局推荐值（与 v2-store 的取值口径一致）。
  // 切换人格时只在「词表真的变了」的情况下刷新会话，避免无意义地重置睡眠计时。
  const effectiveWakeKeywords = (roleName, cfgRef) => {
    const own = roleName ? readRoleProfile(roleName).wakeKeywords : [];
    if (own.length) return own;
    return Array.isArray(cfgRef.socialV2?.wake?.recommendedKeywords)
      ? cfgRef.socialV2.wake.recommendedKeywords.map(String)
      : [];
  };
  const sameKeywords = (a, b) => a.length === b.length && a.every((word, i) => word === b[i]);
  return [
    {
      method: 'GET',
      path: '/api/presets',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        let presets = [];
        try {
          const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
          presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
        } catch {}
        sendJson({ presets });
        return;
        // ── 轻量聊天（Track 2/3）现状：控制台「聊天行为」页一次取全 ────────────
        // 返回引擎/密钥来源、当前生效的全部行为参数、能力开关与用量、
        // 每个会话的唤醒配置与最近动作，以及 token 账本里的分会话花费。
      }
    },
    {
      method: 'POST',
      path: '/api/role',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        const rs = readRoleState();
        if (body.role && typeof body.role === 'string') {
          const name = sanitizeRoleName(body.role);
          if (!roleExists(name)) {
            sendJson({ ok: false, error: `角色「${name}」不存在（可在控制台新建）` }, 400);
            return;
          }
          writeRoleState(name, rs.mode);
          // 人格换了，默认唤醒词也跟着换：只刷新「仍在用默认配置」的会话，
          // AI 或管理员显式设过唤醒条件的会话保持原样（语义见 refreshDefaultWakeConfigV2）。
          // 词表没变就不刷新——刷新会重置会话的睡眠计时，白推迟一次唤醒。
          const keywordsChanged = !sameKeywords(effectiveWakeKeywords(rs.role, cfg), effectiveWakeKeywords(name, cfg));
          let wakeRefreshed = false;
          if (keywordsChanged) {
            try { wakeRefreshed = refreshAllDefaultWakeConfigsV2(); } catch (error) { log(`切换人格后刷新默认唤醒配置失败（不影响切换）：${error?.message ?? error}`); }
          }
          log(`控制台：角色已设置为 ${name}${wakeRefreshed ? '（默认唤醒词已按人格刷新）' : ''}`);
          sendJson({ ok: true, role: name, profile: readRoleProfile(name), wakeRefreshed });
        } else {
          writeRoleState(null, rs.mode);
          // 清除人格后唤醒词回落到全局推荐值：同样只动仍用默认配置的会话。
          const keywordsChanged = !sameKeywords(effectiveWakeKeywords(rs.role, cfg), effectiveWakeKeywords(null, cfg));
          let wakeRefreshed = false;
          if (keywordsChanged) {
            try { wakeRefreshed = refreshAllDefaultWakeConfigsV2(); } catch (error) { log(`清除人格后刷新默认唤醒配置失败（不影响切换）：${error?.message ?? error}`); }
          }
          log(`控制台：角色已清除${wakeRefreshed ? '（默认唤醒词已回落到全局）' : ''}`);
          sendJson({ ok: true, role: null, wakeRefreshed });
        }
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/role-mode',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        const rs = readRoleState();
        const mode = body.mode === 'silent' ? 'silent' : 'active';
        writeRoleState(rs.role, mode);
        log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
        sendJson({ ok: true, roleMode: mode });
        return;
        // ── 人格管理 ──────────────────────────────────────────────────────────
      }
    },
    {
      method: 'GET',
      path: '/api/roles',
      async handler({ req, res, url, sendJson, readBody, roleInjectMaxChars, selfDisplayName }) {
        const rs = readRoleState();
        const summaries = roleSummaries();
        sendJson({
          // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
          // 富信息放在 summaries 里，新老调用方互不影响。
          roles: summaries.map((role) => role.name),
          summaries,
          current: rs.role ?? null,
          // 当前人格的声音设定（音色 / 唤醒词）；没有人格时为 null。
          currentProfile: rs.role ? readRoleProfile(rs.role) : null,
          // 全局默认值：前端用它显示「未设置 → 跟随全局（大肥鱼 / 小鲸鱼…）」。
          voiceDefaults: {
            voice: String(cfg.socialV2?.voice?.tts?.voice || ''),
            voiceName: String(cfg.socialV2?.voice?.tts?.voiceName || ''),
            wakeKeywords: Array.isArray(cfg.socialV2?.wake?.recommendedKeywords)
              ? cfg.socialV2.wake.recommendedKeywords.map(String)
              : [],
          },
          limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
        });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/roles/profile',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        let name;
        try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        const rs = readRoleState();
        sendJson({
          ok: true,
          name,
          isCurrent: rs.role === name,
          profile: readRoleProfile(name),
        });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/roles/profile',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        let name;
        try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        let profile;
        const beforeKeywords = effectiveWakeKeywords(name, cfg);
        try {
          // 各项各写各的：请求里没出现的键保持不变（见 role-store 的 writeProfile）。
          profile = writeRoleProfile(name, {
            voice: body.voice,
            voiceName: body.voiceName,
            wakeKeywords: body.wakeKeywords,
            selfieDirs: body.selfieDirs,
          });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '保存失败' }, 400);
          return;
        }
        // 只有当改的是「当前启用人格」、且生效词表真的变了时才刷新会话。
        let wakeRefreshed = false;
        const isCurrent = readRoleState().role === name;
        const keywordsChanged = body.wakeKeywords !== undefined
          && !sameKeywords(beforeKeywords, effectiveWakeKeywords(name, cfg));
        if (isCurrent && keywordsChanged) {
          try { wakeRefreshed = refreshAllDefaultWakeConfigsV2(); } catch (error) { log(`保存唤醒词后刷新默认配置失败（不影响保存）：${error?.message ?? error}`); }
        }
        // 自拍库即时生效（每次取图现读库），这里只把「目录是否真的存在、里面几张图」回报给控制台，
        // 让管理员在保存的那一刻就知道路径写没写错，而不是等某次 [SELFIE] 发不出来。
        const selfie = body.selfieDirs === undefined
          ? null
          : inspectSelfieDirs(profile.selfieDirs);
        if (selfie && !selfie.images) {
          log(`⚠️ 人格「${name}」的自拍图库没有可用图片（配置 ${selfie.configured.length} 个目录，存在 ${selfie.resolved.length} 个）：[SELFIE] 会回落到全局形象库`);
        }
        log(`控制台：人格「${name}」形象与声音设定已更新（音色 ${profile.voice || '跟随全局'}；唤醒词 ${profile.wakeKeywords.length} 个；自拍目录 ${profile.selfieDirs.length} 个）${wakeRefreshed ? '，默认唤醒配置已刷新' : ''}`);
        sendJson({ ok: true, name, profile, isCurrent, wakeRefreshed, selfie });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/roles/selfie',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        // 自拍图库自检：给控制台回答三件事——这个人格配的目录能不能用、里面有几张图、
        // 没配/配错时会回落到哪儿。取图逻辑本身在 media/local-images.js，这里只做读侧展示。
        const rawName = String(url.searchParams.get('name') ?? '').trim();
        let name = '';
        if (rawName) {
          try { name = validateRoleName(rawName); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        }
        const profile = name ? readRoleProfile(name) : { selfieDirs: [] };
        const own = inspectSelfieDirs(profile.selfieDirs);
        const globalDirs = Array.isArray(cfg.socialV2?.image?.selfDirs) ? cfg.socialV2.image.selfDirs.map(String) : [];
        const fallback = inspectSelfieDirs(globalDirs);
        // assets/ 下的一级子目录当候选：按人格分目录是本功能的推荐用法，
        // 直接把目录名摆出来，管理员不用去资源管理器里抄路径。
        const candidates = [];
        try {
          const assetsDir = path.join(ROOT, 'assets');
          for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const rel = `assets/${entry.name}`;
            candidates.push({ dir: rel, images: inspectSelfieDirs([rel]).images });
          }
        } catch {}
        sendJson({
          ok: true,
          name: name || null,
          isCurrent: !!name && readRoleState().role === name,
          // owns：这个人格自己的自拍库（configured 是原始配置，resolved 是真实存在的绝对路径）
          own,
          // fallback：没配置或配置全失效时实际会用的图库（config.json 的 socialV2.image.selfDirs）
          fallback,
          candidates,
        });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/roles/content',
      async handler({ req, res, url, sendJson, readBody, roleInjectMaxChars, selfDisplayName }) {
        let name;
        try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        const content = readRoleContent(name);
        sendJson({
          ok: true,
          name,
          content,
          chars: content.length,
          bytes: Buffer.byteLength(content, 'utf8'),
          warnings: roleWarnings(content),
          limits: { injectMaxChars: roleInjectMaxChars },
          stats: roleCharStats(content),
          // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
          sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
        });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/roles/limit',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName, setRoleInjectMaxChars }) {
        const body = await readBody();
        const next = applyRoleInjectLimit(body.maxInjectChars);
        const configFile = path.join(ROOT, 'config.json');
        const file = readConfigObject(configFile);
        file.role = { ...(file.role ?? {}), maxInjectChars: next };
        atomicWriteJson(configFile, file);
        cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
        setRoleInjectMaxChars(next);
        log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
        sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/roles/create',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        let name; let content;
        try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
        catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
        writeRoleContent(name, content);
        log(`控制台：创建人格「${name}」（${content.length} 字符）`);
        sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/roles/update',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        let name; let content;
        try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
        catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        writeRoleContent(name, content);
        log(`控制台：更新人格「${name}」（${content.length} 字符）`);
        sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/roles/rename',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        let from; let to;
        try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
        catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
        if (!roleExists(from)) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
        if (roleExists(to)) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
        roleRename(from, to);
        const rs = readRoleState();
        const switched = rs.role === from;
        if (switched) writeRoleState(to, rs.mode);
        log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
        sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/roles/delete',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        let name;
        try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        roleDelete(name);
        const rs = readRoleState();
        const cleared = rs.role === name;
        if (cleared) writeRoleState(null, rs.mode);
        log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
        sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
        return;

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
      }
    },
    {
      method: 'GET',
      path: '/api/preset/sim-prompt',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const preset = knownPresetName(url.searchParams.get('preset'));
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        try {
          const { prefix } = readPresetPromptText(preset);
          sendJson({
            ok: true,
            content: prefix,
            chars: prefix.length,
            bytes: Buffer.byteLength(prefix, 'utf8'),
            warnings: presetPromptWarnings(prefix, 'lite'),
            status: presetStatus(preset),
            presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
          });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
        }
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/preset/sim-prompt',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        const preset = knownPresetName(body.preset);
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        let nextText;
        try {
          const { text, prefix } = readPresetPromptText(preset);
          // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
          // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
          const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
          if (normalized === prefix) {
            sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix, 'lite'), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
            return;
          }
          nextText = renderPresetPromptYaml(text, body.content, 'lite');
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
          return;
        }
        const warnings = presetPromptWarnings(body.content, 'lite');
        let sourceBackup = null;
        let patchSynced = true;
        try {
          sourceBackup = backupPresetFile(preset);
          atomicWriteText(presetSourceYaml(preset), nextText);
          // 同步到 DSH 实际读取的安装目录。
          // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
          // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
          const installed = installedPresetYaml(preset);
          if (fs.existsSync(installed)) {
            fs.copyFileSync(presetSourceYaml(preset), installed);
          }
          patchSynced = regeneratePresetPatch(preset);
        } catch (error) {
          // 尽力回滚源文件，避免留下半截状态
          if (sourceBackup && fs.existsSync(sourceBackup)) {
            try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
          }
          sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
          return;
        }
        log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
        sendJson({
          ok: true,
          chars: String(body.content ?? '').length,
          warnings,
          synced: fs.existsSync(installedPresetYaml(preset)),
          patchSynced,
          requiresRestart: true,
          status: presetStatus(preset),
        });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/preset/sim-prompt/backups',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const preset = knownPresetName(url.searchParams.get('preset'));
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        try {
          sendJson({ ok: true, backups: listPresetBackups(preset) });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
        }
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/preset/sim-prompt/restore',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        const body = await readBody();
        const preset = knownPresetName(body.preset);
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        try {
          const requested = String(body.file ?? '').trim();
          const candidates = listPresetBackups(preset).map((b) => b.file);
          const target = requested || candidates[0];
          // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
          if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
          const backupPath = path.join(PRESET_BACKUP_DIR, target);
          const restored = fs.readFileSync(backupPath, 'utf8');
          const restoredPrefix = extractPresetPrefix(restored);
          if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
          // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
          // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
          // 不变量清单按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
          const blockers = presetPromptBlockers(restoredPrefix, 'lite');
          if (blockers.length) {
            sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
            return;
          }
          backupPresetFile(preset);
          atomicWriteText(presetSourceYaml(preset), restored);
          const installed = installedPresetYaml(preset);
          if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
          regeneratePresetPatch(preset);
          log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
          sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
        }
        return;

        // ── 黑话库管理 ──────────────────────────────────────────────────────
      }
    },
    {
      method: 'ANY',
      prefix: '/api/persons',
      async handler({ req, res, url, sendJson, readBody, selfDisplayName }) {
        if (url.pathname.startsWith('/api/persons')) {
          const topicAgentKey = (input) => String((input && input.key) ?? url.searchParams.get('key') ?? '').trim();
          const topicAgentDeny = (key) => {
            if (!req.headers['x-agent-token']) return null;
            if (!key) return { status: 400, error: '智能体调用必须提供会话 key' };
            if (!agentTokenOk(key, req.headers['x-agent-token'])) return { status: 403, error: 'agent token 无效' };
            if (!v2SessionAllowed(key)) return { status: 403, error: '目标不在当前模式允许范围内' };
            return null;
          };
          const topicFail = (error) => {
            const status = Number(error?.statusCode) || 500;
            if (status >= 500) log(`人物档案接口异常：${error?.stack ?? error?.message ?? error}`);
            sendJson({ ok: false, error: error?.message ?? String(error) }, status);
          };
          const personStoreForRequest = () => {
            const store = personStore();
            if (!store) { sendJson({ ok: false, error: '人物档案已关闭（config.json 的 personMemory.enabled=false）' }, 403); return null; }
            return store;
          };
          // 本机绝对路径只给控制台（人要看文件在哪）；智能体调用不需要、也不该拿到。
          const stripTopicPaths = (value) => {
            if (Array.isArray(value)) return value.map(stripTopicPaths);
            if (value && typeof value === 'object') {
              const out = {};
              for (const [k, v] of Object.entries(value)) {
                if (k === 'path') continue;
                out[k] = stripTopicPaths(v);
              }
              return out;
            }
            return value;
          };
          const topicRespond = (payload, status = 200) => sendJson(req.headers['x-agent-token'] ? stripTopicPaths(payload) : payload, status);
          const denyFor = (key, body) => {
            const denied = topicAgentDeny(key);
            if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return true; }
            return false;
          };

          if (req.method === 'GET' && url.pathname === '/api/persons') {
            const key = topicAgentKey();
            if (denyFor(key)) return;
            const store = personStoreForRequest();
            if (!store) return;
            const q = String(url.searchParams.get('q') ?? '').trim();
            try {
              const entries = q ? store.search(q, Number(cfg.personMemory?.searchLimit) || 8) : store.list();
              topicRespond({ ok: true, dir: store.storage || store.dir, total: q ? entries.length : store.stats().total, topics: entries });
            } catch (error) { topicFail(error); }
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/persons/one') {
            const key = topicAgentKey();
            if (denyFor(key)) return;
            const id = String(url.searchParams.get('id') ?? '').trim();
            if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
            const store = personStoreForRequest();
            if (!store) return;
            try {
              const topic = store.get(id);
              if (!topic) { sendJson({ ok: false, error: `档案不存在：${id}` }, 404); return; }
              topicRespond({ ok: true, topic });
            } catch (error) { topicFail(error); }
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/persons/save') {
            const input = await readBody();
            const key = topicAgentKey(input);
            if (denyFor(key)) return;
            const store = personStoreForRequest();
            if (!store) return;
            try {
              const topic = store.save({
                id: input.id,
                title: input.title,
                summary: input.summary,
                tags: input.tags,
                people: input.people,
                source: input.source,
                pinned: input.pinned,
                body: input.body,
                // 控制台「分段编辑」提交的是三段概况 + 时间线（不再拼整段 Markdown 回来）。
                // 这三个键漏传，save() 就落到「只更新 meta」的分支：接口回 ok、列表字数不变，
                // 人看到的就是「点了保存但正文没变」。
                sections: input.sections,
                timeline: input.timeline,
                sourceNote: input.sourceNote,
                mode: input.mode
              });
              log(`人物档案已保存：${topic.id}（${topic.chars} 字）`);
              topicRespond({ ok: true, topic });
            } catch (error) { topicFail(error); }
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/persons/delete') {
            const input = await readBody();
            const key = topicAgentKey(input);
            if (denyFor(key)) return;
            const id = String(input.id ?? '').trim();
            if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
            const store = personStoreForRequest();
            if (!store) return;
            try {
              const result = store.remove(id);
              log(`人物档案已删除：${id}（备份 ${result.backupPath}）`);
              // 智能体调用不该拿到本机绝对路径（控制台要显示备份位置，照旧返回）。
              if (req.headers['x-agent-token']) sendJson({ ok: true });
              else sendJson({ ok: true, backupPath: result.backupPath });
            } catch (error) { topicFail(error); }
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/persons/search') {
            const input = await readBody();
            const key = topicAgentKey(input);
            if (denyFor(key)) return;
            const store = personStoreForRequest();
            if (!store) return;
            try {
              const q = String(input.q ?? '').trim();
              const limit = Number(input.limit) || Number(cfg.personMemory?.searchLimit) || 8;
              topicRespond({ ok: true, results: q ? store.search(q, limit) : [] });
            } catch (error) { topicFail(error); }
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/persons/digest') {
            const input = await readBody();
            const key = String(input.key ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (denyFor(key)) return;
            const store = personStoreForRequest();
            if (!store) return;
            try {
              const st = getSocialV2State(key);
              let messages = [...(Array.isArray(st.recentMessages) ? st.recentMessages : []), ...(Array.isArray(st.unread) ? st.unread : [])];
              const afterSeq = Number(input.afterSeq);
              const beforeSeq = Number(input.beforeSeq);
              if (Number.isSafeInteger(afterSeq)) messages = messages.filter((m) => Number(m?.seq) > afterSeq);
              if (Number.isSafeInteger(beforeSeq)) messages = messages.filter((m) => Number(m?.seq) < beforeSeq);
              // 先按 seq 去重再排序/截断：recentMessages 与 unread 有重叠，不去重会让 count/from/to
              // 与 formatConversationDigest 内部去重后的正文对不上（模型会以为整理了 N 条，正文只有 M 条）。
              const seenFingerprints = new Set();
              const ordered = messages
                .filter((m) => m && typeof m === 'object')
                .filter((m) => {
                  const seq = Number(m.seq);
                  const fingerprint = Number.isSafeInteger(seq) && seq > 0
                    ? `s:${seq}`
                    : `t:${m.time}:${m.sender}:${m.text}`;
                  if (seenFingerprints.has(fingerprint)) return false;
                  seenFingerprints.add(fingerprint);
                  return true;
                })
                .sort((a, b) => ((Number(a.seq) || 0) - (Number(b.seq) || 0)) || ((Number(a.time) || 0) - (Number(b.time) || 0)));
              const limit = Math.max(1, Math.min(200, Number(input.limit) || 60));
              const picked = ordered.slice(-limit);
              const seqOf = (message) => {
                const seq = Number(message?.seq);
                return Number.isSafeInteger(seq) ? seq : null;
              };
              const markdown = formatConversationDigest({ key, messages: picked, limit, selfName: selfDisplayName });
              const truncated = Array.from(markdown).length > 60000;
              const clipped = truncated ? `${Array.from(markdown).slice(0, 60000).join('')}\n\n…（已截断；请分段整理）` : markdown;
              let topic = null;
              if (input.save === true) {
                const topicInput = {
                  summary: input.summary,
                  body: markdown,
                  source: key
                };
                if (input.topic) {
                  topicInput.id = String(input.topic);
                  topicInput.mode = 'append';
                } else {
                  topicInput.title = input.title || `会话整理 ${key}`;
                }
                topic = store.save(topicInput);
                log(`会话整理已写入档案：${topic.id}（${picked.length} 条消息）`);
              }
              const payload = {
                ok: true,
                markdown: clipped,
                truncated,
                count: picked.length,
                // from/to 是 ISO 时间（给人看/给控制台显示）；fromSeq/toSeq 是消息水位（给 AI 续整理用）。
                from: picked.length ? new Date(Number(picked[0].time) || Date.now()).toISOString() : null,
                to: picked.length ? new Date(Number(picked[picked.length - 1].time) || Date.now()).toISOString() : null,
                fromSeq: picked.length ? seqOf(picked[0]) : null,
                toSeq: picked.length ? seqOf(picked[picked.length - 1]) : null
              };
              if (topic) payload.topic = topic;
              topicRespond(payload);
            } catch (error) { topicFail(error); }
            return;
          }
          sendJson({ ok: false, error: `未知的人物档案接口：${req.method} ${url.pathname}` }, 404);
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
      }
    },
  ];
}
