/**
 * 会话 blob 存储(S1a,`docs/design/session-event-sourcing-2026-08.md` §10.6 第 6 条)。
 *
 * `sessions/<id>/blobs/<sha256-16>` —— **内容寻址、写一次、同步写**。
 *
 * 它存的是事件行里放不下的那部分正文:附件的 `base64Data`、超过 64KB 的工具
 * 结果、图片 part。事件行里留下的只有 `BlobRef {hash, bytes, mime?}`
 * (`@onething/core/session` 的 `isBlobRef` 是两侧共用的判据)。
 *
 * 四条约定,读这个文件时请带着:
 *
 * 1. **内容寻址 = 天然去重**。同一段正文在一个会话里出现十次也只有一份文件;
 *    hash 就是文件名,所以"写之前先看在不在"是一次 `existsSync`,不是一张表。
 * 2. **写一次,永不改写**。已经存在的 hash 直接返回引用 —— 内容寻址下"同名不同
 *    内容"不可能发生,再写一遍只是浪费一次 IO。
 * 3. **同步写**。blob 与那条引用它的事件必须**同时**成立:异步写会让崩溃留下一
 *    条指向不存在文件的引用,而事件是 append-only 的、修不回来。小文件同步写的
 *    代价(几十 KB 级)远小于这条不变量的价值。
 * 4. **随会话一起删**。blobs 住在会话目录里,`storageDriver.delete()` 是
 *    `rmSync(sessionDir, {recursive:true})` —— 会话删了 blob 跟着走,不需要
 *    第二套回收器(而任何"第二套回收器"都会在某个分支上漏掉一类引用)。
 *
 * 写失败**不抛**:S1 仍是影子期,记账坏了不能影响聊天。失败计进
 * `session-shadow-stats.json` 的 `appendFailures` 并每会话 warn 一次
 * (§10.3 ②),调用方拿到 `undefined` 就退回"正文进事件行"或"只留预览"。
 *
 * **S3w-3 批 6b 起 blob 写失败无条件上抛**(§14.6 裁定 7)。理由是那条退路已经
 * 不存在 —— 从前附件 base64 落 blob 失败时"正文还在 messages.jsonl"(§10.1 的
 * 兜底);抄本停写并删码之后,同一次失败 = 正文**永久丢失**(§14.7 风险④)。
 * 上面那段"写失败不抛"说的是 S1 影子期的世界,已成历史。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { BlobRef } from '@onething/core/session'
import { SESSION_EVENT_BLOB_THRESHOLD_BYTES } from '@onething/core/session'
import {
  getOnethingSessionsDir,
} from '@onething/runtime/storage'
import { countSessionEventFailure } from './event-stats.js'
import { SessionEventWriteError } from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

export const SESSION_BLOBS_DIRNAME = 'blobs'

/** 文件名 = sha256 前 16 位(与 system prompt / tools 指纹同长度口径)。 */
export function hashSessionBlob(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function getSessionBlobsDir(sessionId: string): string {
  return path.join(getOnethingSessionsDir(), sessionId, SESSION_BLOBS_DIRNAME)
}

export function getSessionBlobPath(sessionId: string, hash: string): string {
  return path.join(getSessionBlobsDir(sessionId), hash)
}

/**
 * 落一段正文,拿回引用。已存在的同 hash 内容直接复用(不重写)。
 *
 * @returns 写不进去时抛 `SessionEventWriteError`(批 6b 起无条件)—— 那条退路
 *          (正文还在抄本里)已经不存在了。签名里的 `undefined` 留给"没什么可写"
 *          之外的调用方形状,不再是写失败的出口。
 */
export function putSessionBlob(
  sessionId: string,
  data: string | Buffer,
  mime?: string,
): BlobRef | undefined {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const hash = hashSessionBlob(buffer)
  const target = getSessionBlobPath(sessionId, hash)
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(getSessionBlobsDir(sessionId), { recursive: true })
      // 同一 hash 必然同一内容,所以"另一个写者同时在写"是无害的重复写,
      // 不是竞态 —— 不加锁,也不做 rename 原子发布(那要多一次落盘)。
      fs.writeFileSync(target, buffer)
    }
  } catch (error) {
    countSessionEventFailure(sessionId, error, 'blob write failed')
    // 裁定 7:抄本没了,blob 写失败 = 正文永久丢失,不再可吞。
    throw new SessionEventWriteError(sessionId, 'blob write failed', { cause: error })
  }
  return {
    hash,
    bytes: buffer.byteLength,
    ...(mime ? { mime } : {}),
  }
}

