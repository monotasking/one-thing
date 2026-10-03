/**
 * 说话即行动 — the say tool's pure half (W14b,
 * docs/design/multi-agent-collab-im.md §4.5「核心转变:思考与发言分离」).
 *
 * 用户原话:"agent 应该具有发消息的能力,而不是调用大模型直接返回结果的能力
 * ——那是他的思考过程,不是他要说的话。"
 *
 * So a room turn is no longer speech. The LLM turn is THINKING; speech is an
 * explicit action (a `say` tool call), and the room transcript grows two kinds
 * of assistant message that this module tells apart:
 *
 *  - `COLLAB_SAY_SOURCE`  — a real utterance, written by the say executor.
 *  - `COLLAB_TURN_SOURCE` — the turn's own host message (thinking text + board
 *    calls). Stamped at the store choke point when the engine creates it, so
 *    the marker exists from birth (a crash mid-turn can never leave a thinking
 *    record looking like speech, and the room UI never flashes a full bubble
 *    that collapses a tick later).
 *
 * Three epochs coexist, and the rule is a MARKER, never a migration:
 *
 *  | message                          | 投影/意愿窗口 | 链长 | 房间渲染      |
 *  | say (COLLAB_SAY_SOURCE)          | ✓ 进         | 计   | 正常气泡      |
 *  | thinking (COLLAB_TURN_SOURCE)    | ✗ 排除       | 不计 | 折叠痕迹行    |
 *  | 旧转录 (neither marker)          | ✓ 进         | 计   | 正常气泡      |
 *
 * A transcript written before W14b carries neither marker and keeps behaving
 * exactly as it did — the stream WAS the speech back then, and rewriting
 * history to say otherwise would be a lie about what the room showed.
 */
import { sanitizeCollabInlineMarkup } from './inline-tags.js'
import { parseCollabHandleMentions, type CollabAddressable } from './handles.js'
import { buildCollabMentions, mergeCollabMentions, normalizeCollabMentions } from './mentions.js'
import { truncateAtCodePoint } from './truncate.js'
import { resolveCollabVenue } from './tool-surface.js'
import type { CollabAgentLike, CollabMentionLike } from './types.js'

/**
 * The say/thinking markers and their predicates live in `classify.ts` since R3
 * — one place reads a marker off `source`/`origin.source`, and one place gains
 * a new arm when a seventh kind appears. Re-exported so every import site here
 * and in the app layer keeps working unchanged.
 */
export {
  COLLAB_SAY_SOURCE,
  COLLAB_TURN_SOURCE,
  isCollabSayMessage,
  isCollabThinkingMessage,
} from './classify.js'

/** Longest utterance a single say call may carry. Beyond this it is not a chat
 *  message any more — the board (task description / report) is where long-form
 *  content belongs. */
export const COLLAB_SAY_MAX_CHARS = 4000


/**
 * The trace row's label (§3.6 痕迹级): one line of 11px muted ink. The step
 * count is the tool calls the turn made — the only part of a thinking record
 * that is worth advertising before it is unfolded.
 */
export function formatCollabThinkingTraceLabel(stepCount: number): string {
  const steps = Number.isFinite(stepCount) && stepCount > 0 ? Math.floor(stepCount) : 0
  return steps > 0 ? `思考过程 · ${steps} 步` : '思考过程'
}

/**
 * Why a say call did not deliver. These are the FIRST真实送达失败语义 the room
 * has ever had (§4.5 消息送达态): the gates used to swallow an activation
 * before the agent ever ran, so nobody was there to be told. Now the agent
 * itself is holding the phone when the call fails, and the wording says so
 * plainly — 未送达, not "error".
 */
export const COLLAB_SAY_REFUSED_NO_ROOM =
  'send_message 只能在群聊里(或群聊派生的工作会话里)使用——这个会话没有关联的群聊,没有人会收到消息。'
export const COLLAB_SAY_REFUSED_FROZEN =
  '消息未送达:这个群聊已被暂停(总闸),现在没有人能收到消息。等群聊恢复后再说。'
