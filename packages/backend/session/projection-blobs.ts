/**
 * 投影的 **blob 回放口 + 退化留痕**(A8/A9/F6,§13.6)。
 *
 * core 的投影是纯的:它只认得 `BlobRef`,换回正文要宿主给一个读口。这个模块
 * 就是那个读口的**唯一**装配处 —— 从前每个消费者(影子断言、events 读路径)
 * 各自 `resolveHistoryBlobRefs(msg, ref => readSessionBlobText(...))` 抄一遍,
 * 于是 A8(工具大结果)这类新落点补上时,补一处漏一处。
 *
 * ## F6:退化不再是静默的
 *
 * blob 读不到时投影仍然退化(附件摘掉 / 结果留引用),但每一次都会:
 *  - 记进 `session-shadow-stats.json` 的 `projectionIssues`(报告与门看得见);
 *  - **每会话 warn 一次**(多了就成刷屏 —— 一条会话里同一个 blob 会被读几十次)。
 *
 * 绝不抛:投影跑在引擎热路径上,记账坏掉不能让聊天挂掉(S1 三条纪律的第一条)。
 */

import type { BlobRef, ProjectionIssue, ProjectionMaterializeOptions } from '@onething/core/session'
import { readSessionBlob } from './blob-store.js'
import { bumpSessionShadowStats } from './event-stats.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

/** 已经喊过的会话(每会话一次)。 */
const warned = new Set<string>()

/** 会话删除 / 测试:忘掉"这条会话已经喊过了"。 */
export function resetSessionProjectionIssueCache(sessionId?: string): void {
  if (sessionId) warned.delete(sessionId)
  else warned.clear()
}

export function reportSessionProjectionIssue(sessionId: string, issue: ProjectionIssue): void {
  try {
    bumpSessionShadowStats({ projectionIssues: 1 })
    if (warned.has(sessionId)) return
    warned.add(sessionId)
    log.warn('projection degraded', {
      sessionId,
      kind: issue.kind,
      where: issue.where,
      ...(issue.hash ? { hash: issue.hash } : {}),
      ...(issue.messageId ? { messageId: issue.messageId } : {}),
    })
  } catch {
    // 留痕本身坏掉不该再制造第二条错误路径。
  }
}

/**
 * 二进制正文 vs 文本正文的判据(#3,§13.13)。
 *
 * blob 存的是**原始字节**(附件的图片 = `Buffer.from(base64,'base64')`,
 * 超 64KB 的工具结果 = utf8 文本)。回放时:
 *  - 图片 / 音视频 / PDF 等二进制 → `base64`(投影里附件的 `base64Data` /
 *    image part 的 `data` 要的就是 base64,与落盘前逐字节相同);
 *  - `text/*`(或没有 mime 的正文占位符路径)→ `utf8`。
 *
 * 用 utf8 去解一段图片字节会把它改写成 `�`(#3 的病根)——所以这一格必须按
 * mime 分流,而不是一律 utf8。没有 mime 的那条路(`onething-blob://` 正文占位符,
 * `resolveProjectionBlobText` 传的是 `{hash,bytes:0}`)本来就只装文本,退回 utf8。
 */
function blobRefWantsBase64(ref: BlobRef): boolean {
  return typeof ref.mime === 'string' && ref.mime.length > 0 && !ref.mime.startsWith('text/')
}

/**
 * 这条会话的物化选项:blob 读口 + 退化留痕。
 *
 * 每个读点都用它,别再手搓 `ref => readSessionBlob(...)` —— 那正是 A8 补上
 * 之后"补一处漏一处"的来源。读口按 mime 分流二进制 / 文本(`blobRefWantsBase64`);
 * 字节侧的 sha256 自校验在 `readSessionBlob` 里,损坏 = undefined = 走 F6 退化。
 */
export function sessionProjectionOptions(sessionId: string): ProjectionMaterializeOptions {
  return {
    resolveBlob: ref => {
      const buffer = readSessionBlob(sessionId, ref.hash)
      if (buffer === undefined) return undefined
      return blobRefWantsBase64(ref) ? buffer.toString('base64') : buffer.toString('utf8')
    },
    onIssue: issue => reportSessionProjectionIssue(sessionId, issue),
  }
}
