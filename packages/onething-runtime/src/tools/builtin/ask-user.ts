import { z } from 'zod'
import type { JsonObject, JsonObjectProperty } from '@onething/core'
import type {
  InteractionAnswer,
  InteractionOutcome,
  InteractionQuestion,
} from '@onething/core/interaction'
import { Tool } from '../tool.js'

/**
 * 原生会话的**提问工具**:向用户抛一道带选项的题,等一个结构化答案。
 *
 * ## 为什么这里一个新形状都没有
 *
 * 问题、答案、等待、收场、通道亲和、卡片 —— 全套在 E1/E2 已经建好了
 * (`@onething/core/interaction` + `app/interaction` + renderer 的 InteractionCard),
 * 当时只有外部 agent(SDK 自带的 `AskUserQuestion`)在用。协议里 `origin` 那一格
 * 写着 `'host-tool'`,就是给这一天留的位置。所以这个文件是**工具壳**:把模型给的
 * 入参翻成 `InteractionQuestion[]`,把收场翻成模型看得懂的工具结果,中间那条等待链
 * 一个字都不重写。
 *
 * ## 三条刻意的选择
 *
 * 1. **没有硬超时。** 提问是要人拍板的,而人可能去吃饭了。`ask` 的 deadline 拉到
 *    `ASK_USER_TIMEOUT_MS`(见那里的注释:为什么不是 `Infinity`)。真正让它收场的是
 *    用户回答、用户跳过、或者这一回合被中止 —— 而不是一只表。
 * 2. **回合中止 = 取消这次提问。** `ctx.abortSignal` 一响就把 pending 撤回
 *    (`adapters.abort`),内核结成 `aborted`,工具返回一条 cancelled 结果。不接这条,
 *    停了的回合会在输入框上方留下一条永远等不到人的提问,和一只挂着的 Promise。
 * 3. **四种收场都是正常返回。** 与 `Interaction.ask` 的契约逐字一致:answered /
 *    declined / timeout / aborted 都翻成工具结果,没有一种走 throw。异常路径会诱使
 *    上层把它当红错冒泡,而那正是这套协议当初要修的病。
 *
 * ## 结果形状(这是「用户答了什么」唯一的持久记录)
 *
 * `metadata` 里带一份结构化记录(outcome + 逐题答案),`output` 里带同一份 JSON 再
 * 加一行人话摘要。提问栏位收场之后会话里不留痕(它是 composer 上方的一格,不是流内
 * 的一张卡),所以回看只有这一份 —— 结构化字段要自洽到能独立读懂,不能指望渲染层
 * 另存一份。
 */

/**
 * `ask` 挂的 deadline。
 *
 * **不是 `Infinity`,也不是 `Number.MAX_SAFE_INTEGER`**:内核用 `setTimeout` 挂表,
 * 而 Node / 浏览器的延时是 32 位的 —— 超过 2^31-1 毫秒(约 24.8 天)会**立刻**触发,
 * 于是「永不超时」会精确地变成「马上超时」。7 天在这个上限之内,而且比任何一次真实
 * 的桌面会话都长:实际让它收场的永远是人的回答或回合中止,表只是兜底。
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

export const AskUserParameters = z.object({
  questions: z.array(AskUserQuestionSchema).min(1).max(4)
    .describe('1-4 questions asked on one card. Ask everything you need in one call rather than interrogating turn by turn.'),
})

export type AskUserArgs = z.infer<typeof AskUserParameters>

/** 一题的结构化答案。持久面按它重建已办卡,所以题面原文也留一份。 */
export interface AskUserAnswerRecord extends JsonObject {
  /** 与 `InteractionQuestion.id` 同一把 id(`<toolCallId>:<i>`)。 */
  questionId: string
  /** 题面原文 —— id 对不上时(极旧的记录)还能按文字认回来。 */
  question: string
  /** 选中的选项 label。单选也是数组,免得下游为两种形状写两条分支。 */
  selected: string[]
  /** 「其他」里用户自己写的那句。 */
  freeText?: string
}

/** 工具结果的结构化面 —— 收场之后「用户答了什么」只剩它。 */
export interface AskUserMetadata extends JsonObject {
  /** 结构标记:持久面认它,而不是认工具名的拼写。 */
  interaction: 'ask_user'
  outcome: InteractionOutcome
  /** 非 answered 收场的可读理由(直接进 output 给模型看)。 */
  reason?: string
  answers: AskUserAnswerRecord[]
  [key: string]: JsonObjectProperty
}

