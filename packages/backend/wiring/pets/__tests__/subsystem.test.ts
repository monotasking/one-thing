/**
 * 宠物子系统的接线(§9.4 / §9.6 第二条):一种**假资源**发事件,经真的
 * `forwardResourceEventsToBus` 上真的总线,子系统查注册表里的 `moment` 喂宿主。
 *
 *   · 带 `moment` 且带现成台词的事件 → `pet:` 发出 `utterance`,账本落盘;
 *   · 不带 `moment` 的事件 → 什么都不发生;
 *   · `pet:` 自己的 `poked` 绕回来只进账本,不开口;
 *   · `say` 被预算挡掉回执说原因,`adopt` 未知 id 当场拒绝。
 *
 * 内核的 runner 用不上(这里只 mount 与 emit),provider 的 plan / apply 直接调。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ResourceKernel,
  ResourceRegistry,
  type ResourceEventHub,
  type ResourceProvider,
  type ResourceSpec,
} from '@onething/core/resource'
import type { PlanContext, RunContext, ToolRunner } from '@onething/core/toolkit'
import type { Utterance } from '@onething/runtime/pets'
import { EventBus } from '../../../events/event-bus.js'
import { forwardResourceEventsToBus } from '../../resource/event-bridge.js'
import { PetResourceProvider } from '../../resource/pet-provider.js'
import { PetsSubsystem, UnknownPetError } from '../subsystem.js'

const EMPTY = { type: 'object', properties: {}, required: [] }

const demoSpec: ResourceSpec = {
  scheme: 'demo',
  title: 'A resource the pet system has never heard of',
  reads: {},
  ops: {},
  events: {
    announced: { title: 'Something worth saying', payload: EMPTY, moment: { weight: 'high', gist: '有件事值得说' } },
    ticked: { title: 'Nothing worth saying', payload: EMPTY },
  },
}

class DemoProvider implements ResourceProvider {
  readonly spec = demoSpec
  hub: ResourceEventHub | undefined
  attach(hub: ResourceEventHub): void { this.hub = hub }
  async read(): Promise<unknown> { return null }
  async plan(): Promise<never> { throw new Error('no ops') }
  async apply(): Promise<never> { throw new Error('no ops') }
  emit(event: string, payload: unknown): void { this.hub?.emit({ scheme: 'demo', path: 'x' }, event, payload) }
}

class Clock {
  t = 5_000_000
  now(): number { return this.t }
}

let dir: string
let bus: EventBus
let kernel: ResourceKernel
let demo: DemoProvider
let pets: PetsSubsystem
let provider: PetResourceProvider
let clock: Clock
let utterances: Utterance[]
let petEvents: string[]
let teardown: Array<() => unknown>

const planCtx = { principal: { kind: 'user', userId: 'local' }, invocation: { sessionId: 's' } } as unknown as PlanContext
const runCtx = {} as RunContext

async function doOp(op: string, params: unknown): Promise<Record<string, unknown>> {
  const intent = await provider.plan(op, { scheme: 'pet', path: 'current' }, params, planCtx)
  const result = await provider.apply(op, intent, runCtx)
  return JSON.parse(result.content[0].text ?? '{}') as Record<string, unknown>
}

async function ledger(): Promise<Array<Record<string, unknown>>> {
  await pets.settled()
  try {
    const text = await readFile(path.join(dir, 'heidou', 'ledger.jsonl'), 'utf8')
    return text.trim().split('\n').filter(Boolean).map(row => JSON.parse(row) as Record<string, unknown>)
  } catch {
    return []
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'onething-pets-subsystem-'))
  bus = new EventBus()
  kernel = new ResourceKernel(new ResourceRegistry(), {} as ToolRunner)
  clock = new Clock()
  utterances = []
  petEvents = []
  teardown = []
  demo = new DemoProvider()
  pets = new PetsSubsystem({ dir, registry: kernel.registry, bus, clock })
  await pets.start()
  provider = new PetResourceProvider(pets)
  teardown.push(kernel.mount(demo), kernel.mount(provider), forwardResourceEventsToBus(kernel, bus))
  teardown.push(bus.onGlobal('resource:event', ({ event }) => {
    if (!event.ref.startsWith('pet:')) return
    petEvents.push(event.event)
    if (event.event === 'utterance') utterances.push(event.payload as Utterance)
  }))
})

afterEach(async () => {
  for (const stop of teardown.reverse()) await stop()
  await pets.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('PetsSubsystem', () => {
  it('turns a resource event that declares a moment and carries a line into a pet utterance', async () => {
    demo.emit('announced', { say: '下一首来了' })
    const lines = await ledger()
    expect(utterances).toEqual([expect.objectContaining({ petId: 'heidou', mode: 'speak', text: '下一首来了', about: { scheme: 'demo', event: 'announced' } })])
    expect(lines.map(line => line.kind)).toEqual(['moment', 'utterance'])
    expect(pets.current().utterances.map(u => u.text)).toEqual(['下一首来了'])
  })

  it('ignores a resource event whose spec declares no moment', async () => {
    demo.emit('ticked', { say: '这句不该出现' })
    expect(await ledger()).toEqual([])
    expect(petEvents).toEqual([])
  })

  it('records the pet\'s own poked fact as a low moment and never speaks for it', async () => {
    expect(await doOp('poke', {})).toEqual({ ok: true })
    const lines = await ledger()
    expect(petEvents).toEqual(['poked'])
    expect(lines).toEqual([expect.objectContaining({ kind: 'moment', scheme: 'pet', event: 'poked', weight: 'low' })])
    expect(utterances).toEqual([])
  })

  it('answers a budget-blocked say with a reason instead of throwing', async () => {
    expect(await doOp('say', { mode: 'speak', text: '第一句' })).toMatchObject({ said: true, utterance: { text: '第一句' } })
    expect(await doOp('say', { mode: 'speak', text: '第二句' })).toEqual({ said: false, reason: 'busy' })
    expect(await doOp('say', { mode: 'mutter', text: '嘀咕' })).toMatchObject({ said: true, utterance: { mode: 'mutter' } })
    expect(utterances.map(u => u.text)).toEqual(['第一句', '嘀咕'])
  })

  it('refuses an unknown pet id at plan time and a wrong address', async () => {
    await expect(provider.plan('adopt', null, { id: 'dragon' }, planCtx)).rejects.toBeInstanceOf(UnknownPetError)
    await expect(provider.read('current', { scheme: 'pet', path: 'elsewhere' }, {}, {} as never)).rejects.toThrow('pet:current')
    expect(await doOp('adopt', { id: 'heidou' })).toEqual({ pet: { id: 'heidou', name: '黑豆', rig: 'heidou-svg' } })
    await pets.settled()
    expect(JSON.parse(await readFile(path.join(dir, 'current.json'), 'utf8'))).toEqual({ id: 'heidou' })
  })

  it('picks its memory back up from disk on the next start', async () => {
    demo.emit('announced', { say: '记住我' })
    await pets.settled()
    const again = new PetsSubsystem({ dir, registry: kernel.registry, bus: new EventBus(), clock })
    await again.start()
    expect(again.current().utterances.map(u => u.text)).toEqual(['记住我'])
    await again.dispose()
  })
})
