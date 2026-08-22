/**
 * 交互协议 wire 契约的**穷尽守卫**(claude-code-integration-v2 §4,E1)。
 *
 * 与 `collab-observability.test.ts` 同一条 C3 纪律:一张字段表 + 双向 `Exclude`,
 * 联合/接口里有而表里没有 → 红,表里有而那边没有 → 也红。表放在测试里而不是源文件
 * 里,是因为 `ipc/interaction.ts` 是一个**纯类型模块** —— 往它里面塞 const 会让每个
 * `import type` 的地方多出一段运行时代码。测试文件同进 `tsconfig.node.json` 的
 * include,所以守卫照样在 typecheck 里红。
 *
 * 这里额外守一条**别处没有的**:契约本体是从 `@onething/core/interaction` 再导出的
 * (不是手抄的平行副本),所以下面的字段表同时也在盯 core 那边的形状 —— 两边漂移
 * 这件事在结构上就不成立了。
 */
import { describe, expect, it } from 'vitest'

import { interactionRouter } from '../interaction.js'
import type {
  InteractionAnswer,
  InteractionGetPendingRequest,
  InteractionGetPendingResponse,
  InteractionOption,
  InteractionOutcome,
  InteractionQuestion,
  InteractionQuestionAnswer,
  InteractionRequest,
  InteractionRespondRequest,
  InteractionRespondResponse,
} from '../interaction.js'

/* ── 协议本体(照 SDK 的 AskUserQuestionInput 设计)────────────────────── */

const REQUEST_FIELDS = [
  'id',
  'sessionId',
  'toolCallId',
  // 归位的第二档消息锚(与审批卡同一条纪律)。它必须过线:渲染侧只认 toolCallId
  // 的话,那次调用没落进消息的卡就只剩尾泊 —— 而末尾是新消息出现的位置。
  'messageId',
  'origin',
  'questions',
  'deadlineAt',
  'createdAt',
  'targetChannel',
] as const satisfies readonly (keyof InteractionRequest)[]
type RequestMissing = Exclude<keyof InteractionRequest, (typeof REQUEST_FIELDS)[number]>
type RequestStray = Exclude<(typeof REQUEST_FIELDS)[number], keyof InteractionRequest>
const REQUEST_IS_EXHAUSTIVE: [RequestMissing] extends [never]
  ? [RequestStray] extends [never] ? true : never
  : never = true

const QUESTION_FIELDS = [
  'id',
  'header',
  'question',
  'multiSelect',
  'options',
  'allowFreeText',
] as const satisfies readonly (keyof InteractionQuestion)[]
type QuestionMissing = Exclude<keyof InteractionQuestion, (typeof QUESTION_FIELDS)[number]>
type QuestionStray = Exclude<(typeof QUESTION_FIELDS)[number], keyof InteractionQuestion>
const QUESTION_IS_EXHAUSTIVE: [QuestionMissing] extends [never]
  ? [QuestionStray] extends [never] ? true : never
  : never = true

const OPTION_FIELDS = ['label', 'description', 'preview'] as const satisfies
  readonly (keyof InteractionOption)[]
type OptionMissing = Exclude<keyof InteractionOption, (typeof OPTION_FIELDS)[number]>
type OptionStray = Exclude<(typeof OPTION_FIELDS)[number], keyof InteractionOption>
const OPTION_IS_EXHAUSTIVE: [OptionMissing] extends [never]
  ? [OptionStray] extends [never] ? true : never
  : never = true

const ANSWER_FIELDS = ['id', 'answers', 'outcome', 'reason'] as const satisfies
  readonly (keyof InteractionAnswer)[]
type AnswerMissing = Exclude<keyof InteractionAnswer, (typeof ANSWER_FIELDS)[number]>
type AnswerStray = Exclude<(typeof ANSWER_FIELDS)[number], keyof InteractionAnswer>
const ANSWER_IS_EXHAUSTIVE: [AnswerMissing] extends [never]
  ? [AnswerStray] extends [never] ? true : never
  : never = true

const QUESTION_ANSWER_FIELDS = ['selected', 'freeText'] as const satisfies
  readonly (keyof InteractionQuestionAnswer)[]
type QuestionAnswerMissing = Exclude<
  keyof InteractionQuestionAnswer,
  (typeof QUESTION_ANSWER_FIELDS)[number]
>
type QuestionAnswerStray = Exclude<
  (typeof QUESTION_ANSWER_FIELDS)[number],
  keyof InteractionQuestionAnswer
>
const QUESTION_ANSWER_IS_EXHAUSTIVE: [QuestionAnswerMissing] extends [never]
  ? [QuestionAnswerStray] extends [never] ? true : never
  : never = true

/** 四种收场都必须在联合里。少一种 = 某条等待没有落点(原则 3)。 */
const OUTCOMES = ['answered', 'declined', 'timeout', 'aborted'] as const satisfies
  readonly InteractionOutcome[]
