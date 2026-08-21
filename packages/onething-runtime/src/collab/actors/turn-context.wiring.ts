/**
 * v3 回合语境的**登记簿**(D6-a 接线)。
 *
 * 一个模块,零 import —— 这是刻意的。它被三方读写,而那三方之间不该有边:
 *
 *  - `engine-mind-port.ts` **登记**:一轮对话性回合开跑时把「这条执行会话此刻
 *    答的是哪间房、持哪张牌」记下来,收尾时销掉;
 *  - `say-tool.ts` **查询**:`send_message` 只拿得到 `sessionId`,而 v3 的房间
 *    要验票 —— 票在这张表里;
 *  - `actors/runtime.ts` **装配**:把真正的 speak 实现(RoomActor 的租约发言口)
 *    注册进来。
 *
 * 为什么不把表直接挂在 runtime 上:say 工具会 import 它,而 runtime import 半个
 * 主进程(引擎、store、看板、计费)。一条 `say-tool → runtime` 的实边等于让
 * 「注册一个内建工具」把整条协作链拉起来 —— D2 已经为同一个形状的边付过一次
 * 代价(工具桶把房间测试整个拖挂)。
 *
 * 表的生命周期与进程一样长,条目的生命周期与一轮回合一样长。`clear` 只给停机与
 * 测试用 —— 生产里靠 `end` 一一对应地销账。
 *
 * ## 第二个口子:入口投递
 *
 * `ingress.ts` 也要投信给 RoomActor,而 ingress 是**引擎静态引用**的(房间入口门
 * 在 `stream-engine.ts` 的第一段)。让它直接 import 运行时就是
 * `stream-engine → ingress → runtime → engine/index → stream-engine` 的环 ——
 * 这个环只在打包形态下现身(D6 之前的 dm-tool 已经为同一个形状付过一次代价)。
 * 于是投递也走端口:同一个零 import 的模块,同一套「装上才生效」。
 */
import type { ChatMessage } from '@shared/ipc.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.actors.turn')


/** 一轮在飞的对话性回合。键是执行会话 id(一条会话同时至多一轮,AgentActor 保证)。 */
export interface CollabV3TurnContext {
  agentId: string
  roomSessionId: string
  execSessionId: string
  /** 手里那张牌。房间验的就是它 —— 没票不许开口。 */
  leaseId: string
  epoch: number
  startedAt: number
}

/** 一次 speak 的请求。形状与 `speakIntoCollabRoom` 的入参对齐,多一个 `leaseId`。 */
export interface CollabV3SpeakInput {
  agentId: string
  roomSessionId: string
  leaseId: string
  content: string
  /** 模型显式点名的 agentId 列表(未经校验;白名单在房间那侧)。 */
  mentions?: string[]
  replyToMessageId?: string
  /** 外部注入:这条消息落库即把目标房链长清零(跨房私聊 / wake poke)。 */
  chainReset?: boolean
}

export interface CollabV3SpeakResult {
  ok: boolean
  /** 拒绝文案。措辞是 C1/C2 资产,原样透传给模型。 */
  error?: string
  messageId?: string
}

export type CollabV3SpeakPort = (input: CollabV3SpeakInput) => Promise<CollabV3SpeakResult>

/**
 * 一条**已经落库**的房间消息进 RoomActor(入口面 / 跨房面)。
 *
 * 与 speak 分成两个口子而不是一个带开关的:speak 要验票、要由房间落库、要回执;
 * 这一条是「库已经落了,房间该知道」——两者的失败语义完全不同(前者拒绝要回给
 * 模型,后者投不出去只是这间房此刻没醒)。
 */
export type CollabV3RoomPostPort = (
  roomSessionId: string,
  message: ChatMessage,
) => void | Promise<void>

/**
 * 「把这间房的 v3 账整个换成新的」——清空聊天记录的 IPC 走到最后调它。
 *
 * 同样是端口而不是 import:`coordinator.ts` 直接引运行时会把 providers / 计费 /
 * 引擎整条 import 图拉进它的测试环境(实测当场把 19 个 v2 测试文件的 mock 打穿)。
 * 一个零 import 的模块夹在中间,两侧谁都不必认识谁。
 */
export type CollabV3RoomResetPort = (roomSessionId: string) => Promise<boolean>

/**
 * 登记簿动了一下(D8 观测体系 §3.2)。
 *
 * 这张表是「持牌等大脑」与「生成中」唯一的分界线,而在 D8 之前它是**零广播**的:
 * 一轮回合起跑或收尾,房间快照里的 `executing`、agent 快照里的 `mind` 同时翻面,
 * 却没有任何人被告知 —— 于是状态条上那个「持牌 N · 生成中 M」的 M 是个死数字,
 * 要等下一次别的什么事顺带播一遍才会动。
 *
 * 仍然是端口而不是 import:这个模块的零 import 是它能同时被 say 工具与引擎引用的
 * 全部理由(见文件头),为一次观测破例就是把那条论证作废。
 */
export type CollabV3TurnObserver = (
  turn: CollabV3TurnContext,
  phase: 'begin' | 'end',
) => void

