// media 域的 HTTP 端点。

import path from 'node:path';
import { text } from '@snowluma/sdk';
import { SENSITIVE_RE } from '../../sensitive.js';
import { describeAudio, inspectAudio, parseTargetKey, resolveAudioProcessing } from '../../voice-core.js';

export function createMediaRoutes(deps) {
  const {
    allowed, api, appendActivity, bot, cfg, escapeCqText, fetch, log, modeAllowed,
    redactKnownTokensOnly, resolveVoicePathForOperator, sendVoiceV2, socialV2,
    verifyVoiceMessageSent, voiceBudgetCheck, voiceBudgetCommit, voiceCfg,
  } = deps;

  /**
   * 调 OneBot HTTP 动作（本文件只用它做临时查询：fetch_ptt_text）。
   * 统一地址与鉴权头；返回 `{ ok, res, body }`，失败语义交给调用方。
   */
  async function postOneBot(action, params, timeoutMs) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.status === 'ok' && body.retcode === 0, res, body };
  }

  return [
    {
      method: 'POST',
      path: '/api/test-send',
      async handler({ req, res, url, sendJson, readBody, currentMode, stickerEntries, stickerStoreWritable, stickerSyncedAt }) {
        const body = await readBody();
        const kind = body.kind === 'private' ? 'private' : 'group';
        const id = Number(body.id);
        const message = String(body.message ?? '').trim();
        if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
        if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
        if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
        if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
        if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
        try {
          const safeMessage = escapeCqText(redactKnownTokensOnly(message));
          const result = kind === 'private'
            ? await bot.sendPrivateMessage(id, text(safeMessage))
            : await bot.sendGroupMessage(id, text(safeMessage));
          log(`控制台：测试发送 ${kind}:${id} 成功`);
          sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
        } catch (error) {
          sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
        }
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/voice/send',
      async handler({ req, res, url, sendJson, readBody, currentMode, stickerEntries, stickerStoreWritable, stickerSyncedAt }) {
        const body = await readBody();
        const voice = voiceCfg();
        // 这是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
        // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
        // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
        const key = String(body.target ?? body.key ?? '').trim();
        const parsedTarget = parseTargetKey(key);
        if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
          const a = cfg.allow ?? {};
          sendJson({
            ok: false,
            error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
          }, 403);
          return;
        }
        let resolved;
        try {
          resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          return;
        }
        // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
        try {
          resolveAudioProcessing({
            volume: body.volume ?? voice.defaultVolume,
            normalize: body.normalize === true,
            loudness: body.loudness ?? voice.loudness
          });
        } catch (error) {
          sendJson({ ok: false, error: error.message }, 400);
          return;
        }
        const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
        if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
        const preview = {
          key,
          file: resolved.path,
          via: resolved.via,
          bytes: probe.size,
          duration: probe.duration,
          codec: probe.codec,
          detail: describeAudio(probe),
          warnings: probe.warnings ?? [],
          limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
        };
        if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
        const now = Date.now();
        try {
          voiceBudgetCheck('operator:cli', voice);
          const sent = await sendVoiceV2(key, resolved.path, {
            guard: false,
            audit: true,
            audio: {
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            }
          });
          voiceBudgetCommit('operator:cli', now);
          log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
          appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
          // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
          const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
          let readbackText = null;
          if (body.readback === true && sent.messageId) {
            try {
              const { ok, body: rb } = await postOneBot('fetch_ptt_text', { message_id: String(sent.messageId) }, 30000);
              if (ok) readbackText = rb.data?.text ?? '';
            } catch (error) {
              log(`[voice] 转写回读失败：${error?.message ?? error}`);
            }
          }
          sendJson({
            ok: true,
            ...preview,
            messageId: sent.messageId,
            verified: verification?.confirmed === true,
            readback: readbackText,
            audioProcessing: sent.audioProcessing,
            volume: sent.volume,
            loudness: sent.loudness
          });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
        return;
      }
    }
  ];
}
