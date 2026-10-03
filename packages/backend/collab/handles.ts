/**
 * 模型面身份句柄 —— `@名字#3f9c1e2a`(docs/design/collab-agent-handle.md)。
 *
 * ## 这个模块存在的理由
 *
 * W14a 把身份 id 化了,但只化在**数据层**:`mentions[{agentId,label}]`、
 * `memberAgentIds`、`assigneeAgentId` 里全是 id,而模型能看到的每一处
 * (花名册、消息信封、正文的 @、意愿窗口、看板摘要、系统行、drive 尾行)
 * 都只有裸名字。于是三件事同时成立:
 *
 *  1. `dm` 工具的 `to` 参数写着「填 agent id,不是名字」,而 agent 无处得知
 *     任何 id —— 这条链路在提示词层面是断的;
 *  2. `say` 的 `mentions` 参数同理,只能退回正文 `@名字` 的文本兜底;
 *  3. 重名的两位「小李」在文本里分辨不了,想点一个,两个都被叫醒。
 *
 * 句柄就是 id 在模型面的**可见投影**:出站时拼在名字后面,入站时解析回 id
 * **并从正文里剥掉**。房间转录、UI 气泡、用户视野里永远是干净的 `@小李`;
 * 带 `#` 的那一份只活在送进模型的那段文本里。
 *
 * ## 为什么是 8 位而不是全 id
 *
 * agent id 是 `agent-<uuid v4>`(agents/ipc-operations.ts)。全 id 每个 mention
 * 多 ~15 token,而消息信封是**按条**计费的全量投影 —— 这是这套系统里少数几个
 * 随对话线性增长的固定开销之一。8 位十六进制与看板既有的 `#<8位>` 短卡号同构,
 * 模型见过这个形状。
 *
 * 内置 default agent 的 id 是字面量 `'default'`(不是 uuid),所以规则不能写死
 * 「切 8 位」:短 id 原样用,否则 `defaul` 这种半截词会同时难认又难解析。
 *
 * ## 与看板短卡号 `#a1b2c3d4` 的形状撞车
 *
 * 两者都长成 `#` + 8 位。靠**位置**区分,不靠正则:agent 句柄永远紧跟在名字
 * 后面(`名字#句柄`)或紧跟 `@`(`@#句柄`),卡号永远独立成词(`#a1b2c3d4「标题」`)。
 * 解析入口也是分开的(board 的 taskId 参数 vs 这里的 mention 扫描),不共用
 * 一个匹配器。**加第三种 `#` 之前先回来读这一段。**
 */
import type { CollabAgentLike, CollabMentionLike } from './types.js'
import {
  collabIdentitiesFromAgents,
  type CollabIdentity,
} from './identity.js'

export {
  COLLAB_AGENT_HANDLE_CHARS,
  collabAgentHandle,
  collabAgentIdKey,
} from './handle-format.js'
import { collabAgentHandle, collabAgentIdKey } from './handle-format.js'

/** id → 句柄的查表版。反向查(句柄 → id)是入站扫描的内部需要;正向出站不需要
 *  表 —— 句柄既然是 id 的纯函数,拿着 id 就够了。 */
function buildCollabAgentHandles(
  agents: readonly CollabAgentLike[],
): Map<string, string> {
  const handles = new Map<string, string>()
  for (const agent of agents) {
    const id = agent?.id?.trim()
    if (!id || handles.has(id)) continue
    handles.set(id, collabAgentHandle(id))
  }
  return handles
}

/**
 * 出站:`小李` → `小李#3f9c1e2a`。**唯一**的拼接口 —— 七处出站全走它,免得
 * 「名字后面加个井号」这件小事长出七种写法。
 *
 * 没有 id 就没有句柄:用户、系统行、以及连 id 都没有的「成员」占位。
 *
 * 退休/离开本群的人**照样给句柄**:它的 id 是真的,模型拿它去 dm 会得到
 * 「已注销」这种可操作的答复,而不是「查无此人」。给假句柄才是错的,不给句柄
 * 只是少一条线索。
 */
export function formatCollabAgentHandle(
  agentId: string | undefined | null,
  name: string,
): string {
  const id = agentId?.trim()
  if (!id) return name
  const handle = collabAgentHandle(id)
  return handle ? `${name}#${handle}` : name
}

/**
 * 正文里那个 `@` 的模型面写法(配 `renderCollabMentionText` 的 `renderHit`)。
 *
 * UI 侧**不传**这个 renderer,于是气泡里仍然是 `@小李` —— 同一次遍历、同一套
 * 最长名优先与歧义判定,只有末端的写法不同。这正是 `renderHit` 这个缝存在的
 * 理由:两个匹配器扫同一段转录,迟早会各自认出不同的东西。
 *
 * 指向不唯一的那种 `@`(两位重名的都认领了这个 label)拿不到 agentId,于是原样
 * 保留成文字 —— 转录本身就是歧义的,句柄编不出一个它没有的答案。
 */
