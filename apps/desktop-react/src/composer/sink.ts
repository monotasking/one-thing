import { pushChatNotice, sendChatMessage } from '../data/chat-source'

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
}

const realSink: ComposerSink = {
  send: (text, attachments) => sendChatMessage(text, attachments),
  notice: (kind) => pushChatNotice(kind),
}

let sink: ComposerSink | undefined

/** 测试用:换掉 sink。传 undefined 恢复真实现。 */
export function configureComposerSink(next: ComposerSink | undefined): void {
  sink = next
}

export function composerSink(): ComposerSink {
  return sink ?? realSink
}