type OutcomeMissing = Exclude<InteractionOutcome, (typeof OUTCOMES)[number]>
type OutcomeStray = Exclude<(typeof OUTCOMES)[number], InteractionOutcome>
const OUTCOMES_ARE_EXHAUSTIVE: [OutcomeMissing] extends [never]
  ? [OutcomeStray] extends [never] ? true : never
  : never = true

/* ── IPC 请求 / 响应 ────────────────────────────────────────────────────── */

const RESPOND_REQUEST_FIELDS = [
  'sessionId',
  'interactionId',
  'toolCallId',
  'answers',
  'decline',
  'reason',
] as const satisfies readonly (keyof InteractionRespondRequest)[]
type RespondRequestMissing = Exclude<
  keyof InteractionRespondRequest,
  (typeof RESPOND_REQUEST_FIELDS)[number]
>
type RespondRequestStray = Exclude<
  (typeof RESPOND_REQUEST_FIELDS)[number],
  keyof InteractionRespondRequest
>
const RESPOND_REQUEST_IS_EXHAUSTIVE: [RespondRequestMissing] extends [never]
  ? [RespondRequestStray] extends [never] ? true : never
  : never = true

const RESPOND_RESPONSE_FIELDS = ['success', 'error'] as const satisfies
  readonly (keyof InteractionRespondResponse)[]
type RespondResponseMissing = Exclude<
  keyof InteractionRespondResponse,
  (typeof RESPOND_RESPONSE_FIELDS)[number]
>
type RespondResponseStray = Exclude<
  (typeof RESPOND_RESPONSE_FIELDS)[number],
  keyof InteractionRespondResponse
>
const RESPOND_RESPONSE_IS_EXHAUSTIVE: [RespondResponseMissing] extends [never]
  ? [RespondResponseStray] extends [never] ? true : never
  : never = true

const GET_PENDING_REQUEST_FIELDS = ['sessionId'] as const satisfies
  readonly (keyof InteractionGetPendingRequest)[]
type GetPendingRequestMissing = Exclude<
  keyof InteractionGetPendingRequest,
  (typeof GET_PENDING_REQUEST_FIELDS)[number]
>
type GetPendingRequestStray = Exclude<
  (typeof GET_PENDING_REQUEST_FIELDS)[number],
  keyof InteractionGetPendingRequest
>
const GET_PENDING_REQUEST_IS_EXHAUSTIVE: [GetPendingRequestMissing] extends [never]
  ? [GetPendingRequestStray] extends [never] ? true : never
  : never = true

const GET_PENDING_RESPONSE_FIELDS = ['success', 'pending', 'error'] as const satisfies
  readonly (keyof InteractionGetPendingResponse)[]
type GetPendingResponseMissing = Exclude<
  keyof InteractionGetPendingResponse,
  (typeof GET_PENDING_RESPONSE_FIELDS)[number]
>
type GetPendingResponseStray = Exclude<
  (typeof GET_PENDING_RESPONSE_FIELDS)[number],
  keyof InteractionGetPendingResponse
>
const GET_PENDING_RESPONSE_IS_EXHAUSTIVE: [GetPendingResponseMissing] extends [never]
  ? [GetPendingResponseStray] extends [never] ? true : never
  : never = true

describe('interaction wire 契约', () => {
  it('协议本体的字段表两个方向都对得上', () => {
    expect(REQUEST_IS_EXHAUSTIVE).toBe(true)
    expect(QUESTION_IS_EXHAUSTIVE).toBe(true)
    expect(OPTION_IS_EXHAUSTIVE).toBe(true)
    expect(ANSWER_IS_EXHAUSTIVE).toBe(true)
    expect(QUESTION_ANSWER_IS_EXHAUSTIVE).toBe(true)
  })

  it('四种收场一个都不少(原则 3:每条等待都有落点)', () => {
    expect(OUTCOMES_ARE_EXHAUSTIVE).toBe(true)
    expect(OUTCOMES).toHaveLength(4)
  })

  it('IPC 请求 / 响应的字段表两个方向都对得上', () => {
    expect(RESPOND_REQUEST_IS_EXHAUSTIVE).toBe(true)
    expect(RESPOND_RESPONSE_IS_EXHAUSTIVE).toBe(true)
    expect(GET_PENDING_REQUEST_IS_EXHAUSTIVE).toBe(true)
    expect(GET_PENDING_RESPONSE_IS_EXHAUSTIVE).toBe(true)
  })

  it('两条方法在 router 名册上(P4c 第九批:通道常量已退役)', () => {
    expect(interactionRouter.domain).toBe('interaction')
    expect([...interactionRouter.methods]).toEqual(['respond', 'getPending'])
  })
})
