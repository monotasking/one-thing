import {
  abortChatRun,
  pushChatNotice,
  selectEngineBusy,
  sendChatMessage,
  useChatSource,
} from '../data/chat-source'

/**
 * 输入框与聊天之间的**接缝**(D3)。
 *
 * D3 之前 composer 自带一条 `outbox` 假队列,ChatMock 在末尾把它画出来 ——
 * 那是「交出去」这件事还没有收件人时的占位。现在收件人有了(会话命令总线),
 * 于是这条队列整体退役,composer 回到它真正的职责:**一块输入面板**。
 *
 * 为什么中间要隔一层而不是让 store 直接 import 数据源:
 *  1. **可测** —— composer 的形态机(抽屉 / ask / 附件)一条都不需要一台 core,
 *     测试换个假 sink 就能断言「到底交出去了什么」;
 *  2. **方向** —— 输入面板不该认识会话折叠器。它只知道有个地方能收下一句话。
 *
 * 默认实现就是聊天数据源那两口,一行包装都没有。
 */
export interface ComposerSink {
  /** 交出一条纯文本消息。返回 false = 没能交出去(空话 / 还没有当前会话)。 */
  send(text: string, attachments: number): boolean
  /**
   * 挂一条**本地提示**。它说的正是「这件事没有进账本」(拒绝一组问题不是一条
   * 消息),所以它走 overlay 车道,而不是发送。
   */
  notice(kind: 'ask-rejected'): void
  /**
   * 停下正在跑的那一轮(D1 开工批)。发送键在忙态下就是这颗按钮。
   *
   * 它进 sink 而不是让 composer 直接去调数据源,是同一条方向纪律:输入面板
   * 只知道有个地方能收下**一个动作**,不知道那边有个折叠器。没在跑时是恒等 ——
   * 判「在不在跑」的是下面那只 hook,不是这个组件。
   */
  abort(): void
}

const realSink: ComposerSink = {
  send: (text, attachments) => sendChatMessage(text, attachments),
  notice: (kind) => pushChatNotice(kind),
  abort: () => abortChatRun(),
}

let sink: ComposerSink | undefined

/** 测试用:换掉 sink。传 undefined 恢复真实现。 */
export function configureComposerSink(next: ComposerSink | undefined): void {
  sink = next
}

export function composerSink(): ComposerSink {
  return sink ?? realSink
}

/**
 * 「引擎此刻在不在跑」的**订阅式**读法 —— 发送键据此变成停止键。
 *
 * 它不进 `ComposerSink`,因为 sink 是一张**动作表**(交出去一句话、停一轮),
 * 而这是一次**订阅**:形状对不上,硬塞进去就得往接口里放一个 hook,
 * 那会把「换一只假 sink」变成「换一套 hook 调用顺序」。
 *
 * 判据本身仍然只有一个产地(`data/chat-source.ts` 的 `selectEngineBusy`);
 * 这里只是把它接到 React 的订阅上。测试里要造忙态就直接
 * `useChatSource.setState({ activeMessageId: … })` —— 那正是真实现里唯一的开关,
 * 不需要为它再发明一个假的。
 */
export function useComposerBusy(): boolean {
  return useChatSource(selectEngineBusy)
}