export const COLLAB_SAY_REFUSED_BUDGET =
  '消息未送达:这个群聊今天的预算已经用完,消息发不出去。明天自动恢复,或者由用户调整房间预算。'
export const COLLAB_SAY_REFUSED_EMPTY =
  '没发出去:content 是空的,没有内容可发。'
export const COLLAB_SAY_REFUSED_NOT_MEMBER =
  '消息未送达:你已经不在这个群聊的成员名单里了。'

/**
 * W18: the `room` parameter named something that is not a room this agent can
 * speak into. Distinct from NO_ROOM, which means the session has no room at
 * all — here the caller aimed and missed, and the fix is a different id.
 */
export const COLLAB_SAY_REFUSED_UNKNOWN_ROOM =
  '消息未送达:room 参数指向的不是一个群聊(或者你不在那个群里)。不带 room 就是发到你当前这一轮的群里。'

/* ── 统一发送面:channel 与 wake(collab-send-channel-and-wake.md §2) ── */

/**
 * 发送面的三档。`send_message` 与 `dm` 合并成一个带 channel 的工具之后,
 * 「发给这间房」与「发给某个人」是同一个动作的两个方向(设计 §2.1)。
 *
 * `gateway`(远程投递:微信/Telegram)本期只占坑 —— channel 显式存在而不是纯
 * 推断,正是为了它:届时收件人同样是一个 `to` 字符串,「有 to = dm」的推断会
 * 失效,而那时改的是这张表,不是工具契约。
 */
export type CollabSendChannel = 'room' | 'dm' | 'gateway'

/**
 * 观察器与执行器共用的结构视图 —— 只读这一次调用「往哪儿发」需要的四个字段。
 * 索引签名是刻意的:传进来的是**整份** tool args(`content`/`mentions`/…),
 * 这个类型只是从中挑出路由要看的那几个,不是它的全集。
 */
export interface CollabSendArgsLike {
  channel?: unknown
  to?: unknown
  room?: unknown
  wake?: unknown
  [key: string]: unknown
}

export const COLLAB_SEND_REFUSED_ROOM_WITH_TO =
  'to 是私聊的参数 —— 发给某个人就不要指定 channel:"room";要发进群里就别写 to。'
export const COLLAB_SEND_REFUSED_DM_NO_TARGET =
  '要发给谁?to 填花名册里的写法「名字#句柄」,发给用户本人就写「用户」。'
export const COLLAB_SEND_REFUSED_GATEWAY =
  '远程投递(微信/Telegram)还没接入,channel:"gateway" 现在发不出去。'
export const COLLAB_SEND_REFUSED_UNKNOWN_CHANNEL =
  'channel 只有 "room"(发进群聊)和 "dm"(发给某个人)两种写法。'
export const COLLAB_SEND_REFUSED_WAKE_WITHOUT_TARGET =
  'wake 是私聊的参数 —— 它的意思是「TA 读完这条私聊后,我到群里 @ TA 一声」。这一发没有 to,没有人需要被唤醒。'

function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 这次调用**打算**发去哪一档?——宽松推断,不做任何校验。
 *
 * 缺省按参数推断:有 `to` 就是私聊档,否则是房间档(设计 §2.1)。显式 channel
 * 优先,认不出的写法返回 null(校验版把它变成一句可操作的拒绝;观察器把它
 * 当作"看不出来",按房间档处理 —— 打字灯宁可多亮一次也不该少亮)。
 */
export function resolveCollabSendChannelFromArgs(
  args: CollabSendArgsLike | null | undefined,
): CollabSendChannel | null {
  const declared = trimmedText(args?.channel)
  if (declared) {
    if (declared === 'room' || declared === 'dm' || declared === 'gateway') return declared
    return null
  }
  return trimmedText(args?.to) ? 'dm' : 'room'
}

/**
 * 校验版:发送执行器用的那一个。矛盾即拒绝(设计 §2.3),措辞可操作。
 *
 * 只判"这次调用走哪条链路",不碰房间/成员/冻结 —— 那些门在执行器里,而且
 * 它们各自的拒绝文案是资产,合并时一个字都不动。
 */
