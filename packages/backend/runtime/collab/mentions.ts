import type { CollabAgentLike, CollabMentionLike } from './types.js'

/**
 * Parse @mentions of room members from a message text.
 *
 * CJK names have no word boundaries, so each member's name is matched
 * literally after '@'. Longer names are claimed first so that with members
 * 小李工 and 小李, "@小李工" resolves to the longer one (the shorter match at
 * the same '@' position is suppressed). Returns member ids in first-appearance
 * order, deduped.
 *
 * 重名 (W14a): when several members go by the SAME name they all match the
 * same position and all of them are returned — only a longer name suppresses
 * a shorter one. Text cannot tell two 小李 apart, so claiming one of them
 * would be a coin flip; the picker's id is what makes a mention precise.
 *
 * NOTE (W14a): this is the FALLBACK half of identity. A message that carries
 * `mentions` (agent ids fixed at authoring time) is resolved by id — see
 * resolveCollabMentionIds. Name text stays the degradation path for old
 * transcripts and for bare typing that never went through a picker.
 */
export function parseCollabMentions(
  text: string | undefined | null,
  members: readonly CollabAgentLike[],
): string[] {
  if (!text || !text.includes('@')) return []

  const byLength = members
    .filter(member => typeof member.name === 'string' && member.name.trim().length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length)

  const claims: Array<{ index: number; id: string }> = []
  // Longest name wins a position; equally long ones SHARE it (重名).
  const claimedLength = new Map<number, number>()
  for (const member of byLength) {
    const token = `@${member.name.trim()}`
    let from = 0
    for (;;) {
      const index = text.indexOf(token, from)
      if (index < 0) break
      const winner = claimedLength.get(index)
      if (winner === undefined || winner === token.length) {
        claimedLength.set(index, token.length)
        claims.push({ index, id: member.id })
      }
      from = index + token.length
    }
  }

  claims.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const claim of claims) {
    if (seen.has(claim.id)) continue
    seen.add(claim.id)
    ids.push(claim.id)
  }
  return ids
}

/**
 * `@所有人` 的认读写法(2026-08-02)。
 *
 * 存在的理由是一次真机事故链:「所有人报数」作为普通文本要靠仲裁模型读懂,
 * 而弱模型在叙事惯性下反复只排"唯一在回应的人" —— 四层提示词规则都压不住。
 * mention 链路是**代码保证**的(并行短路激活、编排强制进第一批),把"全房"
 * 变成一个 mention token,这类消息就不再依赖任何模型判断。
 */
export const COLLAB_MENTION_ALL_LABELS = ['所有人', '全体成员'] as const

/** ASCII 写法要词边界:`@all` 不能吃掉 `@allen` 的前缀。 */
const MENTION_ALL_ASCII = /@(?:all|everyone)(?![a-z0-9_])/i

function hasCollabAllMentionToken(text: string): boolean {
  if (COLLAB_MENTION_ALL_LABELS.some(label => text.includes(`@${label}`))) return true
  return MENTION_ALL_ASCII.test(text)
}

/**
 * `@所有人` → 全体在职成员的 mention 记录。
 *
 * **只接在用户入口**(app 层 ingress):agent 的 `say` 刻意不认这个 token ——
 * 一位成员一句话唤醒全房是链长闸兜不住的放大器,点名个人已经够用。
 * label 用各成员当下的名字(与名字扫描同一快照纪律),文本里的 `@所有人`
 * 本身不改写,显示层照原文画。
 */
export function expandCollabAllMentions(
  text: string | undefined | null,
  members: readonly CollabAgentLike[],
): CollabMentionLike[] {
  if (!text || !text.includes('@') || !hasCollabAllMentionToken(text)) return []
  return members.map(member => ({
    agentId: member.id,
    label: member.name?.trim() || member.id,
  }))
}

/**
 * Name parse → mention records (W14a). The label is the roster name AT THIS
 * MOMENT: it is a snapshot, kept so a mention still reads as words after the
 * agent is deleted, while the id keeps it addressable after a rename.
 *
 * 重名 note: two members sharing a name both match the same `@名字`, so both
 * get an entry — bare typing is inherently ambiguous and the honest answer is
 * "both". The picker path (which knows exactly which member was chosen) is
 * what makes a mention precise.
 */
export function buildCollabMentions(
  text: string | undefined | null,
  members: readonly CollabAgentLike[],
): CollabMentionLike[] {
  const byId = new Map(members.map(member => [member.id, member]))
  return parseCollabMentions(text, members).map(agentId => ({
    agentId,
    label: byId.get(agentId)?.name?.trim() || agentId,
  }))
}

/**
 * Sanitize an untrusted mentions array into plain literals (a renderer hands
 * these across IPC; a persisted transcript is replayed from disk). Entries
 * without a usable agentId are dropped. When `members` is given, unknown ids
 * are dropped too and every label is re-stamped from the roster — the CLIENT
 * DOES NOT GET TO NAME ANOTHER AGENT: the label is a display snapshot, and
 * letting it arrive from outside would let a sender write words into the room
 * that no member ever went by.
 */
