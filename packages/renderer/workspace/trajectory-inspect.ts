/**
 * chat → 轨迹面板的 **one-shot store handoff**(主线 E1,dsh 判例 §1.1)。
 *
 * 聊天里的工具卡片与轨迹面板是同一份事件窗口的**两次独立装配**,彼此不认识
 * 对方的 DOM。所以"去看这一笔"是这样走的:
 *
 *   工具卡片 → 写一条 {sessionId, callId} → 开轨迹页签 → 面板挂载/激活后
 *   把它**取走**(取即清)→ 在**数据层**按 callId 定位那一行 → 选中 + 滚到可见。
 *
 * 两个"故意":
 * - **取即清**。留着的话,下次用户自己打开面板会莫名其妙跳到上次那一笔。
 * - **不依赖 DOM**。定位在 `findTrajectoryToolRow` 里做,滚动只是定位之后的
 *   一个装饰动作 —— 这条正是 dsh 那边被虚拟化表格逼出来的教训。
 *
 * 落点选在这里而不是 `stores/workspace.ts`:那个 store 管的是"哪条会话在哪一格"
 * (会话布局),chat store 管的是消息,**两个都不管工作台页签** —— 页签的唯一
 * 事实在 `RightWorkbenchPanel` 的本地 `openTabs` 里。而本目录已经有同形先例
 * (`panel-registry.ts` 的 `pluginPanels`:模块级 ref + setter + getter)。
 */
import { ref, type Ref } from 'vue'

export interface PendingTrajectoryInspect {
  sessionId: string
  callId: string
}

/** 面板打开自己的 window 事件(与 practice / agents 同款,注册在 panel-registry)。 */
export const TRAJECTORY_OPEN_WORKSPACE_EVENT = 'trajectory:open-workspace'

const pending: Ref<PendingTrajectoryInspect | null> = ref(null)

/** 面板 watch 它 —— 面板已经开着时也要接得住(挂载那一拍不会再来一次)。 */
export function usePendingTrajectoryInspect(): Ref<PendingTrajectoryInspect | null> {
  return pending
}

/**
 * 记一笔待检查的调用,并请求打开轨迹页签。
 *
 * 顺序是"先写再开":面板可能在下一拍就挂载,挂载时读到的必须已经是这一笔。
 */
export function requestTrajectoryInspect(request: PendingTrajectoryInspect): void {
  if (!request.callId) return
  pending.value = { sessionId: request.sessionId, callId: request.callId }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(TRAJECTORY_OPEN_WORKSPACE_EVENT))
  }
}

/** 取走并清空。找不到那一笔的时候也要调用它 —— 清除与结果无关。 */
export function takePendingTrajectoryInspect(): PendingTrajectoryInspect | null {
  const value = pending.value
  pending.value = null
  return value
}

/** 仅测试用:让每个用例从空手开始。 */
export function resetPendingTrajectoryInspect(): void {
  pending.value = null
}
