/**
 * `canonicalChatMessage(m)` —— 比较两条消息"是不是同一条"的**唯一**判据(§9.4)。
 *
 * 两个消费者:S0 的合同测试(命令线 vs 事件线),S1 的影子断言
 * (`project(events) ≡ messages`,§8 的 `runs ≥ 200 ∧ mismatch = 0` 按它数)。
 * 审查 B7 点名的问题正是"mismatch 没有定义" —— 直接深比较必然恒假
 * (isStreaming / thinkingTime / timestamp / usage 累计 / steps 顺序都不等),
 * 于是那道门要么永远红要么被人调成永远绿。这个函数把"不等但不算数"的那部分
 * 一次性写死。
 *
 * ## 丢掉什么,为什么 —— **两张表,不是一张**
 *
 * F4-c c5 起,"丢掉"的理由分两族,各有各的家:
 *
 * **① 短命-被取代** → 不在这里,在 `events/ephemeral-policy.ts`(定律三的封闭
 * 策略表)。每条都带着"取代它的持久事件"与一条机器能跑的收敛性质测试。这里只
 * **消费**它:`EPHEMERAL_MESSAGE_KEYS` / `EPHEMERAL_STEP_KEYS` /
 * `isEphemeralContentPart` 三个口读过来,判据不再自己抄一份名单。
 * 今天登记在册的有:`isThinking` + `thinkingStartTime`、step 的 `partialResult`
 * 族、`waiting` / `image-loading` / 未结算的 `plugin-status` 三种瞬态 part
 * (以及判据看不见的两条:`toolCall.streamingArgs`、编码器的未刷 delta)。
 *
 * **② 杂项** → 留在下面这张表。它们**不是**"会被取代的短命事实",各带各的
 * 一句人话,而且每一条都只有一句人话 —— 这正是两者分家的意义:
 *
 * | 字段 | 处置 | 理由 |
 * |---|---|---|
 * | `seq` | 丢 | 位置,不是身份。删一条前面的消息它全平移(§3.2 它在 S2 退役) |
 * | `eventSeq` | 丢 | 投影独有的事件坐标,命令线没有它 |
 * | `sessionId` | 丢 | 上下文字段,同一条消息在不同读法下有无都算对 |
 * | `thinkingTime` | 丢 | G5:**派生量**(投影从 chunks 时刻算,消息里常常没有)。它是策略表 `message.thinking-activity` 的**替身**,不是短命事实本身 |
 * | `isStreaming` | 只保留 `true` | `false` 与缺席是同一件事。**这一格本身是策略表条目**(`run/end` 取代),这里只是那条 `false ≡ 缺席` 的归一 |
 * | `data-steps` / `tool-call` part | 丢 | G4:工具行的两种**渲染锚点**(重放合成前者、流式落后者,core `render-anchors.ts` 并列写着),位置算得出来,不是正文。不会被任何事件"取代",所以不进策略表 |
 * | `undefined` 值的键 | 丢 | `{a: undefined}` 与 `{}` 是同一条消息 |
 * | 空数组 | 丢 | `toolCalls: []` 与没有 toolCalls 是同一件事 |
 * | `steps` / `toolCalls` 顺序 | 按 id 排序 | 数组序是派生物(到达序 vs 落盘序),身份是 id |
 * | step/toolCall 的 `timestamp` `startTime` `endTime` `receivedAt` `durationMs` | 丢 | 同一件事的两次读表(引擎 vs 事件),差 1~2ms |
 * | toolCall 的 `argsFinalizedBy` | 丢 | **采集过程的注记,不是会话事实**(§17.7 #7 定性,留账 #11 结清):它说的是"我们的流式层怎么知道参数说完了",全仓零消费者 —— 见 `canonicalToolCall` |
 * | `usage.durationMs` | 丢 | 一次流的墙钟量测,不是用量 |
 * | toolCall 的 `requiresConfirmation: false` / `canRespond: false` | 与缺席同义 | 确认闸的收场态,不是事实的一部分 |
 * | step 的 `id` | 丢 | G1:老抄本里是停写那一刻的 uuid(下面那段长注释) |
 *
 * **不丢**的:`contentParts` 的顺序(那是正文本身)、消息级 `timestamp`、
 * `usage` 的 token 计数、`errorDetails`、工具的**结构化结局**。它们不等就是
 * 真的不等。
 *
 * 下面这几条 S1b 的裁定都有一个共同判据:**S2 切读之后,拿投影那一份当真相,
 * 用户看到的东西会不会变?** 会变的一格都不许丢(工具结局的 metadata 就是这么
 * 补上采集点而不是豁免掉的);不会变的才写进这张表。
 */