export function normalizeCollabMentions(
  value: unknown,
  options: { members?: readonly CollabAgentLike[] } = {},
): CollabMentionLike[] {
  if (!Array.isArray(value)) return []
  const byId = options.members ? new Map(options.members.map(member => [member.id, member])) : undefined
  const seen = new Set<string>()
  const mentions: CollabMentionLike[] = []
  for (const entry of value) {
    const agentId = typeof (entry as CollabMentionLike | undefined)?.agentId === 'string'
      ? String((entry as CollabMentionLike).agentId).trim()
      : ''
    if (!agentId || seen.has(agentId)) continue
    if (byId && !byId.has(agentId)) continue
    const rosterName = byId?.get(agentId)?.name?.trim()
    const rawLabel = typeof (entry as CollabMentionLike).label === 'string'
      ? String((entry as CollabMentionLike).label).trim()
      : ''
    const label = rosterName || rawLabel || agentId
    seen.add(agentId)
    mentions.push({ agentId, label })
  }
  return mentions
}

/**
 * Merge picker-supplied mentions with the name-parse fallback (W14a ingress).
 *
 * Per-LABEL authority: when the sender explicitly picked a member, the ids it
 * picked own that label and the text scan contributes nothing more for it —
 * that is exactly what makes 重名 precise (picking one 小李 must not also
 * activate the other one, whose name matches the same `@小李`). Labels the
 * picker said nothing about still come from the text, so a draft mixing one
 * picked mention with one typed by hand keeps both.
 */
export function mergeCollabMentions(
  picked: readonly CollabMentionLike[],
  parsed: readonly CollabMentionLike[],
): CollabMentionLike[] {
  const claimedLabels = new Set(picked.map(mention => mention.label))
  const merged: CollabMentionLike[] = []
  const seen = new Set<string>()
  for (const mention of [...picked, ...parsed.filter(entry => !claimedLabels.has(entry.label))]) {
    // 用户那一条的 agentId 是空串(collab-handle-codec.md §2.3),按 agentId 去重
    // 会把"用户"与"任何 agentId 缺失的条目"混为一谈 —— 所以 key 带上 kind。
    const key = mention.kind === 'user' ? 'user' : mention.agentId
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      agentId: mention.agentId,
      label: mention.label,
      // 不带 kind 的一律是 agent(老转录即此),不写这个键,免得整仓多出一批
      // `kind:'agent'` 的噪音字段。用户那条把句柄一起带走 —— merge 丢字段
      // 正是"存了等于没存"的经典出口。
      ...(mention.kind === 'user'
        ? {
            kind: 'user' as const,
            ...(mention.userHandle ? { userHandle: mention.userHandle } : {}),
          }
        : {}),
    })
  }
  return merged
}

/**
 * The consumption rule (W14a): ids first, text second.
 *
 *  - a message carrying `mentions` is resolved from it — renames and 重名 are
 *    both already settled at authoring time
 *  - a message WITHOUT the field (every transcript written before W14a, and
 *    anything an external channel injects) falls back to the name scan
 *
 * An EMPTY mentions array is a real answer ("this message mentions nobody"),
 * not a missing field — writers therefore omit the key rather than store [].
 */
export function resolveCollabMentionIds(
  message: { content?: string | null; mentions?: readonly CollabMentionLike[] },
  members: readonly CollabAgentLike[],
): string[] {
  if (Array.isArray(message.mentions)) {
    const seen = new Set<string>()
    const ids: string[] = []
    for (const mention of message.mentions) {
      const agentId = typeof mention?.agentId === 'string' ? mention.agentId : ''
      if (!agentId || seen.has(agentId)) continue
      seen.add(agentId)
      ids.push(agentId)
    }
    return ids
  }
  return parseCollabMentions(message.content, members)
}

/**
 * One resolved `@…` occurrence, handed to a surface that wants to draw it as
 * something richer than words (the room UI's mention pill).
 *
 * `agentId` is present ONLY when this occurrence points at exactly one member:
 * a label two mentions claim (two 小李) has no single addressee, and a pill
 * that linked to one of them would be a coin flip.
 */
export interface CollabMentionHit {
  kind: 'agent' | 'user'
  /** The single member this occurrence addresses; null when it addresses the
   *  human user, or when the label is claimed by more than one member. */
  agentId: string | null
  /** The name as the transcript wrote it (the label snapshot). */
  label: string
  /** The name to show NOW (renames already applied). */
  name: string
}

export interface CollabMentionRenderOptions {
  /**
   * Names the human user goes by. An `@` on one of these is a `kind: 'user'`
   * hit — mentions[] only ever holds AGENT ids, so the user can never appear
   * there, and this is the one label the walker is told about explicitly
   * rather than inferring from the roster.
   */
  userLabels?: readonly string[]
  /** How to write a hit out. Default: `@<name>` — i.e. plain text, unchanged. */
  renderHit?: (hit: CollabMentionHit) => string
}

