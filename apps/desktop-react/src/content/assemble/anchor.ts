import { synthesizeCoreToolAnchors } from '@onething/core/session/render-anchors'
import type { ProjectedMessage } from '../../data/chat-fold'
import type { BlobRef, ProjectedToolCall } from '../model/segments'

/**
 * 管线第 ① 步:**锚点归位**(§2 ①)。
 *
 * 折叠器的输出不带排布 —— 它给的是「正文是什么、推理是什么、这条消息上挂了哪些
 * 工具调用」,**没说工具卡该插在正文的哪一处**。这一步把那件事定下来,产出一条
 * 从上到下的节点序列;后面四步只在这条序列上做事。
 *
 * ── 算法不在这里,在 core ────────────────────────────────────────────────
 * 「工具锚点插在哪」由 `synthesizeCoreToolAnchors`(`@onething/core/session/
 * render-anchors`)算 —— renderer(Vue)的加载路径与主进程的 settle 推送已经在用
 * 它,本壳是**第三个消费者**。三处必须逐字同算,否则「流式看到的分界」与「刷新后
 * 看到的分界」会分叉(§15.16 那一课的反面),所以这里一行算法都不写:只负责把
 * parts 递进去、把补好锚点的 parts 翻成本壳的节点词汇。
 *
 * core 给的锚点有两种,含义不同:
 *   · `data-steps{turnIndex}` —— 「**这一轮**的工具行画在这里」。真调用要按
 *     turnIndex 去 `message.steps` 里取(与 Vue 壳的 `stepsForTurn` 同一条)。
 *   · `tool-call{toolCalls}` —— 更老的、只存了 toolCalls 没存 steps 的消息的兜底,
 *     调用就带在锚点上。
 *
 * ── 正文为什么改从 contentParts 取(P0 是 message.content) ──────────────
 * P0 取的是 `message.content`(全部文本 part 的拼接),那时工具卡一律挂尾,一条
 * 消息只有一段正文,两者等价。归位之后不再等价:工具段要出现在**它发生的那两段
 * 正文之间**,而「哪两段」只有 parts 说得出来。
 *
 * 相邻的文本 part 之间**直接相接、不插分隔**(`materializePartText` 就是 `+=`),
 * 所以「中间没有锚点的几个文本 part」合并出来的字符串与 `message.content` 的对应
 * 那一截逐字相同 —— markdown 因此不会被 part 边界劈成两段(那会把一个 `<p>` 拆成
 * 两个,是没人要的可感知变化)。
 *
 * 没有 parts 的老消息(冷加载、脱水过的)按 `message.content` 现搭一格,再走同一
 * 条锚点合成 —— 与 Vue 壳的 `rebuildLoadedContentParts` 同款。
 */

export type AnchoredNode =
  | { node: 'text'; text: string }
  | { node: 'reasoning'; text: string; placement: 'top' | 'inline' }
  | { node: 'image'; blob: BlobRef }
  | { node: 'tool'; call: ProjectedToolCall }

/** core 只认 `type` / `turnIndex` 两格;本壳还要读内容,所以这里声明的是全形。 */
interface AnchorPart {
  type: string
  turnIndex?: number
  content?: string
  blob?: BlobRef
  toolCalls?: readonly ProjectedToolCall[]
}

type StepLike = NonNullable<ProjectedMessage['steps']>[number]

export function anchorMessage(message: ProjectedMessage): AnchoredNode[] {
  const nodes: AnchoredNode[] = []
  // 按 id 找调用 —— `data-steps` 锚点认领时的第二条路,见 `callOfStep`。
  const callById = new Map<string, ProjectedToolCall>()
  for (const call of message.toolCalls ?? []) callById.set(call.id, call)

  // 顶部推理落在 `message.reasoning`(不是 part)—— 折叠器与活尾巴同一个落点。
  // 它按定义排在所有 part 之前:那是引擎开这一段时就定下的事实(placement:'top')。
  if (message.reasoning) {
    nodes.push({ node: 'reasoning', text: message.reasoning, placement: 'top' })
  }

  const claimed = new Set<string>()
  // 合并相邻文本用的缓冲:锚点(或任何非文本节点)一到就落地。
  let pendingText = ''
  const flushText = () => {
    if (!pendingText) return
    nodes.push({ node: 'text', text: pendingText })
    pendingText = ''
  }
  const pushCall = (call: ProjectedToolCall | undefined) => {
    if (!call || claimed.has(call.id)) return
    claimed.add(call.id)
    flushText()
    nodes.push({ node: 'tool', call })
  }

  for (const part of anchoredParts(message)) {
    switch (part.type) {
      case 'text':
        pendingText += part.content ?? ''
        break
      case 'reasoning':
        // 走到这里的推理一定是**行内**的:top 那一份不进 parts(见上)。
        if (part.content) {
          flushText()
          nodes.push({ node: 'reasoning', text: part.content, placement: 'inline' })
        }
        break
      case 'image':
        if (part.blob) {
          flushText()
          nodes.push({ node: 'image', blob: part.blob })
        }
        break
      case 'data-steps':
        for (const step of stepsForTurn(message, part.turnIndex)) pushCall(callOfStep(step, callById))
        break
      case 'tool-call':
        for (const call of part.toolCalls ?? []) pushCall(call)
        break
      // provider-data 之类的不透明 part 不进屏幕 —— 它是给 provider 带回去的,
      // 不是给人看的。默认分支照单全收地跳过,不当成错误。
    }
  }
  flushText()

  // 锚点一格都没认领到的调用挂尾。**这不是兜底的客气话**:锚点合成只在
  // 「本来没有锚点」时动手,一条已经带着锚点、而锚点又盖不全的消息(流式中途的
  // 形态)照样得把每一次调用摆出来 —— 屏幕上少一张卡就是说谎。
  for (const call of message.toolCalls ?? []) pushCall(call)

  return nodes
}