import { stringifyToolResult, toolCallArguments } from '../../agent-loop/wire-format.js'
import {
  EPHEMERAL_MESSAGE_KEYS,
  EPHEMERAL_STEP_KEYS,
  isEphemeralContentPart,
} from '../events/ephemeral-policy.js'

export interface CanonicalizeOptions {
  /** 额外忽略的顶层字段(S1 影子期用来临时豁免还没接上的采集点)。 */
  ignoreKeys?: readonly string[]
}

const ALWAYS_DROPPED_KEYS: ReadonlySet<string> = new Set([
  // —— 杂项(坐标 / 派生量),各带各的理由 ——
  'seq',
  'eventSeq',
  'sessionId',
  // G5(§10.1):`thinkingTime` 是**派生**的 —— 投影从 chunks 的时刻算,引擎那份
  // 账里它是渲染层事后写上的(常常根本没有)。S1b 实测:同一次执行,投影算出
  // 20ms,messages.jsonl 那条一格都没有。派生量不参与"是不是同一条消息"。
  'thinkingTime',
  // —— 策略表条目(定律三):`message.thinking-activity` 的两格 ——
  // 名单不在这里,在 `events/ephemeral-policy.ts`;那边每一条都带取代事件与
  // 一条收敛性质测试。这里只是把它读过来。
  ...EPHEMERAL_MESSAGE_KEYS,
])

/**
 * step / toolCall 上**不参与比较**的那几格(S1b 实测,§10.8)。
 *
 * 全是"同一件事的两次读表":引擎在执行前后各调一次 `Date.now()`,事件账本记的
 * 是 `tool/call` / `tool/result` 两条记录的时刻 —— 同一个同步路径上的两行代码,
 * 差 1~2ms。投影**照旧产出**这几格(S2 切读之后工具卡要靠它显示"跑了多久"),
 * 只是拿它们比"是不是同一条消息"没有意义:那道门会永远红,而红的原因只是时钟。
 *
 * `durationMs` 一并排除:它是两次读表的差,继承同一份噪声。
 */
const DERIVED_CLOCK_KEYS = new Set(['timestamp', 'startTime', 'endTime', 'receivedAt', 'durationMs'])

/**
 * **G4(§10.1):渲染锚点,不是短命事实。**
 *
 * 工具行的锚点有**两种形状**,core 自己把它们并列写在一处
 * (`core/session/render-anchors.ts` 的 `hasCoreRenderToolAnchor`):
 *
 *  - `data-steps` —— 位置由"这一轮有没有工具调用"算得出来
 *    (`planAgentLoopTurnContentPersistence` / `synthesizeCoreToolAnchors`);
 *  - `tool-call` —— **流式期间**渲染侧当场落的那一个。重放时合成的是 `data-steps`,
 *    而且明文**不去冲掉** live 的这一个(同文件 119-120 行,冲掉会让工具行 remount)。
 *
 * 所以"live 一种、重放另一种"是设计,不是失配。从前这里只丢前一种,因为 S 线的
 * 影子是**折 vs 折**、两侧都不会有 live 的 `tool-call`;U 线(ui-refold)第一次把
 * live 侧摆上台,于是它在门内自己又排除了一次 —— **两把尺**。§17.7 #4 归并:
 * 尺只有这一把,U 线那份具名豁免撤销(留账 18 结清)。
 *
 * 它们**不进策略表**:没有任何一条持久事件"取代"它们,它们压根不是被记录的事实。
 * 这一条与 `isEphemeralContentPart` 分开写,正是为了让"被取代"与"算得出来"
 * 两种理由各自可辨认。
 */
const RENDER_ANCHOR_PART_TYPES = new Set(['data-steps', 'tool-call'])

function isRenderAnchorPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const type = (part as { type?: unknown }).type
  return typeof type === 'string' && RENDER_ANCHOR_PART_TYPES.has(type)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry === undefined) continue
    out[key] = canonicalValue(entry)
  }
  return out
}

