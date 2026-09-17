/**
 * 宠物 P2 —— `pet:` 在**真装配**里的门(`docs/design/pet-system-2026-09.md` §9.1 / §9.6)。
 *
 *   ① `pets` 不开:注册表里没有 `pet`(CLI 守护进程的形状);
 *   ② `pets: true`:注册表里有 `pet`,`describe` 投影带出 `poked` 的 `moment`,
 *      `say` 经真管线 → 子系统 → 事件经真 bridge 上总线,`current` 读得回那一句,
 *      账本落在这个临时 store 的 `pets/heidou/ledger.jsonl`。
 *
 * store 隔离与全动态 import 的写法照 `resource-music.test.ts`:`stores/*` 在 import 期就解析
 * store 根,所以环境变量要在任何 backend 模块被 import 之前设好。
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-pet-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

async function assemble(pets: boolean): Promise<Backend> {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({
    host: {
      storePath: {},
      sandbox: {},
      auth: null,
      logging: null,
      shell: null,
      voice: null,
      terminal: null,
      skillsEnvironment: null,
      todoPlan: null,
      scratchpad: null,
      plugins: null,
      gateway: null,
      settings: null,
      evals: null,
      mcp: null,
      localTrust: null,
    },
    toolRegistry: 'headless',
    ...(pets ? { pets: true } : {}),
    sender: new NoopSender() as never,
  })
}

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

describe('pet 这一 scheme 在真装配里(宠物 P2)', () => {
  it('pets 不开:注册表里没有 pet', { timeout: 180_000 }, async () => {
    const backend = await assemble(false)
    try {
      expect(backend.resources.registry.has('pet')).toBe(false)
      const read = await backend.resources.read('pet:current', 'current', {}, { principal: PRINCIPAL })
      expect(read.kind).toBe('failed')
    } finally {
      await backend.dispose()
    }
  })

  it('pets 开:say 经真管线出一条 utterance,current 读得回,账本落盘', { timeout: 180_000 }, async () => {
    const backend = await assemble(true)
    const seen: Array<{ ref: string; event: string }> = []
    const stop = backend.eventBus.onGlobal('resource:event', ({ event }) => {
      seen.push({ ref: event.ref, event: event.event })
    })
    try {
      expect(backend.resources.registry.has('pet')).toBe(true)

      const { serializeSpec } = await import('../rpc/domains/resources.js')
      const described = serializeSpec(backend.resources.registry.get('pet')!)
      expect(described.events.poked.moment).toEqual({ weight: 'low', gist: '用户戳了宠物' })
      expect(described.events.utterance.moment).toBeUndefined()

      const done = await backend.resources.do('pet:current', 'say', { mode: 'speak', text: '晚上好' }, { principal: PRINCIPAL })
      expect(done.kind).toBe('ok')
      expect(seen).toContainEqual({ ref: 'pet:current', event: 'utterance' })

      const read = await backend.resources.read('pet:current', 'current', {}, { principal: PRINCIPAL })
      expect(read.kind).toBe('ok')
      const view = read.kind === 'ok' ? (read.value as { pet: { id: string }; speaking: boolean; utterances: Array<{ text: string }> }) : undefined
      expect(view?.pet.id).toBe('heidou')
      expect(view?.speaking).toBe(true)
      expect(view?.utterances.map(u => u.text)).toEqual(['晚上好'])
    } finally {
      stop()
      await backend.dispose()
    }
    const ledger = fs.readFileSync(path.join(storeRoot, 'pets', 'heidou', 'ledger.jsonl'), 'utf8')
    expect(ledger).toContain('"text":"晚上好"')
  })
})
