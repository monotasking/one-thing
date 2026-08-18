/**
 * R3a 移植 —— `ask_user`。§4 的 `InteractiveTool` 一族。
 *
 * 描述、参数、题 id 规则、四种收场的文案与结果形状逐字沿用旧
 * `tools/builtin/ask-user.ts`;等待链(挂起、广播、通道亲和)照旧全部在
 * `@onething/core/interaction`,这里只是工具壳。
 *
 * 与旧实现的两处差别:
 *  - 撤回登记从 `signal.addEventListener('abort', …, { once: true })` + `finally`
 *    摘除,换成家族基类的 `ctx.abort.onAbort(...)`(返回摘除函数,且**已经取消时
 *    立即回调** —— 旧写法里"注册得太晚"等于没注册);
 *  - plan 报一条 `user_ask` 效果 + 一份带题面的预览。`user_ask` 在策略表里是
 *    `silent`,所以**不会**多出一张权限卡;它的意义是让"这次调用打算问什么"
 *    进审计 —— 提问栏位收场之后会话里不留痕,这是除工具结果之外唯一的记录。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type {
  InteractionAnswer,
  InteractionOutcome,
  InteractionQuestion,
} from '@onething/core/interaction'
import type { Preview, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { defineInput } from '../contract.js'
import { InteractiveTool, type InteractiveRequest } from '../families/interactive.js'

/**
 * `ask` 挂的 deadline。**不是 `Infinity`**:Node / 浏览器的延时是 32 位的,超过
 * 2^31-1 毫秒会**立刻**触发,于是「永不超时」会精确地变成「马上超时」。
 */
export const ASK_USER_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

/** 回合被中止时写给模型的那句话。 */
export const ASK_USER_ABORTED_REASON =
  '这一回合已被中止,提问随之取消,用户没有回答。不要把它当作一次拒绝,也不要立刻重问。'

const AskUserOptionSchema = z.object({
  label: z.string().min(1).describe('The option the user clicks. This exact string comes back as the answer.'),
  description: z.string().optional().describe('One short line explaining the trade-off of this option.'),
})

const AskUserQuestionSchema = z.object({
  question: z.string().min(1).describe('The question, in the user\'s language. Be specific about what you need decided.'),
  header: z.string().optional().describe('Short chip label for this question, ~12 characters.'),
  multiSelect: z.boolean().optional().describe('true when the user may pick several options. Default false.'),
  allowFreeText: z.boolean().optional().describe('true to offer an "other" box so the user can type their own answer.'),
  options: z.array(AskUserOptionSchema).min(1)
    .describe('The concrete choices. Make them mutually exclusive and actionable — not "yes/no" restatements of the question.'),
})

export const AskUserInputSchema = z.object({
  questions: z.array(AskUserQuestionSchema).min(1).max(4)
    .describe('1-4 questions asked on one card. Ask everything you need in one call rather than interrogating turn by turn.'),
})

export const ASK_USER_DESCRIPTION = `Ask the user a multiple-choice question and wait for their answer. It shows in a panel above the input box; the choice (one, several, or free text when allowed) comes back as the tool result and the panel then closes — restate anything you rely on later.

This blocks until answered; the user may take long or never answer (declined / timeout / aborted), in which case continue on your own judgement and state the assumption. Use it only when the user genuinely must decide (an ambiguous requirement, a fork with real trade-offs, a destructive action with several plausible shapes) — not to confirm work you can verify yourself, to ask permission the permission system already gates, or to narrate progress.`

const AskUserContract = defineInput(AskUserInputSchema)

export type AskUserInput = z.infer<typeof AskUserInputSchema>

/** 一题的结构化答案。持久面按它重建已办卡,所以题面原文也留一份。 */
export interface AskUserAnswerRecord extends JsonObject {
  questionId: string
  question: string
  selected: string[]
  freeText?: string
}

export interface AskUserAskInput {
  sessionId: string
  toolCallId?: string
  messageId?: string
  questions: InteractionQuestion[]
  timeoutMs: number
}

export interface AskUserAbortInput {
  sessionId: string
  toolCallId?: string
  reason: string
}

export interface AskUserToolAdapters {
  /** 发起一次提问并等收场。**只 resolve,永不 reject**。 */
  ask(input: AskUserAskInput): Promise<InteractionAnswer>
  /** 撤回一次还没收场的提问。找不到就是已经收场了,幂等 no-op。 */
  abort(input: AskUserAbortInput): void
}

function questionId(anchor: string, index: number): string {
  return `${anchor}:${index}`
}

