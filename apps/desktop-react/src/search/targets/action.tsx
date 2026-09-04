import { registerTargetRenderer } from './registry'

/**
 * `kind: 'action'` —— 一条命令(`runtime/src/search/capabilities/actions.ts` 的
 * `ActionTarget`)。
 *
 * 它是这张表里**唯一一种「没有去处」的目标**:点它是执行一件事,不是打开什么。
 * 所以 `activate` 走 `runAction`,而 `payload` 上一格路径 / 会话号都没有,只有动作号。
 */
export interface ActionTargetPayload {
  actionId: string
}

function payloadOf(payload: unknown): ActionTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { actionId } = payload as Partial<ActionTargetPayload>
  if (typeof actionId !== 'string' || actionId.length === 0) return undefined
  return { actionId }
}

export const actionTargetRenderer = {
  kind: 'action',
  badge: () => ({ labelKey: 'search.badgeAction' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    context.runAction(payload.actionId)
  },
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