let speakPort: CollabV3SpeakPort | null = null
let roomPostPort: CollabV3RoomPostPort | null = null
let roomResetPort: CollabV3RoomResetPort | null = null
let turnObserver: CollabV3TurnObserver | null = null
const turns = new Map<string, CollabV3TurnContext>()

/** 装上(或以 null 摘下)真正的发言口。摘下之后 say 工具整条回落 v2 落库路径。 */
export function configureCollabV3SpeakPort(port: CollabV3SpeakPort | null): void {
  speakPort = port
}

export function collabV3SpeakPort(): CollabV3SpeakPort | null {
  return speakPort
}

export function configureCollabV3RoomPostPort(port: CollabV3RoomPostPort | null): void {
  roomPostPort = port
}

export function collabV3RoomPostPort(): CollabV3RoomPostPort | null {
  return roomPostPort
}

export function configureCollabV3RoomResetPort(port: CollabV3RoomResetPort | null): void {
  roomResetPort = port
}

/** 清这间房的 v3 账。运行时没起就是空操作(返回 false)。 */
export async function resetCollabV3RoomAccount(roomSessionId: string): Promise<boolean> {
  const port = roomResetPort
  if (!port) return false
  return port(roomSessionId)
}

/**
 * v3 在跑吗。
 *
 * 判据是**投递口装没装上**,不是另立一个布尔:两个口子由同一次装配装上、同一次
 * 收摊摘下,再加一个标志位就是第三份同一件事的账。
 */
export function isCollabV3Wired(): boolean {
  return roomPostPort !== null
}

/** 装上(或以 null 摘下)登记簿的观测口。摘下之后起落两端都不再通知任何人。 */
export function configureCollabV3TurnObserver(observer: CollabV3TurnObserver | null): void {
  turnObserver = observer
}

/** 通知观测口。**全程吞错** —— 观测不能变成第二个故障源(与死信钩子同一条)。 */
function notifyTurnObserver(turn: CollabV3TurnContext, phase: 'begin' | 'end'): void {
  try {
    turnObserver?.(turn, phase)
  } catch (error) {
    log.warn('turn observer hook failed', { phase }, error)
  }
}

/** 记一轮。同一条会话重复登记按后来者算 —— 前一轮已经不在了。 */
export function beginCollabV3Turn(context: CollabV3TurnContext): void {
  turns.set(context.execSessionId, context)
  notifyTurnObserver(context, 'begin')
}

/**
 * 销一轮。**按 leaseId 核对**:一条会话上前后两轮的收尾可能乱序到达(前一轮
 * 超时放弃等待、后一轮已经起跑),按 id 销账会把还活着的那一轮的票撕掉。
 */
export function endCollabV3Turn(execSessionId: string, leaseId?: string): void {
  const current = turns.get(execSessionId)
  if (!current) return
  if (leaseId && current.leaseId !== leaseId) return
  turns.delete(execSessionId)
  notifyTurnObserver(current, 'end')
}

/** 这条执行会话此刻在跑的那一轮(没有就是 undefined)。 */
export function findCollabV3Turn(execSessionId: string): CollabV3TurnContext | undefined {
  return turns.get(execSessionId)
}

/** 这间房此刻在飞的全部回合 —— 喊停要按住的就是它们。 */
export function collabV3TurnsInRoom(roomSessionId: string): CollabV3TurnContext[] {
  return [...turns.values()].filter(turn => turn.roomSessionId === roomSessionId)
}

/**
 * 这位同事此刻在飞的回合 —— agent 快照的 `mind` 与 `executing` 读它(D8 §3.1)。
 *
 * 「一个大脑」保证了它至多有一条,但这里仍然返回数组:那条不变式由 AgentActor
 * 的 `settle()` 实现,而一个**观测**函数不该建立在被观测者的正确性之上 —— 真要
 * 有第二条,快照该把它画出来,而不是悄悄丢掉一条。
 */
export function collabV3TurnsOfAgent(agentId: string): CollabV3TurnContext[] {
  return [...turns.values()].filter(turn => turn.agentId === agentId)
}

/** 停机 / 测试收摊。 */
export function clearCollabV3Turns(): void {
  turns.clear()
}

/**
 * 这一次 `send_message` 该走 v3 的租约面吗。
 *
 * 三个条件缺一不可:运行时装上了、这条会话此刻真有一轮在飞、而且这一轮答的**就是**
 * 目标房。第三条是刻意的收窄:显式 `room` 指向别处(跨房私聊注入、工作台往母房
 * 汇报)时手里那张牌管不着那间房,那条路照旧走落库 + 投信,一个字都不改。
 */
export function resolveCollabV3SpeakRoute(input: {
  sessionId: string
  roomSessionId: string
  agentId: string
}): { speak: CollabV3SpeakPort; leaseId: string } | undefined {
  const port = speakPort
  if (!port) return undefined
  const turn = turns.get(input.sessionId)
  if (!turn) return undefined
  if (turn.roomSessionId !== input.roomSessionId) return undefined
  if (turn.agentId !== input.agentId) return undefined
  return { speak: port, leaseId: turn.leaseId }
}
