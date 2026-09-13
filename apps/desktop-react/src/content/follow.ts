/**
 * 聊天跟随的状态机(§5.1)—— **纯函数,零 DOM、零 React**。
 *
 * 两个态:`pinned` = 贴底,内容长高我就跟;`browsing` = 人在看上面的东西,我不动。
 *
 * ── 判据只有位置与意图 ────────────────────────────────────────────────────
 * **没有计时器、没有「这一下是我自己滚的」标志位**。判据是滚动停下来的位置:
 * 我们自己落底那几下正正好在底(误差 < `AT_BOTTOM_EPS`),人往上翻才会离底。
 * 标志位那条路要为每一种滚动来源(wheel / 触控板 / 键盘 / 拖滚动条 / TOC 跳转 /
 * scrollIntoView / 浏览器的滚动锚定)各记一次「这是不是我」,而漏掉任何一条
 * 就是一次「跟不住」或者「拽人回底」—— 位置这条判据一条路径都不必记。
 * 这条纪律是从 `useEnterAtBottom`(进场落底)原样继承的,它在真机上活过一批。
 *
 * ── 六个事件 ──────────────────────────────────────────────────────────────
 *   enter        进一条会话(换会话也是)
 *   scrolled     滚动停下,带此刻的 gap(= scrollHeight − clientHeight − scrollTop)
 *   grew         内容长高了(流式 delta / 异步高亮 / 图 / 自己刚发的那条)
 *   sent         自己发了一条
 *   reply        回复到了(这一轮收到了一段 delta)
 *   jumpToBottom 点丸 / End / TOC 点最后一轮
 *
 * `grew` 与 `reply` 是**两件事**,不是一件事的两种说法:长高问的是「屏幕变高了吗」
 * (自己刚发的那条也让屏幕变高),回复到达问的是「模型开口了吗」。丸的脸要换的
 * 那一刻是后者 —— 所以它有自己的事件,而不是让 `grew` 去猜(猜的代价见下面
 * `grew` 分支里那段:照字面让 `grew` 覆盖 `sent`,「已发送」那张脸一帧都活不到)。
 *
 * ── 「滚动停下」这句话由调用方判,不在这张表里(2026-09-12 补注)────────────
 * `scrolled` 说的是「人停在离底这么远的地方」。**哪一次滚动算人干的**由发事件的
 * 那一头判(`ChatStream` 的 `onScrollWithFollow`:人往上翻 = `scrollTop` 变小;
 * gap 张开而位置没往回走 = 内容自己长的,同一帧稍后的 RO 会贴回去)。判词与那次
 * 真机探针的读数写在那只回调上。这里仍然只认「位置」,一个标志位都没多。
 *
 * ── `unseen` 是给丸看的,不是给滚动看的 ───────────────────────────────────
 * `pinned` 时它恒为 `none`(你就在底,没有「没看见」这回事);`browsing` 时它说
 * 下面长出来的是哪一种东西,丸据此换脸(§5.3 三张脸)。
 */
export type FollowMode = 'pinned' | 'browsing'

export type FollowUnseen = 'none' | 'sent' | 'reply'

export interface FollowState {
  mode: FollowMode
  /** 浏览中时下面长出了没看见的东西(流式增量或自己刚发的那条)。 */
  unseen: FollowUnseen
}

export type FollowEvent =
  | { type: 'enter' }
  | { type: 'scrolled'; gap: number }
  | { type: 'grew' }
  | { type: 'sent' }
  | { type: 'reply' }
  | { type: 'jumpToBottom' }

/**
 * 「已经在底了」的容差:一像素级的小数误差(缩放、亚像素行高)不该被当成
 * 「用户往上翻了」。从 `ChatStream` 搬过来 —— 判据与状态机住在一起。
 */
export const AT_BOTTOM_EPS = 2

/** 贴底且没有未读:进场、点丸、滚回底,三条路的终点都是它。 */
export const FOLLOW_PINNED: FollowState = { mode: 'pinned', unseen: 'none' }

/** 浏览中,而下面还什么都没长 —— 丸此刻不画。 */
const BROWSING_CLEAN: FollowState = { mode: 'browsing', unseen: 'none' }

/**
 * 转移表(§5.1 逐格)。**状态不变时返回同一个对象** —— 调用方拿它直接
 * `setState`,React 的 `Object.is` 短路于是白送:流式期间每一帧都有一次 `grew`,
 * 而 pinned 下那一格什么都不改,不该为它重渲一次整条消息流。
 */
