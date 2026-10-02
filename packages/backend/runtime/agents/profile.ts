/**
 * Agent capability profile — the one place that answers "what are this turn's
 * runtime boundaries" (docs/design/agent-capability-profile.md).
 *
 * An agent used to be a persona plus a tool list: switching from 「研究员」 to
 * 「运维」 changed the prompt and nothing else, while the parts that actually
 * decide what a turn may DO — permission mode, turn budget, model — each had
 * their own resolution chain that no agent could reach.
 *
 * This module is a pure function over (agent, session, settings). It lives in
 * the product layer and never reads a store: the assembly layer resolves it
 * ONCE at the start of a turn and hands the snapshot down, so a mid-turn edit
 * cannot produce a half-new/half-old combination (new prompt, old allowlist).
 * The one deliberate exception is the permission mode, which is read live on
 * every ask — permissions go strict-and-fresh, never snapshot-stale.
 */

import type { OnethingAgentDefinition, OnethingAgentModelBinding } from './store.js'
import {
  COLLAB_NOTEBOOK_TOOLS,
  COLLAB_ROOM_TOOLS,
  COLLAB_WORK_REQUIRED_TOOLS,
} from '../collab/tool-surface.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('agents')

/**
 * Capability packs. A grant either REPLACES the agent's own allowlist (the
 * pack IS the surface) or is UNIONed into it (the pack is a floor layered on
 * the agent's real tools).
 *
 * 分工:工具**表**(房面地板 / 工作台面地板)是 collab 的产品口径,来自
 * collab/tool-surface.ts;**规则**(哪个 kind 拿哪一格、怎么叠)只在这里实现。
 * C2「工具面单点」(2026-08-03):collab 那边曾有一份同义的
 * `resolveCollabToolAllowlist`,两处互相在注释里要求对方保持一致,而对齐真的
 * 漂过一次 —— 那份已删,这里是唯一的答案,不再有人肉对齐的义务。
 *
 * Both packs are UNION grants (collab-team-v2 §2.1): say/board are a floor
 * layered on the agent's own tools; an agent without a whitelist stays
 * unrestricted. `collab-room` was briefly a REPLACE grant (2026-07-30 收紧,
 * over MCP tool noise in room turns), reverted the same day by user decision —
 * light work may run inline in a room turn, heavy work still goes through a
 * board card into a work session.
 */
export interface AgentToolGrant {
  id: string
  tools: readonly string[]
  mode: 'replace' | 'union'
}

export const AGENT_TOOL_GRANTS: readonly AgentToolGrant[] = [
  { id: 'collab-room', tools: COLLAB_ROOM_TOOLS, mode: 'union' },
  // agent-im-dm.md D7:单成员 dm 房(用户 ↔ agent 托管私聊)的回合。同样的两个
  // 工具、**恒为 union**,与 `collab-room` 分开登记的唯一目的是隔离:群房那一格
  // 将来若再次收紧成 replace,私聊不会被连带收窄(托管私聊的本义就是替你干活)。
  { id: 'collab-dm', tools: COLLAB_ROOM_TOOLS, mode: 'union' },
  { id: 'collab-work', tools: COLLAB_WORK_REQUIRED_TOOLS, mode: 'union' },
  /**
   * Collab v3 的跨房笔记(docs/design/collab-actor-v3.md §1.2)。
   *
   * D2 登记时刻意不由任何 kind 隐含(v2 回合带一个没人读的工具是纯损耗);
   * **D6-a 接线后由 `NOTEBOOK_SESSION_KINDS` 隐含** —— v3 的心智循环在每一条
   * drive 的尾部注入笔记,写下的东西从此有读者。
   */
  { id: 'collab-notebook', tools: COLLAB_NOTEBOOK_TOOLS, mode: 'union' },
]

/**
 * Which grant a session kind implies. W18 moved the room RESPONSE turn into the
 * agent's own execution session, so 'agent' means the same thing as 'room' here
 * — the surface follows the turn, not the session that stores the messages.
 */
const GRANTS_BY_SESSION_KIND: Readonly<Record<string, string>> = {
  room: 'collab-room',
  agent: 'collab-room',
  work: 'collab-work',
}

/** 同一张表的 dm 分支(D7):房是单成员私聊时,room/agent 两个 kind 改走 dm 那一格。 */
const DM_GRANTS_BY_SESSION_KIND: Readonly<Record<string, string>> = {
  room: 'collab-dm',
  agent: 'collab-dm',
}

