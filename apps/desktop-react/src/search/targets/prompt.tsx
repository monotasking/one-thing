import { registerTargetRenderer } from './registry'

/**
 * `kind: 'prompt'` —— 一条提示词(`runtime/src/search/capabilities/prompts.ts` 的
 * `PromptTarget`)。
 *
 * **落点走动作口**:提示词命中的意思是「把它填进输入框」,那是一件宿主动作,
 * 不是一个「去某处」。所以这里报的是那条动作号,由宿主决定怎么落 —— 壳今天还
 * 没有那个落点,`runAction` 会**如实说出来**而不是静默吞掉(§4.3「绝不因为壳
 * 没跟上而把结果吞掉」的同一条纪律,只是这一次缺的是落点不是渲染器)。
 */
export interface PromptTargetPayload {
  promptId: string
  /** 「新建提示词」那条快捷项的动作号;缺席 = 这是一条已经存在的提示词。 */
  actionId?: string
}

function payloadOf(payload: unknown): PromptTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { promptId, actionId } = payload as Partial<PromptTargetPayload>
  if (typeof actionId === 'string') return { promptId: promptId ?? '', actionId }
  if (typeof promptId !== 'string' || promptId.length === 0) return undefined
  return { promptId }
}

export const promptTargetRenderer = {
  kind: 'prompt',
  badge: () => ({ labelKey: 'search.badgePrompt' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    context.runAction(payload.actionId ?? payload.promptId)
  },
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