function toInteractionQuestions(args: AskUserInput, anchor: string): InteractionQuestion[] {
  return args.questions.map((question, index) => ({
    id: questionId(anchor, index),
    question: question.question,
    ...(question.header ? { header: question.header } : {}),
    ...(question.multiSelect ? { multiSelect: true } : {}),
    ...(question.allowFreeText ? { allowFreeText: true } : {}),
    options: question.options.map(option => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  }))
}

function toAnswerRecords(
  questions: InteractionQuestion[],
  answer: InteractionAnswer,
): AskUserAnswerRecord[] {
  const records: AskUserAnswerRecord[] = []
  for (const question of questions) {
    const given = answer.answers[question.id]
    // 没答这一题就不编一条记录出来:空数组读起来像「用户选了零个」。
    if (!given) continue
    records.push({
      questionId: question.id,
      question: question.question,
      selected: [...(given.selected ?? [])],
      ...(given.freeText ? { freeText: given.freeText } : {}),
    })
  }
  return records
}

function summarize(records: AskUserAnswerRecord[]): string {
  if (records.length === 0) return '用户没有回答任何一题。'
  const parts = records.map(record => {
    const chosen = [...record.selected, ...(record.freeText ? [record.freeText] : [])]
    return `「${record.question}」→ ${chosen.length > 0 ? chosen.join('、') : '(空)'}`
  })
  return `用户已回答:${parts.join(';')}`
}

const OUTCOME_TITLE: Record<InteractionOutcome, string> = {
  answered: '用户已回答',
  declined: '用户跳过了提问',
  timeout: '提问超时',
  aborted: '提问已取消',
}

export class AskUserTool extends InteractiveTool<AskUserInput, InteractionQuestion[]> {
  private readonly adapters: AskUserToolAdapters

  readonly spec: ToolSpec = {
    id: 'ask_user',
    title: 'AskUser',
    description: ASK_USER_DESCRIPTION,
    input: AskUserContract.schema,
    effects: ['user_ask'],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(adapters: AskUserToolAdapters) {
    super()
    this.adapters = adapters
  }

  protected questionsFor(input: AskUserInput, anchor: string): InteractionQuestion[] {
    return toInteractionQuestions(input, anchor)
  }

  protected previewFor(request: InteractiveRequest<InteractionQuestion[]>): Preview {
    const first = request.questions[0]
    return {
      title: first ? `向用户提问:${first.question}` : '向用户提问',
      metadata: { questions: request.questions.map(question => question.question) },
    }
  }

  protected async awaitAnswer(
    request: InteractiveRequest<InteractionQuestion[]>,
    ctx: RunContext,
  ): Promise<Result> {
    const answer = await this.adapters.ask({
      sessionId: ctx.invocation.sessionId,
      ...(ctx.invocation.callId ? { toolCallId: ctx.invocation.callId } : {}),
      ...(ctx.invocation.messageId ? { messageId: ctx.invocation.messageId } : {}),
      questions: request.questions,
      timeoutMs: ASK_USER_TIMEOUT_MS,
    })
    return this.buildResult(request.questions, answer, ctx)
  }

  protected withdraw(_request: InteractiveRequest<InteractionQuestion[]>, ctx: RunContext): void {
    this.adapters.abort({
      sessionId: ctx.invocation.sessionId,
      ...(ctx.invocation.callId ? { toolCallId: ctx.invocation.callId } : {}),
      reason: ASK_USER_ABORTED_REASON,
    })
  }

  protected async cancelled(
    request: InteractiveRequest<InteractionQuestion[]>,
    ctx: RunContext,
  ): Promise<Result> {
    return this.buildResult(request.questions, {
      id: '',
      answers: {},
      outcome: 'aborted',
      reason: ASK_USER_ABORTED_REASON,
    }, ctx)
  }

  /** 四种收场都是正常返回 —— 没有一种走 throw(与 `Interaction.ask` 的契约一致)。 */
  private buildResult(
    questions: InteractionQuestion[],
    answer: InteractionAnswer,
    ctx: RunContext,
  ): Result {
    const records = answer.outcome === 'answered' ? toAnswerRecords(questions, answer) : []
    const details: JsonObject = {
      interaction: 'ask_user',
      outcome: answer.outcome,
      ...(answer.reason ? { reason: answer.reason } : {}),
      answers: records,
    }
    const headline = answer.outcome === 'answered'
      ? summarize(records)
      : answer.reason || OUTCOME_TITLE[answer.outcome]
    const output = `${headline}\n\n${JSON.stringify({
      outcome: answer.outcome,
      ...(answer.reason ? { reason: answer.reason } : {}),
      answers: records.map(record => ({
        question: record.question,
        selected: record.selected,
        ...(record.freeText ? { freeText: record.freeText } : {}),
      })),
    }, null, 2)}`

    ctx.emit({ type: 'annotate', title: OUTCOME_TITLE[answer.outcome], details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createAskUserTool(adapters: AskUserToolAdapters): AskUserTool {
  return new AskUserTool(adapters)
}