export function renderCollabModelMention(hit: {
  kind: 'agent' | 'user'
  agentId: string | null
  name: string
}): string {
  return hit.kind === 'agent' && hit.agentId
    ? `@${formatCollabAgentHandle(hit.agentId, hit.name)}`
    : `@${hit.name}`
}

/** 解析结果:成或败,败必须能说清是哪一种败(模型据此改做别的事)。 */
export type CollabHandleResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: string }

/** `名字#句柄` 被拆开之后的样子。字段全是**语法**,一个判定都没做。 */
export interface CollabHandleQuery {
  /** 归一后的整串:去掉两端空白与前导 `@`。空串 = 模型什么也没写。 */
  raw: string
  /** `#` 前那一截。没有 `#` 时是空串 —— 裸写的整串归 `handle`,不归这里。 */
  name: string
  /** `#` 后那一截;没有 `#` 时就是整串(裸句柄与裸名字在语法上分不开)。 */
  handle: string
  /** 原串里有没有 `#`。带 `#` = 模型明确在写句柄,判定可以更严。 */
  hashed: boolean
}

/**
 * 「名字#句柄」的**唯一**语法切分口(架构审查 B8)。
 *
 * 从前有三份:这里的四档解析、`dm` 的用户档匹配、`history` 的 `who` 过滤,
 * 各自 `lastIndexOf('#')` 一遍。三份切分意味着三种「什么算名字、什么算句柄、
 * `@` 要不要剥、空白要不要 trim」——而它们答的是同一个问题,只是**答完之后**
 * 拿去干的事不同(授权解析要严,过滤可以宽)。
 *
 * 所以收口收在这一层:切分只有一份,宽严的差别留在各自的比较步里。
 *
 * `lastIndexOf` 而不是 `indexOf`:名字本身可以含 `#`(模型抄一段带卡号的话进
 * 来),而句柄永远在最后一截。
 */
export function splitCollabHandleQuery(
  query: string | undefined | null,
): CollabHandleQuery {
  const raw = (query ?? '').trim().replace(/^@/, '')
  const hashAt = raw.lastIndexOf('#')
  if (hashAt < 0) return { raw, name: '', handle: raw, hashed: false }
  return {
    raw,
    name: raw.slice(0, hashAt).trim(),
    handle: raw.slice(hashAt + 1).trim(),
    hashed: true,
  }
}

/**
 * 入站:模型写的一个"谁"(dm 的 to、board 的 assignee),解析成 agentId。
 *
 * 优先级而非试探 —— 每一档都比下一档更精确:
 *
 *  1. 全 id(`agent-3f9c…`)——模型从某处抄到了完整 id,照单全收;
 *  2. 句柄(`#3f9c1e2a` / `3f9c1e2a`)——花名册教它的写法;
 *  3. `名字#句柄` —— **以句柄为准**,名字只当显示(模型可能拿旧名字配新句柄);
 *  4. 裸名字 —— 唯一命中才算。重名时拒绝并把候选的 `名字#句柄` 列出来,
 *     因为此刻"猜一个"和"叫醒两个"都是错的,而模型完全有能力再说一次。
 */
export function resolveCollabAgentHandle(
  query: string | undefined | null,
  agents: readonly CollabAgentLike[],
): CollabHandleResolution {
  const { raw, name: namePart, handle: handlePart, hashed } = splitCollabHandleQuery(query)
  if (!raw) return { ok: false, error: '没说是谁 —— 填花名册里的写法「名字#句柄」。' }

  const handles = buildCollabAgentHandles(agents)

  // 1. 全 id
  const byId = agents.find(agent => agent.id === raw)
  if (byId) return { ok: true, agentId: byId.id }

  // 2/3. 句柄(带不带名字都走同一条:句柄说了算)
  if (handlePart && (hashed || looksLikeHandle(handlePart))) {
    const exact = [...handles].filter(([, handle]) => handle === handlePart)
    if (exact.length === 1) return { ok: true, agentId: exact[0][0] }
    // 模型可能抄短了或抄长了 —— 唯一前缀仍然是明确的指认。
    const prefix = agents.filter(agent => {
      const key = collabAgentIdKey(agent.id)
      return handlePart.length >= 4
        && (key.startsWith(handlePart) || handlePart.startsWith(key))
    })
    if (prefix.length === 1) return { ok: true, agentId: prefix[0].id }
    if (prefix.length > 1) {
      return { ok: false, error: `句柄「#${handlePart}」不止一个人对得上:${listCandidates(prefix)}。` }
    }
    if (hashed && namePart) {
      // 句柄写错了但名字可能是真的 —— 说清楚哪一半错了,别让它以为人不在。
      const byName = agents.filter(agent => agent.name?.trim() === namePart)
      if (byName.length === 1) {
        return { ok: false, error: `「${namePart}」的句柄不是 #${handlePart},是 #${handles.get(byName[0].id)}。` }
      }
    }
    return { ok: false, error: `花名册里没有句柄 #${handlePart} 的人。` }
  }

  // 4. 裸名字
  const name = namePart || raw
  const byName = agents.filter(agent => agent.name?.trim() === name)
  if (byName.length === 1) return { ok: true, agentId: byName[0].id }
  if (byName.length > 1) {
    return { ok: false, error: `叫「${name}」的不止一个:${listCandidates(byName)} —— 带上句柄再说一次。` }
  }
  return { ok: false, error: `花名册里没有「${name}」这个人。` }
}

