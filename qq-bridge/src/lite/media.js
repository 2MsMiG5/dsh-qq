// media.js — lite 引擎的媒体层：图片/语音转文字、表情索引、发图与拍一拍。
//
// 为什么需要这一层：lite 会话**没有工具**（不接 MCP），模型的全部输入就是桥接拼好的一段
// 文本。图片/语音若不在这里转成描述，模型只看到「[图片]」三个字，只能瞎接。所以预取
// 发生在唤醒**之前**，并且结果按消息 id 缓存（TTL 30 分钟）——同一条消息不会因为多轮
// 唤醒被反复送进视觉/视频接口。
//
// 状态归属：liteMediaNotes 与 LITE_MEDIA_NOTE_TTL_MS 由本模块独占。
// 可替换能力（describeMessageImages / transcribeVoiceMessage / fetchMediaData）一律 bind：
// 测试注入桩实现来避免真打视觉与视频接口，直接 import 会绕过它（假绿）。
import { truncateText } from '../md-to-plain.js';
import path from 'node:path';
import { renderStickerIndex as renderStickerIndexPure } from '../lite-chat.js';
import { IMAGE_DEFAULTS, fetchPixevalImage, pickRandomLocalImage, readImageFile, searchPixevalIllustrations, selectPixevalWork } from '../image-source.js';
import { transcribeViaDsh } from '../voice-asr.js';
import { formatBytes } from '../voice-core.js';

