// inbound.js — 从 src/bridge.js 抽取的函数簇（24 个函数）。
//
// 采用「延迟绑定」：工厂先返回可调用的函数，boot 装配完成后再 bind 一次依赖。
// 原因是这些函数依赖 bot / handles 等在 boot 尾部才创建的对象，在工厂创建时解构会撞 TDZ。
//
// 三条规则（违反任一条都会静默出错）：
//   1) 可变状态（currentMode 等）必须 bind **取值函数**，不能 bind 值快照——
//      否则模块一旦装配，看到的就是永久冻结的旧状态。
//   2) 函数体与原实现逐字一致，只把闭包引用改为 bind 进来的局部变量。
//   3) 凡是能被测试/调用方替换的能力（抓取、识图、ASR），一律走 bind，**不要**在这里 import。
//      原实现从 boot 外层作用域取这些名字，测试通过注入同名全局来替换；改成直接 import
//      会绕过那个注入点——测试以为自己换了实现，实际跑的还是真模块（假绿）。

// 只有 node 内建与「不可能被替换」的东西才直接 import。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function createInboundMedia() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let MAX_MEDIA_BYTES, MAX_MEDIA_COUNT, MAX_MEDIA_FETCH_BYTES, MAX_MEDIA_PIXELS, VIDEO_HINT_CACHE_MAX, VIDEO_HINT_TTL_MS;
  let api, appendSocialV2Message, bot, cfg, getCurrentMode, getSocialV2State, log, messageMediaStore, modelMediaLimits, socialV2;
  let videoCallTimes, videoHintCache, videoHintPrefetching, videoLinkApi, visionCallTimes, withTimeout;
  // 可替换能力（见规则 3）
  let ASR_LANGUAGES, canonicalizeWav, describeImagesWithVision, extractRecordSegments, fetchRecordWav;
  let looksLikeImageBuffer, normalizeImageForModel, safeFetchBuffer, text, transcribeViaDsh, transcribeViaQqAsr;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    // 解构赋值：逐个绑定。写成逗号表达式只会给最后一个变量赋值，其余全是 undefined。
    ({
      MAX_MEDIA_BYTES, MAX_MEDIA_COUNT, MAX_MEDIA_FETCH_BYTES, MAX_MEDIA_PIXELS, VIDEO_HINT_CACHE_MAX, VIDEO_HINT_TTL_MS,
      api, appendSocialV2Message, bot, cfg, getCurrentMode, getSocialV2State, log, messageMediaStore, modelMediaLimits, socialV2,
      videoCallTimes, videoHintCache, videoHintPrefetching, videoLinkApi, visionCallTimes, withTimeout,
      ASR_LANGUAGES, canonicalizeWav, describeImagesWithVision, extractRecordSegments, fetchRecordWav,
      looksLikeImageBuffer, normalizeImageForModel, safeFetchBuffer, text, transcribeViaDsh, transcribeViaQqAsr
    } = deps);
  }

  /**
   * 调 OneBot HTTP 动作：统一地址、鉴权头与超时；失败抛出带 retcode 的错误。
   * `label` 可覆盖错误前缀（默认 `<action> 失败`），供调用方保留原有文案。
   */
  async function oneBot(action, params, timeoutMs = 30000, label = `${action} 失败`) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const wording = body.wording ? ` ${body.wording}` : '';
      throw new Error(`${label}（HTTP ${res.status}，retcode=${body.retcode}${wording}）`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  async function toModelMedia(buffer, mimeType, label = '图片') {
    const out = await normalizeImageForModel(buffer, mimeType, { ...modelMediaLimits, label });
    if (!out.ok) {
      log(`[media] ${label} 不提供：${out.error}`);
      return out;
    }
    if (out.note) log(`[media] ${label}: ${out.note}`);
    return out;
  }

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_FETCH_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_FETCH_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_FETCH_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_FETCH_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_FETCH_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `face-${media.faceId}.${(prep.mimeType || 'png').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          // 压不到可用体积：明确说明原因，别让模型对着「（获取失败）」瞎猜。
          parts.push({ type: 'text', text: `[表情${index}（${prep.error}）]` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${label}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          parts.push({ type: 'text', text: `${label}（${prep.error}）` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: [face.text || '', prep.note ? `（${prep.note}）` : ''].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: `（获取失败：${prep.error}）` });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${noun}${index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            ...base,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: prep.note ? `（${prep.note}）` : ''
          });
        } else if (prep && !prep.ok) {
          out.push({ ...base, text: `（${noun}获取失败：${prep.error}）` });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function videoHintToolHint(key, messageRef) {
    return `要看内容细节/都说啥了，调用 mcp__dfy66__qq_describe_video(key="${key}", messageId="${messageRef}", token=…)；拿不到就如实说没看到，别编。`;
  }

  function videoHintLine(key, textContent, messageRef) {
    if (!messageRef || cfg.video?.enabled === false) return '';
    // 缓存先查：唤醒提示里的上下文文本被 appendSocialV2Message 截到 200 字，
    // 卡片标题很长时 URL 可能正好被截掉 —— 只按文本判定会漏掉已经预取好的完整卡片。
    const cacheKey = `${key}:${messageRef}`;
    const cached = videoHintCache.get(cacheKey);
    if (cached && Date.now() - cached.at < VIDEO_HINT_TTL_MS) return cached.line;
    let links = [];
    if (typeof videoLinkApi.extractVideoLinks === 'function') {
      try { links = videoLinkApi.extractVideoLinks(String(textContent ?? ''), { max: 1 }); } catch { links = []; }
    }
    // `[视频]` 段可能没有 URL（QQ 直传视频），仍要告诉模型「这是视频」，但不要暗示
    // 一定有链接可抓 —— 工具调用失败时它必须如实说没看到。
    const hasVideoSegment = typeof textContent === 'string' && textContent.includes('[视频]');
    if (!links.length && !hasVideoSegment) return '';
    if (getCurrentMode() !== 'reserved2' && getCurrentMode() !== 'closed-agent') {
      // 一代模式没有 qq_describe_video 工具面（端点会 403），只给事实提示，不给调用建议。
      return `【视频】本条消息包含视频链接/视频（消息ID=${messageRef}）。`;
    }
    return `【视频】检测到视频链接/分享卡片（消息ID=${messageRef}）。${videoHintToolHint(key, messageRef)}`;
  }

  async function prepareVideoHint(key, messageId, textContent) {
    if (!messageId || cfg.video?.enabled === false) return;
    if (typeof videoLinkApi.extractVideoLinks !== 'function' || typeof videoLinkApi.describeVideo !== 'function') return;
    const cacheKey = `${key}:${messageId}`;
    const cached = videoHintCache.get(cacheKey);
    if (cached && Date.now() - cached.at < VIDEO_HINT_TTL_MS) return;
    if (videoHintPrefetching.has(cacheKey)) return;
    // 全局并发上限：连发一堆视频链接时不能每条都起一次抓取（否则桥接会被群友刷满）。
    // 超出的消息仍会拿到「检测到视频链接，可调用工具」的通用提示，不影响使用。
    if (videoHintPrefetching.size >= 3) return;
    let links = [];
    try { links = videoLinkApi.extractVideoLinks(String(textContent ?? ''), { max: 1 }); } catch { return; }
    if (!links.length) return;
    videoHintPrefetching.add(cacheKey);
    try {
      const metaTimeout = Number(cfg.video?.metaTimeoutMs) > 0 ? Number(cfg.video.metaTimeoutMs) : 3500;
      const meta = await withTimeout(
        videoLinkApi.describeVideo(links[0].url, {
          config: cfg.video,
          mode: 'meta',
          ffmpegPath: cfg.video?.ffmpegPath || undefined,
          // 超时后连底层请求一起中止：否则这条预取会在后台继续跑到 fetchTimeoutMs（默认 20s）。
          signal: AbortSignal.timeout(metaTimeout)
        }),
        metaTimeout,
        '视频元数据'
      );
      if (!meta?.ok) return;
      const card = videoLinkApi.formatVideoCard ? videoLinkApi.formatVideoCard(meta) : '';
      if (!card) return;
      videoHintCache.set(cacheKey, { line: `【视频】${card}（消息ID=${messageId}）。${videoHintToolHint(key, messageId)}`, at: Date.now() });
      if (videoHintCache.size > VIDEO_HINT_CACHE_MAX) {
        for (const oldKey of videoHintCache.keys()) {
          videoHintCache.delete(oldKey);
          if (videoHintCache.size <= VIDEO_HINT_CACHE_MAX) break;
        }
      }
    } catch {
      // 预取失败就保持通用提示：模型仍可自己调工具重试，提示词不能因此变空。
    } finally {
      videoHintPrefetching.delete(cacheKey);
    }
  }

  function mediaHintFor(key, messageRef, mediaList, textContent = '') {
    if (!messageRef) return '';
    const hints = [];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      if (getCurrentMode() === 'reserved2') {
        hints.push(`【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。若你能直接看到图像内容就直接描述；若看不到（本会话模型通常不能看图），请调用 mcp__dfy66__qq_describe_image 让识图模型描述，参数 key="${key}", messageId="${messageRef}"。`);
      } else {
        hints.push(`【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`);
      }
    }
    if (typeof textContent === 'string' && textContent.includes('[语音]')) {
      hints.push(`【语音】本条消息是 QQ 语音（消息ID=${messageRef}），可调用 mcp__dfy66__qq_transcribe_voice 转写听到内容，参数 key="${key}", messageId="${messageRef}"。`);
    }
    // 视频链接/分享卡片/视频段：同步给提示（详细卡片由 prepareVideoHint 预取后进缓存）。
    const videoHint = videoHintLine(key, textContent, messageRef);
    if (videoHint) hints.push(videoHint);
    return hints.join('');
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (getCurrentMode() === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function visionRateLimited(vc) {
    const now = Date.now();
    while (visionCallTimes.length && now - visionCallTimes[0] > 3600000) visionCallTimes.shift();
    const minuteCount = visionCallTimes.filter((t) => now - t < 60000).length;
    if (vc.maxPerMinute > 0 && minuteCount >= vc.maxPerMinute) return `识图调用过于频繁（每分钟上限 ${vc.maxPerMinute} 次），请稍后再试`;
    if (vc.maxPerHour > 0 && visionCallTimes.length >= vc.maxPerHour) return `识图调用过于频繁（每小时上限 ${vc.maxPerHour} 次），请稍后再试`;
    return null;
  }

  function videoRateLimited(videoCfg) {
    const now = Date.now();
    while (videoCallTimes.length && now - videoCallTimes[0] > 3600000) videoCallTimes.shift();
    const minuteCount = videoCallTimes.filter((t) => now - t < 60000).length;
    const maxPerMinute = Number(videoCfg?.maxPerMinute ?? 4);
    const maxPerHour = Number(videoCfg?.maxPerHour ?? 20);
    if (maxPerMinute > 0 && minuteCount >= maxPerMinute) return `看视频调用过于频繁（每分钟上限 ${maxPerMinute} 次），请稍后再试`;
    if (maxPerHour > 0 && videoCallTimes.length >= maxPerHour) return `看视频调用过于频繁（每小时上限 ${maxPerHour} 次），请稍后再试`;
    return null;
  }

  async function describeMessageImages(key, messageId, promptText = '') {
    const vc = cfg.vision;
    if (!vc.enabled) return { ok: false, error: '识图功能未开启（config.json 的 vision.enabled=false 或 tools.describeImage=false）' };
    const blocked = visionRateLimited(vc);
    if (blocked) return { ok: false, error: blocked };
    const media = findMessageMedia(key, String(messageId));
    if (!media.length) return { ok: false, error: `消息 ${messageId} 没有可识别的图片/表情` };
    const images = await fetchMediaData(media);
    const usable = images.filter((img) => img?.data && img?.mimeType);
    if (!usable.length) return { ok: false, error: `消息 ${messageId} 的图片获取失败，无法识别` };
    const labels = images
      .map((img, i) => `${i + 1}. ${img.kind === 'face' ? '表情' : img.kind === 'sticker' ? '表情' : '图片'}${img.index ?? i + 1}${img.text ? ` ${img.text}` : ''}`)
      .join('；');
    const defaultPrompt = usable.length > 1
      ? `以下共 ${usable.length} 张图片，已全部附上，按出现顺序编号为图1 到 图${usable.length}。请按编号分别详细描述每一张，不要说只能看到一张图。`
      : '请详细描述这张图片的内容。';
    const result = await describeImagesWithVision(vc, usable, promptText.trim() ? promptText.trim() : defaultPrompt, { timeoutMs: vc.timeoutMs });
    if (!result.ok) return { ok: false, error: result.error };
    visionCallTimes.push(Date.now());
    return { ok: true, description: result.text, model: result.model, note: labels ? `识别对象：${labels}` : '' };
  }

  async function findMessageVoice(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) throw new Error('messageId 不能为空');
    let targetId = refStr;
    // 二代：先用会话状态把 seq / messageId 归一化成 QQ 真 message_id
    try {
      const st = getSocialV2State(key);
      if (st) {
        for (const messages of [st.recentMessages, st.unread]) {
          const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
          if (found && found.messageId) { targetId = String(found.messageId); break; }
        }
      }
    } catch {}
    const data = await oneBot('get_msg', { message_id: Number(targetId) }, 30000, '读取消息失败');
    const segments = Array.isArray(data?.message) ? data.message : [];
    const records = extractRecordSegments(segments);
    if (!records.length) throw new Error(`消息 ${refStr} 不是语音消息（没有 record 段）`);
    return { records, messageId: targetId };
  }

  async function transcribeVoiceMessage(key, messageId, language = '') {
    const asr = cfg.voice.asr;
    if (!asr.enabled) return { ok: false, error: '语音转写未开启（config.json 的 voice.asr.enabled=false 或 tools.transcribeVoice=false）' };
    const wantLanguage = String(language || asr.language);
    if (!ASR_LANGUAGES.includes(wantLanguage)) return { ok: false, error: `language 只能是 ${ASR_LANGUAGES.join('/')}` };
    let found;
    try {
      found = await findMessageVoice(key, String(messageId));
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
    const oneBotWithAsrTimeout = (action, params) => oneBot(action, params, asr.timeoutMs);

    // 主路径：SenseVoice
    try {
      const record = found.records[0];
      const wav = await fetchRecordWav(oneBotWithAsrTimeout, record);
      const canonical = canonicalizeWav(wav);
      if (!canonical.ok) return { ok: false, error: `音频规整失败：${canonical.error}` };
      if (canonical.durationSeconds > asr.maxDurationSeconds) {
        return { ok: false, error: `语音时长 ${canonical.durationSeconds.toFixed(1)}s 超过上限 ${asr.maxDurationSeconds}s` };
      }
      if (canonical.buffer.length > asr.maxBytes) {
        return { ok: false, error: `语音体积超限（${(canonical.buffer.length / 1024 / 1024).toFixed(1)}MB，上限 ${(asr.maxBytes / 1024 / 1024).toFixed(1)}MB）` };
      }
      const transcript = await transcribeViaDsh(
        (method, payload) => api.callUnary(method, payload),
        canonical.buffer.toString('base64'),
        { providerId: asr.providerId, language: wantLanguage }
      );
      if (transcript.ok) {
        return {
          ok: true,
          text: transcript.text,
          source: 'sensevoice',
          audioSeconds: transcript.audioSeconds,
          inferenceSeconds: transcript.inferenceSeconds,
          note: record.fileName ? `来源：${record.fileName}` : '',
        };
      }
      if (!asr.fallbackToQqAsr) return { ok: false, error: transcript.error };
      log(`[voice-asr] SenseVoice 失败，回退 QQ 转写：${transcript.error}`);
      try {
        const qqText = await transcribeViaQqAsr(oneBotWithAsrTimeout, found.messageId);
        return {
          ok: true,
          text: qqText,
          source: 'qq-asr',
          note: '（SenseVoice 不可用，回退为 QQ 自带转写）',
        };
      } catch (fallbackError) {
        return { ok: false, error: `${transcript.error}；QQ 转写回退也失败：${fallbackError?.message ?? fallbackError}` };
      }
    } catch (error) {
      return { ok: false, error: `语音转写失败：${error?.message ?? error}` };
    }
  }

  return { bind, mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe, toModelMedia, isSafeLocalMediaPath, isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer, fetchOneBotImage, fetchFaceMedia, resolveMediaList, fetchMediaData, videoHintToolHint, videoHintLine, prepareVideoHint, mediaHintFor, findMessageMedia, visionRateLimited, videoRateLimited, describeMessageImages, findMessageVoice, transcribeVoiceMessage };
}