function sortByKey(items: readonly unknown[], key: 'id' | 'toolCallId'): unknown[] {
  return [...items].sort((a, b) => {
    const left = String((a as Record<string, unknown>)?.[key] ?? (a as { id?: unknown })?.id ?? '')
    const right = String((b as Record<string, unknown>)?.[key] ?? (b as { id?: unknown })?.id ?? '')
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * G1(§10.1):**step 的 `id` 不参与比较**。
 *
 * 立这条时的理由是"两侧本来就不可能相等":事件里从来没有 stepId,引擎实时
 * 那一份是 `createCoreId()` 随机生成的,投影那一份是 `step-${callId}` 派生的。
 *
 * **F4-b1(§16.16)把那个前提消掉了** —— 引擎侧改成同一条派生规则
 * (`coreStepIdForToolCall`,唯一产地),活链路上两侧从此逐字相同。
 *
 * **但这条豁免不收紧**,理由是**老账本**,不是审美:`sessions:verify` 拿
 * `messages.jsonl`(F4-a 起永久停写的存量抄本)逐条过 `canonicalChatMessage`,
 * 而那些抄本里的 step id 是停写那一刻的 uuid —— 真机实测 443 条会话里 **284 条
 * 带 18126 个 uuid step id**。收紧 = 给那道门加一条"老抄本豁免",而豁免路径
 * 本身就是这张表最该少的东西(§16.13 记的正是"恒等门证明的是 canonical 之后
 * 相等,不是可以互换")。
 *
 * 身份仍然是 `toolCallId`:排序按它,比较也不看 id。`childSteps` 递归同款。
 * 门看不见的那件事(两侧 id 语义是否还是同一个)由
 * `session/__tests__/step-identity-contract.test.ts` 跨两条路取值钉住 ——
 * 那是一条常驻合同,不是一次性验收。
 */
function canonicalStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return canonicalValue(step)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(step as Record<string, unknown>).sort()) {
    if (key === 'id') continue
    // 时钟噪声(杂项)+ `step.partialResult` 族(策略表条目,名单从那边读)。
    if (DERIVED_CLOCK_KEYS.has(key) || EPHEMERAL_STEP_KEYS.has(key)) continue
    const value = (step as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (key === 'childSteps') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.childSteps = sortByKey(value, 'toolCallId').map(canonicalStep)
      continue
    }
    if (key === 'toolCall') {
      out.toolCall = canonicalToolCall(value)
      continue
    }
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = canonicalValue(value)
  }
  return out
}

/**
 * toolCall 上的同一条时钟规则,外加 `argsFinalizedBy`。
 *
 * `argsFinalizedBy`(`'parse' | 'provider-done'`)记的是**参数流是怎么收尾的** ——
 * 中途 JSON 补齐,还是等 provider 报完。
 *
 * **§17.7 #7 定性(2026-08-28,勘察后结清留账 #11):它是采集过程的注记,不是
 * 会话事实 —— 所以进豁免表是终态,不是欠一条产地。** 判据是 §13.8 那条尺子
 * (「这句话在别处有没有产地」)的另一面:它说的不是"模型/工具做了什么",是
 * "**我们的流式层怎么知道参数说完了**"。逐口实测过消费面:全仓只有生产者
 * (`core/engine/stream-processor.ts` 盖章 → `event-only-emitter.ts` 顺着
 * `TOOL_INPUT_END` 发出去),**没有任何一处拿它做判断** —— renderer 零引用、
 * 工具执行链零引用、权限链零引用。换句话说它连"影响读侧行为"的资格都没有,
 * 补一条产地只会让账本多记一句没人读的自述。
 *
 * 从前这里写的是"留作 §10.8 的公开缺口" —— 那句话把它记成了**欠账**。
 * 它不是欠账,是**不该进账本**的东西。
 */
function canonicalToolCall(toolCall: unknown): unknown {
  if (!toolCall || typeof toolCall !== 'object') return canonicalValue(toolCall)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(toolCall as Record<string, unknown>).sort()) {
    if (DERIVED_CLOCK_KEYS.has(key) || key === 'argsFinalizedBy') continue
    const value = (toolCall as Record<string, unknown>)[key]
    if (value === undefined) continue
    // `requiresConfirmation: false` 与缺席是同一件事(与 `isStreaming` 同一条规则):
    // 引擎在收尾时把这一位写死成 false,而没走过确认闸的调用上根本没有它。
    if (key === 'requiresConfirmation') {
      if (value === true) out.requiresConfirmation = true
      continue
    }
    // `canRespond: false` 同理 —— 它是"这张卡还能不能按"的 UI 闸,收场时被写死
    // 成 false(桌面的停止按钮走 `cancelOnethingStreamingStepsForAbort`),而
    // 从来没开过闸的调用上根本没有它。`true` 才是一件事。
    if (key === 'canRespond') {
      if (value === true) out.canRespond = true
      continue
    }
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = canonicalValue(value)
  }
  return out
}

export function canonicalChatMessage(
  message: Record<string, unknown>,
  options: CanonicalizeOptions = {},
): Record<string, unknown> {
  const ignored = new Set([...ALWAYS_DROPPED_KEYS, ...(options.ignoreKeys ?? [])])
  const out: Record<string, unknown> = {}

  for (const key of Object.keys(message).sort()) {
    if (ignored.has(key)) continue
    const value = message[key]
    if (value === undefined) continue

    // 策略表条目 `message.isStreaming`(定律三:`run/end` 取代)。这里做的只是
    // 那条归一:`false` 与缺席是同一件事 —— 收敛性质本身在 ephemeral-policy 那边。
    if (key === 'isStreaming') {
      if (value === true) out.isStreaming = true
      continue
    }

    if (key === 'contentParts') {
      if (!Array.isArray(value)) continue
      // 两种"丢",两条理由:策略表登记的短命 part(会被取代)+ 渲染锚点(算得出来)。
      const parts = value
        .filter(part => !isEphemeralContentPart(part) && !isRenderAnchorPart(part))
        .map(canonicalValue)
      if (parts.length > 0) out.contentParts = parts
      continue
    }

    if (key === 'steps') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.steps = sortByKey(value, 'toolCallId').map(canonicalStep)
      continue
    }

    if (key === 'toolCalls') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.toolCalls = sortByKey(value, 'id').map(canonicalToolCall)
      continue
    }

    if (key === 'usage') {
      // `usage.durationMs` 是一次流的墙钟量测(引擎在收尾时写),不是用量。
      // 事件账本按 `request/response.usage` 求和,里面没有这一格。
      const { durationMs: _droppedWallClock, ...rest } = (value ?? {}) as Record<string, unknown>
      out.usage = canonicalValue(rest)
      continue
    }

    if (Array.isArray(value) && value.length === 0) continue

    out[key] = canonicalValue(value)
  }

  return out
}

