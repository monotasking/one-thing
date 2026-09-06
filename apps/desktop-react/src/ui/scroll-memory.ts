import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * **「这块内容上次滚到哪儿了」**(09-06 检索面第 ③ 步立件;原产地:查看器
 * `useViewerScroll` 里那对手写的还原 / 写回)。
 *
 * 一句话:一个滚动容器 + 一把**内容的键**,这件负责在**真重挂**之间把滚动位
 * 端过去。它一共只有四条判据,四条都是真机上撞出来的 —— 所以收进库里,不许
 * 各面再摸一遍 DOM 各写一份(施工纪律「基础件先行」)。
 *
 * ── 判例①:还原必须在 `useLayoutEffect` ────────────────────────────────
 * `useEffect` 在**画完之后**才跑,屏幕上会先闪一帧顶部再跳回去。这一格是
 * 「换宿主不弹回顶上」的全部实现。
 *
 * ── 判例②:写回必须在 **layout cleanup**,不能在 `useEffect` cleanup ────
 * 卸载时 React 先跑 layout effect 的拆卸、**再**把节点从 DOM 上摘掉;passive
 * (`useEffect`)的拆卸排在摘掉之后,那时 `el.scrollTop` 读回来是 **0** ——
 * 于是「记住的位置」全变成 0,下次回来照样弹顶。这条判例配了一个反证用例
 * (`__tests__/scroll-memory.test.tsx` 的「layout cleanup 才读得到真数」)。
 *
 * ── 判例③:换键 = 先写回旧键,再还原新键 ────────────────────────────────
 * 一个 effect、依赖 `[ref, key]` 就同时办了两件事:React 换键时先跑上一次的
 * cleanup(闭包里是**旧键**、DOM 还在),再跑新一次的 effect(**新键**)。
 * 新键没有记忆 = 归零 —— 换了一份内容还停在上一份的高度上,是比弹顶更糟的
 * 那一种错。
 *
 * ── 判例④:滚动写回要节流,而且**领沿也要写** ──────────────────────────
 * 一帧里几十发 `scroll` 各写一次 store 是白付的账;但纯尾沿(只在帧末写)会让
 * 「滚一下马上换走」丢掉最后那一段。所以是**领沿 + 尾沿**:一帧里第一发当场
 * 写,该帧其余的并进帧末那一发。宿主没有 `requestAnimationFrame` 时降级成
 * 每发都写(正确但不省)。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:挂载 → 还原(`read(key) ?? 0`,读不到就是 0);key 变 → 写回旧键 +
 *             还原新键;每帧滚动 → 写回当前键;卸载 → 取消待发的那一帧 + 写回一次。
 *             ref 还没挂上(`ref.current === null`)= 什么都不做,不抛。
 *             **无模块级副作用 → 不需要 HMR dispose**。
 *   交互状态:无。这件不是控件,它不画任何东西。
 *   数据状态:有记忆(还原到那个数)/ 没有记忆(还原到 0)/ 记忆比当下可滚范围
 *             大(浏览器自己钳住,贴不满是事实 —— 内容还在懒加载时就是这一档)。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * ```tsx
 * const listRef = useRef<HTMLDivElement>(null)
 * const { onScroll } = useScrollMemory(listRef, shownKey, {
 *   read: (k) => store.scrollByKey[k],
 *   write: (k, top) => store.setScroll(k, top),
 * })
 * return <div ref={listRef} onScroll={onScroll}>…</div>
 * ```
 * **口子留给消费方接**,这件不自己 `addEventListener`:滚动容器是消费方渲染的,
 * 它本来就有 `onScroll` 这道缝;这件再偷偷挂一份,两边都写就成了两个产地。
 *
 * ── 谁存那个数,不归这件管 ──────────────────────────────────────────────
 * `read` / `write` 是端口:查看器存进 `viewer-source` 的 `scrolls[path]`,检索面
 * 存进它自己的 store。这件只认「键 → 数」这一层关系,不认识 store,也不认识
 * 那把键是怎么拼出来的(**那必须是「屏上那份数据的键」**,不是「此刻要去问的
 * 那把键」—— 后者会在换键那一帧把旧内容的高度记到新键名下)。
 */

export interface ScrollMemoryPorts {
  /** 这把键上次滚到哪儿了。没记过 = `undefined` = 还原到 0。 */
  read: (key: string) => number | undefined
  /** 记下这把键此刻滚到哪儿了。每帧最多被调两次(判例④)。 */
  write: (key: string, top: number) => void
}

export interface ScrollMemory {
  /** 挂到滚动容器的 `onScroll` 上。不读事件,读的是 `ref.current.scrollTop`。 */
  onScroll: () => void
}

export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string,
  ports: ScrollMemoryPorts,
): ScrollMemory {
  /*
   * 端口存进 ref:消费方几乎一定是就地写两个闭包,每渲染换一次身份。让它们进
   * effect 的依赖表,就会**每渲染重跑一次还原** —— 用户滚到一半被弹回记忆位。
   * 依赖表里只许有 `[ref, key]` 这两件真正说明「这是另一份内容」的事。
   */
  const portsRef = useRef(ports)
  // 排在还原那只 effect **之前**声明:挂载时按声明序跑,端口先就位。
  useLayoutEffect(() => {
    portsRef.current = ports
  })

  const frameRef = useRef(0)

  const flush = useCallback(() => {
    const el = ref.current
    if (!el) return
    portsRef.current.write(key, el.scrollTop)
  }, [ref, key])

  const onScroll = useCallback(() => {
    // 这一帧已经记过账 —— 后面的事件并进帧末那一发。
    if (frameRef.current) return
    flush()
    if (typeof requestAnimationFrame !== 'function') return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      flush()
    })
  }, [flush])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = portsRef.current.read(key) ?? 0
    return () => {
      // 待发的那一帧带的是**旧键**的账,而它可能落在新键还原之后 —— 撤掉。
      if (frameRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameRef.current)
      }
      frameRef.current = 0
      // 判例②:这里 DOM 还在,读得到真数。
      portsRef.current.write(key, el.scrollTop)
    }
  }, [ref, key])

  return { onScroll }
}