export function resolveCollabSendChannel(
  args: CollabSendArgsLike | null | undefined,
): { ok: true; channel: CollabSendChannel } | { ok: false; error: string } {
  const channel = resolveCollabSendChannelFromArgs(args)
  if (!channel) return { ok: false, error: COLLAB_SEND_REFUSED_UNKNOWN_CHANNEL }
  const to = trimmedText(args?.to)
  if (channel === 'room' && to) return { ok: false, error: COLLAB_SEND_REFUSED_ROOM_WITH_TO }
  if (channel === 'dm' && !to) return { ok: false, error: COLLAB_SEND_REFUSED_DM_NO_TARGET }
  // wake 是私聊档的参数。房间档带 wake **必须**拒绝而不是静默忽略:它请求的是
  // 一个不会发生的唤醒,而发起方会当它已经安排好了(设计 §2.3 的同一条纪律 ——
  // 调用时说清楚,别让失败在几分钟后以"什么都没发生"的形式出现)。
  if (channel !== 'dm' && args?.wake === true) {
    return { ok: false, error: COLLAB_SEND_REFUSED_WAKE_WITHOUT_TARGET }
  }
  return { ok: true, channel }
}

/** 私聊档的调用吗?(断路器按这一条对齐现 `dm` 的计数口径 —— 见 circuit-breaker.ts。) */
export function isCollabSendDmCall(args: CollabSendArgsLike | null | undefined): boolean {
  return resolveCollabSendChannelFromArgs(args) === 'dm'
}

/**
 * 这次调用是**发进当前这间房**的吗?(打字灯的判据,设计 §4。)
 *
 * 合并之后 dm 档也顶着 `send_message` 这个名字,而打字灯挂在"这一轮在答的那间
 * 房"上:私聊档、以及显式指向别的房的调用,都不该让这间房亮灯。
 */
export function isCollabSendIntoRoom(
  args: CollabSendArgsLike | null | undefined,
  roomSessionId: string | undefined,
): boolean {
  if (resolveCollabSendChannelFromArgs(args) !== 'room') return false
  const room = trimmedText(args?.room)
  if (!room) return true
  return !roomSessionId || room === roomSessionId
}

/* ── wake:私聊送达后到群里 @ 一声(设计 §3) ─────────────────────── */

export const COLLAB_WAKE_REFUSED_USER_TARGET =
  '用户没有可唤醒的执行会话 —— TA 收到通知就会看到,不用 wake。'
export const COLLAB_WAKE_REFUSED_NO_ROOM =
  '不知道该到哪个群唤醒 TA:这一轮没有关联的群。要么去掉 wake,要么用 wakeRoom 指定一个群。'

/** 收件人不在那个群里 —— 唤醒是"到群里 @ TA",TA 不在场就没有可 @ 的人。 */
export function formatCollabWakeRefusedTargetNotMember(peerName: string): string {
  return `${peerName} 不在那个群里,唤醒不了 —— 唤醒是到群里 @ TA 一声,而 TA 得先在那个群。`
}

/** 发起人不在那个群里 —— poke 由发起人署名落群,说话的门就是这道门(设计 §2.3)。 */
export const COLLAB_WAKE_REFUSED_SELF_NOT_MEMBER =
  '你不在那个群里:唤醒的那一声是以你的名义说的,得先是那个群的成员。'

/**
 * poke 文案 —— **固定模板,不可自定义**(设计 §3.4)。
 *
 * 开放文案等于开了「用 wake 在群里代言」的口子,与「内容永不跨房」这条铁律
 * 打架:要说的话应该写在私聊正文里,或者作为普通消息发到群里。
 */
export function formatCollabWakePoke(mention: string): string {
  return `@${mention} 我在私聊里给你发了消息 —— 看完后请回到这里回应。`
}

/**
 * 私聊档的成功回执(agent-dm-user.md §3.2 + 本设计 §3.5)。
 *
 * 发给人的那一版必须说清「TA 不一定在线」,否则 agent 会发完就停轮空等回复;
 * 带 wake 时追加一句 —— 发起方据此知道"我不用再嘱咐 TA 回群里"。
 */
