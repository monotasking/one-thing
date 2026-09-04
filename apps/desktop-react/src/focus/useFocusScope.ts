import { useCallback, useContext, useSyncExternalStore } from 'react'
import { FocusScopeContext } from './FocusScope'
import { focusTree } from './registry'
import type { ActivateReason, FocusInstanceId } from './types'

/**
 * **两个问题,两只 hook** —— 判据只有一条:**要不要订阅那棵树**。
 *
 * · `useFocusScope()` 答的是「我是哪一格 / 把键盘送进来」—— 两样都与「此刻谁是
 *   第一响应者」无关,所以它**一格订阅都不该有**;
 * · `useFocusScopeActive()` 答的是「我这块面此刻是不是当前」—— 那是一句会随焦点
 *   变化翻面的**读数**,只有它需要订阅。
 *
 * ── 为什么必须拆(09-04 S2,真机读数背书)────────────────────────────────
 * 合成一只的时候,`isActive` 那一格 `useSyncExternalStore` 是**无条件**挂上的:
 * 只要有人调 `useFocusScope()`,不管他读不读那个布尔,焦点每换一次人,他就跟着
 * 重渲一次。而全壳四个生产消费者(`ComposerInput` / `AskForm` / `expose/Toolbar` /
 * `expose/Overview`)**一个都没读过 `isActive`** —— 四个都只取 `activate`。
 * 读数(隔离 store,焦点在输入框与总览的树之间来回换 80 次,每次让一帧):
 * `render.Overview` = **80**(整块总览连着它的树重渲 80 次)、三个消费者合计
 * `useFocusScope` 调用 240 次;`notify` 自身 15–32µs/次(订阅者是同步跑的,
 * 所以这笔钱也计在 `focusin` 的账上:同场景 43.8–52.5µs/次)。
 * 拆开之后这三笔全部归零 —— 代价与「谁真的需要这个布尔」成正比,而不是与
 * 「谁碰过这只 hook」成正比。
 *
 * 这与 `FocusScope.tsx` 文件头那段(09-03:面**自己**不许订阅,交给需要的叶子)
 * 是同一条法的第二半:那一批把订阅从「包着一整块面的 Provider」搬到了这只 hook,
 * 本批再把它从「这只 hook 的所有调用方」收窄到**真的读那个布尔的人**。
 *
 * ── 「我是不是当前」为什么不许再有第二种问法 ──────────────────────────────
 * 从前这句话有三种问法,而且三种答的不是同一件事:
 *  · `panelRef.current?.contains(document.activeElement)`(`useEscStop`)——
 *    答的是「DOM 焦点在不在我身体里」,焦点掉到 body 就当场变成「不在」;
 *  · `usePanelVisibility().interactive` —— 答的是「宿主让不让我占全局输入」;
 *  · `live` 之类的自制布尔(`ExposeView`)—— 答的是「我这一份算不算数」。
 * 树里只有一个答案:**我在不在活动路径上**。它不会因为一个 DOM 节点消失而翻面
 * (§4.2:第一响应者不会因为一个节点消失而消失),这正是 ⌘F 那条报障的病根 ——
 * 旧判据问的是「这一下按键经不经过我的根」,而不是「我是不是当前」。
 *
 * 交出去的两格里**没有 `scopeProps`**:铺根元素只有 render-prop 一条路
 * (理由写在 `FocusScope.tsx` 文件头)。
 *
 * 不在任何 `<FocusScope>` 里调用 = `instanceId` 为 null、`isActive` 恒 false、
 * `activate()` 什么都不做。**不抛** —— 一个组件既可能长在树里也可能长在
 * 规格页(`?gallery`)那种没有宿主的地方,为这件事抛错只会逼出一堆条件调用。
 */
export interface FocusScopeHandleView {
  instanceId: FocusInstanceId | null
  activate: (reason?: ActivateReason) => void
}

export function useFocusScope(): FocusScopeHandleView {
  const instanceId = useContext(FocusScopeContext)

  const activate = useCallback(
    (reason: ActivateReason = 'programmatic') => {
      if (instanceId) focusTree.activate(instanceId, reason)
    },
    [instanceId],
  )

  return { instanceId, activate }
}

/**
 * **「我这块面此刻是不是当前」** —— 唯一的问法(见上面那段文件头)。
 *
 * 它是这条链上**唯一还订阅着树**的 hook,所以调用它就是在说「我真的要随焦点
 * 变化重渲」。调之前先问自己一句:画出来的东西真的会因为这个布尔而不同吗?
 * 只是想把键盘送进来 → `useFocusScope().activate`,那一条不必订阅。
 *
 * 今天生产代码里零消费者(四个用到响应链的组件全都只要 `activate`)。**不删**:
 * 它不是第二种打开语义那种「多出来的口」,而是设计 §4.2 那个问题**仅有的**
 * 正确答案 —— 少了它,下一个真需要这个布尔的人就会回去写
 * `ref.current.contains(document.activeElement)`,而那正是这条链立法要治的东西。
 * `__tests__/FocusScope.test.tsx` 的两组用例把它的语义钉着。
 */
export function useFocusScopeActive(): boolean {
  const instanceId = useContext(FocusScopeContext)
  return useSyncExternalStore(
    useCallback((listener: () => void) => focusTree.subscribe(listener), []),
    useCallback(
      () => (instanceId ? focusTree.activePath().includes(instanceId) : false),
      [instanceId],
    ),
    () => false,
  )
}
