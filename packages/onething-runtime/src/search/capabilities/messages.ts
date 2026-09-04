/**
 * 消息检索能力 —— **索引型**(S3b)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(索引基座)/ §5.1(文档模型)/
 * §6.5(打分是能力的事)/ §10 S3 行(「messages / sessions / daily 换成
 * `indexedCapability`」)。
 *
 * S2 里它是 `scan` 基座裹着那只全库扫的 `searchMessages`(真店实测 1.6s、无预算、
 * 子串匹配)。这一期换成 `indexedCapability` + 一路
 * `createSqliteLexicalRetriever` —— 病根(每次查询把整个会话库读一遍)在这一行
 * 消失,而**上层一个字不改**:注册表、流水线、`all` 档配额、壳读的那几个字段全是
 * 原样(§4.2「只有一路时 fuse 是恒等」)。
 *
 * ## 这份 manifest 说的话
 *
 *  - `schema` —— 索引哪几个字段、各多重。三格与 `IndexProjector` 产出的
 *    `fields` 逐字对应(`content` / `attachments` / `reasoning`);推理那一格默认
 *    根本不产(拍点乙 (a)),权重 0.6 是「产了也别盖过正文」。
 *  - `facets` —— 五个键与投影器写进 `doc_facets` 的**逐字同名**。授权范围
 *    (§6.4b)与壳的过滤片都从这里认路。
 *  - `ranking` —— §6.5 那几格数据:30 天半衰、用户消息 ×1.1。**core 里没有 `role`
 *    这个词**,它只出现在这一份自述里。`pinFieldHit` 这一格 S3b **删了**:消息文档
 *    没有 `title` 字段,声明它永远不触发,而自述里不许有假话。
 *  - `budget.timeoutMs: 300` —— S2 那个 `0`(不设刹车)是给全库扫的临时豁免,
 *    换索引之后钉真预算(§10 S2 行末句「S3 换索引后再钉真预算」)。
 *
 * ## 与 S2 的可感知出入(报告里逐条列过)
 *
 *  - 空词不再答:索引对零词元查询答零命中(FTS 没有「全都要」这一形),所以
 *    `supports` 用基座的缺省(有词才答),`all` 档在空词下**没有**这一组,而不是
 *    有一组 0 条。
 *  - 匹配语义从子串变成词与前缀(§13 留账「中段子串」那一条),放宽阶梯因此有了
 *    意义 —— `relax` 回到缺省的 true。
 */

import {
  indexedCapability,
  type Candidate,
  type CapabilityManifest,
  type PreviewPayload,
  type SearchCapability,
} from '@onething/core/search'
import { createSqliteLexicalRetriever } from '../index/service.js'
import type { OnethingSearchMessage, OnethingSearchProvidersAdapters } from '../providers.js'
import {
  createSessionShellLookup,
  snippetOf,
  trackIndexGeneration,
  type SearchIndexQueryFace,
} from './indexed.js'
import type { LegacyBackedCandidate, SearchServiceResult } from './legacy.js'
import {
  PreviewUnavailableError,
  firstCandidate,
  requireStringField,
  targetPayloadOf,
  type MessageContextPreview,
  type PreviewMessage,
} from './preview.js'

/** 这一类的目标形(§4.1;壳的 `locate-message` 落点吃它)。 */
export interface MessageTarget {
  kind: 'message'
  payload: { sessionId: string; messageId: string }
}

export const messagesSearchManifest: CapabilityManifest = {
  id: 'messages',
  labelKey: 'search.capability.messages',
  icon: 'MessagesSquare',
  kind: 'indexed',
  schema: {
    content: { analyzer: 'composite', weight: 1 },
    attachments: { analyzer: 'composite', weight: 1 },
    reasoning: { analyzer: 'composite', weight: 0.6 },
  },
  facets: [
    { key: 'sessionId', type: 'enum' },
    { key: 'spaceId', type: 'enum' },
    { key: 'role', type: 'enum' },
    { key: 'archived', type: 'boolean' },
    { key: 'time', type: 'range' },
  ],
  budget: { default: 5, timeoutMs: 300 },
  order: 5,
  orderWhenIntent: { actions: 6 },
  // **没有 `pinFieldHit`**:消息文档的字段是正文 / 附件名 / 推理(拍点乙 a),没有
  // `title` 这一格,声明它等于写一句永不触发的假话(S3b 删)。要「标题命中置顶」就
  // 得先让投影器把会话标题写进消息文档 —— 那是另一件事,没做就别在自述里说。
  ranking: { halfLifeDays: 30, boosts: { role: { user: 1.1 } } },
  // 用户什么都看得见(§6.4b 的缺省);agent 那一支是 S6(拍点辛)。
  visibility: () => ({}),
  // **lazy**(§4.5 ①):上下文要把那间会话的账本翻一遍,不是随候选带得起的东西 ——
  // 一次 `all` 档五条命中就是五次翻账本。选中再取,↑↓ 换行由壳 abort 上一条。
  preview: { mode: 'lazy' },
}

