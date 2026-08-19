/**
 * 每日摘要的落盘(collab-agent-view.md P2)。
 *
 * `<store>/collab/<roomId>/digests.json` —— 与 `state.json` 同目录、同写法
 * (`writeJsonFile` = writeFileSync + rename,同步且原子)。分成两个文件而不是塞
 * 进 state:state 每次激活状态变化都要写,而摘要一天只变一次,合在一起等于把
 * 一份冷数据放进最热的写路径上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '@onething/core/storage'
import type { CollabDayDigest } from '@onething/runtime/collab'
import { getStorePath } from '../stores/paths.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.digest')


interface CollabDigestFile {
  version: 1
  days: Record<string, CollabDayDigest>
}

/**
 * 保留多少天的摘要。折叠段只会越来越长,但一份 300 天的摘要本身就变成了新的
 * 上下文膨胀 —— 而且没人会读 200 天前那一行。到期直接丢,`<Folded count>` 仍然
 * 诚实地说"这里少了多少条"。
 */
const DIGEST_RETAIN_DAYS = 60

function digestPath(roomSessionId: string): string {
  return path.join(getStorePath(), 'collab', roomSessionId, 'digests.json')
}

function load(roomSessionId: string): CollabDigestFile {
  const raw = readJsonFile<CollabDigestFile | null>(digestPath(roomSessionId), null)
  if (raw && raw.version === 1 && raw.days && typeof raw.days === 'object') {
    return { version: 1, days: raw.days }
  }
  return { version: 1, days: {} }
}

/** 这间房已有的摘要,按日期升序。 */
export function getCollabDigests(roomSessionId: string): CollabDayDigest[] {
  return Object.values(load(roomSessionId).days).sort((a, b) => a.day.localeCompare(b.day))
}

/** 指定这几天的摘要(缺的不补,顺序按传入的天)。 */
export function getCollabDigestsForDays(
  roomSessionId: string,
  days: readonly string[],
): CollabDayDigest[] {
  if (days.length === 0) return []
  const file = load(roomSessionId)
  const found: CollabDayDigest[] = []
  for (const day of days) {
    const digest = file.days[day]
    if (digest) found.push(digest)
  }
  return found
}

/**
 * 写一天的摘要。
 *
 * `messageCount` 一起存:同一天后来又说了话(这在真机上很常见 —— 折叠是按天切的,
 * 而昨天的对话可能在今天凌晨还在继续),条数对不上就说明这份摘要过期了,
 * `needsCollabDigest` 据此判定要不要重算。
 */
export function saveCollabDigest(roomSessionId: string, digest: CollabDayDigest): void {
  const file = load(roomSessionId)
  file.days[digest.day] = digest
  const cutoff = [...Object.keys(file.days)].sort().slice(-DIGEST_RETAIN_DAYS)
  const kept = new Set(cutoff)
  for (const day of Object.keys(file.days)) {
    if (!kept.has(day)) delete file.days[day]
  }
  writeJsonFile(digestPath(roomSessionId), file)
}

/**
 * 丢掉这间房的全部摘要(清空聊天记录)。
 *
 * 整文件删而不是逐天清:摘要是转录的派生物,转录没了它一条都不成立。留着任何
 * 一天,编排的折叠头就会注入一段已删内容的概要 —— 一段查无出处的幽灵历史。
 */
export function forgetCollabDigests(roomSessionId: string): void {
  try {
    fs.rmSync(digestPath(roomSessionId), { force: true })
  } catch (error) {
    log.error('digest cleanup failed', { roomSessionId }, error)
  }
}

/** 这一天还需不需要(重新)生成:没有过、或者那天的条数变了。 */
export function needsCollabDigest(
  roomSessionId: string,
  day: string,
  messageCount: number,
): boolean {
  const existing = load(roomSessionId).days[day]
  if (!existing) return true
  return existing.messageCount !== messageCount
}
