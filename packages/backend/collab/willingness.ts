/**
 * Response willingness — docs/design/multi-agent-collab-im.md §2.
 *
 * The IM turn: there is no "default responder" any more. After every real
 * message each member decides FOR ITSELF whether it wants to speak, via one
 * cheap small-context call. This module is the pure half (prompt shape +
 * reply parser); the app layer runs the calls and queues the volunteers
 * (app/collab/willingness-runner.ts).
 *
 * Prompt discipline is the same red line as the room turn (roster.ts): the
 * persona is used VERBATIM, and the only things added to the system message
 * are FACTS — the existing room note, plus (PM only) one line stating it is
 * the room's lead. The JSON instruction lives in the USER message, where it
 * is the task at hand rather than a behavioral rule grafted onto a persona.
 */
import { isCollabProjectedRoomMessage } from './cooldown.js'
import { truncateAtCodePoint } from './truncate.js'
import { renderCollabModelMention } from './handles.js'
import { renderCollabMentionText } from './mentions.js'
import { formatCollabReplyQuote } from './projection.js'
import {
  COLLAB_REACTION_EMOJIS,
  appendCollabReactionSummary,
  normalizeCollabReactionEmoji,
  type CollabReactionEmoji,
} from './reactions.js'
import {
  buildCollabRoomSystemPrompt,
  resolveCollabSpeakerLabel,
  type BuildCollabRoomContextOptions,
} from './roster.js'
import { formatCollabProjectedSystemLine, isCollabProjectedSystemLine } from './system-lines.js'
import type { CollabAgentLike, CollabMessageLike, CollabSelfTaskFact } from './types.js'

/** How many recent messages the judgement window carries. */
export const COLLAB_WILLINGNESS_RECENT_LIMIT = 8
/** Per-message truncation inside the judgement window (cost engineering). */
export const COLLAB_WILLINGNESS_LINE_LIMIT = 200

/**
 * The one instruction, kept in the user message.
 *
 * `react` is the free half of the turn (§3.5 B): the judgement call is already
 * paid for, so a member that stays quiet can still leave the one gesture real
 * people leave — 没什么好说的但点个赞. It is offered ONLY as the silent path's
 * companion; a member that is about to speak has no use for it.
 */
export const COLLAB_WILLINGNESS_QUESTION =
  'After that last message, will you speak up?\nReply with JSON only: {"respond": true|false, "react": "👍"|null}\n' +
  `If you are not speaking, you may still leave a reaction — one of ${COLLAB_REACTION_EMOJIS.join(' ')}, or null for none.`

/** The single factual line the room lead gets (replaces default-responder). */
export const COLLAB_WILLINGNESS_PM_FACT =
  '<you_are_the_lead>You are this room\'s lead.</you_are_the_lead>'

export interface BuildWillingnessPromptOptions extends BuildCollabRoomContextOptions {
  /** The agent's own persona prompt (its systemPrompt field), used VERBATIM. */
  personaPrompt: string
  /** Room transcript tail; filtered and windowed here. */
  recent: readonly CollabMessageLike[]
  /** Room lead, if any — only affects the agent that IS the lead. */
  pmAgentId?: string
  /**
   * 这个 agent 名下还在飞的卡。判定这一路够不着变量通道,所以由调用方喂进来
   * (见 `formatWillingnessSelfCards` 的注释)。
   */
  selfCards?: readonly CollabSelfTaskFact[]
  /**
   * Names for speakers the room roster no longer holds (P2-16). The app layer
   * passes the global agent lookup; without it a departed member's line falls
   * back to 「前成员」 rather than to a raw id.
   */
  resolveAgentName?: (agentId: string) => string | undefined
}

export interface CollabWillingnessPrompt {
  system: string
  user: string
}


function condense(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > COLLAB_WILLINGNESS_LINE_LIMIT
    ? `${truncateAtCodePoint(flat, COLLAB_WILLINGNESS_LINE_LIMIT)}…`
    : flat
}

/**
 * The judgement window: the same IM projection the room uses (`名字: 内容`),
 * one line per message, drives/pass/unmarked system lines excluded,
 * tail-windowed. Marked collab system lines (task lifecycle, membership) DO
 * enter as「系统: …」— same rule as the room projection (W9.1), because a
 * member deciding whether to speak must see the same facts it would answer
 * with (「任务受阻」is exactly the kind of line that should make the lead talk).
 */
