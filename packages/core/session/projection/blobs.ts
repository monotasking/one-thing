/**
 * 投影侧的 **BlobRef → 正文** 回填(G8 的另一半;A8/A9/F6/R-b,§13.6)。
 *
 * 事件行放不下的东西一律换成 `BlobRef`(附件的 base64、超 64KB 的工具结果、
 * provider-data 的大载荷、生图正文里那段 data URL)。投影要给出与
 * `messages.jsonl` **逐字节相同**的一份,所以回放时必须换回来 —— 换回来的口子
 * 只有一个:宿主注入的 `resolveBlob`。
 *
 * ## 三条纪律
 *
 * 1. **不猜**。拿不到正文就退化(附件摘掉、结果留引用),但**绝不**把一个
 *    `{hash,bytes}` 对象当成 base64 发出去 —— 那是最难查的一类脏请求。
 * 2. **退化必须留痕**(F6,§13.2)。从前"读不到就静默摘掉"是 S2b 的数据丢失面:
 *    附件凭空变短,而两侧的账都是绿的。现在每一次退化都产出一条
 *    `ProjectionIssue`,由调用方决定怎么喊(`sessions:verify` 打印,宿主 warn 一次)。
 *    **不抛** —— 投影跑在引擎的热路径上,记账坏掉不能让聊天挂掉。
 * 3. **落点与回放同一函数**。落盘时把大正文换成引用的是 app 层的 blob store,
 *    换回来的是这里,两边认的是同一个 `isBlobRef` / 同一个占位符形式。
 */

import type { BlobRef } from '../events/types.js'
import { isBlobRef } from '../events/types.js'

/**
 * 一次**退化**的记录:投影给出的这一格不是完整事实。
 *
 *  - `blob-missing`(F6):引用换不回正文 —— 附件被摘掉 / 结果留着引用;
 *  - `turn-split-fallback`(F8):多回合的助手消息掉回"合并成一段独白"的老口径。
 */
export interface ProjectionIssue {
  kind: 'blob-missing' | 'turn-split-fallback'
  /** 哪一格退化了(`attachments.base64Data` / `tool.result` / `part.text` …)。 */
  where: string
  hash?: string
  /** 认得出是哪条消息时带上(附件/工具结果都带得出来)。 */
  messageId?: string
}

export type ProjectionBlobResolver = (ref: BlobRef) => string | undefined

/**
 * 投影**物化**阶段的注入口。
 *
 * 折叠(`reduceSessionProjection`)一个字节都不需要它 —— 事件里存的就是引用;
 * 只有把节点变成 `ChatMessage` 的那一刻才需要正文。所以它挂在 materialize 上,
 * 活投影可以一直缓存着而不必记住是谁在读。
 */
export interface ProjectionMaterializeOptions {
  resolveBlob?: ProjectionBlobResolver
  /** 每一次退化调一次(F6)。不传 = 照旧退化,只是没人看见。 */
  onIssue?: (issue: ProjectionIssue) => void
}

/**
 * 正文里的 blob 占位符(R-b,§13.6)。
 *
 * 生图那条特化流的正文是一整段带 `data:image/png;base64,…` 的 markdown ——
 * 几百 KB,进不了事件行。采集点把**整个 data URL** 落进 blob store,行里留下
 * 这个占位符;投影按同一张表换回去,于是 `content` 与 messages.jsonl 逐字节相同。
 *
 * 形式故意选得又短又不可能自然出现:`onething-blob://<hash>`。它是一个 URL,
 * 所以即便某一天回放不到(blob 丢了),留在 markdown 里的也是一段不会渲染成
 * 半张图的东西 —— 而且 F6 会把这次退化记下来。
 */
export const PROJECTION_BLOB_URL_SCHEME = 'onething-blob://'

const BLOB_URL_PATTERN = /onething-blob:\/\/([0-9a-f]{8,64})/g

/** 把一段正文里的占位符换成引用(采集点用)。 */
export function projectionBlobUrl(hash: string): string {
  return `${PROJECTION_BLOB_URL_SCHEME}${hash}`
}

/** 这段正文里有占位符吗(热路径上的短路:绝大多数正文没有)。 */
export function hasProjectionBlobUrl(text: string): boolean {
  return text.includes(PROJECTION_BLOB_URL_SCHEME)
}

/**
 * 正文回放:把 `onething-blob://<hash>` 换回那段正文。
 *
 * 拿不到就**原样留着占位符**(比留半段 base64 诚实)并记一条 issue。
 * 占位符里只有 hash —— 回放口要的 `bytes` 在这条路上没有意义,给 0。
 */
