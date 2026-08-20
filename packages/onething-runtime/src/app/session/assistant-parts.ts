/**
 * 助手正文里**不经 agent-loop** 的那一段(S1b 缺口 3 → R-b 收口,§13.6)。
 *
 * 文本与推理的 delta 全部走 recorder(`assistant/chunks`),因为它们本来就是
 * agent-loop 的事件流。图片生成不是:它是引擎里的一条特化流(provider 的
 * image API → 媒体库 → **一段带 data URL 的 markdown 正文**),一条 delta 都不经
 * 过 agent-loop。于是事件账本上那次执行只有 `run/start` / `run/end` 两格,
 * 中间产出的东西一点痕迹都没有。
 *
 * ## R-b:记的是**正文**,不是图片本体(2026-08-20 用户裁定)
 *
 * S1b 当时补的是一条 `assistant/part-end{kind:'image', blob}`,并且诚实地写下了
 * 那条偏差:messages.jsonl 里那条消息的正文是 markdown,`ContentPart` 里**根本
 * 没有 image 成员** —— 投影产出一格产品里不存在的 part,而真正的正文整段缺席。
 *
 * 现在反过来:**记正文**。markdown 里那段 data URL(几百 KB,事件行装不下)
 * 换成 `onething-blob://<hash>` 占位符落进 blob store,投影按同一张表换回去 ——
 * `content` 与 `contentParts` 两格都与 messages.jsonl 逐字节相同。图片本体仍然
 * 在 blob 里(就是那段 data URL 的字节),媒体库那一份一个字节没动。
 *
 * 两格新词汇(§10.16 成对交付):
 *  - `assistant/part-end.synthetic` —— 这一格是引擎直接落到消息上的:不受
 *    "这一轮收齐了吗"那道闸管(它没有 `turn-end`),也不派生 `turnIndex`
 *    (消息上那一格就没有);
 *  - `onething-blob://<hash>` —— 正文里的 blob 占位符(`core/session/projection/blobs.ts`)。
 *
 * **老账本照旧**:里面那些 `kind:'image'` 的 part 仍然按 A2 的豁免物化成
 * image part(修复前的事实,一个字节不改)。
 */

import { projectionBlobUrl } from '@onething/core/session'
import {
  appendSessionLogEvent,
  nextSessionRequestIndex,
} from './event-log.js'
import { putSessionBlob } from './blob-store.js'
import { currentSessionRun, nextSessionRunPartIndex } from './runs.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('sessions.events')

/**
 * 正文里超过这个长度的 `data:` URL 才换成占位符。
 *
 * 不是 64KB(事件行的那条线):一段 40KB 的 base64 塞在正文里同样会让每一次
 * fold 都把它读一遍,而它天然是内容寻址去重的。1KB 以下的 data URL(小图标)
 * 留在行里 —— 换成占位符反而多一次文件读。
 */
const INLINE_DATA_URL_BLOB_THRESHOLD = 1024

const DATA_URL_PATTERN = /data:[^;,\s)]*;base64,[A-Za-z0-9+/=]+/g

/**
 * 正文 → 事件行里的那一份:大段 data URL 换成 `onething-blob://<hash>`。
 *
 * blob 写不进去就**留原文**(一条大一点的事件行,好过一条丢了正文的账)——
 * 与 `textOrBlobForEvent` 同一条退路。
 */
export function inlineDataUrlsToBlobs(sessionId: string, text: string): string {
  if (!text.includes('data:')) return text
  return text.replace(DATA_URL_PATTERN, match => {
    if (match.length < INLINE_DATA_URL_BLOB_THRESHOLD) return match
    const blob = putSessionBlob(sessionId, match, 'text/plain')
    return blob ? projectionBlobUrl(blob.hash) : match
  })
}

/**
 * 记一段引擎**自己落到消息上**的正文(今天唯一的产地:生图)。
 *
 * 与 recorder 的 `recordSynthesizedText` 是同一件事的两个作用域:那一个挂在
 * 一次 agent-loop 执行上(run 级),这一个只需要"这条会话现在跑的是哪次执行"
 * (会话级)—— 生图流没有 agent-loop,但它照样有 run(`beginSessionRun` 先开)。
 *
 * @returns 记下了就 true。没有活跃 run / 分不到 partIndex 时 false(不抛)。
 */
export function recordSynthesizedAssistantText(
  sessionId: string,
  messageId: string,
  text: string,
): boolean {
  try {
    if (!text) return false
    const run = currentSessionRun(sessionId)
    if (!run) return false
    const partIndex = nextSessionRunPartIndex(sessionId)
    if (partIndex === undefined) return false
    const requestIndex = run.requestIndex ?? nextSessionRequestIndex(sessionId)
    if (requestIndex === undefined) return false

    const payload = inlineDataUrlsToBlobs(sessionId, text)
    const now = Date.now()
    // 正文的唯一来源仍然是 `assistant/chunks` 的 fold —— 这里也走它(一条 delta),
    // 而不是给 part-end 加第二个正文字段(§9.2 的类型级门盯着这条)。
    appendSessionLogEvent(sessionId, 'assistant/chunks', {
      runId: run.runId,
      requestIndex,
      messageId,
      partIndex,
      kind: 'text',
      time0: now,
      dt: [0],
      text: [payload],
    })
    appendSessionLogEvent(sessionId, 'assistant/part-end', {
      runId: run.runId,
      requestIndex,
      messageId,
      partIndex,
      kind: 'text',
      len: payload.length,
      synthetic: true,
    })
    return true
  } catch (error) {
    log.warn('synthesized assistant text record failed', { sessionId }, error)
    return false
  }
}
