// diag-log.js — 控制台诊断数据的读写：用户反馈条目（JSON 数组）。
//
// 目前唯一的消费者是 HTTP 控制台路由 (src/http/routes/social-v2.js)：
// 数据写在 STATE_DIR 下、要截断、读失败一律退化成空列表而不是往外抛。
//
// 为什么 truncation 的阈值硬编码：
//   · feedback 保留最近 **500 条** —— 它是给人看的列表，且每条自带 message 正文。
//
// 依赖用 bind 而不是 import：readJsonSafe / atomicWriteJson / redactSensitiveText
// 目前还定义在 bridge.js 的顶层（未导出），在没有把它们整体抽成基础库之前，
// 跟着现有所有模块一样走 bind 是最省事也最一致的做法。

export function createDiagLog() {
  let FEEDBACK_FILE, atomicWriteJson, readJsonSafe, redactSensitiveText;

  /** 由 boot 在依赖就绪后调用一次 */
  function bind(deps) {
    ({ FEEDBACK_FILE, atomicWriteJson, readJsonSafe, redactSensitiveText } = deps);
  }

  /** 读不出就当没有——控制台面板宁可显示空白，也别因为一份坏文件整个打不开。 */
  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  /**
   * 追加一条反馈。message 会过一道 redactSensitiveText：这一栏的正文是**用户手写的**，
   * 里面完全可能贴着路径或令牌，而它会直接渲染到控制台页面上。
   */
  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  return { bind, readFeedbackEntries, appendFeedbackEntry };
}