export function resolveProjectionBlobText(
  text: string,
  options: ProjectionMaterializeOptions,
  where: string,
  messageId?: string,
): string {
  if (!text || !hasProjectionBlobUrl(text)) return text
  return text.replace(BLOB_URL_PATTERN, (whole, hash: string) => {
    const resolved = options.resolveBlob?.({ hash, bytes: 0 })
    if (resolved !== undefined) return resolved
    options.onIssue?.({ kind: 'blob-missing', where, hash, ...(messageId ? { messageId } : {}) })
    return whole
  })
}

/**
 * 一格 `BlobRef` → 正文;拿不到就 `undefined` 并记一条 issue。
 *
 * 值不是 `BlobRef` 时原样返回 `undefined` 而**不**记 issue —— 那不是退化,
 * 是这一格本来就没有引用。
 */
export function resolveProjectionBlobRef(
  ref: unknown,
  options: ProjectionMaterializeOptions,
  where: string,
  messageId?: string,
): string | undefined {
  if (!isBlobRef(ref)) return undefined
  const resolved = options.resolveBlob?.(ref)
  if (resolved !== undefined) return resolved
  options.onIssue?.({ kind: 'blob-missing', where, hash: ref.hash, ...(messageId ? { messageId } : {}) })
  return undefined
}

/**
 * 消息上带 `BlobRef` 的两格(附件正文 / part 正文)一次换回。
 *
 * 从 `model-history.ts` 搬过来的那一份(它原本只服务模型历史),现在是**唯一**
 * 一份:`materializeChatMessages` 也走它,于是"投影出的消息"与"发给模型的历史"
 * 在这一格上不可能分叉。`model-history.ts` 仍然再导出这个名字(既有消费者)。
 */
export function resolveHistoryBlobRefs<TMessage>(
  message: TMessage,
  resolveBlob: ProjectionBlobResolver | undefined,
  onIssue?: (issue: ProjectionIssue) => void,
  /**
   * 换不回来时怎么办 —— **两条路两个答案**:
   *
   *  - `'drop'`(缺省,模型历史那条路):摘掉那一格。一个 `{hash,bytes}` 对象
   *    被当成 base64 发出去是最难查的一类脏请求(请求发得出去,模型看到一句 JSON);
   *  - `'keep'`(投影出的**消息**那条路):照实留引用。屏幕上那一格会是个占位,
   *    而这正是事实 —— 把整格摘掉等于让一条带图的消息凭空变短(A2 / provider-data
   *    两处早就写着"照实留引用"这条口径)。
   *
   * 两条路都记 issue(F6),退化本身不再是静默的。
   */
  onMissing: 'drop' | 'keep' = 'drop',
): TMessage {
  const record = message as unknown as Record<string, unknown>
  const attachments = record.attachments
  const contentParts = record.contentParts
  const options: ProjectionMaterializeOptions = {
    ...(resolveBlob ? { resolveBlob } : {}),
    ...(onIssue ? { onIssue } : {}),
  }
  const messageId = typeof record.id === 'string' ? record.id : undefined

  const nextAttachments = Array.isArray(attachments)
    ? resolveBlobList(attachments, 'base64Data', options, messageId, onMissing)
    : undefined
  const nextParts = Array.isArray(contentParts)
    ? resolveBlobList(contentParts, 'blob', options, messageId, onMissing)
    : undefined

  if (nextAttachments === undefined && nextParts === undefined) return message
  return {
    ...(record as object),
    ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
    ...(nextParts !== undefined ? { contentParts: nextParts } : {}),
  } as TMessage
}

/** @returns undefined = 这一格没有任何 BlobRef,原样复用(不复制数组)。 */
function resolveBlobList(
  items: readonly unknown[],
  key: string,
  options: ProjectionMaterializeOptions,
  messageId: string | undefined,
  onMissing: 'drop' | 'keep',
): unknown[] | undefined {
  let changed = false
  const out: unknown[] = []
  for (const item of items) {
    const ref = (item as Record<string, unknown> | null)?.[key]
    if (!isBlobRef(ref)) {
      out.push(item)
      continue
    }
    changed = true
    const resolved = resolveProjectionBlobRef(
      ref,
      options,
      key === 'blob' ? 'contentParts.blob' : `attachments.${key}`,
      messageId,
    )
    if (resolved === undefined) {
      // 见 `onMissing` 的注释:模型历史摘掉,消息照实留引用。
      if (onMissing === 'drop') continue
      out.push(item)
      continue
    }
    out.push(key === 'blob'
      // 图片 part 的正文回到 `data`(与落盘前同名),blob 引用撤下。
      ? { ...(item as object), blob: undefined, data: resolved }
      : { ...(item as object), [key]: resolved })
  }
  return changed ? out : undefined
}