/**
 * 笔记的那一格(collab v3 D6-a)。
 *
 * 与上面两张表**并列而不是替换**:笔记是跨房的私人本子,与「这一回合在哪间房」
 * 无关,所以它不该跟着 room / dm 的分支走 —— 那两张表回答的是"这一格该给哪一份
 * 房面地板",而这一条回答的是"这个 kind 的回合是不是一个 v3 心智回合"。
 *
 * 少一格 `room`:W18 之后房回合跑在执行会话里(kind='agent'),留在 kind='room'
 * 的只有旧形状的房内流,而那条路上没有 v3 的心智循环。与 `COLLAB_VENUE_TOOLS`
 * 的 `notebook: ['agent', 'work']` 逐格对齐 —— 场子门与工具面必须说同一句话。
 */
const NOTEBOOK_SESSION_KINDS: ReadonlySet<string> = new Set(['agent', 'work'])

/**
 * Permission modes ordered STRICTEST FIRST. Composition takes the stricter of
 * the agent's mode and the session/settings mode, so this table is the whole
 * definition of "stricter" — a mode missing from this table cannot be ordered
 * against the others and is therefore ignored by the composition (see
 * `sanitizePermissionMode`), with a warning.
 */
export const AGENT_PERMISSION_MODE_STRICTNESS: readonly string[] = [
  'normal',
  'auto-accept-edits',
  'dangerously-allow-all',
]

export const DEFAULT_AGENT_PERMISSION_MODE = 'normal'

/**
 * Turn budget when neither the agent nor settings.chat.maxTurns says otherwise.
 * The core runner's own default (8) is far too small for real tool-heavy work;
 * `DEFAULT_CHAT_MAX_TURNS` in agent-loop/stream-runtime.ts is an alias of this
 * so the number has exactly one home.
 */
export const DEFAULT_AGENT_MAX_TURNS = 100

function strictnessRank(mode: string | undefined): number {
  if (!mode) return Number.POSITIVE_INFINITY
  const index = AGENT_PERMISSION_MODE_STRICTNESS.indexOf(mode)
  // Unknown modes are filtered out before they get here (sanitizePermissionMode),
  // so this branch is a second layer only: an unorderable value must not be
  // silently ranked, it must not participate.
  return index < 0 ? Number.POSITIVE_INFINITY : index
}

/**
 * One warning per (origin, mode) pair. The composition runs on EVERY
 * `Permission.ask` (strict-and-fresh, see the module header), so warning
 * unconditionally would turn one typo in agents.json into a console flood.
 */
const warnedUnknownPermissionModes = new Set<string>()

/**
 * A mode this build cannot order is treated as NOT SET — it drops out of the
 * composition and the next priority stands (session/settings → fallback).
 *
 * The old behaviour ranked it as strictest (fail closed), which read well on
 * paper and was a trap in practice: one typo in agents.json silently pinned an
 * agent to the strictest mode and quietly overrode every room/global setting
 * with no way to see why. P1-4 (docs/design/todo2-fix-plan.md): make the typo
 * loud and let the configured chain keep working.
 */
function sanitizePermissionMode(
  mode: string | undefined,
  origin: string,
  agentId?: string,
): string | undefined {
  if (!mode) return undefined
  if (AGENT_PERMISSION_MODE_STRICTNESS.includes(mode)) return mode
  const key = `${origin}:${agentId ?? '—'}:${mode}`
  if (!warnedUnknownPermissionModes.has(key)) {
    warnedUnknownPermissionModes.add(key)
    log.warn('unknown permissionMode ignored', {
      mode,
      origin,
      agentId,
      knownModes: AGENT_PERMISSION_MODE_STRICTNESS,
    })
  }
  return undefined
}

/** Test seam: the per-(origin, mode) warn latch is process-global. */
export function resetUnknownPermissionModeWarnings(): void {
  warnedUnknownPermissionModes.clear()
}

/**
 * The composition rule: strictest wins; an agent that does not declare a mode
 * does not participate at all (so the collab worker's "inherit the room's
 * auto-approve so headless self-tests don't stall on an approval nobody will
 * answer" path keeps working until someone explicitly marks an agent).
 *
 * A mode this build does not recognize also does not participate — it is
 * warned about once and ignored (see `sanitizePermissionMode`).
 */
export function composeAgentPermissionMode(
  agentMode: string | undefined,
  sessionOrSettingsMode: string | undefined,
  fallback: string = DEFAULT_AGENT_PERMISSION_MODE,
  context?: { agentId?: string },
): string {
  const agentId = context?.agentId
  const declared = sanitizePermissionMode(agentMode, 'agent', agentId)
  const base = sanitizePermissionMode(sessionOrSettingsMode, 'session/settings', agentId)
    ?? sanitizePermissionMode(fallback, 'fallback', agentId)
    ?? DEFAULT_AGENT_PERMISSION_MODE
  if (!declared) return base
  return strictnessRank(declared) <= strictnessRank(base) ? declared : base
}

