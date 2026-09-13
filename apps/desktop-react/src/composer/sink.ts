import {
  abortChatRun,
  pushChatNotice,
  selectEngineBusy,
  sendChatMessage,
  useChatSourceOf,
} from '../data/chat-source'
import { useExposeStore } from '../expose/store'

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
  /**
   * 交出一条纯文本消息。返回 false = 没能交出去(空话 / 这一格还没绑会话)。
   *
   * `sessionId` 是**交给谁**(W5-c-2):它由叫这一口的那块面板自己说,不再由
   * 这只文件去问一句「当前会话是谁」—— 判词见下面 `realSink` 那一段。
   */
  send(text: string, attachments: number, sessionId: string): boolean
  /**
   * 挂一条**本地提示**。它说的正是「这件事没有进账本」(拒绝一组问题不是一条
   * 消息),所以它走 overlay 车道,而不是发送。
   */
  notice(kind: 'ask-rejected', sessionId: string): void
  /**
   * 停下正在跑的那一轮(D1 开工批)。发送键在忙态下就是这颗按钮。
   *
   * 它进 sink 而不是让 composer 直接去调数据源,是同一条方向纪律:输入面板
   * 只知道有个地方能收下**一个动作**,不知道那边有个折叠器。没在跑时是恒等 ——
   * 判「在不在跑」的是下面那只 hook,不是这个组件。
   *
   * 停哪一条也由调用方说:消息流里那颗停止键(`content/message/StreamReadout`)
   * 停的是**它自己那条会话**,与它所在那片叶的输入框按的是同一条。
   */
  abort(sessionId: string): void
  /**
   * 惰性开一条会话(D1 尾批「首开草稿态」)。
   *
   * 刚打开 app 时没有活动会话(当前会话**故意**不跨启动持久化),标题栏画的是
   * 「新会话」这张空脸。人在这张脸上打一句话按下发送 —— 那一下的意思是
   * 「开始一段对话」,不是「什么都别发生」。于是这里多一口:**先开一条,再发**。
   *
   * 返回新会话 id;`undefined` = 没开成(编排点自己 notify 过了,这里不重复报)。
   *
   * 它进 sink 而不是让 composer 直接去调形态机,是这个文件从头到尾那条方向纪律:
   * 输入面板只知道有个地方**能收下一个动作**,不知道那边有 store、有形态、有项目。
   * 真实现落在 `expose/store.newSession` —— 建会话的**唯一**编排点,这里不复刻它。
   */
  startSession(): Promise<string | undefined>
}

/**
 * **收件人由调用方说**(W5-c-2,路线 A;推翻 W5-b 裁定 4 那一句投影)。
 *
 * W5-b 走的是路线 B:输入框留在 `.center` 上只有一块,所以「交给谁」只能问一句
 * 投影(焦点那片会话叶在看的那条)。路线 A 之后输入框**是会话叶自己渲染的** ——
 * 屏幕上有几片会话叶就有几块面板,每一块从挂载那一刻起就知道自己对着哪一条。
 * 于是那句投影在这里没有位置了:它答的是「焦点此刻在哪」,而按下发送的那只手
 * 按的是**它手指底下那一块面板**,两者在分屏下不是一件事。
 *
 * 所以这三口都收一个 `sessionId`,`targetSession()` 整只退役 —— 这只文件从此
 * 不认识 `expose`(只剩 `startSession` 那一口还要它,而那一口本来就没有会话)。
 */
const realSink: ComposerSink = {
  send: (text, attachments, sessionId) => sendChatMessage(text, attachments, sessionId),
  notice: (kind, sessionId) => pushChatNotice(kind, sessionId),
  abort: (sessionId) => abortChatRun(sessionId),
  // 惰性建会话时没有「当前会话」,所以当前项目必然是 null —— 与 ⌘N 首开同义。
  startSession: () => useExposeStore.getState().newSessionInCurrentProject(),
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
export function useComposerBusy(sessionId: string): boolean {
  // 与 `realSink` 同一个收件人:忙态问的必须是**它要发给谁**那一条,
  // 不然停止键会画着另一条会话的状态。W5-c-2 起那一条是叶递下来的 prop,
  // 不再是一句「当前会话」投影 —— 分屏里两块面板各画各的忙态。
  return useChatSourceOf(sessionId, selectEngineBusy)
}