/** 看着像句柄:纯 hex/字母数字且够长。裸名字走不到这条(中文名一律不像)。 */
function looksLikeHandle(value: string): boolean {
  return value.length >= 4 && /^[0-9a-fA-F][0-9a-fA-F-]*$/.test(value)
}

function listCandidates(agents: readonly CollabAgentLike[]): string {
  return agents.map(agent => formatCollabAgentHandle(agent.id, agent.name)).join('、')
}

/**
 * 目录归一。调用点可以给完整目录(含用户、退休成员),也可以只给一批 agent
 * —— 后者是纯同事场景与既有测试的写法,在这里被就地转成目录。
 *
 * 接受两种入参是刻意的:强迫每个调用点先自己转一道,只会让"忘了转"变成新的
 * 裂缝,而这个模块的全部教训就是**识别面不该由调用点各自决定**。
 */
export type CollabAddressable = CollabIdentity | CollabAgentLike

function normalizeDirectory(
  scope: readonly CollabAddressable[],
): CollabIdentity[] {
  const directory: CollabIdentity[] = []
  for (const entry of scope) {
    if (!entry) continue
    const asIdentity = entry as CollabIdentity
    if (typeof asIdentity.handle === 'string' && typeof asIdentity.kind === 'string') {
      directory.push(asIdentity)
      continue
    }
    const agent = entry as CollabAgentLike
    if (agent.id?.trim()) directory.push(collabIdentitiesFromAgents([agent])[0])
  }
  return directory
}

/**
 * 入站:正文里被**点名**的那些 `@名字#句柄` / `@#句柄` → mentions。
 *
 * 只有带 `@` 的算点名。裸写的 `名字#句柄`(叙述里提到某人)照样会被剥掉句柄,
 * 但**不进 mentions** —— 「说到某人」与「叫某人」是两件事,后者才该把人拉起来。
 *
 * 名字部分不参与判定:句柄指到谁就是谁。label 从目录现取,与 W14a 的
 * 「客户端不得给别人起名」同一条纪律。
 */
export function parseCollabHandleMentions(
  text: string | undefined | null,
  scope: readonly CollabAddressable[],
): CollabMentionLike[] {
  const seen = new Set<string>()
  const mentions: CollabMentionLike[] = []
  for (const hit of scanCollabHandleMentions(text, scope)) {
    if (!hit.addressed) continue
    const identity = hit.identity
    // 用户没有 agent id —— 空串是**诚实**的,而所有消费方本来就有空值门
    // (unionTurnMentions / normalizeCollabMentions 都是 `if (!agentId) continue`),
    // 所以它天然不进激活、不进成员校验。合成一个假 id 才会在很远的地方炸。
    const key = identity.kind === 'user' ? 'user' : identity.agentId ?? ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    mentions.push(identity.kind === 'user'
      // 句柄进 userHandle 而不是 agentId:那是 TA 真实的标识符,落库时不该丢
      // (网关渠道进来的是多个真人,「是用户」那一刻不再是一个身份)。
      ? { kind: 'user', agentId: '', label: identity.label, userHandle: identity.handle }
      : { agentId: identity.agentId ?? '', label: identity.label })
  }
  return mentions
}

interface CollabHandleHit {
  /** 整段起点(带 `@` 时指向 `@`)。 */
  index: number
  /** 整段长度。 */
  length: number
  identity: CollabIdentity
  /** 模型写的名字部分(`@#句柄` 时为空)。 */
  writtenName: string
  /** 带 `@` = 点名行为;否则是叙述里提到。 */
  addressed: boolean
}

/**
 * 扫出正文里每一处句柄。解析与剥离共用这一次扫描 —— 两个匹配器扫同一段文本,
 * 就是"剥掉的和认出的不是同一批"的开始。
 *
 * 判据分级(docs/design/collab-handle-codec.md §2.2),因为要与看板短卡号
 * `#a1b2c3d4` 共存:
 *
 *  - `@名字#句柄` / `@#句柄` —— **句柄说了算**,名字对不上照样认(点名行为,
 *    模型可能拿旧名字配新句柄);
 *  - `名字#句柄`(裸) —— **名实必须相符**:`#` 前紧挨着的必须是这个身份的
 *    label 或别名。卡号引用永远不会把指派人的名字粘在 `#` 前面,所以两者
 *    结构上撞不了车;
 *  - `#句柄`(独立成词) —— **不认**。这一格是卡号的地盘,没有上下文可依。
 */