export function reduceFollow(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    // 进会话 = 一次新的进场,一律贴底(既有的「进场落底」并入本状态机的这一格)。
    case 'enter':
      return state.mode === 'pinned' && state.unseen === 'none' ? state : FOLLOW_PINNED

    case 'scrolled': {
      const atBottom = event.gap <= AT_BOTTOM_EPS
      // 人自己回来了就接着跟,未读一并清掉(他已经看见了)。
      if (atBottom) return state.mode === 'pinned' && state.unseen === 'none' ? state : FOLLOW_PINNED
      // 离底 = 人在看上面的东西。已经在浏览就什么都不改(未读照旧攒着)。
      return state.mode === 'browsing' ? state : BROWSING_CLEAN
    }

    /*
     * 内容长高。pinned 下**状态一格不动** —— 要做的事是赋 `scrollTop`,
     * 那是调用方的活(判据由 `followShouldStick` 交出去,见下)。
     */
    case 'grew': {
      if (state.mode === 'pinned') return state
      /*
       * ── 与设计稿 §5.1 的一处出入(执行时发现的竞态)────────────────────
       * 表上写的是「内容长高 → `unseen = reply`」,但**自己刚发的那条本身就是
       * 一次长高**:`chat-source.send()` 同步往 overlay 里追一条,屏幕当场变高。
       * 照字面实现,`sent` 刚把 `unseen` 置成 `'sent'`,同一拍的 `grew` 立刻把它
       * 冲成 `'reply'` —— 表上「发送 · browsing → 已发送」那一行画出来的脸
       * 一帧都活不到,等于设计了一个永远看不见的态。
       * 所以 `grew` **不覆盖 `'sent'`**:长高说不出「这一下是谁长的」,它没有资格
       * 解那个闩。解闩的有两条路:「人看见了」(`scrolled` 贴底 / `jumpToBottom` /
       * `enter`),以及「回复真的到了」—— 后者是下面那格 `reply` 的事,它拿的是
       * 数据源的事实(这一轮收到了 delta),不是几何的猜测。
       */
      if (state.unseen === 'sent') return state
      return state.unseen === 'reply' ? state : { mode: 'browsing', unseen: 'reply' }
    }

    /*
     * 发送。pinned 下同样什么都不改:自己那条追加即长高,`grew` 那一格会把它
     * 落进视口(拍点 ⑤ 已拍**落底**,不是 hold-top)。
     */
    case 'sent': {
      if (state.mode === 'pinned') return state
      return state.unseen === 'sent' ? state : { mode: 'browsing', unseen: 'sent' }
    }

    /*
     * 回复到了 —— **`sent` 那个闩唯一的另一把钥匙**。
     *
     * 用户在浏览时发了一条,丸说「已发送」;等模型开口,那句话就过期了:
     * 此刻下面**确实有一条没看过的回复**,再说「已发送」是这张脸在撒谎
     * (而流收完之后它还会一直挂在那儿,说的仍是那句过期的话)。
     * 所以这一格把 `'sent'` 也翻成 `'reply'` ——「回复到了」正是 `grew` 说不出的
     * 那句话:自己刚发的那条也让屏幕长高,几何分不出是谁长的,而这个事件的产地
     * 是数据源(这一轮收到了 delta),它分得出来。
     *
     * pinned 下什么都不改(你就在底,没有「没看见」这回事);已经是 `'reply'`
     * 就返回同一个对象 —— 流式期间每一段 delta 都来一次,那几百次不该各推一次 state。
     */
    case 'reply': {
      if (state.mode === 'pinned') return state
      return state.unseen === 'reply' ? state : { mode: 'browsing', unseen: 'reply' }
    }

    // 明确场景下的跟随:点丸 / End / TOC 点最后一轮。
    case 'jumpToBottom':
      return state.mode === 'pinned' && state.unseen === 'none' ? state : FOLLOW_PINNED
  }
}

/**
 * 「这一刻要不要把 `scrollTop` 赋到底」。
 *
 * 它就是 `pinned` 这个词的意思,单独出一格是为了让**判据也住在纯函数里**:
 * 调用方于是一句 `if (followShouldStick(state))`,没有第二处写着 `mode === 'pinned'`
 * 的地方可以和这里说岔。
 */
export function followShouldStick(state: FollowState): boolean {
  return state.mode === 'pinned'
}

/** 丸挂不挂在屏幕上:只在浏览中、且下面确实长出了没看见的东西时。 */
export function followPillVisible(state: FollowState): boolean {
  return state.mode === 'browsing' && state.unseen !== 'none'
}
