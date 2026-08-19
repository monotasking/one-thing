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
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { BlobRef } from '@onething/core/session'
import { SESSION_EVENT_BLOB_THRESHOLD_BYTES } from '@onething/core/session'
import { getSessionsDir } from '../stores/paths.js'
import { countSessionEventFailure } from './event-stats.js'

export const SESSION_BLOBS_DIRNAME = 'blobs'

/** 文件名 = sha256 前 16 位(与 system prompt / tools 指纹同长度口径)。 */
export function hashSessionBlob(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function getSessionBlobsDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId, SESSION_BLOBS_DIRNAME)
}

export function getSessionBlobPath(sessionId: string, hash: string): string {
  return path.join(getSessionBlobsDir(sessionId), hash)
}

/**
 * 落一段正文,拿回引用。已存在的同 hash 内容直接复用(不重写)。
 *
 * @returns 写不进去时 `undefined` —— 调用方必须有一条不写 blob 也能走的路。
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
    return undefined
  }
  return {
    hash,
    bytes: buffer.byteLength,
    ...(mime ? { mime } : {}),
  }
}

/** 读回正文(utf8)。文件不在 = 这条引用没有对应的正文,返回 undefined。 */
export function readSessionBlobText(sessionId: string, hash: string): string | undefined {
  try {
    return fs.readFileSync(getSessionBlobPath(sessionId, hash), 'utf8')
  } catch {
    return undefined
  }
}

export function readSessionBlob(sessionId: string, hash: string): Buffer | undefined {
  try {
    return fs.readFileSync(getSessionBlobPath(sessionId, hash))
  } catch {
    return undefined
  }
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