export function createLiteMedia() {
  // 依赖在 bind() 之前都是 undefined——只能被「装配期之后」调用的路径使用。
  let MAX_SEND_BYTES, api, appendActivity, bot, buildWakePromptLite, cfg, describeMessageImages, fetchMediaData, findMessageMedia, getSocialV2State, liteStickerChoices, loadRecentLocalImages, log, rememberLocalImage, resolveImageDirs, resolveSelfieDirs, reverse, saveSocialV2State, sendImageV2, socialV2, transcribeVoiceMessage, videoCallTimes, videoLinkApi, videoRateLimited;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ MAX_SEND_BYTES, api, appendActivity, bot, buildWakePromptLite, cfg, describeMessageImages, fetchMediaData, findMessageMedia, getSocialV2State, liteStickerChoices, loadRecentLocalImages, log, rememberLocalImage, resolveImageDirs, resolveSelfieDirs, reverse, saveSocialV2State, sendImageV2, socialV2, transcribeVoiceMessage, videoCallTimes, videoLinkApi, videoRateLimited } = deps);
  }

  // 本模块独占的缓存：同一条消息只描述一次（多轮唤醒不重复打视觉 / 视频接口）。
  const liteMediaNotes = new Map();
  const LITE_MEDIA_NOTE_TTL_MS = 30 * 60 * 1000;

  function liteMediaNoteKey(msg) {
    const id = msg?.messageId ?? msg?.seq;
    return id == null ? '' : String(id);
  }

  function liteCachedMediaNote(msg) {
    const k = liteMediaNoteKey(msg);
    if (!k) return '';
    const hit = liteMediaNotes.get(k);
    if (!hit) return '';
    if (Date.now() - hit.at > LITE_MEDIA_NOTE_TTL_MS) {
      liteMediaNotes.delete(k);
      return '';
    }
    return hit.text;
  }

  function rememberLiteMediaNote(msg, text) {
    const k = liteMediaNoteKey(msg);
    if (!k || !text) return;
    liteMediaNotes.set(k, { text, at: Date.now() });
    while (liteMediaNotes.size > 200) liteMediaNotes.delete(liteMediaNotes.keys().next().value);
  }

  function liteMessageMediaKind(msg) {
    const text = String(msg?.text || msg?.plain || '').trim();
    if (/\[语音\]/.test(text)) return 'voice';
    if (/\[图片\]|\[表情/.test(text)) return 'image';
    return '';
  }

  /**
   * 原生多模态附图：把本轮未读消息里的图片下载成 base64，随 chat/completions 一起发。
   * 为什么不再预描述：视觉描述是二次加工（多一次模型调用 + 一段描述文字），
   * 原图直接进上下文能保留细节，也少一次调用。失败时返回已拿到的部分，由调用方降级。
   * @param {string} key
   * @param {Array} unread
   * @param {number} max 最多几张（与 maxImagesPerWake 对齐）
   * @returns {Promise<Array<{base64:string, mimeType:string, seq:number|null, note:string}>>}
   */
  async function fetchLiteInlineImages(key, unread, max) {
    const limit = Math.max(0, Math.min(3, Number(max) || 1));
    const out = [];
    if (limit === 0) return out;
    for (const msg of unread) {
      if (!msg) continue;
      if (liteMessageMediaKind(msg) !== 'image') continue;
      const ref = msg.messageId ?? msg.seq;
      if (ref == null) continue;
      try {
        const media = findMessageMedia(key, String(ref));
        if (!media.length) continue;
        const images = await fetchMediaData(media);
        for (const img of images) {
          if (!img?.data || !img?.mimeType) continue;
          // note 是归一化时的「做了什么」说明（动图抽了几帧、拼成几×几网格、行优先）。
          // 必须跟着字节一起走：模型看到的是拼图，不给这句话它只会当成一张四分格表情包。
          // 剥掉 fetchMediaData 包的那层全角括号，拼进提示词时自己加括号。
          const note = String(img.text ?? '')
            .replace(/^[（(]\s*/, '')
            .replace(/\s*[）)]$/, '')
            .trim();
          out.push({ base64: img.data, mimeType: img.mimeType, seq: Number(msg.seq) || null, ...(note ? { note } : {}) });
          if (out.length >= limit) return out;
        }
      } catch (error) {
        log(`[lite] ${key} 附图获取失败：${error?.message ?? error}`);
      }
    }
    return out;
  }

  async function prefetchLiteMedia(key, unread, opts = {}) {
    const lite = cfg.socialV2?.liteChat ?? {};
    // 原生多模态：图片不预描述，字节由 buildWakePromptLite 收集后直接随调用附图。
    const nativeImages = opts.nativeImages === true;
    const maxImages = Math.max(0, Math.min(3, Number(lite.maxImagesPerWake) || 1));
    const maxVoices = Math.max(0, Math.min(3, Number(lite.maxVoicesPerWake) || 1));
    const maxVideos = Math.max(0, Math.min(2, Number(lite.maxVideosPerWake) || 1));
    if (maxImages === 0 && maxVoices === 0 && maxVideos === 0) return;
    let images = 0;
    let voices = 0;
    let videos = 0;
    for (const msg of unread) {
      if (!msg) continue;
      if (liteCachedMediaNote(msg)) continue;
      const kind = liteMessageMediaKind(msg);
      const ref = msg.messageId ?? msg.seq;
      // 视频：文本里出现链接就试着抓一次「标题/UP/时长/字幕或AI总结」，
      // 失败或超时只留 snapshot.videoHints 的元数据（不影响唤醒）。
      if (!kind && maxVideos > 0 && ref != null && String(msg.text || msg.plain || '').includes('http')) {
        let links = [];
        try {
          links = videoLinkApi.extractVideoLinks ? videoLinkApi.extractVideoLinks(String(msg.text || msg.plain || ''), { max: 1 }) : [];
        } catch { links = []; }
        if (links.length && videos < maxVideos) {
          const blocked = videoRateLimited(cfg.video);
          if (blocked) {
            videos = maxVideos;
          } else {
            videos += 1;
            videoCallTimes.push(Date.now());
            try {
              const asrCfg = cfg.voice?.asr ?? {};
              const transcribe = async (buffer, opts = {}) => transcribeViaDsh(
                (method, payload) => api.callUnary(method, payload),
                Buffer.from(buffer).toString('base64'),
                { providerId: asrCfg.providerId, language: opts?.language || asrCfg.language }
              );
              const described = await Promise.race([
                videoLinkApi.describeVideo(links[0].url, {
                  config: cfg.video,
                  mode: 'auto',
                  transcribe,
                  ffmpegPath: cfg.video?.ffmpegPath || undefined,
                  log: (line) => log(`[lite][video] ${line}`)
                }),
                new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 9000); timer.unref?.(); })
              ]);
              const report = described?.ok && videoLinkApi.formatVideoReport
                ? videoLinkApi.formatVideoReport(described, { maxChars: 260 })
                : '';
              if (report) rememberLiteMediaNote(msg, `视频：${truncateText(report.replace(/\s+/g, ' '), 220)}`);
              else if (described?.error) log(`[lite] ${key} 视频理解失败：${described.error}`);
            } catch (error) {
              log(`[lite] ${key} 视频预取失败：${error?.message ?? error}`);
            }
          }
        }
      }
      if (!kind) continue;
      if (ref == null) continue;
      try {
        if (kind === 'image' && images < maxImages) {
          images += 1;
          if (!nativeImages) {
            const res = await describeMessageImages(key, String(ref), '用一句中文说图里是什么或写了什么，不超过 40 字，不要客套。');
            if (res?.ok && res.description) {
              rememberLiteMediaNote(msg, `图：${truncateText(String(res.description).replace(/\s+/g, ' '), 80)}`);
            } else if (res?.error) {
              log(`[lite] ${key} 图片预描述失败：${res.error}`);
            }
          }
        } else if (kind === 'voice' && voices < maxVoices) {
          voices += 1;
          const res = await transcribeVoiceMessage(key, String(ref));
          if (res?.ok && res.text) {
            rememberLiteMediaNote(msg, `语音：${truncateText(String(res.text).replace(/\s+/g, ' '), 120)}`);
          } else if (res?.error) {
            log(`[lite] ${key} 语音转写失败：${res.error}`);
          }
        }
      } catch (error) {
        log(`[lite] ${key} 媒体预取失败：${error?.message ?? error}`);
      }
      if (images >= maxImages && voices >= maxVoices && videos >= maxVideos) break;
    }
  }

  function liteStickerIndexText(choices) {
    const list = Array.isArray(choices) ? choices : liteStickerChoices();
    if (!list.length) return '';
    return renderStickerIndexPure(list, { max: list.length });
  }

  function liteImageBudgetOk(st) {
    const imageCfg = cfg.socialV2?.image ?? {};
    const now = Date.now();
    st.imageSendTimes = Array.isArray(st.imageSendTimes) ? st.imageSendTimes : [];
    const perMinute = Math.max(0, Number(imageCfg.maxPerMinute) || 0);
    const perHour = Math.max(0, Number(imageCfg.maxPerHour) || 0);
    const inMinute = st.imageSendTimes.filter((t) => now - t < 60000).length;
    const inHour = st.imageSendTimes.filter((t) => now - t < 3600000).length;
    if ((perMinute > 0 && inMinute >= perMinute) || (perHour > 0 && inHour >= perHour)) return false;
    st.imageSendTimes.push(now);
    if (st.imageSendTimes.length > 500) st.imageSendTimes = st.imageSendTimes.slice(-500);
    return true;
  }

  /**
   * Pixiv 搜索的取图参数。
   *
   * 这里全部是「能不能发出去」的客观条件，没有一条在替模型判断好不好看：
   *   · minBookmarks —— 收藏数下限，好图需要时间攒收藏；
   *   · allowR18     —— 年龄分级，默认关；
   *   · searchWindowYears —— 历史时间窗（下面单独解释）；
   *   · contentType / searchIncludeAi / preferSinglePage —— 排掉动图、漫画格、AI 图和多页首图。
   */
  function litePixivSearchOpts(imageCfg) {
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
      minBookmarks: Math.max(0, num(imageCfg.minBookmarks, 300)),
      allowR18: imageCfg.allowR18 === true,
      count: Math.max(1, Math.min(100, num(imageCfg.searchCount, 30))),
      contentType: typeof imageCfg.searchContentType === 'string' && imageCfg.searchContentType
        ? imageCfg.searchContentType
        : 'illust',
      // 默认排除 AI 图：Pixiv 的 includeAi 默认是 true，不显式关掉就会混进来。
      includeAi: imageCfg.searchIncludeAi === true,
      windowYears: Math.max(0, Math.min(10, num(imageCfg.searchWindowYears, 6))),
      // 冷门 tag 在某一年的窗口里可能一条都没有，多试几个窗口再放弃，比直接退回「最新发布」划算。
      windowTries: Math.max(1, Math.min(4, num(imageCfg.searchWindowTries, 2))),
      preferSinglePage: imageCfg.preferSinglePage !== false
    };
  }

  /**
   * 随机取一个「12 个月长、整体落在 1~N 年前」的时间窗。
   *
   * 为什么非要时间窗：search_illustrations 的 sort 默认是 date_desc（最新发布），而最新发布的作品
   * 收藏数天然只有个位数——实测同一关键词，最新 30 条的收藏中位数是 120/14，换成 2023 年窗口后
   * 变成 749/242，top 从 1032 涨到 7442/18677。好图需要时间攒收藏，靠放大样本救不回来。
   * 随机而不是固定某年，是为了让同一个关键词每次搜到不同的图，不至于天天发同一张。
   */
  function randomPixivWindow(years) {
    const dayMs = 86400000;
    const spanDays = 365;
    const minOffset = 365;
    const maxOffset = Math.max(minOffset + 1, Math.round(years * 365));
    const offsetDays = minOffset + Math.floor(Math.random() * (maxOffset - minOffset));
    const end = Date.now() - offsetDays * dayMs;
    const start = end - spanDays * dayMs;
    return {
      startDate: new Date(start).toISOString().slice(0, 10),
      endDate: new Date(end).toISOString().slice(0, 10)
    };
  }

  /**
   * 搜一张合格作品：先试历史时间窗，窗内没有合格结果再退回全时段。
   *
   * 为什么要退回：冷门 tag 在一年窗口里可能只有个位数作品（实测「虎鲸娘」2023 年只有 1 条），
   * 死守时间窗会导致「明明有图却发不出」。退回全时段至少还有机会，且闸门仍在（收藏/分级/类型）。
   */
  async function searchPixevalWorkForQuery(query, opts) {
    const { search, mcpUrl, timeoutMs, key } = opts;
    const base = {
      mcpUrl,
      timeoutMs,
      count: search.count,
      contentType: search.contentType,
      includeAi: search.includeAi
    };
    const selectOpts = {
      minBookmarks: search.minBookmarks,
      allowR18: search.allowR18,
      preferSinglePage: search.preferSinglePage
    };
    if (search.windowYears > 0) {
      for (let attempt = 1; attempt <= search.windowTries; attempt += 1) {
        const window = randomPixivWindow(search.windowYears);
        const works = await searchPixevalIllustrations(query, { ...base, ...window });
        const hit = selectPixevalWork(works, selectOpts);
        if (hit) return { work: hit, window, scanned: works.length };
        log(`[lite] ${key} Pixiv 搜「${truncateText(query, 20)}」时间窗 ${window.startDate}~${window.endDate} 无合格结果（${works.length} 条，第 ${attempt}/${search.windowTries} 次）`);
      }
    }
    const works = await searchPixevalIllustrations(query, base);
    return { work: selectPixevalWork(works, selectOpts), window: null, scanned: works.length };
  }

  /**
   * lite 主动发图：有关键词先走 Pixiv 搜索（达标收藏才发），失败/没达标降级本地图库随机。
   * 图片字节在桥接侧解析好再走 sendImageV2 的排队/限频/真人节奏。
   *
   * opts.source = 'self' 时是「发自己的照片」：只从形象图库（默认 assets/，见
   * socialV2.image.selfDirs）挑一张，既不搜 Pixiv，也不降级到别人的图——
   * 形象库空了宁可报错，也不能拿别人的图冒充自己。
   */
  async function liteSendImage(key, query, opts = {}) {
    const imageCfg = cfg.socialV2?.image ?? {};
    if (imageCfg.enabled === false) throw new Error('发图功能未开启（config.json image.enabled=false）');
    const selfMode = opts.source === 'self';
    const st = getSocialV2State(key);
    if (!liteImageBudgetOk(st)) throw new Error('发图太频繁了（每会话限额）');
    saveSocialV2State();
    const mcpUrl = String(imageCfg.pixevalMcpUrl || IMAGE_DEFAULTS.pixevalMcpUrl);
    const pixevalTimeoutMs = Number(imageCfg.pixevalTimeoutMs) || IMAGE_DEFAULTS.pixevalTimeoutMs;
    const localMaxBytes = Math.min(MAX_SEND_BYTES, Math.max(256 * 1024, Number(imageCfg.maxBytes) || IMAGE_DEFAULTS.maxBytes));
    let image = null;
    if (query && !selfMode) {
      const search = litePixivSearchOpts(imageCfg);
      try {
        const found = await searchPixevalWorkForQuery(query, { mcpUrl, timeoutMs: pixevalTimeoutMs, key, search });
        if (found.work) {
          image = await fetchPixevalImage(found.work.id, {
            mcpUrl,
            size: imageCfg.pixevalSize || IMAGE_DEFAULTS.pixevalSize,
            maxBytes: Math.min(MAX_SEND_BYTES, Number(imageCfg.pixevalMaxBytes) || IMAGE_DEFAULTS.maxPixevalBytes),
            timeoutMs: pixevalTimeoutMs
          });
          image.source = 'pixeval';
          image.bookmarks = found.work.totalBookmarks;
          image.window = found.window;
        } else {
          log(`[lite] ${key} Pixiv 搜「${truncateText(query, 20)}」没有符合条件的作品（收藏 ≥${search.minBookmarks}${search.allowR18 ? '' : '、非 R-18'}，${found.scanned} 条候选），改用本地图库`);
        }
      } catch (error) {
        log(`[lite] ${key} Pixiv 搜图失败，改用本地图库：${error?.message ?? error}`);
      }
    }
    if (!image) {
      // 形象库通常只有十几张：recent 窗口给太大会被全部过滤掉（退化成纯随机，等于没有轮换），
      // 给到 6 张刚好让 12 张的库转两圈，也不至于连着发同一张。
      const dirs = selfMode ? resolveSelfieDirs(imageCfg) : resolveImageDirs(imageCfg);
      const recentLimit = selfMode
        ? Math.min(6, Number(imageCfg.recentLimit) || IMAGE_DEFAULTS.recentLimit)
        : Number(imageCfg.recentLimit) || IMAGE_DEFAULTS.recentLimit;
      let picked;
      try {
        picked = await pickRandomLocalImage(dirs, {
          maxBytes: localMaxBytes,
          maxScanFiles: Number(imageCfg.maxScanFiles) || IMAGE_DEFAULTS.maxScanFiles,
          recentPaths: loadRecentLocalImages(),
          recentLimit
        });
      } catch (error) {
        // 自拍库按人格分目录后，「目录存在但里面没图」成了常见状态（新建人格先建空目录）。
        // 原始报错只说「图库里没有可用图片」，看不出是哪个库——补上目录与处理办法，
        // 否则日志里只能看到一句无从下手的错误。
        if (selfMode) {
          throw new Error(`当前人格的自拍图库没有可用图片（${dirs.join(', ')}）：往目录里放图，或在控制台「形象与声音设定」里给这个人物色别的目录（原错误：${error?.message ?? error}）`);
        }
        throw error;
      }
      const file = await readImageFile(picked.filePath, { maxBytes: localMaxBytes });
      image = {
        ...picked,
        buffer: file.buffer,
        bytes: file.bytes,
        mimeType: file.mimeType,
        width: file.width,
        height: file.height,
        source: selfMode ? 'self' : 'local',
        // 记下取自哪个目录：活动日志里能一眼看出「切了人格之后到底换了没」。
        // 自拍库按人格分目录，最后一级目录名就是人格的形象库名（assets/自恋小鲸鱼 → 自恋小鲸鱼）。
        selfieDir: selfMode ? path.basename(path.dirname(picked.filePath)) : ''
      };
      rememberLocalImage(picked.filePath, imageCfg.recentLimit);
    }
    if (!image?.buffer?.length) throw new Error('取图失败：图片为空');
    if (image.buffer.length > MAX_SEND_BYTES) throw new Error(`图片过大（${formatBytes(image.buffer.length)}）`);
    const sent = await sendImageV2(key, image);
    // 直连引擎把 recentMessages 当会话历史：自己发的图也留一条，下一轮才知道发过图。
    try {
      st.recentMessages.push({
        messageId: sent?.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: '[图片]',
        plain: '[图片]',
        isSelf: true,
        media: [],
        time: Date.now()
      });
      // 保留策略与 social/record.js 保持一致：这里原来硬写 30，而 lite 的历史现在取 36 条——
      // 发过一次图就会把 recentMessages 砍到 30，历史永远差一截。
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages = st.recentMessages.slice(-recentLimit);
      saveSocialV2State();
    } catch {}
    appendActivity(`${key} lite 发图：${image.source === 'pixeval'
      ? `Pixiv「${truncateText(query, 20)}」${Number.isFinite(image.bookmarks) ? `（${image.bookmarks} 收藏）` : ''}`
      : image.source === 'self' ? `自己的照片${image.selfieDir ? `（${image.selfieDir}）` : ''}` : '本地图库'}`);
  }

  async function liteSendPoke(key) {
    const st = getSocialV2State(key);
    const [kind, id] = key.split(':');
    const latest = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf);
    if (kind === 'private') {
      await bot.raw('send_poke', { user_id: Number(id) });
    } else {
      const target = Number(latest?.userId ?? 0);
      if (!Number.isSafeInteger(target) || target <= 0) throw new Error('没有可拍的群友（最近消息缺少 userId）');
      await bot.raw('group_poke', { group_id: Number(id), user_id: target });
    }
    appendActivity(`${key} lite 拍一拍${kind === 'group' && latest?.sender ? `：${truncateText(String(latest.sender), 20)}` : ''}`);
  }

  return { bind, liteMediaNoteKey, liteCachedMediaNote, rememberLiteMediaNote, liteMessageMediaKind, fetchLiteInlineImages, prefetchLiteMedia, liteStickerIndexText, liteImageBudgetOk, liteSendImage, liteSendPoke };
}
