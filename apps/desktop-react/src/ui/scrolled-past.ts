import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * **「滚过那个点了没有」**(09-02 批 9a 立件,原产地:模型服务面的回顶钮)。
 *
 * 一句话:在内容顶上放一个零高度的哨兵,这只件回答「它是不是已经从**上面**
 * 出去了」。回顶钮 / 粘头的分隔线 / 「返回列表首」这一族都是同一个问题,
 * 而它一共只有两条判据 —— 两条都是真机上一次一次撞出来的,所以收进库里,
 * 不许各面再摸一遍 DOM 各写一份(施工纪律「基础件先行」)。
 *
 * ── 判例①:必须问方向 ──────────────────────────────────────────────────
 * `!entry.isIntersecting` 同时意味着**两件事** —— 「已经滚过去了」和
 * 「还没滚到」。模型目录排在详情列的下半截,开面时它本来就在视野下方,
 * 于是「不相交」当场为真,回顶钮一上来就出现。
 * 判据要看哨兵落在视口(root)的**上面**还是下面:`boundingClientRect.top`
 * 小于 `rootBounds.top` 才叫滚过去了。
 *
 * ── 判例②:root 必须是真正在滚的那一层 ────────────────────────────────
 * 缺省 root 是**视口**,那时 `rootBounds` 是窗口的矩形。而真正在滚的常常是
 * 某个内层容器(模型目录那次是详情列 `.body`,它自己从窗口顶往下 150px 才开始)
 * —— 哨兵被那一层裁掉时,它相对**窗口**的 top 仍然是正数,于是判例①那条判据
 * **恒假**,钮永远出不来(真机量到:滚到 1200px 仍然不出现)。
 * 所以要往上摸一次 DOM 找到滚动层交给 observer 当 root。摸法只认**计算样式**
 * (`overflow-y` 是 auto / scroll),不认类名 —— 类名会被改,而「谁在滚」是一条
 * 样式事实。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:挂载时 observer 尚未回调 → `past` 恒为 `false`(**没量到之前
 *             一律当作「还没滚过」** —— 反过来会让钮闪一下再消失);
 *             `IntersectionObserver` 缺席的环境(jsdom / 老宿主)= 永远 `false`,
 *             不抛不警告,消费方那颗钮只是不出现;
 *             卸载时 `disconnect()`;**无模块级副作用 → 不需要 HMR dispose**。
 *             **换宿主**(换一坑 / 换一份内容)= `resetKey` 变 → 读数当场归零,
 *             observer 不重建(哨兵还是同一个 DOM 节点,重建只是白付一次布局)。
 *   交互状态:无。这件不是控件,它只交出一个读数。
 *   数据状态:哨兵在视口内 / 在视口上方(= past)/ 在视口下方(**不是** past,
 *             判例①)/ 哨兵还没挂上(ref 是 null)。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * ```tsx
 * const mark = useRef<HTMLDivElement>(null)
 * const { past } = useScrolledPast(mark, { resetKey: providerId })
 * return (
 *   <>
 *     <div ref={mark} aria-hidden="true" style={{ height: 0 }} />
 *     {past && <BackToTop />}
 *   </>
 * )
 * ```
 * 哨兵**自己不占位**(零高度),观察的是「那个点」而不是「那块头」——
 * 观察头本身会把「头的高度变了」也算进读数里。
 */

/**
 * 往上找第一个**自己会滚**的祖先。认的是计算样式(`overflow-y` 是 auto / scroll),
 * 不是类名。一个都没有 = 在滚的是视口本身,交回 `null`
 *(那正是 `IntersectionObserver` 的缺省 root)。
 */
export function scrollParentOf(node: Element): Element | null {
  let current = node.parentElement
  while (current) {
    const overflowY = getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}

/**
 * 判据①那条方向判断,拆成纯函数好断言。
 * 形状按结构写而不是收 `IntersectionObserverEntry` —— 真 entry 是它的子类型,
 * 而测试喂得进一个只带这三格的桩。
 */
export interface ScrolledPastEntry {
  isIntersecting: boolean
  boundingClientRect: { top: number }
  rootBounds: { top: number } | null
}

/** 哨兵落在 root 的**上面**且不相交 = 真的滚过去了。 */
export function isScrolledPast(entry: ScrolledPastEntry): boolean {
  return !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)
}

export interface ScrolledPastOptions {
  /**
   * **换宿主就归零**。与 `useFrozenFlags` 的 `token` 同一种口:值变了 = 这块面
   * 换了一份内容(换一坑 / 换一个文档),上一份滚到哪儿了跟这一份没关系。
   * 不传 = 从不归零(整块面的寿命里只有一份内容)。
   */
  resetKey?: unknown
}

export function useScrolledPast(
  markRef: RefObject<Element | null>,
  options: ScrolledPastOptions = {},
): { past: boolean } {
  const { resetKey } = options
  const [past, setPast] = useState(false)

  // 换宿主归零。挂载那一次也会跑,但那时它已经是 false,React 自己就 bail out 了。
  useEffect(() => {
    setPast(false)
  }, [resetKey])

  useEffect(() => {
    const mark = markRef.current
    // 宿主没有 IntersectionObserver:读数停在 false —— 「不知道」按「还没滚过」画,
    // 那一档屏幕上什么都不多出来,是两种错法里没有副作用的那一种。
    if (!mark || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => setPast(entries.some(isScrolledPast)), {
      root: scrollParentOf(mark),
      threshold: 0,
    })
    observer.observe(mark)
    return () => observer.disconnect()
  }, [markRef])

  return { past }
}
