/**
 * 助手正文里**不经 agent-loop** 的那几段(S1b,§10.7 缺口 3)。
 *
 * 文本与推理的 delta 全部走 recorder(`assistant/chunks`),因为它们本来就是
 * agent-loop 的事件流。图片生成不是:它是引擎里的一条特化流(provider 的
 * image API → 媒体库 → 一条 markdown 正文),一条 delta 都不经过 agent-loop。
 * 于是事件账本上那次执行只有 `run/start` / `run/end` 两格,中间产出的图片
 * 一点痕迹都没有。
 *
 * 这个模块把那一格补上:图片本体进 blob store(内容寻址、写一次),事件行里
 * 留一条 `assistant/part-end{kind:'image', blob}` —— 与 §9.2 给图片留的位子
 * 逐字对上。
 *
 * ## 一条必须说清楚的偏差
 *
 * 今天 messages.jsonl 里那条消息的正文是**一段带 base64 data URL 的 markdown
 * 文本**(`media/image-generation.ts` 的 `buildImageStreamResponseContent`),
 * `ContentPart` 里根本没有 image 成员。所以投影出来的那条消息与事实**不等**:
 * 投影有一格 image part、没有那段 markdown。
 *
 * 这条偏差**故意不掩盖** —— 影子断言会照实报 `kind:'messages'` 的不等。把它
 * 豁免掉才是错的:那等于让 S2 切读之后图片正文凭空消失,而门却是绿的。
 * 收口方案(把 markdown 正文也记成 chunks,还是让渲染层认 image part)属于 S2
 * 的读路径裁定,不在影子期自作主张。
 *
 * ## A2:那一格曾经被另一道闸吃掉(2026-08-20,§13.1 / §13.5)
 *
 * 上面那句"投影有一格 image part"一度**不成立**:§10.14 给 contentParts 加了
 * "这一轮收齐了吗"的闸(`settledRequests`,来源是 agent-loop 的 `request/end`),
 * 而图片流从来不发那条事件 —— 于是这里辛苦记下的 part 在投影里一格都不剩,
 * 头注释描述的偏差变成了"整格消失",而且没人看得见。
 *
 * 现在 `materializeContentParts` 对 `kind:'image'` **豁免**那道闸
 * (`isSettleExemptPartKind`)。豁免而不是"让图片流补记一对 request 事件":
 * 那两条事件说的是"向模型发了一次请求、收齐了一次响应",这条路没有发生过那件事。
 */

import {
  appendSessionLogEvent,
  nextSessionRequestIndex,
} from './event-log.js'
import { putSessionBlob } from './blob-store.js'
import { currentSessionRun, nextSessionRunPartIndex } from './runs.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('sessions.events')


/**
 * 记一段生成出来的图片正文。
 *
 * @param base64 图片本体(不带 `data:` 前缀)。
 * @returns 落下的 blob 引用;没有活跃 run / 写不进去时 `undefined`。
 */
export function recordGeneratedImagePart(
  sessionId: string,
  messageId: string,
  base64: string,
  mime = 'image/png',
): { hash: string; bytes: number; mime?: string } | undefined {
  try {
    const run = currentSessionRun(sessionId)
    if (!run) return undefined
    const blob = putSessionBlob(sessionId, Buffer.from(base64, 'base64'), mime)
    if (!blob) return undefined
    const partIndex = nextSessionRunPartIndex(sessionId)
    if (partIndex === undefined) return undefined
    const requestIndex = run.requestIndex ?? nextSessionRequestIndex(sessionId)
    if (requestIndex === undefined) return undefined
    appendSessionLogEvent(sessionId, 'assistant/part-end', {
      runId: run.runId,
      requestIndex,
      messageId,
      partIndex,
      kind: 'image',
      len: blob.bytes,
      hash: blob.hash,
      blob,
    })
    return blob
  } catch (error) {
    log.warn('image part record failed', { sessionId }, error)
    return undefined
  }
}