export function canonicalChatMessages(
  messages: readonly Record<string, unknown>[],
  options: CanonicalizeOptions = {},
): Record<string, unknown>[] {
  return messages.map(message => canonicalChatMessage(message, options))
}

/**
 * F10a(§13.2):**wire 上是一整串字节的那两格,按字节比,不按对象比。**
 *
 * `canonicalValue` 对对象键排序 —— 对绝大多数格这是对的:它们在 wire 上被
 * **逐字段映射**成 provider 的形状,键序是拼装顺序的副产物。但有两格例外,
 * 它们整个被 `JSON.stringify` 成一个字符串塞进请求:
 *
 *   - 工具结局(`role:'tool'` 的 `content[].result` → `stringifyToolResult`)
 *   - 工具参数(assistant 的 `toolCalls[].args` → `toolCallArguments`)
 *
 * `JSON.stringify` 保留键的插入序,所以 `{"a":1,"b":2}` 与 `{"b":2,"a":1}` 在
 * 判等器眼里一样、在 provider 眼里是两段不同的前缀(prompt cache 直接失效)。
 * 这是全表唯一"判等但不等价"的格 —— 判据这里改成拿**同一个序列化器**(core
 * 的 `wire-format.ts`,messages.ts 用的就是它)算出字符串再比。
 */
function canonicalHistoryToolCall(call: unknown): unknown {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return canonicalValue(call)
  const record = call as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    // `args` / `arguments` 是同一件事的两种写法,归一成 wire 的那一串。
    if (key === 'args' || key === 'arguments') continue
    const value = record[key]
    if (value === undefined) continue
    out[key] = canonicalValue(value)
  }
  out.arguments = toolCallArguments(record)
  return out
}

function canonicalHistoryToolResultEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return canonicalValue(entry)
  const record = entry as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (key === 'result') continue
    const value = record[key]
    if (value === undefined) continue
    out[key] = canonicalValue(value)
  }
  out.result = stringifyToolResult(record.result)
  return out
}

function canonicalHistoryMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return canonicalValue(message)
  const record = message as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const value = record[key]
    if (value === undefined) continue
    if (key === 'content' && record.role === 'tool' && Array.isArray(value)) {
      out.content = value.map(canonicalHistoryToolResultEntry)
      continue
    }
    if (key === 'toolCalls' && Array.isArray(value)) {
      out.toolCalls = value.map(canonicalHistoryToolCall)
      continue
    }
    out[key] = canonicalValue(value)
  }
  return out
}

/**
 * 模型历史的**唯一**比较判据(S1b,§10.4 第二条)。
 *
 * 两侧都是 provider 形状的历史数组:一侧是今天 `buildHistoryMessages` 发出去的
 * 那一份,另一侧是同一条 surface 投影出来的。判据是**序列化之后的字节** ——
 * 任何一处不同都意味着"S2 切读之后模型会看到另一段历史",没有"不算数"的那一类。
 *
 * 归一的只有两件与内容无关的事:键序(一侧是字面量的写法序,另一侧是投影的
 * 拼装序)与 `undefined`(它与缺席是同一件事)。**例外见上面的 F10a**:
 * 工具结局与工具参数在 wire 上是一整串字节,它们按那一串比。
 */
export function canonicalHistoryMessages(messages: readonly unknown[]): string {
  return JSON.stringify(messages.map(canonicalHistoryMessage))
}
