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
  /**
   * **「这一篇能在它自己的 app 里打开」那一格能力位**(P5)。
   *
   * 在场 = 产这条结果的那个库答得出 `openInApp`(后端问的是
   * `typeof vault.openInApp === 'function'`),缺席 = 这个系统没有这回事(目录库
   * 就是这一档)。**壳按这一格画,不按 `system` 分叉** —— 这只文件里因此一个笔记
   * 系统的名字都没有,加一种笔记系统它一个字不改。
   */
  openInAppActionId?: string
}

function payloadOf(payload: unknown): NoteTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { filePath, actionId, openInAppActionId } = payload as Partial<NoteTargetPayload>
  if (typeof filePath !== 'string') return undefined
  return {
    filePath,
    ...(typeof actionId === 'string' ? { actionId } : {}),
    ...(typeof openInAppActionId === 'string' ? { openInAppActionId } : {}),
  }
}

export const noteTargetRenderer = {
  kind: 'note',
  badge: () => ({ labelKey: 'search.badgeNote' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    if (payload.actionId !== undefined) {
      context.runAction(payload.actionId, row.capability)
      return
    }
    context.openFile(payload.filePath)
  },
  /**
   * 「在 Obsidian 中打开」(P5,§4.1 行动作)。
   *
   * **只在那一格能力位在场时才有这一条**:一条按下去什么都不会发生的菜单项比
   * 没有更让人怀疑(与过滤片那条「摆不出就整颗不画」同一条判据)。「还没建出来」
   * 的那条同样没有 —— 打开一个不存在的文件不是一件说得通的事。
   */
  rowActions(row) {
    const payload = payloadOf(row.target.payload)
    if (payload?.openInAppActionId === undefined || payload.actionId !== undefined) return []
    return [{ labelKey: 'search.action.openInApp', actionId: payload.openInAppActionId }]
  },
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
