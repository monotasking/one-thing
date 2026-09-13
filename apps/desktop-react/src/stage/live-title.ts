import { create } from 'zustand'
import { sameTitleTip } from '../content/model/title-tip'
import type { TitleTip } from '../content/model/title-tip'

/**
 * **一块瓦此刻在显示什么**(09-01 回炉:浮窗双檐)。
 *
 * ── 它解决的是「两条檐」那件事 ────────────────────────────────────────────
 * 瓦表(`stage/items.ts`)上的 `titleKey` 说的是**这块面是什么**(「查看器」);
 * 而摆进浮窗 / 舞台 / 盖之后,宿主那条檐上该写的是**它此刻在显示什么**
 * (`engine.ts` + 未保存丸)。修前查看器为此自带一条檐,于是宿主檐与它上下叠着
 * ——真机读数 `chromes: 2`,两条 40px 白占 80px,而浮窗一共才 520 高。
 *
 * 修法不是「让查看器把自己的檐藏起来就完了」——那会把文件名一起藏掉。
 * 而是让**内容告诉宿主它在显示什么**,宿主那条檐替它说。这一格就是那条缝:
 *   · 内容侧:`ViewerPanel` 在 effect 里发布 / 卸载时收回;
 *   · 宿主侧:`FloatWindow` / `StageOverlay` / `FullLayer` 读它,有就用它当标题。
 *
 * ── 为什么是一张按 id 的表,而不是查看器专用的一个字段 ────────────────────
 * 「这块面此刻在显示什么」不会只有查看器一个用户(浏览器瓦该写当前网页标题、
 * 终端瓦该写当前 cwd)。一张 `id → 活标题` 的表让第二个用户零成本接入。
 *
 * ── 为什么不放进 stage store ──────────────────────────────────────────────
 * stage store 是**形态**的事实,而且它整份 persist。活标题是内容的当下状态,
 * 既不该落盘(重开时那个文件可能早关了),也不该让每一次改名去惊动形态机的
 * 订阅者(Dock / 架子 / 浮窗全订着它)。所以它自成一个极小的 store。
 */

export interface LiveTitle {
  /** 屏幕上那句话。已经是**成品文案**(内容侧自己翻译好),宿主不再加工。 */
  text: string
  /** 有没有没存的改动 —— 宿主檐上那颗丸读它。缺席 = 这块内容没有「脏」这回事。 */
  dirty?: boolean
  /**
   * 悬停时说的全名(查看器给的是整条路径)。**截断的标题必须配 Tooltip 全名**
   * 是禁令区那条 —— 檐上那格宽度有限,`engine.ts` 与另一个目录里的 `engine.ts`
   * 在屏幕上长得一模一样。缺席 = 这句话本来就不会被截断,不必挂提示。
   *
   * **路径形由产地自述**(09-13):交 `{ path }` 的那一种会被画成「名字一行 +
   * 目录一行、家目录缩成 `~`」,交字符串的照原样画。判据在产地而不在檐上 ——
   * 檐认不出「这串字是不是路径」,而产地本来就知道(判词在
   * `content/model/title-tip.ts`)。
   */
  tip?: TitleTip
}

interface LiveTitleStore {
  titles: Record<string, LiveTitle>
  /** 发布 / 收回(null = 收回,回落到瓦表上那个静态名字)。 */
  setLiveTitle: (id: string, title: LiveTitle | null) => void
}

export const useLiveTitleStore = create<LiveTitleStore>()((set) => ({
  titles: {},
  setLiveTitle: (id, title) =>
    set((st) => {
      if (!title) {
        if (!(id in st.titles)) return st
        const next = { ...st.titles }
        delete next[id]
        return { titles: next }
      }
      const now = st.titles[id]
      /*
       * 逐字相同就不动 —— 一次无谓的 set 会让三个宿主全重渲一遍。
       *
       * `tip` **按值比**(`sameTitleTip`),不是 `===`:09-13 起它可以是
       * `{ path }` 那一形,而那是产地每次现造的对象 —— 用 `===` 的话每一次
       * 发布都判成「变了」,这句短路当场失效。
       */
      if (now && now.text === title.text && now.dirty === title.dirty && sameTitleTip(now.tip, title.tip)) {
        return st
      }
      return { titles: { ...st.titles, [id]: title } }
    }),
}))

/** 宿主读它:有活标题就用,没有就回落到瓦表那个静态名字。 */
export function useLiveTitle(id: string | null | undefined): LiveTitle | undefined {
  return useLiveTitleStore((st) => (id ? st.titles[id] : undefined))
}
