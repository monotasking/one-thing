import { create } from 'zustand'

/**
 * 「进这条会话,并且落到**这条消息**上」的那一格待办(09-02 正文检索)。
 *
 * ── 它为什么是一格状态,而不是一个函数调用 ──────────────────────────────
 * 发起的地方(检索面板点一行)与办得成的地方(聊天区那棵树)之间隔着**两件
 * 异步**:换会话要重开一次折叠(`chat-source.open`),折出来的消息要渲染成
 * DOM 才有锚点可滚。点下去那一刻这两件都还没发生 —— 所以那一下只能**留一格
 * 待办**,由聊天区那一侧在锚点真的出现时把它消掉。
 *
 * 直接在点击处 `querySelector` 会稳定失败(那一帧树还是上一条会话的),
 * 而 `setTimeout` 猜一个延迟是在赌渲染速度 —— 那正是这台壳反复立法禁止的形状。
 *
 * ── 为什么不挂在 `expose/store` 上 ──────────────────────────────────────
 * 那个 store 是**形态机**(总览 / QuickLook / 会话三态 + 焦点),它 persist 落盘。
 * 「我刚才点了检索面里的哪一行」是一件**瞬态**的事:它活不过这一次跳转,
 * 更不该跨重启活着。一格模块级的小 store,寿命刚好。
 *
 * ── token 是身份,不是计数 ───────────────────────────────────────────────
 * 同一条消息连点两次也要重放一次高亮(与 `useChatToc.pickTurn` 里「先清再点」
 * 那一手同一条理由:同一个类名不换,CSS 动画不会重来)。所以待办带一个自增的
 * token —— 消费方按 token 判「这是不是同一件待办」,而不是按 messageId。
 */
export interface LocateRequest {
  sessionId: string
  messageId: string
  /** 每次 `locateMessage` 自增。同一条消息再点一次也是一件新待办。 */
  token: number
}

export interface LocateMessageState {
  /** 此刻那格待办;null = 没有。 */
  request: LocateRequest | null
  /** 留一格待办。**幂等不去重** —— 连点两次就是两件待办(见上面 token 那段)。 */
  locateMessage: (sessionId: string, messageId: string) => void
  /**
   * 消掉待办。收 token 是为了**只消掉自己看见的那一件**:办的过程里
   * (等锚点出现)用户完全可能又点了另一行,那一格不该被上一件的收尾抹掉。
   */
  settleLocate: (token: number) => void
  /** 测试与 HMR 用:回到出厂。 */
  reset: () => void
}

let nextToken = 0

export const useLocateMessage = create<LocateMessageState>()((set, get) => ({
  request: null,
  locateMessage: (sessionId, messageId) => {
    nextToken += 1
    set({ request: { sessionId, messageId, token: nextToken } })
  },
  settleLocate: (token) => {
    if (get().request?.token !== token) return
    set({ request: null })
  },
  reset: () => {
    nextToken = 0
    set({ request: null })
  },
}))

/**
 * 模块级副作用的退役口(09-01 立法)。这里留着的是 `nextToken` 那格跨渲染的
 * 可变状态 —— 寿命就是「这个模块实例」,热更时按同一条法退役,
 * 复用这个模块已有的那一口拆卸(`reset()`),不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useLocateMessage.getState().reset()
  })
}