export function formatCollabDmReceipt(input: {
  targetKind: 'user' | 'agent'
  peerName: string
  /** 带 wake 时,poke 会落在哪个群(房名,不是 id)。 */
  wakeRoomName?: string
}): string {
  if (input.targetKind === 'user') {
    return `已发给 ${input.peerName};TA 不一定在线,看到后会在你们的私聊里回复——不用等,先继续手头的事。`
  }
  const base = `已发给 ${input.peerName};TA 会在你们的私聊里回复,用户也看得见。`
  return input.wakeRoomName
    ? `${base}TA 读完后,我会在「${input.wakeRoomName}」替你 @ TA 一声。`
    : base
}

/**
 * Which room does this `say` land in? (W18 §4.6「say(room)」)
 *
 * Three sources, in order, and each says something different:
 *
 *  1. `requestedRoomSessionId` — the agent aimed explicitly. Kept as the first
 *     priority because it is the door multi-room activation walks through later
 *     (today an agent is driven for one room at a time, so it is rarely used —
 *     but a turn that names its target must never be second-guessed).
 *  2. `linkedRoomSessionId` — the room this session is currently bound to: the
 *     target room the drive pointed the AGENT EXECUTION session at, or the
 *     parent room of a WORK session. This is the everyday path.
 *  3. the session itself, when it IS a room — pre-W18 shape, where the turn ran
 *     inside the room. Kept so an old-style drive still speaks.
 *
 * Returns null when there is no room to speak into at all.
 */
export function resolveCollabSayRoomSessionId(options: {
  kind?: string
  sessionId: string
  requestedRoomSessionId?: string
  linkedRoomSessionId?: string
}): string | null {
  const requested = options.requestedRoomSessionId?.trim()
  if (requested) return requested
  const linked = options.linkedRoomSessionId?.trim()
  if (linked) return linked
  // kind → 场子走统一归一化(C3-6):这里曾是同一句 kind 判断的第五份手写。
  // `resolveCollabVenue('room') === 'room'`,所以这是逐字等价的替换。
  if (resolveCollabVenue(options.kind) === 'room' && options.sessionId) return options.sessionId
  return null
}

/** Success line handed back to the caller — it names the id so a follow-up send
 *  can quote it with replyTo.
 *
 *  中性措辞:同一个执行器既发群也发私聊,而「已发进群里」在私聊房是句假话
 *  (一致性审计 P2-8)。 */
export function formatCollabSayReceipt(messageId: string): string {
  return `已发出(消息 id: ${messageId})。可以再发一条,或者就此打住。`
}

/**
 * The tool a room turn sends through — the name persisted tool calls carry.
 *
 * 2026-08-02 由 `say` 改名为 `send_message`
 * (docs/design/collab-turn-protocol-and-identity.md A)。这个常量是**工具名**,
 * 与落盘的 `COLLAB_SAY_SOURCE`('collab-say')无关 —— 后者是持久化约定,不动。
 *
 * 打字信号观察器(`typing.ts`)与断路器(`circuit-breaker.ts`)**不**直接比这个
 * 常量,走 `isCollabSendCall`:事件流里带的是模型吐出来的原始名,而模型仍会照着
 * 旧转录吐 `say`。只认现名,那一次调用就发得出消息、却点不亮灯也不进计数
 * (架构审查 B7 抓到的正是这个)。
 */
export const COLLAB_SEND_MESSAGE_TOOL_NAME = 'send_message'

/**
 * 旧工具名,**静默别名**用(A.3)。
 *
 * 执行会话的历史里全是 `say` 调用范例,模型会照着模仿;provider 是生成器,
 * 声明与否都可能吐旧名。别名把旧名路由到同一个执行器,于是模仿旧历史的调用
 * 照常送达,不产生「unknown tool」的教育成本。它**不进** COLLAB_ROOM_TOOLS、
 * 不出现在请求的 tools 参数里、不出现在任何提示词里 —— 灰度期过后整条拆除。
 */
export const COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME = 'say'

