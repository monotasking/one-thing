import { registerTargetRenderer } from './registry'

/**
 * `kind: 'note'` —— 一篇笔记(`runtime/src/search/capabilities/notes.ts` 的
 * `NoteTarget`)。
 *
 * **两形一个 kind**:`actionId` 在场的那条是「还没建出来」(文件不存在),缺席的
 * 是一篇真笔记。判据在 payload 上而不是两个 kind 上,因为它们是同一类东西的两个
 * 状态 —— 后端那一侧也是这么说的(`NoteTarget.payload.actionId`)。
 *
 * 落点因此分两支:有 `actionId` 走动作口(宿主去建文件),没有就当文件打开。
 */
export interface NoteTargetPayload {
  filePath: string
  /** 「还没建出来」那条的动作号;缺席 = 这是一篇已经存在的笔记。 */
  actionId?: string
}

function payloadOf(payload: unknown): NoteTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { filePath, actionId } = payload as Partial<NoteTargetPayload>
  if (typeof filePath !== 'string') return undefined
  return typeof actionId === 'string' ? { filePath, actionId } : { filePath }
}

export const noteTargetRenderer = {
  kind: 'note',
  badge: () => ({ labelKey: 'search.badgeNote' }),
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
