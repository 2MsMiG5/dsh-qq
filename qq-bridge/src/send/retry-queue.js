// retry-queue.js — DSH 不可用期间的离线补投队列（全进程唯一一个）。
//
// 先说清楚它和同目录 queue.js 的区别，两个都叫「队列」但不是一回事：
//   · queue.js        —— **出站发送链**（sendQueue.tail），保证「文字先于表情」的顺序，
//                        正常在线时用。它是 Promise 链。
//   · retry-queue.js  —— **离线攒投 Map**（queued），DSH 挂掉时把消息存起来，
//                        探活恢复后按序补投。它是 Map。
// 合进一个文件只会让「顺序保证」和「断线重投」两套语义互相污染——它们的失败模式、
// 重试策略、清理时机都不一样，保持文件级别的隔离。
//
// 为什么两个 Map 要从 return 里**按引用**导出：
//   queued / queueRetries 会被 bind 给多个模块（wake / mux-ingest / handles 等）。
//   它们是 `const` Map——引用永不变，只有内容在变，所以传引用是安全的
//   （这条规矩见 src/send/queue.js 顶部：共享可变状态要么用取值函数，要么用同一个对象）。
//   注意这里**不能**改成 `let queued = new Map()`：那会退化成值快照，别处看到的就是旧 Map。
//
// 两个私有标记位的来历（都是踩出来的坑，别删注释）：
//   flushingQueue   —— 单飞锁。补投里有一次 deliverPrompt 可能卡上 60 秒，
//                      不锁的话定时器会叠出一堆并发 flush。
//   flushQueueAgain —— 尾沿重跑。只有锁是不够的：旧写法在锁生效期间把重试定时器的
//                      调用直接 return 掉，于是**再没人重新排一次 flush**，
//                      队列里的消息会一直躺到下次收到新消息为止。
//                      这两个是配合使用的：锁负责「别并发」，尾沿负责「别丢请求」。
export function createRetryQueue() {
  const queued = new Map();      // key -> { promptText, farewell, silent, media, wakeReason }[]
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于指数退避/暂停恢复）
  const QUEUE_MAX = 50;
  const QUEUE_MAX_LOG = '队列满（' + QUEUE_MAX + '），丢弃最旧消息';

  let flushingQueue = false;
  let flushQueueAgain = false;

  let cfg, deliverPrompt, getCurrentMode, log, modeAllowed;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ cfg, deliverPrompt, getCurrentMode, log, modeAllowed } = deps);
  }

  /**
   * 入队等待重试。已在队列中的相同文本不重复入队（去重靠 promptText 全等）。
   * 注意这里的 3 秒延迟是**有意的**：DSH 刚不可用时立刻补投必然再失败，
   * 给一个小窗口让它有可能自己恢复。
   */
  /**
   * 入队的公共内核：取桶 → 满了丢弃最旧 → push → 写回。
   *
   * 为什么要抽出来：这段「满队列丢弃最旧」原本在三个地方各写了一遍
   * （这里 + src/mux/ingest.js + src/social/wake.js），操作的都是**同一个** queued Map。
   * 三份实现已经漂移 —— 只有本文件的 enqueueForRetry 会去重 promptText 并重置退避计数，
   * 另两处都不管，于是同一条消息从入站口进来是可能重复入队的。这个差异先**照原样保留**
   * （本轮只做去重前的内核抽取，不改任何一处的判定），但集中到一处之后它才看得见、也才好讨论要不要统一。
   *
   * @returns {object[]} 写回后的桶（调用方通常不关心，留着便于断言）
   */
  function pushQueued(key, item) {
    const items = queued.get(key) ?? [];
    if (items.length >= QUEUE_MAX) {
      items.shift();
      log(`${QUEUE_MAX_LOG} (${key})`);
    }
    items.push(item);
    queued.set(key, items);
    return items;
  }

  function enqueueForRetry(key, promptText, opts = {}) {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      pushQueued(key, { promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { void flushQueue(); }, 3000);
  }

  async function flushQueue() {
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, getCurrentMode())) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${getCurrentMode()}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              // 当前项 + 剩余项整体放回，避免丢失；旧消息优先（rest 在前、existing 在后）
              requeueRest(key, items, i);
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            requeueRest(key, items, i);
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) scheduleRetry(key);
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { void flushQueue(); }, 200);
      }
    }
  }

  /** 把第 i 项起的剩余消息放回队首（旧消息优先），队列里原有的排在其后。 */
  function requeueRest(key, items, i) {
    const rest = items.slice(i);
    const existing = queued.get(key) ?? [];
    queued.set(key, rest.concat(existing));
  }

  /**
   * 指数退避重试。连续失败超过 5 次就不再快速重试——否则 DSH 一直不在线时
   * 会打出密集的失败日志，而且每 3 秒一次的失败补投本身也是负担。
   * 冷却 60 秒后再给一次机会，并重置计数，让它重新从短间隔开始退避。
   */
  function scheduleRetry(key) {
    const retries = (queueRetries.get(key) ?? 0) + 1;
    queueRetries.set(key, retries);
    if (retries > 5) {
      log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
      setTimeout(() => {
        queueRetries.delete(key);
        void flushQueue();
      }, 60000);
    } else {
      const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
      setTimeout(() => { void flushQueue(); }, delay);
    }
  }

  return { bind, QUEUE_MAX, pushQueued, queued, queueRetries, enqueueForRetry, flushQueue };
}