export function buildWillingnessWindow(options: {
  recent: readonly CollabMessageLike[]
  members: readonly CollabAgentLike[]
  userLabel?: string
  limit?: number
  /** Names for speakers the roster no longer holds (P2-16). */
  resolveAgentName?: (agentId: string) => string | undefined
}): string[] {
  const userLabel = options.userLabel ?? '用户'
  const limit = options.limit ?? COLLAB_WILLINGNESS_RECENT_LIMIT
  const lines: string[] = []

  for (const message of options.recent) {
    // Drives, `[pass]`, thinking records (W14b: another member's unspoken
    // deliberation is not part of what the room said) and unmarked system
    // noise are dropped by the shared visibility口径 — the same one W21's
    // speech cooldown counts its window in.
    if (!isCollabProjectedRoomMessage(message)) continue
    if (isCollabProjectedSystemLine(message)) {
      const systemBody = condense(message.content ?? '')
      if (systemBody) lines.push(formatCollabProjectedSystemLine(systemBody))
      continue
    }
    // Same rename resolution the room projection applies (W14a): a member
    // deciding whether to speak must read the very names the room now uses —
    // "@新名字 你看一下" is only a signal if it says the reader's current name.
    const body = condense(renderCollabMentionText(message.content, message.mentions, options.members, {
      renderHit: renderCollabModelMention,
    }))
    if (!body) continue
    const label = message.role === 'user'
      ? userLabel
      : resolveCollabSpeakerLabel(message.agentId, options.members, options.resolveAgentName)
    // A quote rides INSIDE the entry, not as its own array slot: the window is
    // limited by MESSAGES, and a two-slot entry would silently shrink it. The
    // reaction tally rides on the tail of the same entry (§3.5 B) — "群里已经
    // 三个人点了赞" is exactly the signal that says nobody needs to say it again.
    const entry = appendCollabReactionSummary(`${label}: ${body}`, message.reactions)
    const quote = formatCollabReplyQuote(message.replyTo)
    lines.push(quote ? `${quote}\n${entry}` : entry)
  }

  return limit > 0 ? lines.slice(-limit) : lines
}

/**
 * 判定回合的在飞卡片(agent-self-state-variables.md §4.4 的补漏)。
 *
 * 房间回合是通过 `my_cards` 变量拿到这件事的,而判定这一路走的是裸
 * `generateChatResponse` —— 它不碰引擎的提示词装配,**变量的两条通道一格都到
 * 不了**。§4.4 删 `taskFacts` 时漏了这条链,代价是「任务受阻」这类最该让人开口
 * 的事实,恰好在决定要不要开口的那一刻看不见 —— 而这个文件自己的口径写着:
 * 判定必须看见它作答时会看见的同一批事实。
 *
 * 形状与 `my_cards` 变量逐字同源(短 id + 标题 + 状态):两处分家,同一张卡在
 * 两拍里就成了两件事。
 */
