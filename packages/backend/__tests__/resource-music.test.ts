/**
 * K3-b —— 音乐这一 scheme 在**真装配**里的门。
 *
 * 三句话,没有一句在单测里说得出口:
 *
 *   ① **`full` 档挂它,`headless` 档不挂**,而且 `radio` 那只工具从两档里都消失了 ——
 *      「加一种资源 = 一份自述 + 一份 provider + 一行注册」这句话的另一半是「退役一只
 *      工具 = 目录里真的没有它」,而目录是装配建的;
 *   ② `do('music:radio', 'open', …)` 经**真管线**(校验 → 拦截 → plan → 授权 →
 *      apply → 预算 → 审计)落到端口上 —— 假的只有端口本身;
 *   ③ `read('music:radio', 'radio')` 交出来的是 `RadioToolStatus` 那份**结构化值**
 *      (读走的是 `ReadOutcome` 那条短路径,不是一段被 JSON 化的文本)。
 *
 * 端口这一侧是假的:真的那一份要拉起 ncm-cli 的守护进程与一台 DJ agent。假的办法是
 * 把 `wiring/music/{radio,operations,service}.js` 的**进程槽访问器**换掉 —— 那三只
 * 模块正是 `radioAdapters()` / `musicPlayerAdapters()` 取端口的地方的另一头
 * (它们从 `getCurrentBackendInstance()?.music` 上取,所以这里连 `backend.music` 的
 * 那一格一起换)。
 *
 * store 隔离与全动态 import 的写法照 `resource-kernel.test.ts`:
 * `stores/sessions.ts` / `stores/settings.ts` 在 **import 期**就解析 store 根。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-music-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const STATUS = { active: true, intent: '安静的中文民谣', programmeLength: 5, nowPlayingTitle: '晴天' }

/**
 * 假端口。它替掉的是**音乐子系统本身**那几只作用域(`backend.music.radio` /
 * `.operations` / `.service`),而不是 provider —— 于是从 `resources.do` 到这里的
 * 每一段(内核 / 管线 / provider / `radioAdapters()` 里那道信任门)全是真的。
 */
const music = vi.hoisted(() => {
  const radio = {
    radioToolOpen: vi.fn(async () => STATUS),
    radioToolClose: vi.fn(async () => ({ ...STATUS, active: false, programmeLength: 0 })),
    radioToolStatus: vi.fn(() => STATUS),
    requestSong: vi.fn(async () => ({ success: true, title: '晴天 周杰伦' })),
  }
  const operations = { runMusicCommand: vi.fn(async () => ({ success: true })) }
  const service = { getMusicNowPlaying: vi.fn(() => null) }
  return { radio, operations, service, onNowPlayingChanged: vi.fn(() => () => {}) }
})

vi.mock('../current.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../current.js')>()
  const withFakeMusic = (backend: unknown): unknown =>
    backend ? new Proxy(backend as object, {
      get(target, property, receiver) {
        return property === 'music' ? music : Reflect.get(target, property, receiver)
      },
    }) : backend
  return {
    ...actual,
    getCurrentBackendInstance: () => withFakeMusic(actual.getCurrentBackendInstance()),
  }
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

async function assemble(tier: 'full' | 'headless'): Promise<Backend> {
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
    toolRegistry: tier,
    sender: new NoopSender() as never,
  })
}

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

describe('music 这一 scheme 在真装配里(K3-b)', () => {
  it('headless 档:注册表里没有 music,工具目录里 music 与 radio 都没有', { timeout: 180_000 }, async () => {
    const backend = await assemble('headless')
    try {
      expect(backend.resources.registry.list().map(spec => spec.scheme)).not.toContain('music')

      const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
      const catalog = getToolkitCatalog()
      expect(catalog?.has('music')).toBe(false)
      // `radio` 退役了 —— 它在**任何**一档里都不该再出现。
      expect(catalog?.has('radio')).toBe(false)
    } finally {
      await backend.dispose()
    }
  })

  it('full 档:目录里有 music、没有 radio,做与读都经真管线到端口', { timeout: 180_000 }, async () => {
    const backend = await assemble('full')
    try {
      expect(backend.resources.registry.list().map(spec => spec.scheme)).toContain('music')

      const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
      const catalog = getToolkitCatalog()
      expect(catalog?.has('music')).toBe(true)
      expect(catalog?.has('radio')).toBe(false)

      // ② 做:一次开台经真管线落到端口上。
      const done = await backend.resources.do(
        'music:radio',
        'open',
        { intent: '下雨天,安静的中文民谣' },
        { principal: PRINCIPAL },
      )
      expect(done.kind).toBe('ok')
      expect(music.radio.radioToolOpen).toHaveBeenCalledWith('下雨天,安静的中文民谣', {
        clearProgramme: false,
      })

      // ③ 读:`ReadOutcome.ok` 装的是**值**,形状就是 `RadioToolStatus`。
      const read = await backend.resources.read('music:radio', 'radio', {}, { principal: PRINCIPAL })
      expect(read.kind).toBe('ok')
      expect(read.kind === 'ok' ? read.value : undefined).toEqual(STATUS)
    } finally {
      await backend.dispose()
    }
  })
})