/**
 * 读回原始字节(#3,§13.13)。文件不在 = 这条引用没有对应的正文,返回 undefined。
 *
 * **读时自校验(dsh 的安全网)**:blob 是内容寻址的 —— 文件名**就是**这段字节的
 * sha256(前 16 位,`hashSessionBlob`)。读回来重算一遍,对不上就当**损坏**处理:
 * 返回 undefined(调用方走 F6 退化,`blob-missing` 那条 issue 会记下来),而不是把
 * 一段被截断 / 被改写的字节当成正文投出去。**不抛** —— 投影跑在引擎热路径上。
 */
export function readSessionBlob(sessionId: string, hash: string): Buffer | undefined {
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(getSessionBlobPath(sessionId, hash))
  } catch {
    return undefined
  }
  const actual = hashSessionBlob(buffer)
  if (actual !== hash) {
    // 内容寻址下"文件名 ≠ 内容 hash"= 磁盘上这段 blob 坏了(被截断 / 被覆盖)。
    // 当成读不到:调用方退化留痕,不把脏字节投出去。
    log.warn('session blob failed sha256 self-check', { sessionId, hash, actual, bytes: buffer.byteLength })
    return undefined
  }
  return buffer
}

/** 读回 base64(图片等二进制正文的回放口,#3)。字节走同一条自校验路。 */
export function readSessionBlobBase64(sessionId: string, hash: string): string | undefined {
  return readSessionBlob(sessionId, hash)?.toString('base64')
}

/**
 * 读回文本正文(utf8)。走 `readSessionBlob` 同一条自校验路,只是最后按 utf8 解。
 * 文件不在 / 自校验失败 = 返回 undefined。
 *
 * 只用于**确知是文本**的 blob(超 64KB 的工具结果、text/plain):二进制正文
 * (图片附件 / image part)必须走 `readSessionBlobBase64`,否则 utf8 解码会把
 * 字节改写成 `�`(#3 的病根就在这里)。
 */
export function readSessionBlobText(sessionId: string, hash: string): string | undefined {
  return readSessionBlob(sessionId, hash)?.toString('utf8')
}

/**
 * 一段正文在事件里的落法:64KB 以内直接进事件行,超过走 blob(§9.1)。
 *
 * 阈值不是性能调参,是**行的可读性**:events.jsonl 要被逐行 parse,一条 400KB
 * 的工具结果会让每一次 fold 都把它读一遍。
 */
export function textOrBlobForEvent(
  sessionId: string,
  text: string,
): { text: string } | { blob: BlobRef } {
  if (Buffer.byteLength(text, 'utf8') <= SESSION_EVENT_BLOB_THRESHOLD_BYTES) return { text }
  const blob = putSessionBlob(sessionId, text, 'text/plain')
  // blob 写不进去就退回正文:一条大一点的事件行,好过一条丢了结果的账。
  // (`off` 档 `putSessionBlob` 已经抛了,走不到这一行 —— 那一档的裁定是
  // "写不进去 = 命令失败",不是"退回一条更胖的事件行"。)
  return blob ? { blob } : { text }
}

/** 该会话所有 blob 的 hash 列表(`sessions:verify` 的引用完整性用)。 */
export function listSessionBlobs(sessionId: string): string[] {
  try {
    return fs.readdirSync(getSessionBlobsDir(sessionId))
  } catch {
    return []
  }
}
