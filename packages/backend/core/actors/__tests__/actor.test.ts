import { describe, expect, it } from 'vitest'

import { ActorBase, CallbackActor } from '../actor.js'
import { createActorEvent, type ActorEvent } from '../envelope.js'
import { InMemoryMailbox } from '../mailbox.js'

type TestEvent = ActorEvent<{ text: string }>

function event(id: string): TestEvent {
  return createActorEvent({
    id,
    at: 0,
    type: 'room:posted',
    from: { kind: 'room', id: 'r1' },
    to: { kind: 'agent', id: 'a1' },
    payload: { text: id },
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('ActorBase', () => {
  it('串行处理:批内保序,一条一条', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const seen: string[] = []
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      handler: async e => {
        await new Promise(resolve => setTimeout(resolve, 1))
        seen.push(e.id)
      },
    })
    actor.start()
    await mailbox.append(event('e1'))
    await mailbox.append(event('e2'))
    await mailbox.append(event('e3'))
    await actor.drain()

    expect(seen).toEqual(['e1', 'e2', 'e3'])
    expect(actor.processedCount).toBe(3)
    await actor.stop()
  })

  it('前一批没跑完,绝不去取下一批', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const gate = deferred()
    const started: string[] = []
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      handler: async e => {
        started.push(e.id)
        if (e.id === 'e1') await gate.promise
      },
    })
    actor.start()
    await mailbox.append(event('e1'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(started).toEqual(['e1'])

    // 第一批卡住的期间又来了两封:它们排队,不能被并发拉起来
    await mailbox.append(event('e2'))
    await mailbox.append(event('e3'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(started).toEqual(['e1'])
    // 未 ack 口径:在飞的 e1 也算数,所以是 3 不是 2
    expect(mailbox.pendingCount()).toBe(3)

    gate.resolve()
    await actor.drain()
    expect(started).toEqual(['e1', 'e2', 'e3'])
    await actor.stop()
  })

  it('单条抛错不杀循环,坏信进 dead-letter', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const seen: string[] = []
    const observed: string[] = []
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      onDeadLetter: dl => observed.push(dl.event.id),
      handler: e => {
        if (e.id === 'bad') throw new Error('boom')
        seen.push(e.id)
      },
    })
    actor.start()
    await mailbox.append(event('e1'))
    await mailbox.append(event('bad'))
    await mailbox.append(event('e2'))
    await actor.drain()

    expect(seen).toEqual(['e1', 'e2'])
    expect(actor.deadLetterCount).toBe(1)
    expect(actor.deadLetters[0].event.id).toBe('bad')
    expect(actor.deadLetters[0].error.message).toBe('boom')
    expect(observed).toEqual(['bad'])
    // 坏信也算处理过 —— 循环推进了,不是卡住了
    expect(actor.processedCount).toBe(3)
    await actor.stop()
  })

  it('拒绝的 promise 与非 Error 抛值都收得住', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      handler: e => (e.id === 'reject' ? Promise.reject(new Error('rejected')) : Promise.reject('plain string')),
    })
    actor.start()
    await mailbox.append(event('reject'))
    await mailbox.append(event('weird'))
    await actor.drain()

    expect(actor.deadLetters.map(dl => dl.error.message)).toEqual(['rejected', 'plain string'])
    await actor.stop()
  })

  it('dead-letter 是有界环,满了丢最旧的', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      maxDeadLetters: 2,
      handler: e => {
        throw new Error(e.id)
      },
    })
    actor.start()
    for (const id of ['e1', 'e2', 'e3']) await mailbox.append(event(id))
    await actor.drain()

    expect(actor.deadLetters.map(dl => dl.event.id)).toEqual(['e2', 'e3'])
    await actor.stop()
  })

  it('观测钩子自己炸了不影响循环', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const seen: string[] = []
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      onDeadLetter: () => {
        throw new Error('observer exploded')
      },
      handler: e => {
        if (e.id === 'bad') throw new Error('boom')
        seen.push(e.id)
      },
    })
    actor.start()
    await mailbox.append(event('bad'))
    await mailbox.append(event('e1'))
    await actor.drain()
    expect(seen).toEqual(['e1'])
    await actor.stop()
  })

  it('整批处理完才 ack —— 中途没 ack 就是重投的语义来源', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const gate = deferred()
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      handler: async e => {
        if (e.id === 'e1') await gate.promise
      },
    })
    actor.start()
    await mailbox.append(event('e1'))
    await mailbox.append(event('e2'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(mailbox.cursor).toBe(0)

    gate.resolve()
    await actor.drain()
    expect(mailbox.cursor).toBe(2)
    await actor.stop()
  })

  it('stop 会 drain 在飞批,不半途掐断', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const gate = deferred()
    const finished: string[] = []
    const actor = new CallbackActor<TestEvent>({
      id: 'a1',
      mailbox,
      handler: async e => {
        if (e.id === 'slow') await gate.promise
        finished.push(e.id)
      },
    })
    actor.start()
    await mailbox.append(event('slow'))
    await new Promise(resolve => setTimeout(resolve, 5))

    let stopped = false
    const stopping = actor.stop().then(() => {
      stopped = true
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(stopped).toBe(false)
    expect(finished).toEqual([])

    gate.resolve()
    await stopping
    expect(finished).toEqual(['slow'])
    expect(actor.running).toBe(false)
  })

  it('start 幂等,没起来时 drain 立即返回', async () => {
    const mailbox = new InMemoryMailbox<TestEvent>()
    const actor = new CallbackActor<TestEvent>({ id: 'a1', mailbox, handler: () => {} })
    await actor.drain()
    expect(actor.running).toBe(false)

    actor.start()
    actor.start()
    expect(actor.running).toBe(true)
    await actor.stop()
    await actor.stop()
    expect(actor.running).toBe(false)
  })

  it('子类实现 handleEvent 就是一个完整 actor', async () => {
    class CountingActor extends ActorBase<TestEvent> {
      total = 0
      protected handleEvent(): void {
        this.total += 1
      }
    }
    const mailbox = new InMemoryMailbox<TestEvent>()
    const actor = new CountingActor({ id: 'a1', mailbox })
    actor.start()
    await mailbox.append(event('e1'))
    await mailbox.append(event('e2'))
    await actor.drain()
    expect(actor.total).toBe(2)
    await actor.stop()
  })
})
