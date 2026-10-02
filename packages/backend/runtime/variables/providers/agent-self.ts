import type { ContextVariable, VariableContext, VariableProvider } from '../types.js'

const CARDS = 'my_cards'
const ROOMS = 'my_rooms'
const DMS = 'my_dms'

/** 本 provider 产出的全部变量名 —— RESERVED_NAMES 与 claims() 共用一份。 */
export const AGENT_SELF_VARIABLE_NAMES = [CARDS, ROOMS, DMS] as const

/** 看板上"还在飞"的两种状态(done/review/backlog 是历史,不是当前状况)。 */
export type AgentSelfCardStatus = 'doing' | 'blocked'

export interface AgentSelfCardFact {
  /** 卡的完整 id;渲染时截成 `#a1b2c3d4`,与看板/房间里的写法一致。 */
  id: string
  title: string
  status: AgentSelfCardStatus
}

/** 一个场子(群房或私聊)在这个 agent 的在场面上留下的痕迹。 */
export interface AgentSelfChatFact {
  /** 群房是房名;私聊是对面那个人。 */
  name: string
  /** 最近一次活动的时间戳;渲染成天粒度,缺省就只写名字。 */
  lastActiveAt?: number
}

export interface AgentSelfStateFacts {
  cards: readonly AgentSelfCardFact[]
  rooms: readonly AgentSelfChatFact[]
  dms: readonly AgentSelfChatFact[]
}

export interface AgentSelfStateGateway {
  /**
   * 当前会话绑定的 agent 此刻的自我状态。会话没绑 agent(或宿主没有协作子
   * 系统)就返回 null —— 三个变量一个都不产出。
   */
  read(sessionId: string): AgentSelfStateFacts | null
}

/** 与房间/看板里的短 id 同一写法(`#a1b2c3d4`),模型照抄即可指认同一张卡。 */
const SHORT_ID_CHARS = 8

const MAX_TITLE_CHARS = 32

function shortenTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS)}…` : flat
}

function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * ⚠️ 天粒度,故意的 —— 照 datetime provider 的做法。
 *
 * `<context-update>` 的去重判定是逐字相等,值里放"3 分钟前"这类每 tick 都变的数字,
 * 每回合都会注入一块新的 `<context-update>`(background-jobs / music-radio
 * 两个 provider 的注释都为这条栽过跟头)。天粒度让同一天里的连续回合字节相同,
 * 一天最多翻一次。
 */
export function formatCoarseAge(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return '30 天以上没动静'
}

function describeChat(fact: AgentSelfChatFact, now: number): string {
  const age = fact.lastActiveAt === undefined ? '' : formatCoarseAge(fact.lastActiveAt, now)
  return age ? `「${fact.name}」${age}` : `「${fact.name}」`
}

function byName(a: AgentSelfChatFact, b: AgentSelfChatFact): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

export interface AgentSelfProviderOptions {
  now?: () => number
}

/**
 * agent 自我状态的**事实层**(docs/design/agent-self-state-variables.md §4.1)。
 *
 * 三个只读变量,每回合现算,一个字节都不落库 —— 数据源是会话索引推出来的在场面
 * 与各房看板,与「在场面永不落库」那条铁律同源(agents/presence.ts)。
 *
 * 这一层取代了此前 roster.ts 里手写的 `<your_cards>` 段:一处产出、`<context-update>`
 * 通道自动受益,而且用户在 Context 面板里也看得见 —— `<your_cards>` 从头到尾
 * 只有模型看得见。
 *
 * `state: true`,而且不受任何预算约束(§R.5):`<your_cards>` 当初存在的全部理由
 * 就是"房间侧 agent 对自己的任务零感知,被 @ 时只能凭想象作答";一个可被截断的
 * 状态层等于给那个事故留了后门。
 *
 * 没有数据的那一个变量**不产出**(不是产出空值):一块空板子不值一行 prompt,
 * 这也是 background-jobs / goal 一路的既有做法。
 */
export class AgentSelfProvider implements VariableProvider {
  readonly id = 'agent-self'
  readonly priority = 24

  private readonly now: () => number

  constructor(
    private readonly gateway: AgentSelfStateGateway,
    options: AgentSelfProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  list(ctx: VariableContext): ContextVariable[] {
    const facts = this.gateway.read(ctx.sessionId)
    if (!facts) return []
    const now = this.now()
    const variables: ContextVariable[] = []

    if (facts.cards.length > 0) {
      // 按 id 排序而不是按看板顺序:同一组卡必须永远渲染成同样的字节,否则
      // 看板一挪动就白白重发一块 `<context-update>`。
      const cards = [...facts.cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      variables.push({
        name: CARDS,
        value: cards
          .map(card => `#${card.id.slice(0, SHORT_ID_CHARS)}「${shortenTitle(card.title)}」${card.status}`)
          .join('; '),
        readonly: true,
        state: true,
        // 第一人称写在 description 里(W10 的教训:一个状态词会让模型用第三
        // 人称转述自己的卡)。逐卡重复这句话太贵,所以只说一次,而它对整组生效。
        description: 'Cards on the board assigned to you and still in flight — you are the one executing them, each in a work session of its own. The board is the authority on where they stand.',
      })
    }

    if (facts.rooms.length > 0) {
      variables.push({
        name: ROOMS,
        value: [...facts.rooms].sort(byName).map(room => describeChat(room, now)).join('; '),
        readonly: true,
        state: true,
        description: 'Rooms you are a member of, each with when it last saw activity (day granularity).',
      })
    }

    if (facts.dms.length > 0) {
      variables.push({
        name: DMS,
        value: [...facts.dms].sort(byName).map(dm => describeChat(dm, now)).join('; '),
        readonly: true,
        state: true,
        description: 'One-on-one chats you have open, each with when it last saw activity (day granularity).',
      })
    }

    return variables
  }

  claims(name: string): boolean {
    return (AGENT_SELF_VARIABLE_NAMES as readonly string[]).includes(name)
  }
}
