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
import type { CollabDayDigest } from './index.js'
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

export function createCollabDigestStore(options: { storePath: string; assertOwned?: () => void }) {
  const directory = path.join(path.resolve(options.storePath), 'collab')
  let closed = false
  function assertActive(): void {
    if (closed) throw new Error('Collab digest store is shutting down')
    options.assertOwned?.()
  }
  function digestPath(roomSessionId: string): string {
    assertActive()
    if (!roomSessionId || roomSessionId === '.' || roomSessionId === '..' || /[/\\]/.test(roomSessionId)) throw new Error('Invalid digest room id')
    return path.join(directory, roomSessionId, 'digests.json')
  }

  function load(roomSessionId: string): CollabDigestFile {
    const raw = readJsonFile<CollabDigestFile | null>(digestPath(roomSessionId), null)
    if (raw && raw.version === 1 && raw.days && typeof raw.days === 'object') {
      return { version: 1, days: raw.days }
    }
    return { version: 1, days: {} }
  }

  /** 这间房已有的摘要,按日期升序。 */
  function getCollabDigests(roomSessionId: string): CollabDayDigest[] {
    return Object.values(load(roomSessionId).days).sort((a, b) => a.day.localeCompare(b.day))
  }

  /** 指定这几天的摘要(缺的不补,顺序按传入的天)。 */
  function getCollabDigestsForDays(
    roomSessionId: string,
    days: readonly string[],
  ): CollabDayDigest[] {
    assertActive()
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
  function saveCollabDigest(roomSessionId: string, digest: CollabDayDigest): void {
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
  function forgetCollabDigests(roomSessionId: string): void {
    assertActive()
    try {
      fs.rmSync(digestPath(roomSessionId), { force: true })
    } catch (error) {
      log.error('digest cleanup failed', { roomSessionId }, error)
    }
  }

  /** 这一天还需不需要(重新)生成:没有过、或者那天的条数变了。 */
  function needsCollabDigest(
    roomSessionId: string,
    day: string,
    messageCount: number,
  ): boolean {
    const existing = load(roomSessionId).days[day]
    if (!existing) return true
    return existing.messageCount !== messageCount
  }

  return { quiesce() { closed = true }, getCollabDigests, getCollabDigestsForDays, saveCollabDigest, forgetCollabDigests, needsCollabDigest }
}
export type CollabDigestStore = ReturnType<typeof createCollabDigestStore>

const binding: { current?: CollabDigestStore } = {}
export function configureCollabDigestStore(store: CollabDigestStore): () => void {
  if (binding.current) throw new Error('Collab digest store is already bound')
  binding.current = store
  return () => { if (binding.current === store) binding.current = undefined }
}
function currentStore(): CollabDigestStore {
  if (!binding.current) throw new Error('Collab digest store is not bound to a Backend')
  return binding.current
}
export const getCollabDigests: CollabDigestStore['getCollabDigests'] = (...args) => currentStore().getCollabDigests(...args)
export const getCollabDigestsForDays: CollabDigestStore['getCollabDigestsForDays'] = (...args) => currentStore().getCollabDigestsForDays(...args)
export const saveCollabDigest: CollabDigestStore['saveCollabDigest'] = (...args) => currentStore().saveCollabDigest(...args)
export const forgetCollabDigests: CollabDigestStore['forgetCollabDigests'] = (...args) => currentStore().forgetCollabDigests(...args)
export const needsCollabDigest: CollabDigestStore['needsCollabDigest'] = (...args) => currentStore().needsCollabDigest(...args)
