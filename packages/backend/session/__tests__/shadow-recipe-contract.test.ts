/**
 * F5(§13.2/§13.4):**影子的 `build` 入参必须认得宿主配方的每一格。**
 *
 * 历史断言的前提是"同一条配方,两个来源"。宿主配方
 * (`historyProjectionRecipe`)有五格:`prepareMessages`(房投影 / goal drive
 * 折叠 / 用户消息上模型面)、`buildMessageContent`、`getAIToolName`、
 * `failureResultForAI`、`providerDataFromContentPart`。而影子的入参类型从前只
 * 写了中间三格 —— 另外两格纯靠 spread 活着,类型上一格都没记着。
 *
 * 这道用例是**双保险**:
 *  - 编译期:下面那个 `satisfies` 让 `bun run typecheck` 直接替我们把关(少一格
 *    就是类型错误);
 *  - 运行期:配方的键集必须被入参类型全部认领 —— 将来给配方加第六格而忘了
 *    改类型,这里当场红。
 */
import { describe, expect, it } from 'vitest'
import { historyProjectionRecipe } from '../../wiring/engine/stream/message-helpers.js'
import type { SessionHistoryShadowInput } from '../shadow.js'

/** 入参类型认领的那几格 —— 与 `SessionHistoryShadowInput['build']` 逐字对齐。 */
const ACCEPTED_RECIPE_KEYS = [
  'buildMessageContent',
  'failureResultForAI',
  'getAIToolName',
  'prepareMessages',
  'providerDataFromContentPart',
] as const

describe('history shadow recipe contract (F5)', () => {
  it('accepts the whole host recipe — compile time and run time', () => {
    const recipe = historyProjectionRecipe()

    // 编译期的那一半:类型不认得的键在这里就是一个类型错误。
    const build = recipe satisfies NonNullable<SessionHistoryShadowInput['build']>
    expect(build).toBeTruthy()

    // 运行期的那一半:配方长出第六格而类型没跟上 —— 当场红。
    expect(Object.keys(recipe).sort()).toEqual([...ACCEPTED_RECIPE_KEYS])
  })

  it('keeps prepareMessages and providerDataFromContentPart callable through that type', () => {
    const build: NonNullable<SessionHistoryShadowInput['build']> = historyProjectionRecipe()
    expect(typeof build.prepareMessages).toBe('function')
    expect(typeof build.providerDataFromContentPart).toBe('function')
  })
})