function scanCollabHandleMentions(
  text: string | undefined | null,
  scope: readonly CollabAddressable[],
): CollabHandleHit[] {
  const source = text ?? ''
  if (!source.includes('#')) return []

  const byHandle = new Map<string, CollabIdentity>()
  for (const identity of normalizeDirectory(scope)) {
    const handle = identity.handle?.trim()
    if (!handle || byHandle.has(handle)) continue
    byHandle.set(handle, identity)
  }
  if (byHandle.size === 0) return []

  const hits: CollabHandleHit[] = []
  let cursor = 0
  while (cursor < source.length) {
    const hash = source.indexOf('#', cursor)
    if (hash < 0) break
    const handleEnd = scanHandleChars(source, hash + 1)
    const identity = handleEnd > hash + 1
      ? byHandle.get(source.slice(hash + 1, handleEnd))
      : undefined
    if (!identity) {
      cursor = hash + 1
      continue
    }

    // ① 同一个"词"里往回找 `@`。跨过空白就放弃 —— 一个够过空格去接 `#` 的
    //    匹配会把「@小李 看下 #a1b2c3d4」误读成一次点名。
    const at = findAddressingAt(source, hash)
    if (at >= 0) {
      hits.push({
        index: at,
        length: handleEnd - at,
        identity,
        writtenName: source.slice(at + 1, hash),
        addressed: true,
      })
      cursor = handleEnd
      continue
    }

    // ② 裸形态:`#` 前必须正好接着这个身份认的某个名字(取最长的那个)。
    //    这一步不需要定义"什么算名字字符" —— 直接拿已知的名字去比结尾,
    //    于是反引号、引号、括号这些包裹符天然落在名字之外。
    const matched = matchTrailingName(source.slice(0, hash), identity)
    if (matched) {
      const start = hash - matched.length
      hits.push({
        index: start,
        length: handleEnd - start,
        identity,
        writtenName: matched,
        addressed: false,
      })
      cursor = handleEnd
      continue
    }

    cursor = handleEnd
  }
  return hits
}

/** 从 `hash` 往回找同一个词里的 `@`;遇到空白或另一个 `#` 就放弃。 */
function findAddressingAt(source: string, hash: number): number {
  for (let index = hash - 1; index >= 0; index -= 1) {
    const char = source[index]
    if (char === '@') return index
    if (char === '#' || /\s/.test(char)) return -1
  }
  return -1
}

/** `#` 之前是不是正好接着这个身份认的名字。返回命中的那个写法(取最长)。 */
function matchTrailingName(before: string, identity: CollabIdentity): string | null {
  const names = [identity.label, ...identity.aliases]
    .map(name => name?.trim())
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => b.length - a.length)
  const lower = before.toLowerCase()
  for (const name of names) {
    if (before.endsWith(name)) return before.slice(before.length - name.length)
    if (lower.endsWith(name.toLowerCase())) return before.slice(before.length - name.length)
  }
  return null
}

/** 句柄本体:十六进制与连字符(全 key 兜底时会带 `-`)。 */
function scanHandleChars(source: string, from: number): number {
  let index = from
  while (index < source.length && /[0-9a-zA-Z-]/.test(source[index])) index += 1
  return index
}

/**
 * 入站:把认出来的句柄从正文里删掉,再落库。
 *
 * 于是房间里、UI 里、别人的投影里看到的仍然是干净的一句话,而身份走 mentions[]
 * —— 这正是出站拼句柄的逆运算,两个方向必须成对存在,否则句柄会一层层堆进转录
 * (而模型看见转录里有句柄,会开始把它当成可讨论、可试验的东西,泄漏自我放大)。
 *
 * 认不出的原样留着:模型把句柄写错了,它下一轮能在自己的转录里看见自己写错了。
 * `@#句柄` 这种没写名字的补上现名,免得群里出现一串十六进制。
 */
export function stripCollabAgentHandles(
  text: string | undefined | null,
  scope: readonly CollabAddressable[],
): string {
  const source = text ?? ''
  const hits = scanCollabHandleMentions(source, scope)
  if (hits.length === 0) return source

  let output = ''
  let cursor = 0
  for (const hit of hits) {
    output += source.slice(cursor, hit.index)
    const written = hit.writtenName.trim()
    output += hit.addressed
      ? `@${written || hit.identity.label}`
      : hit.writtenName
    cursor = hit.index + hit.length
  }
  output += source.slice(cursor)
  return output
}
