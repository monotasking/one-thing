/**
 * 生命周期竞态(整体验收修复)。
 *
 * 三条都是"两个正确的操作各自没错,叠在一起出事"——它们不会被任何单操作的用例
 * 抓到,而战役里已经栽过一次同族的(refresh 在飞时被 disable)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CorePluginManager,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginStateLike,
} from '@onething/core/plugins'

interface TestAPI { id: string }
type TestEntry = (api: TestAPI) => void | Promise<void>
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestCommand { name: string }
interface TestState extends CorePluginStateLike<TestCommand> {
  stateId: number
  disposed?: boolean
}

let nextStateId = 1

function createManager(options: {
  loadDelay?: () => Promise<void>
  enabled?: boolean
} = {}) {
  const disposedStates: number[] = []
  const liveStates = new Set<number>()
  const definition: TestDefinition = {
    id: 'demo',
    manifest: { name: 'demo', version: '1.0.0' },
    dirPath: '/plugins/demo',
    entryPath: '/plugins/demo/entry.js',
    enabled: options.enabled ?? true,
    entry: () => {},
  }

  const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
    ensurePluginDirs() {},
    scanPlugins: () => [definition],
    loadPluginEntry: async (def) => {
      await options.loadDelay?.()
      return def.entry ?? null
    },
    createPluginAPI() {
      const stateId = nextStateId++
      liveStates.add(stateId)
      return { state: { commands: new Map(), requestHandlers: new Map(), stateId }, api: { id: 'demo' } }
    },
    disposePlugin(state) {
      state.disposed = true
      disposedStates.push(state.stateId)
      liveStates.delete(state.stateId)
    },
    setPluginEnabled(_pluginId, enabled) {
      definition.enabled = enabled
    },
  }

  const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
    host,
    { log: () => {}, error: () => {} },
  )
  return { manager, definition, disposedStates, liveStates }
}

describe('plugin lifecycle races', () => {
  it('leaves no orphan state when disable→enable lands during an in-flight refresh', async () => {
    /*
     * 战役里修过反方向(refresh 在飞时被 disable,靠落表前复查 enabled 丢弃),
     * 正方向一直没修:refresh 的 loadPlugin 还在 await,disable→enable 又发起
     * 一次并先落表;refresh 那次回来时 enabled 已经是 true,于是把自己的 state
     * 盖上去 —— 先落的那份成了**永远拆不掉的孤儿**(事件双份、停用后仍写盘、
     * 注册的连接器无人撤下)。
     */
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let firstLoad = true
    const { manager, liveStates } = createManager({
      loadDelay: async () => {
        if (!firstLoad) return
        firstLoad = false
        await gate
      },
    })

    const refreshing = manager.initialize({ ready: true })
    await Promise.resolve()

    // refresh 的加载卡在闸门里,这时用户 disable→enable。
    await manager.disablePlugin('demo')
    const enabling = manager.enablePlugin('demo')

    release?.()
    await Promise.all([refreshing, enabling])

    // 只允许有**一份**活着的 state。
    expect(liveStates.size, `live states: ${[...liveStates].join(', ')}`).toBe(1)

    // 而且拆掉之后一份不剩 —— 孤儿是拆不掉的,所以这条同时证明没有孤儿。
    manager.shutdown()
    expect(liveStates.size).toBe(0)
  })

  it('does not resurrect a plugin when shutdown lands during an in-flight refresh', async () => {
    /*
     * shutdown 只做 disposeAll + clear:不推进 generation、不落闩、不管在飞的
     * refresh。于是那次 refresh 跑完后 stale() 为假(generation 没动)、
     * `plugins.get(id)?.definition.enabled` 是 undefined(`undefined === false`
     * 不成立),照常落表 —— 插件在拆除之后被复活,state 永不 dispose。
     * R7 刚把 shutdownPlugins 接进 beforeQuit,而插件装配是 post-window 非阻塞的,
     * 两者的窗口天然重叠。
     */
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const { manager, liveStates } = createManager({ loadDelay: () => gate })

    const refreshing = manager.initialize({ ready: true })
    await Promise.resolve()

    manager.shutdown()

    release?.()
    await refreshing

    expect(manager.getPlugins().some(info => info.loaded), 'shutdown must not be undone by a late load').toBe(false)
    expect(liveStates.size, 'a resurrected state would never be disposed').toBe(0)
  })

  it('disposes the superseded load itself — the token check, not the overwrite backstop', async () => {
    /*
     * 领号与"覆盖前先 dispose"的兜底在上一版里互为替身:关掉任一条,测试仍然绿。
     * 那意味着将来有人"简化"掉其中一条不会有任何报警。这条只验领号:
     * 被超过的那次加载必须**在写回之前**自己拆掉,而不是等兜底来收尸。
     */
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let firstLoad = true
    const { manager, disposedStates, liveStates } = createManager({
      loadDelay: async () => {
        if (!firstLoad) return
        firstLoad = false
        await gate
      },
    })

    const refreshing = manager.initialize({ ready: true })
    await Promise.resolve()
    await manager.disablePlugin('demo')
    const enabling = manager.enablePlugin('demo')
    await enabling

    // 此刻 enable 那份已经落表;refresh 那份还卡着。
    const settledBefore = [...liveStates]
    expect(settledBefore).toHaveLength(1)
    const winner = settledBefore[0]

    release?.()
    await refreshing

    // 被超过的那次自己拆了,而且**赢家没有被换掉** —— 如果只有兜底在起作用,
    // 落表的会是后到的那份,赢家会先被 dispose 再替换。
    expect([...liveStates]).toEqual([winner])
    expect(disposedStates).not.toContain(winner)
  })

  it('can be assembled again after shutdown', async () => {
    // 拆除闩不能是单向的 —— 否则 dev 热重载后一个插件也装不上。
    const { manager } = createManager()
    await manager.initialize({ ready: true })
    manager.shutdown()
    await manager.initialize({ ready: true })
    expect(manager.getPlugins().some(info => info.loaded)).toBe(true)
    manager.shutdown()
  })
})
