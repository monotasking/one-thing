import { useCallback, useContext, useSyncExternalStore } from 'react'
import { FocusScopeContext } from './FocusScope'
import { focusTree } from './registry'
import type { ActivateReason, FocusInstanceId } from './types'

/**
 * **「我这块面此刻是不是当前」的唯一问法**。
 *
 * 从前这句话有三种问法,而且三种答的不是同一件事:
 *  · `panelRef.current?.contains(document.activeElement)`(`useEscStop`)——
 *    答的是「DOM 焦点在不在我身体里」,焦点掉到 body 就当场变成「不在」;
 *  · `usePanelVisibility().interactive` —— 答的是「宿主让不让我占全局输入」;
 *  · `live` 之类的自制布尔(`ExposeView`)—— 答的是「我这一份算不算数」。
 *
 * 树里只有一个答案:**我在不在活动路径上**。它不会因为一个 DOM 节点消失而翻面
 * (§4.2:第一响应者不会因为一个节点消失而消失),这正是 ⌘F 那条报障的病根 ——
 * 旧判据问的是「这一下按键经不经过我的根」,而不是「我是不是当前」。
 *
 * 交出去的三格里**没有 `scopeProps`**:铺根元素只有 render-prop 一条路
 * (理由写在 `FocusScope.tsx` 文件头)。
 *
 * 不在任何 `<FocusScope>` 里调用 = `instanceId` 为 null、`isActive` 恒 false、
 * `activate()` 什么都不做。**不抛** —— 一个组件既可能长在树里也可能长在
 * 规格页(`?gallery`)那种没有宿主的地方,为这件事抛错只会逼出一堆条件调用。
 */
export interface FocusScopeHandleView {
  instanceId: FocusInstanceId | null
  isActive: boolean
  activate: (reason?: ActivateReason) => void
}

export function useFocusScope(): FocusScopeHandleView {
  const instanceId = useContext(FocusScopeContext)

  const isActive = useSyncExternalStore(
    useCallback((listener: () => void) => focusTree.subscribe(listener), []),
    useCallback(
      () => (instanceId ? focusTree.activePath().includes(instanceId) : false),
      [instanceId],
    ),
    () => false,
  )

  const activate = useCallback(
    (reason: ActivateReason = 'programmatic') => {
      if (instanceId) focusTree.activate(instanceId, reason)
    },
    [instanceId],
  )

  return { instanceId, isActive, activate }
}