/**
 * 补好锚点的 parts。
 *
 * `synthesizeCoreToolAnchors` 返回 `null` 表示「无需改动」(已经带锚点,或者这条
 * 消息压根没有工具活儿),那时原样用。
 */
function anchoredParts(message: ProjectedMessage): AnchorPart[] {
  const parts = ((message.contentParts ?? []) as AnchorPart[]).slice()
  if (parts.length === 0 && message.content) {
    // 老消息 / 脱水过的消息:按正文现搭一格,再走同一条合成(Vue 壳的
    // `rebuildLoadedContentParts` 同款)。
    parts.push({ type: 'text', content: message.content })
  }
  return synthesizeCoreToolAnchors<AnchorPart>(parts, message) ?? parts
}

/** 这一轮的 step(`turnIndex` 缺省视为第 0 轮 —— 单轮老消息就是这个形状)。 */
function stepsForTurn(message: ProjectedMessage, turnIndex: number | undefined): StepLike[] {
  const turn = turnIndex ?? 0
  return (message.steps ?? []).filter((step) => (step.turnIndex ?? 0) === turn)
}

/**
 * 一条 step 指的是哪一次调用 —— **两条路,`toolCallId` 是那条一定在的**。
 *
 * 08-31 真机回访的报障三就死在这里:从前只读 `step.toolCall`,而账本上**大多数**
 * 消息的 step 根本没有那一格。产地是 `message/imported` —— 老会话(messages.jsonl
 * 时代)迁进事件账本时,写进去的是**脱水过**的消息形:`dehydrateProjectedMessages`
 * 按定义摘掉 `step.toolCall`(那是 `toolCalls[]` 里那个对象的重复引用,存两份就会
 * 分叉),只留 `toolCallId`。投影对这类消息是**原样搬运**(`materializeMessageNode`
 * 只做浅展开),所以脱水形一路交到这里。
 *
 * 后果不是「少画一张卡」而是**位置全错**:`data-steps` 锚点一格都认领不到,于是
 * 每一次调用都落到 `anchorMessage` 末尾那句兜底里,整条消息的工具卡堆成一摞挂在
 * 正文之后 —— 正是用户报的那个样子。生产 store 只读扫描 250 条会话:带工具活儿的
 * assistant 消息 1166 条,其中 1002 条是这种 imported 形,835 条的 step 缺
 * `toolCall`,**739 条(63%)的段序列因此是错的**。
 *
 * 修法只碰这一句:拿 `toolCallId` 去 `message.toolCalls` 里认 —— 那份表是同一条
 * 消息自己带的,不是从别处猜来的,两格本来就一一对应。认不到才退回 `step.toolCall`
 * (脱水形没有它,现役形有);两条都空就返回 undefined,那次调用照旧由末尾的兜底
 * 摆出来(**屏幕上少一张卡就是说谎**,这条纪律不变)。
 *
 * ── 为什么表**排在前面**(C2-b 改的这一格)────────────────────────────
 * `step.toolCall` 与 `toolCalls[i]` 是**两个对象**:投影的 `materializeStep` 自己
 * 又调了一次 `materializeToolCall`,两份内容逐格相同但引用不同。上面那段注里
 * 「存两份就会分叉」说的正是这件事 —— 它一直是真的,只是从前没有人往其中一份上
 * 写东西,于是分叉不显形。
 *
 * C2-b 的活流进度写在**表**那一份上(`chat-materialize` / `chat-fold` 都按 id 盖),
 * 而这张卡从前读的是 step 上那一份 —— 于是屏幕上一条进度都看不到(真机读数:
 * 20 条 `tool-progress` 全部到达渲染层、水位表也收下了,而执行中那一行的摘要
 * 一帧都没变)。**修法不是再往 step 上盖一份**(那就真有两份要维护了),
 * 是让这一句只认一张表。
 *
 * 换过来对旧行为的影响:现役消息从「读 step 上那份」变成「读表里那份」,两份内容
 * 逐格相同(同一个 `materializeToolCall` 的确定性产物),所以除了进度那一格,
 * 屏幕上一个像素都不变;脱水形本来就走表,一个字没动。
 */
function callOfStep(
  step: StepLike,
  callById: ReadonlyMap<string, ProjectedToolCall>,
): ProjectedToolCall | undefined {
  const fromTable = step.toolCallId ? callById.get(step.toolCallId) : undefined
  if (fromTable) return fromTable
  return (step.toolCall as ProjectedToolCall | undefined) ?? undefined
}