export interface AskUserAskInput {
  sessionId: string
  toolCallId?: string
  /** 归位的第二档消息锚。原生链路直接就是 `ctx.messageId` —— 这一轮写在哪它最清楚。 */
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
  /**
   * 发起一次提问并等收场。**只 resolve,永不 reject** —— 四种 outcome 都是正常返回,
   * 与 `Interaction.ask` 的契约一致。
   */
  ask(input: AskUserAskInput): Promise<InteractionAnswer>
  /**
   * 撤回一次还没收场的提问(回合中止)。按 `toolCallId` 定位 —— 那是这次提问唯一
   * 跨得过内存的相关键。找不到就是已经收场了,幂等 no-op。
   */
  abort(input: AskUserAbortInput): void
}

/**
 * 题 id。answers 表按它对上题面,所以它必须只由「这次调用 + 第几题」决定 ——
 * 换一次重放、换一个宿主都要拼回同一把钥匙。
 */
function questionId(anchor: string, index: number): string {
  return `${anchor}:${index}`
}

function toInteractionQuestions(args: AskUserArgs, anchor: string): InteractionQuestion[] {
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
    // 没答这一题(部分作答、或非 answered 收场)就不编一条记录出来:空数组读起来
    // 像「用户选了零个」,而事实是「这题没被回答」。
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

/** 一行人话:模型扫一眼就知道用户拍了什么板,不必自己解 JSON。 */
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

function buildResult(
  questions: InteractionQuestion[],
  answer: InteractionAnswer,
): Tool.Result<AskUserMetadata> {
  const records = answer.outcome === 'answered' ? toAnswerRecords(questions, answer) : []
  const metadata: AskUserMetadata = {
    interaction: 'ask_user',
    outcome: answer.outcome,
    ...(answer.reason ? { reason: answer.reason } : {}),
    answers: records,
  }
  const headline = answer.outcome === 'answered'
    ? summarize(records)
    : answer.reason || OUTCOME_TITLE[answer.outcome]
  return {
    title: OUTCOME_TITLE[answer.outcome],
    output: `${headline}\n\n${JSON.stringify({
      outcome: answer.outcome,
      ...(answer.reason ? { reason: answer.reason } : {}),
      answers: records.map(record => ({
        question: record.question,
        selected: record.selected,
        ...(record.freeText ? { freeText: record.freeText } : {}),
      })),
    }, null, 2)}`,
    metadata,
  }
}

export function createAskUserTool(
  adapters: AskUserToolAdapters,
): Tool.Info<typeof AskUserParameters, AskUserMetadata> {
  return Tool.define<typeof AskUserParameters, AskUserMetadata>('ask_user', {
    name: 'AskUser',
    description: `Ask the user a multiple-choice question and wait for their answer. It shows in a panel above the input box; the choice (one, several, or free text when allowed) comes back as the tool result and the panel then closes — restate anything you rely on later.

This blocks until answered; the user may take long or never answer (declined / timeout / aborted), in which case continue on your own judgement and state the assumption. Use it only when the user genuinely must decide (an ambiguous requirement, a fork with real trade-offs, a destructive action with several plausible shapes) — not to confirm work you can verify yourself, to ask permission the permission system already gates, or to narrate progress.`,
    category: 'builtin',
    enabled: true,
    autoExecute: true,
    // 提问没有副作用:不写盘、不发请求、不动任何外部状态。所以不立 effect,
    // 也就不过审批门 —— 「要不要打扰用户」这件事由模型的判断和上面那段描述管,
    // 再加一道审批只会让用户为「问不问」先点一次同意,再为答案点第二次。
    permissionGuard: 'safe',
    renderKind: 'text',
    parameters: AskUserParameters,
    async execute(args, ctx) {
      // 题 id 的锚。渲染侧的提问栏位长在 composer 上方,不再需要在消息流里找位置,
      // 但这两个 id 仍然原样带过去:应答按 toolCallId 回到发起它的那次调用,而
      // `messageId` 是外部 / ACP 通路(提问不长在工具执行上下文里)唯一的相关键。
      const anchor = ctx.toolCallId || ctx.messageId
      const questions = toInteractionQuestions(args, anchor)

      const abortedAnswer: InteractionAnswer = {
        id: '',
        answers: {},
        outcome: 'aborted',
        reason: ASK_USER_ABORTED_REASON,
      }

      // 已经停了就不要再挂一条没人会看的提问。
      if (ctx.abortSignal?.aborted) return buildResult(questions, abortedAnswer)

      const signal = ctx.abortSignal
      const onAbort = signal
        ? () => adapters.abort({
          sessionId: ctx.sessionId,
          ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
          reason: ASK_USER_ABORTED_REASON,
        })
        : undefined
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true })

      try {
        const answer = await adapters.ask({
          sessionId: ctx.sessionId,
          ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
          ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
          questions,
          timeoutMs: ASK_USER_TIMEOUT_MS,
        })
        return buildResult(questions, answer)
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
    },
  })
}