export function formatWillingnessSelfCards(
  cards: readonly CollabSelfTaskFact[],
): string {
  if (cards.length === 0) return ''
  // 按 id 排序,与变量那侧同一条纪律:同一组卡永远渲染成同样的字节。
  const ordered = [...cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const items = ordered
    .map(card => `#${card.id.slice(0, 8)}「${card.title}」${card.status}`)
    .join('; ')
  return `<your_cards>${items}</your_cards>`
}

/**
 * The whole judgement prompt. system = persona verbatim + the factual room
 * note (+ the lead fact for the PM, + the in-flight cards); user = the window
 * + the JSON question.
 */
export function buildWillingnessPrompt(
  options: BuildWillingnessPromptOptions,
): CollabWillingnessPrompt {
  const roomSystem = buildCollabRoomSystemPrompt({
    self: options.self,
    members: options.members,
    roomName: options.roomName,
    userLabel: options.userLabel,
    userHandle: options.userHandle,
    personaPrompt: options.personaPrompt,
    // 房形态跟着调用方走(D.1):pair 房用群版世界观会把用户说成"群成员",
    // 于是判定是站在一个错误的场子里回答"要不要开口"。
    ...(options.dm ? { dm: true } : {}),
    ...(options.dmPair ? { dmPair: true } : {}),
    // 薄档:这一路是裸 generate,零工具、不读看板、不写变量 —— `<your_tools>`、
    // 状态板、`<board>` 全是关于载荷的假话,裁掉。
    judgement: true,
  })
  const isLead = Boolean(options.pmAgentId) && options.pmAgentId === options.self.id
  const system = [
    roomSystem,
    isLead ? COLLAB_WILLINGNESS_PM_FACT : '',
    formatWillingnessSelfCards(options.selfCards ?? []),
  ]
    .filter(part => part.length > 0)
    .join('\n\n')

  const windowLines = buildWillingnessWindow({
    recent: options.recent,
    members: options.members,
    userLabel: options.userLabel,
    resolveAgentName: options.resolveAgentName,
  })
  const user = [windowLines.join('\n'), COLLAB_WILLINGNESS_QUESTION]
    .filter(part => part.length > 0)
    .join('\n\n')

  return { system, user }
}

function stripCodeFences(text: string): string {
  return text.replace(/```[^\n`]*\n?/g, '').replace(/```/g, '')
}

/**
 * A parsed judgement (§3.5 B extended the shape). `react` is only ever acted
 * on when `respond` is false — a member that is about to speak has said its
 * piece in words.
 */
export interface CollabWillingnessVerdict {
  respond: boolean
  /** Palette emoji, or null when none was offered / it was off-palette. */
  react: CollabReactionEmoji | null
  /**
   * **为什么**是这个结果(collab-coordinator-inspector.md §8)。
   *
   * `respond: false` 此前是五种完全不同的事共用的一个答案:模型真说了不、回复读不懂、
   * 8s 死线到了、provider 解析不出来、被喊停抢占。对**这一轮**来说它们等价(都不说话),
   * 对**排查**来说天差地别——"它们不想说"不用管,"这条链断了"必须修。
   *
   * 判定这一步是整条链上最贵也最不可见的,而它此前唯一的输出是一个布尔。
   * 这一格就是把那四种失败从"沉默"里分出来。
   */
  outcome: CollabWillingnessOutcomeKind
}

export type CollabWillingnessOutcomeKind =
  /** 模型说了要说话。 */
  | 'yes'
  /** 模型明确说了不说。**只有这一种是"它不想说"**,其余都是没答上。 */
  | 'no'
  /** 回复到了,但读不出 respond —— 模型没按格式答(常见于推理模型把预算烧在思考上)。 */
  | 'unparsable'
  /** 8s 死线到期,一个字都没等到。 */
  | 'timeout'
  /** 还没发出去就没了:provider/model 解析不出来,或鉴权拿不到。 */
  | 'unresolved'
  /** 用户喊停,这一轮作废。 */
  | 'aborted'
  /** 调用抛异常。 */
  | 'error'

const SILENT_VERDICT: CollabWillingnessVerdict = {
  respond: false,
  react: null,
  outcome: 'unparsable',
}

/**
 * The emoji half of the reply. Off-palette values are DROPPED rather than
 * stored: the room's reaction vocabulary is a product decision, not something
 * a model gets to extend at runtime.
 *
 * Quoted forms are excluded from the bare alternative on purpose — that is what
 * makes an echoed instruction (`"react": "👍"|null`) fail to match at all
 * instead of parsing as a real 👍.
 */
function parseWillingnessReact(body: string): CollabReactionEmoji | null {
  const match = /['"]?react['"]?\s*[::=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,}\]"']+))(?!\s*[|｜/])/i
    .exec(body)
  if (!match) return null
  return normalizeCollabReactionEmoji(match[1] ?? match[2] ?? match[3])
}

/**
 * Lenient parse of the judgement reply. Anything that is not a recognizable
 * "yes" is a NO — silence is the safe failure mode (a missed reply costs the
 * user one @; a spurious reply costs tokens and noise).
 *
 * The negative lookahead is deliberate: models that echo the instruction
 * (`{"respond": true|false}`) have not answered, and must not read as `true`.
 *
 * Backward compatible with the pre-W8 shape: a bare `{"respond": true}` (or a
 * bare `true`) parses exactly as before and simply carries no reaction.
 */
export function parseWillingnessReply(
  text: string | null | undefined,
): CollabWillingnessVerdict {
  if (!text) return SILENT_VERDICT
  const body = stripCodeFences(text)
  const react = parseWillingnessReact(body)

  const keyed = /['"]?respond['"]?\s*[::=]\s*['"]?(true|false)\b(?!\s*[|｜/])/i.exec(body)
  if (keyed) {
    const respond = keyed[1].toLowerCase() === 'true'
    return { respond, react, outcome: respond ? 'yes' : 'no' }
  }

  const bare = body.replace(/[\s"'`「」。.,,!!]/g, '').toLowerCase()
  if (bare === 'true') return { respond: true, react, outcome: 'yes' }
  // 裸 false 也算答过了 —— 它没按 JSON 格式,但意思是明确的,不该和"读不懂"混为一谈。
  if (bare === 'false') return { respond: false, react, outcome: 'no' }
  // 到这儿说明回复有内容却读不出结论:模型没按格式答。行为照旧是沉默(安全方向),
  // 但账要记成 `unparsable` —— 满屋子的 unparsable 指向的是 prompt 或模型,
  // 而满屋子的 `no` 指向的是这群人真的没话说。
  return { respond: false, react, outcome: 'unparsable' }
}