/** 命中那条前后各留几条。§4.5 那张表写的是「命中消息 ± N 条」,N 在这里定一次。 */
const MESSAGE_CONTEXT_RADIUS = 2

/**
 * 一条 raw 消息 → 预览里那四格。
 *
 * `content` **非字符串就是空串** —— 与旧扫描路 `searchMessages` 那一刀逐字同源
 * (多模态那些 `content` 是数组,这一层不去展开它;要画附件是另一件事)。
 */
function previewMessageOf(message: OnethingSearchMessage): PreviewMessage {
  const text = typeof message.content === 'string' ? message.content : ''
  const shell: PreviewMessage = { id: message.id, role: message.role ?? '', text }
  return message.timestamp === undefined ? shell : { ...shell, timestamp: message.timestamp }
}

/**
 * 命中消息 ± N 条(§4.5 ②那张表的 `message-context` 那一行)。
 *
 * **零副作用**靠取材口保证:`iterateSessionMessages` 是 raw 语义的端口(宿主接的是
 * `sessionReads.iterateMessagesRaw`)—— 不进 LRU、不 sanitize、不回写,所以翻一遍
 * 账本既不会把这间会话灌进缓存,也不会碰 `meta.json` 的任何一格。「已读」在这个
 * 产品里根本不是一格持久状态,预览连打开态都不改。
 *
 * 找不到那条消息(账本被压缩过、或候选是上一代索引留下的)就抛**原话**,由服务层
 * 捞成 `{ success:false, error }` —— 不给一段「前后都是空」的假上下文。
 */
function messageContextPreview(
  adapters: OnethingSearchProvidersAdapters,
  candidates: Candidate[],
): PreviewPayload {
  const candidate = firstCandidate(candidates)
  const payload = targetPayloadOf(candidate, 'message')
  const sessionId = requireStringField(payload, 'sessionId', '这条消息命中')
  const messageId = requireStringField(payload, 'messageId', '这条消息命中')

  // 一次性物化:要取「前面两条」就必须能往回看,而端口是 Iterable 不是随机访问。
  // 会话消息数 p99 是 296 条(§4.6 的真库读数),一条会话的量级是安全的。
  const messages = [...adapters.iterateSessionMessages(sessionId)]
  const at = messages.findIndex(message => message.id === messageId)
  if (at < 0) {
    throw new PreviewUnavailableError(`会话 ${sessionId} 的账本里已经没有这条消息了`)
  }

  const context: MessageContextPreview = {
    sessionId,
    messageId,
    hit: previewMessageOf(messages[at]),
    before: messages.slice(Math.max(0, at - MESSAGE_CONTEXT_RADIUS), at).map(previewMessageOf),
    after: messages.slice(at + 1, at + 1 + MESSAGE_CONTEXT_RADIUS).map(previewMessageOf),
  }
  return { kind: 'message-context', payload: context, title: candidate.subtitle }
}

export function createMessagesSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
  index: SearchIndexQueryFace,
): SearchCapability {
  const sessionOf = createSessionShellLookup(() => adapters.getSessionsList(), session => session.id)
  const tracked = trackIndexGeneration(index)

  const indexed = indexedCapability({
    manifest: messagesSearchManifest,
    generation: tracked.generation,
    retrievers: [createSqliteLexicalRetriever({
      manifest: messagesSearchManifest,
      service: tracked.face,
      toCandidate({ doc, hit, score }) {
        // 文档 key 是 `${sessionId}:${messageId}`(投影器定的);会话号另有 facet,
        // 消息号从 key 里剥 —— 会话号本身可以带冒号,所以从**第一个**冒号切。
        const sessionId = typeof doc.facets.sessionId === 'string' ? doc.facets.sessionId : ''
        const messageId = doc.key.slice(sessionId.length + 1)
        const role = typeof doc.facets.role === 'string' ? doc.facets.role : ''
        const snippet = snippetOf(doc.fields.content ?? '', hit.matched)
        const session = sessionOf(sessionId)

        const legacy: SearchServiceResult = {
          id: `msg:${sessionId}:${messageId}`,
          type: 'message',
          title: snippet.text,
          subtitle: session?.name || 'New Chat',
          detail: role === 'user' ? 'User message' : 'Assistant message',
          sessionId,
          messageId,
          timestamp: doc.time,
          matchRanges: snippet.ranges,
        }
        const candidate: LegacyBackedCandidate = {
          capability: messagesSearchManifest.id,
          id: legacy.id,
          title: legacy.title,
          subtitle: legacy.subtitle,
          ranges: snippet.ranges,
          score,
          time: doc.time,
          target: { kind: 'message', payload: { sessionId, messageId } } satisfies MessageTarget,
          facets: doc.facets,
          legacy,
        }
        return candidate
      },
    })],
  })

  // 基座只管「怎么搜」;`preview` 是能力自己多说的一句话,所以在这里摊开而不是
  // 塞进 `indexedCapability` 的选项(基座不认识预览,§4.2 三种基座一格没加)。
  return { ...indexed, preview: async candidates => messageContextPreview(adapters, candidates) }
}