/**
 * Display-time rename resolution (W14a): `@<label>` is repainted with whatever
 * the mentioned agent is called NOW. One implementation for every surface —
 * the model projection, the willingness window and the room UI must all read
 * the same name, or an agent renamed mid-conversation would answer to a name
 * the transcript no longer shows.
 *
 * Fallbacks are deliberate: an agent that is gone from the roster keeps its
 * label snapshot (the words stay readable), and a label that two mentions
 * resolve differently (two 小李, one renamed) is left ALONE — silently picking
 * one of them would put a name next to the wrong person.
 *
 * `options.renderHit` (im-message 设计稿 §A) lets the room UI turn the very
 * same occurrences into pills WITHOUT a second matcher: the walk, the
 * longest-name-wins rule and the ambiguity verdict stay here, and the caller
 * only decides what an already-resolved hit looks like. Two matchers over one
 * transcript is exactly the crack this parameter exists to avoid.
 */
export function renderCollabMentionText(
  text: string | undefined | null,
  mentions: readonly CollabMentionLike[] | undefined,
  agents: readonly CollabAgentLike[],
  options: CollabMentionRenderOptions = {},
): string {
  const source = text ?? ''
  if (!source.includes('@')) return source
  /**
   * 用户的写法有两个来源,合并成一份:调用点给的(当前档案名)+ **消息自己
   * 带的**(`kind:'user'` 那些 mention 的 label 快照)。
   *
   * 后者是 collab-handle-codec.md §2.3 的兑现:用户此前只能按两个常量词认,
   * 而名字匹配正是 W14a 为 agent 废弃掉的东西 —— 改名之后旧转录就认不出了。
   * 带着 label 快照走,那一条永远认得出它当初点的是谁。
   */
  const userLabels = [...new Set(
    [
      ...(options.userLabels ?? []),
      ...(mentions ?? []).filter(mention => mention?.kind === 'user').map(mention => mention.label),
    ].map(label => label?.trim()).filter((label): label is string => Boolean(label)),
  )]
  if ((!mentions || mentions.length === 0) && userLabels.length === 0) return source

  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const resolved = new Map<string, string | null>()
  /** Which members claim a label. size > 1 ⇒ no single addressee ⇒ no pill. */
  const owners = new Map<string, Set<string>>()
  for (const mention of mentions ?? []) {
    // 用户那一条不进 agent 解析表 —— 它的 agentId 是空串,落进来会让这个 label
    // 命中下面的 agent 分支(claimants 只有一个空串),把用户分支整个遮掉:
    // 结果是 `@我` pill 退化成一段普通文字。
    if (mention?.kind === 'user') continue
    const label = mention?.label?.trim()
    if (!label) continue
    const current = byId.get(mention.agentId)?.name?.trim() || label
    const previous = resolved.get(label)
    if (previous === undefined) resolved.set(label, current)
    else if (previous !== current) resolved.set(label, null) // ambiguous — leave the text as written
    let claimants = owners.get(label)
    if (!claimants) {
      claimants = new Set<string>()
      owners.set(label, claimants)
    }
    claimants.add(mention.agentId)
  }

  /**
   * Longest-name-wins, over EVERY name the room knows (P2-11) — the same
   * disambiguation `parseCollabMentions` does above, which the repaint used to
   * lack. The old candidate set held only the RENAMED labels, so a short
   * renamed name could eat the prefix of a longer one that had not changed:
   * with 小李→小李新 and 小李工 untouched, `@小李工` came out `@小李新工`.
   *
   * Unrenamed and ambiguous names stay in the set as BLOCKERS: matching one
   * emits it verbatim and steps past it, which is exactly what stops a shorter
   * candidate from claiming its opening characters.
   */
  const candidates = [...new Set([
    ...resolved.keys(),
    ...agents.map(agent => agent.name?.trim()).filter((name): name is string => Boolean(name)),
    ...userLabels,
  ])].sort((a, b) => b.length - a.length)
  if (candidates.length === 0) return source

  const renderHit = options.renderHit
  let output = ''
  let index = 0
  while (index < source.length) {
    if (source[index] !== '@') {
      output += source[index]
      index += 1
      continue
    }
    const label = candidates.find(candidate => source.startsWith(candidate, index + 1))
    if (!label) {
      output += source[index]
      index += 1
      continue
    }
    index += 1 + label.length
    if (resolved.has(label)) {
      const current = resolved.get(label)
      const name = typeof current === 'string' ? current : label
      const claimants = owners.get(label)
      // A pill needs ONE addressee: ambiguous labels and shared names stay words.
      const agentId = typeof current === 'string' && claimants?.size === 1
        ? [...claimants][0]
        : null
      output += renderHit && agentId
        ? renderHit({ kind: 'agent', agentId, label, name })
        : `@${name}`
      continue
    }
    if (userLabels.includes(label)) {
      output += renderHit
        ? renderHit({ kind: 'user', agentId: null, label, name: label })
        : `@${label}`
      continue
    }
    // A roster name nobody mentioned: a blocker, emitted verbatim.
    output += `@${label}`
  }
  return output
}