/**
 * 另一个退役名:`dm`(collab-send-channel-and-wake.md §5 R1)。
 *
 * 2026-08-02 起 `dm` 不再是一个工具 —— 发送面只有 `send_message` 一个,连隐藏的
 * 第二个都不留。旧转录里的 `dm` 调用范例照样会被模仿出来,所以它和 `say` 一样
 * 进退役名表。
 *
 * 与 `say` 的差别是**参数不同形**(`{to, message}` vs `{to, content}`),所以这
 * 不是无缝转发,是一次**刻意接受的降级**:`to` 是合并面的正式参数、活着进来,
 * `message` 被 zod strip 掉 → `content` 缺席 → 校验层逐字回一句
 * `COLLAB_SAY_REFUSED_EMPTY`(见 `tools/builtin/say.ts` 的 formatValidationError)。
 * 代价是一轮重试,消息不丢,零额外机械件 —— 名字级转发本来会让 `message` 被静默
 * 吞掉(edit replaceAll 事故同款陷阱),这句拒绝就是不让它静默。
 *
 * 拆除条件与 `say` 相同:改名前的会话历史被摘要压掉、或危险区清空拿到干净基线。
 */
export const COLLAB_DM_LEGACY_TOOL_NAME = 'dm'

/**
 * 退役名的全集。**这是登记处**:`app/collab/say-tool.ts` 把这些名字喂进 core 的
 * 退役表(派发用),观察器则直接读这张表(识别用)。加第四个名字时改这里一处。
 */
export const COLLAB_SEND_RETIRED_TOOL_NAMES: readonly string[] = [
  COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
  COLLAB_DM_LEGACY_TOOL_NAME,
]

/**
 * 这次调用是一次「发消息」吗?—— 现名 + 退役名归一后的判据(架构审查 B7)。
 *
 * 观察器(打字灯 `typing.ts`、断路器 `circuit-breaker.ts`)此前**严格等于**
 * `send_message`。而事件流里带的是**模型吐出来的原始工具名**:派发那一头有退役
 * 表兜底(runner 的 toolMap miss → `resolveRetiredAgentToolName`),所以一次
 * `say` 调用照样执行、照样把消息发出去 —— 但对观察器来说它根本不是发言。真机
 * 症状因此是"消息发出来了,打字灯没亮过,断路器也没数它"。
 *
 * **为什么不查 core 的退役表**:那张表是**运行期登记**的(`say-tool.ts` 装配时
 * 才写入),而这几个文件是纯层 —— 一个不启动装配层的单测里表是空的,判据会随
 * 启动顺序变结果。名字这一层的事实(哪些名字曾经是发送面)本来就住在这个文件
 * 里,查常量是同一个事实的更早、更稳的形态。core 那张表管的是**派发**,这里管
 * 的是**识别**,两者由同一组常量喂养,不会各自漂移。
 */
export function isCollabSendCall(toolName: string | undefined | null): boolean {
  if (!toolName) return false
  return toolName === COLLAB_SEND_MESSAGE_TOOL_NAME
    || COLLAB_SEND_RETIRED_TOOL_NAMES.includes(toolName)
}

/**
 * 沉默 = 什么都不调 (2026-07-30) — why there is no `stay_silent`, and no forced
 * opening call either.
 *
 * W18b gave the room turn a second tool so that a FORCED opening call would
 * still leave silence reachable ("required" + a do-nothing tool). It backfired
 * within hours: 真机 counted 77 `stay_silent` calls across four turns of one
 * agent. The tool's result told the turn to stop, the model would not end a
 * round with an empty response, so it called the only inert tool it had —
 * again, and again, each round a full-context request, until the wall clock
 * cut it off. W22 then kept the forcing and dropped the tool, naming `say` as
 * the opening call ("判定即承诺":判定层已经决定要发言,开口即 say).
 *
 * That trade is now reversed: the forcing itself is gone (`app/collab/turn.ts`).
 * 判定即承诺 asked the judgement layer to be right about EVERY activation, and
 * @ 和任务事件从来不经过判定——一个被点名却确实没自己的事的 agent 只剩一条
 * 出路:调 say 说一句「我这轮不说了」。真机里这就是它做的。废话消息比空转回合
 * 贵:群里所有人都要读它。
 *
 * 现在两头都空着,而这恰好是安全的形状:沉默不是一个工具、不是一个参数,而是
 * "什么都不调"——没有惰性工具可以循环,也没有必须开口的义务。
 *
 * 曾经还有第三个机制:W14d 补救 nudge(写了正文没调 say → 同一激活内引用那段
 * 未发正文再驱一轮)。2026-07-30 拆除:真机上它把一个想 pass 却把 pass 写成
 * 旁白的回合重新推上发言台,模型在补救轮里误以为已送达的上一条消息没发出去,
 * 又 say 了一遍,群里出现重复消息。"写了完整回复却忘调 say"从此不再有结构
 * 补救,只靠 drive 尾行陈述通道规则;沉默与失手在收尾处不再区分。
 */