export interface EffectiveAgentProfile {
  agentId: string
  name: string
  systemPrompt: string
  /** Tool allowlist for this turn; `null` = no restriction. */
  tools: string[] | null
  permissionMode: string
  maxTurns: number
  /**
   * Model override to stamp onto this turn, or undefined to let the session's
   * own effective configuration stand. Present only when the agent binds a
   * model AND the session has no explicit user pick to defend.
   */
  model?: OnethingAgentModelBinding
}

export interface AgentProfileSessionInput {
  /** Collab session kind ('room' | 'agent' | 'work'); absent for chat. */
  kind?: string
  /**
   * 这一回合答的房是单成员 dm 房吗(agent-im-dm.md D7)。app 层现算:kind='room'
   * 读自己的 `room`,kind='agent' 读 `collab.roomSessionId` 指的那间房。
   */
  dm?: boolean
  permissionMode?: string
  /**
   * True when the user picked this session's provider/model by hand. Without
   * it, lastProvider/lastModel are indistinguishable from the auto-stamp every
   * assistant message performs — and an agent binding would look overridden by
   * a "choice" nobody made.
   */
  modelPinned?: boolean
}

export interface AgentProfileSettingsInput {
  tools?: { permissionMode?: string }
  chat?: { maxTurns?: number }
}

export interface ResolveAgentProfileInput {
  agent: OnethingAgentDefinition
  session?: AgentProfileSessionInput | null
  settings?: AgentProfileSettingsInput | null
  defaults?: { permissionMode?: string; maxTurns?: number }
}

/**
 * Tool surface for a turn: the agent's own allowlist, with the grants implied
 * by the session kind applied on top (an explicit `toolGrants` list on the
 * agent adds to those). Returns null for "no restriction".
 *
 * A `replace` grant would win outright and ignore the agent's own list; no
 * built-in pack uses it today (room/agent went replace on 2026-07-30 and was
 * reverted to union the same day). `union` grants layer onto a curated list;
 * with no list there is nothing to restrict.
 *
 * 这是「这一回合能用哪些工具」的**唯一**实现(C2,2026-08-03):房、私聊、
 * 工作台、普通会话都从这里出答案,调用方要么读回合开头解析好的 profile 快照,
 * 要么调这个函数 —— 不该有第三条自己算的路。
 */
export function resolveAgentToolSurface(input: {
  ownTools?: readonly string[] | null
  grants?: readonly string[] | null
  sessionKind?: string
  /** 这一回合答的是单成员 dm 房吗(D7)。true 时 room/agent 走 `collab-dm` 那一格。 */
  sessionDm?: boolean
}): string[] | null {
  const grantIds = new Set<string>(input.grants ?? [])
  const implied = input.sessionKind
    ? (input.sessionDm ? DM_GRANTS_BY_SESSION_KIND[input.sessionKind] : undefined)
      ?? GRANTS_BY_SESSION_KIND[input.sessionKind]
    : undefined
  if (implied) grantIds.add(implied)
  if (input.sessionKind && NOTEBOOK_SESSION_KINDS.has(input.sessionKind)) {
    grantIds.add('collab-notebook')
  }

  const grants = AGENT_TOOL_GRANTS.filter(grant => grantIds.has(grant.id))
  const replacement = grants.find(grant => grant.mode === 'replace')
  if (replacement) return [...replacement.tools]

  const own = input.ownTools ?? null
  const unions = grants.filter(grant => grant.mode === 'union')
  // A union grant layers onto a curated allowlist. With no allowlist the agent
  // already sees every tool, so there is nothing to add to.
  if (!own || unions.length === 0) return own ? [...own] : null

  const surface = [...own]
  for (const grant of unions) {
    for (const tool of grant.tools) {
      if (!surface.includes(tool)) surface.push(tool)
    }
  }
  return surface
}

export function resolveAgentProfile(input: ResolveAgentProfileInput): EffectiveAgentProfile {
  const { agent, session, settings } = input
  const defaultMaxTurns = input.defaults?.maxTurns ?? DEFAULT_AGENT_MAX_TURNS

  return {
    agentId: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    tools: resolveAgentToolSurface({
      ownTools: agent.tools ?? null,
      grants: agent.toolGrants ?? null,
      sessionKind: session?.kind,
      sessionDm: session?.dm,
    }),
    permissionMode: composeAgentPermissionMode(
      agent.permissionMode,
      session?.permissionMode ?? settings?.tools?.permissionMode,
      input.defaults?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE,
      { agentId: agent.id },
    ),
    // Ordinary override chain here — a turn budget is a preference, not a
    // safety boundary, so the agent simply wins over the global setting.
    maxTurns: agent.maxTurns ?? settings?.chat?.maxTurns ?? defaultMaxTurns,
    // An explicit pick by the user outranks the agent's binding; everything
    // else (including the lastProvider auto-stamp) does not.
    model: session?.modelPinned ? undefined : agent.model,
  }
}
