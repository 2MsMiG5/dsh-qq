// queue.js — QQ 出站发送队列（全进程唯一一条）。
//
// 为什么单独一个模块而不是放进 src/send：
//   这条链的**生产者和消费者分处两侧**。src/send 里的 sendVoiceV2 / sendStickerV2 /
//   sendImageV2 / sendMessagesV2 会往链上追加任务，桥接侧的 sendToQQ / sendTextMessagesV2
//   也会。两侧必须是同一条链，否则「文字先、表情后」的顺序保证立刻失效——症状是
//   并发工具调用时偶尔反序，且只在真机上偶发。
//
// 为什么不能用 bind 传：
//   bind 是**值绑定**。传 `sendChain` 时拿到的是当时的那个 Promise，之后一侧
//   `sendChain = sendChain.then(...)` 只改自己那份，另一侧永远看不到，链就分叉了。
//   共享可变状态要么用取值/写入函数，要么用同一个对象——这里选对象，因为调用点
//   写法可以保持 `sendQueue.tail = sendQueue.tail.then(...)` 不变，零逻辑差异。
export const sendQueue = { tail: Promise.resolve() };
