import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createActorEvent, type ActorEvent } from '../envelope.js'
import { DurableMailbox, InMemoryMailbox, readActorMailboxLog, type ActorMailboxBatch } from '../mailbox.js'

const ROOM = { kind: 'room', id: 'r1' }
const AGENT = { kind: 'agent', id: 'a1' }

function event(id: string, at = 0): ActorEvent<{ text: string }> {
  return createActorEvent({ id, at, type: 'room:posted', from: ROOM, to: AGENT, payload: { text: id } })
}

/** 取一批(或等到 close);测试里不想为了拿一批写十行样板。 */
async function nextBatch<T>(
  iterator: AsyncIterableIterator<ActorMailboxBatch<T>>,
): Promise<ActorMailboxBatch<T> | null> {
  const result = await iterator.next()
  return result.done ? null : result.value
}

describe('DurableMailbox', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'actor-mailbox-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('把积压一次性给出(批语义),ack 后游标落盘', async () => {
    const mailbox = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await mailbox.append(event('e1'))
    await mailbox.append(event('e2'))
    await mailbox.append(event('e3'))

    const iterator = mailbox.batches()
    const batch = await nextBatch(iterator)
    expect(batch?.events.map(e => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(batch?.cursor).toBe(3)

    mailbox.ack(batch!.cursor)
    expect(mailbox.cursor).toBe(3)

    const cursorFile = JSON.parse(readFileSync(join(dir, 'inbox.cursor'), 'utf-8')) as {
      v: number
      ownerId: string
      seq: number
      seen: string[]
    }
    expect(cursorFile.v).toBe(1)
    expect(cursorFile.ownerId).toBe('a1')
    expect(cursorFile.seq).toBe(3)
    expect(cursorFile.seen).toEqual(['e1', 'e2', 'e3'])

    mailbox.close()
    await iterator.return?.()
  })

  /**
   * 「压了多久」——观测面(D8 §3.1 的 `inbox.oldestAt`)问的第二个问题。
   *
   * `pendingCount` 只答得出「压了多少」,而「刚进来两封」与「两封在那儿躺了十分钟」
   * 是完全不同的两件事:后者是一条卡死的心智循环。
   */
  it('oldestPendingAt 指向最旧那封**未 ack** 的信;清空之后是 undefined', async () => {
    const mailbox = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    expect(mailbox.oldestPendingAt()).toBeUndefined()

    await mailbox.append(event('e1', 100))
    await mailbox.append(event('e2', 200))
    expect(mailbox.oldestPendingAt()).toBe(100)

    // ack 掉第一封:队头往后走一格,时刻跟着走。
    mailbox.ack(1)
    expect(mailbox.pendingCount()).toBe(1)
    expect(mailbox.oldestPendingAt()).toBe(200)

    mailbox.ack(2)
    expect(mailbox.pendingCount()).toBe(0)
    expect(mailbox.oldestPendingAt()).toBeUndefined()
    mailbox.close()
  })

  it('空时挂起,新事件到达才醒', async () => {
    const mailbox = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    const iterator = mailbox.batches()

    let resolved = false
    const pending = nextBatch(iterator).then(batch => {
      resolved = true
      return batch
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resolved).toBe(false)

    await mailbox.append(event('e1'))
    const batch = await pending
    expect(batch?.events.map(e => e.id)).toEqual(['e1'])

    mailbox.close()
  })

  it('崩溃重投:ack 之前重启,同一批原样再来一次', async () => {
    const first = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await first.append(event('e1'))
    await first.append(event('e2'))
    const firstBatch = await nextBatch(first.batches())
    expect(firstBatch?.events.map(e => e.id)).toEqual(['e1', 'e2'])
    // 故意不 ack —— 模拟处理到一半进程没了
    first.close()

    const reopened = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    expect(reopened.cursor).toBe(0)
    const replay = await nextBatch(reopened.batches())
    expect(replay?.events.map(e => e.id)).toEqual(['e1', 'e2'])
    reopened.close()
  })

  it('ack 过的那一批重启后不再重投', async () => {
    const first = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await first.append(event('e1'))
    await first.append(event('e2'))
    const batch = await nextBatch(first.batches())
    first.ack(batch!.cursor)
    first.close()

    const reopened = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    expect(reopened.cursor).toBe(2)
    expect(reopened.pendingCount()).toBe(0)
    await reopened.append(event('e3'))
    const next = await nextBatch(reopened.batches())
    expect(next?.events.map(e => e.id)).toEqual(['e3'])
    reopened.close()
  })

  it('幂等:同一封信重投(哪怕跨重启)也只被消费一次', async () => {
    const first = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await first.append(event('e1'))
    const batch = await nextBatch(first.batches())
    first.ack(batch!.cursor)
    first.close()

    // 上游重投 e1(补水/跨房转投),外加一封新的
    const reopened = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await reopened.append(event('e1'))
    await reopened.append(event('e2'))
    const next = await nextBatch(reopened.batches())
    expect(next?.events.map(e => e.id)).toEqual(['e2'])
    expect(reopened.duplicatesDropped).toBe(1)
    // 游标仍然走过了那条重投,不会卡在原地
    reopened.ack(next!.cursor)
    expect(reopened.cursor).toBe(3)
    reopened.close()
  })

  it('整批都是重投时静默推进游标,不惊动心智循环', async () => {
    const first = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await first.append(event('e1'))
    const batch = await nextBatch(first.batches())
    first.ack(batch!.cursor)
    first.close()

    const reopened = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await reopened.append(event('e1'))
    const iterator = reopened.batches()
    let handed = false
    void nextBatch(iterator).then(() => {
      handed = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(handed).toBe(false)
    expect(reopened.cursor).toBe(2)
    reopened.close()
  })

  it('日志是纯追加的 jsonl,顺序 = 追加顺序', async () => {
    const mailbox = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    // 不 await,考验写链的串行化
    const writes = [event('e1'), event('e2'), event('e3'), event('e4')].map(e => mailbox.append(e))
    await Promise.all(writes)

    const lines = readFileSync(mailbox.logPath, 'utf-8').trim().split('\n')
    expect(JSON.parse(lines[0])).toMatchObject({ t: 'h', sessionId: 'a1' })
    expect(lines.slice(1).map(line => JSON.parse(line).seq)).toEqual([1, 2, 3, 4])
    expect((await readActorMailboxLog<ActorEvent<{ text: string }>>(mailbox.logPath)).map(e => e.id))
      .toEqual(['e1', 'e2', 'e3', 'e4'])
    mailbox.close()
  })

  it('拒绝拿别人的邮箱当自己的开', async () => {
    const mailbox = await DurableMailbox.open({ dir, ownerId: 'a1' })
    mailbox.close()
    await expect(DurableMailbox.open({ dir, ownerId: 'a2' })).rejects.toThrow(/belongs to "a1"/)
  })

  it('单消费者:第二路迭代直接抛', async () => {
    const mailbox = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await mailbox.append(event('e1'))
    const first = mailbox.batches()
    await nextBatch(first)
    // 异步生成器的体到 .next() 才跑,所以违规是一个被拒的 promise,不是同步抛。
    await expect(mailbox.batches().next()).rejects.toThrow(/single consumer/)
    mailbox.close()
  })

  it('游标指到日志尾巴之后时夹回合法前缀', async () => {
    const mailbox = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    await mailbox.append(event('e1'))
    const batch = await nextBatch(mailbox.batches())
    mailbox.ack(batch!.cursor)
    mailbox.close()

    // 伪造一份「游标跑过了头」的账(恢复扫描丢过一段日志时就是这个形状)
    const cursorPath = join(dir, 'inbox.cursor')
    const record = JSON.parse(readFileSync(cursorPath, 'utf-8')) as Record<string, unknown>
    record.seq = 99
    writeFileSync(cursorPath, JSON.stringify(record), 'utf-8')

    const reopened = await DurableMailbox.open<ActorEvent<{ text: string }>>({ dir, ownerId: 'a1' })
    expect(reopened.cursor).toBe(1)
    reopened.close()
  })
})

describe('InMemoryMailbox', () => {
  it('与持久版同语义:批、ack、id 去重', async () => {
    const mailbox = new InMemoryMailbox<ActorEvent<{ text: string }>>()
    await mailbox.append(event('e1'))
    await mailbox.append(event('e2'))
    const iterator = mailbox.batches()
    const batch = await nextBatch(iterator)
    expect(batch?.events.map(e => e.id)).toEqual(['e1', 'e2'])
    mailbox.ack(batch!.cursor)

    await mailbox.append(event('e2'))
    await mailbox.append(event('e3'))
    const next = await nextBatch(iterator)
    expect(next?.events.map(e => e.id)).toEqual(['e3'])
    expect(mailbox.duplicatesDropped).toBe(1)
    mailbox.close()
  })

  it('close 之后迭代正常结束', async () => {
    const mailbox = new InMemoryMailbox()
    const iterator = mailbox.batches()
    const pending = iterator.next()
    mailbox.close()
    expect((await pending).done).toBe(true)
  })

  it('oldestPendingAt 与持久版同口径', async () => {
    const mailbox = new InMemoryMailbox<ActorEvent<{ text: string }>>()
    expect(mailbox.oldestPendingAt()).toBeUndefined()
    await mailbox.append(event('e1', 100))
    await mailbox.append(event('e2', 200))
    expect(mailbox.oldestPendingAt()).toBe(100)
    mailbox.ack(1)
    expect(mailbox.oldestPendingAt()).toBe(200)
    mailbox.ack(2)
    expect(mailbox.oldestPendingAt()).toBeUndefined()
    mailbox.close()
  })
})
