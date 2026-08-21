/**
 * R2 评审修复第 7 条:事件分流走**真** EventBus。
 *
 * request-channel.test.ts 里那批用例全用 stub host,恰好绕开了
 * `createPluginAPI` 里这段真实的分流代码 —— 而分流判据写错的后果是
 * "订阅了、永远收不到、零告警",测试不打在真总线上就永远看不见。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { collectLogRecordsForTests } from '../../logging/index.js'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-events-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  // 让出若干轮事件循环,给在飞的收尾写入一个落完的机会 —— 比 `setTimeout(50)`
  // 少一点猜测(负载下 50ms 不够就是偶发红),但仍是启发式。
  // 根治项:diskWriter 暴露 flush() 让收尾可等待。
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

async function load() {
  const [{ EventBus }, api, apiModule] = await Promise.all([
    import('../../../events/event-bus.js'),
    import('../api.js'),
    import('../api.js'),
  ])
  return { EventBus, createPluginAPI: api.createPluginAPI, disposePlugin: api.disposePlugin, apiModule }
}

function streamEngineStub() {
  return { steerMessage() {}, followUpMessage() {} }
}

describe('plugin event routing over the real EventBus', () => {
  it('delivers plugin custom events to a subscriber on the global bus', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()

    const emitter = createPluginAPI('emitter', bus as never, streamEngineStub() as never)
    const listener = createPluginAPI('listener', bus as never, streamEngineStub() as never)

    const received: unknown[] = []
    listener.api.on('plugin:emitter:ping', (envelope: any) => {
      received.push(envelope?.event)
    })

    emitter.api.events.emit('ping', { at: 1 })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'plugin:emitter:ping',
      pluginId: 'emitter',
      name: 'ping',
      payload: { at: 1 },
    })

    disposePlugin(emitter.state)
    disposePlugin(listener.state)
  })

  it('routes real global events (settings:changed) to the global bus, not the session fan-out', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('watcher', bus as never, streamEngineStub() as never)

    const received: string[] = []
    // 按 startsWith('plugin:') 分流的话,这条订阅会被误挂到会话面上 ——
    // 于是插件订阅了 settings:changed 却永远收不到,而且零告警。
    plugin.api.on('settings:changed', (envelope: any) => {
      received.push(envelope?.event?.type)
    })

    bus.emitGlobal({ type: 'settings:changed', settings: {} } as never)
    expect(received).toEqual(['settings:changed'])

    disposePlugin(plugin.state)
  })

  it('still routes session events through the per-session fan-out', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('session-watcher', bus as never, streamEngineStub() as never)

    const received: string[] = []
    plugin.api.on('stream:start', (envelope: any) => {
      received.push(envelope?.event?.type)
    })

    await bus.emit('session-1', { type: 'stream:start' } as never)
    expect(received).toEqual(['stream:start'])

    disposePlugin(plugin.state)
  })

  it('warns once when the event name looks like neither a known global nor a namespaced event', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('sloppy', bus as never, streamEngineStub() as never)
    const logs = collectLogRecordsForTests()

    try {
      plugin.api.on('typo-without-namespace', () => {})
      expect(logs.messages()).toContain(
        'plugin subscribed to an unrecognized event; treating it as a session event',
      )
    } finally {
      logs.stop()
      disposePlugin(plugin.state)
    }
  })

  it('stops delivering plugin events after dispose', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const emitter = createPluginAPI('emitter2', bus as never, streamEngineStub() as never)
    const listener = createPluginAPI('listener2', bus as never, streamEngineStub() as never)

    const received: unknown[] = []
    listener.api.on('plugin:emitter2:tick', () => {
      received.push('tick')
    })

    emitter.api.events.emit('tick')
    expect(received).toHaveLength(1)

    disposePlugin(listener.state)
    emitter.api.events.emit('tick')
    // 订阅已退订:拆除测试的同一条判据,这里打在真总线上。
    expect(received).toHaveLength(1)

    disposePlugin(emitter.state)
    emitter.api.events.emit('tick')
    expect(received).toHaveLength(1)
  })

  it('keeps the global-event allowlist in step with the shared GlobalEvent union', async () => {
    const { apiModule } = await load()
    const source = fs.readFileSync(
      path.join(process.cwd(), 'packages/shared/events/global-events.ts'),
      'utf-8',
    )
    const declared = [...source.matchAll(/^\s*type:\s*'([^']+)'/gm)].map(match => match[1])
    expect(declared.length).toBeGreaterThan(0)
    for (const type of declared) {
      // 名单漏一个,插件订阅它就会被静默挂到会话面上 —— 这条断言是那份名单的看门狗。
      expect(apiModule.GLOBAL_PLUGIN_EVENT_TYPES.has(type)).toBe(true)
    }
  })
})
