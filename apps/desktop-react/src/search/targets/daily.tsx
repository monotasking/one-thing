import { registerTargetRenderer } from './registry'

/**
 * `kind: 'daily'` —— 一篇每日笔记(`runtime/src/search/capabilities/daily.ts` 的
 * `DailyTarget`)。
 *
 * **两形一个 kind**:`actionId` 在场的那条是「新建今天的日记」(文件还不存在),
 * 缺席的是一篇真笔记。判据在 payload 上而不是两个 kind 上,因为它们是同一类东西的
 * 两个状态 —— 后端那一侧也是这么说的(`DailyTarget.payload.actionId`)。
 *
 * 落点因此分两支:有 `actionId` 走动作口(宿主去建文件),没有就当文件打开。
 */
export interface DailyTargetPayload {
  filePath: string
  /** 「今天还没建」那条快捷项的动作号;缺席 = 这是一篇已经存在的笔记。 */
  actionId?: string
}

function payloadOf(payload: unknown): DailyTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { filePath, actionId } = payload as Partial<DailyTargetPayload>
  if (typeof filePath !== 'string') return undefined
  return typeof actionId === 'string' ? { filePath, actionId } : { filePath }
}

export const dailyTargetRenderer = {
  kind: 'daily',
  badge: () => ({ labelKey: 'search.badgeDaily' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    if (payload.actionId !== undefined) {
      context.runAction(payload.actionId)
      return
    }
    context.openFile(payload.filePath)
  },
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