/** Structural view of a persisted tool call (circuit breaker / typing signal).
 *  Real transcripts carry `toolName`/`toolId`; `name` is the flattened shape
 *  the projection uses. */
export interface CollabTurnToolCallLike {
  name?: string
  toolName?: string
  toolId?: string
}

/**
 * Resolve the say call's `mentions` into the W14a record shape.
 *
 * THREE sources now, in descending precision (collab-agent-handle.md §2.4):
 *
 *  1. the explicit ids the tool call carried — whitelisted against the room
 *     roster (an agent does not get to address a member of another room, or a
 *     made-up id) and re-labelled from the roster, exactly like the ingress
 *     gate does for a human's picker (防冒名: the caller never names anyone).
 *  2. `@名字#句柄` in the prose — the handle IS an id, so this is as exact as
 *     (1) while being something the agent can actually write: the roster is
 *     where it learns the handle, and it has no picker.
 *  3. bare `@名字` — the name-scan fallback W14a keeps, so an agent that just
 *     writes 「@小李 你看一下」 still addresses a real member (and, when two
 *     members share the name, honestly addresses both).
 *
 * Per-label authority (mergeCollabMentions) chains down the list: a label an
 * explicit id claimed is not re-scanned, and a label a HANDLE claimed is not
 * re-scanned by name either — which is exactly what stops `@小李#c0ffee11`
 * from also waking the OTHER 小李 that the bare name-scan would match at the
 * very same position.
 */
export function resolveCollabSayMentions(options: {
  content: string
  mentionAgentIds?: unknown
  /** 授权面:能被点名激活的人(房内在职成员)。显式 id 参数按它校验。 */
  members: readonly CollabAgentLike[]
  /**
   * 识别面:哪串字符算一个真身份(用户、退休成员、非本房 agent 都在内)。
   * 缺省退回 `members` —— 老调用点与纯 agent 测试因此不用改一个字,而新的
   * 接线点传完整目录(collab-handle-codec.md §2.1:识别与授权分家)。
   */
  directory?: readonly CollabAddressable[]
}): CollabMentionLike[] {
  const ids = Array.isArray(options.mentionAgentIds) ? options.mentionAgentIds : []
  const explicit = normalizeCollabMentions(
    ids.map(id => ({ agentId: typeof id === 'string' ? id : '', label: '' })),
    { members: options.members },
  )
  const handled = parseCollabHandleMentions(options.content, options.directory ?? options.members)
  const parsed = buildCollabMentions(options.content, options.members)
  return mergeCollabMentions(mergeCollabMentions(explicit, handled), parsed)
}

/**
 * Normalize the utterance itself. Returns null when there is nothing to say —
 * an empty message must fail loudly at the tool boundary rather than land in
 * the room as a blank bubble.
 *
 * 转义在截断之后(collab-team-v2 §6.1 防线一)。顺序是刻意的:先截断,被拦腰
 * 砍断的那半个标签就走不出白名单校验,于是作为字面文本被转义掉;反过来先转义
 * 再截断,砍点可能落在 `&lt;` 中间,留下一个半截实体。转义可以把内容撑过
 * COLLAB_SAY_MAX_CHARS —— 上限管的是模型说了多少话,不是编码后有多少字节。
 */
export function normalizeCollabSayContent(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  return sanitizeCollabInlineMarkup(truncateAtCodePoint(text, COLLAB_SAY_MAX_CHARS))
}
