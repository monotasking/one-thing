/**
 * 插件的 `api.resources`(原子 K4-b,`docs/design/atom-2026-09.md` §4
 * 「调度 / 网关 / 插件」:「都是 `Principal` 不同的 `do`」)。
 *
 * 它跑的是一整只 `createOnethingBackend`(临时 store),写法照
 * `packages/backend/__tests__/resource-kernel.test.ts` —— 因为本单要证的四句话
 * 没有一句在纯单测里说得出口:
 *
 *  ① 声明了 `resources:read` 的插件 `read('session:<id>','get')` 拿到的是**真会话**
 *     的摘要(走的是同一台内核、同一条读路,不是一个 mock);
 *  ② 没声明就是**结构化拒绝**(`denied`),而且**熔断账一动不动** —— 作者写错
 *     manifest 不该连坐插件(与 `sessions:peek` 逐字同一条纪律);
 *  ③ `do` 走**真管线**:读面看得见新标题,而
 *     `<store>/audit/resource.jsonl` 那一行的主体是 `system:plugin:<id>` ——
 *     不是 `user`(那是桌面主人的全部授权面)、不是 `agent`(那是会话里那个 AI);
 *  ④ `watch` 收得到 `renamed`,拆除之后收不到。
 *
 * 第五句(连败到阈值 → surface 降级)用的是一台**会抛的内核**替身:内核自己从不
 * 抛(它把五种结局都折成 `Outcome`),而这一族只记「压根没拿到结局」那种失败,
 * 所以要造这种失败只能让那台内核抛 —— 这恰恰也是那条罚则在真机上唯一的产地
 * (关机途中、内核被拆掉的那一瞬)。
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-resources-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../../../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean { return false }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../../../backend.js')['createOnethingBackend']>>

async function assemble(): Promise<Backend> {
  const { createOnethingBackend } = await import('../../../backend.js')
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
      speechOutput: null,
      dialog: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

const ALL_PERMISSIONS = ['resources:read', 'resources:do', 'resources:watch']

/** 无会话那本账(`<store>/audit/resource.jsonl`)。同步写,不用 flush。 */
function readResourceAuditRows(): Array<Record<string, unknown>> {
  const ledger = path.join(storeRoot, 'audit', 'resource.jsonl')
  if (!fs.existsSync(ledger)) return []
  return fs.readFileSync(ledger, 'utf-8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('插件的三个动词(K4-b)', () => {
  let backend: Backend
  let sessionId: string

  async function makePlugin(
    pluginId: string,
    declaredPermissions: string[],
    resources?: () => unknown,
  ) {
    const { createPluginAPI } = await import('../api.js')
    const { getStreamEngine } = await import('../../engine/index.js')
    return createPluginAPI(pluginId, backend.eventBus as never, getStreamEngine() as never, {
      declaredPermissions,
      declaredPanelIds: [],
      declaredWebviewPanelIds: [],
      declaredUiSlots: [],
      declaredBackground: false,
      ...(resources ? { resources: resources as never } : {}),
    })
  }

  it('装配之后 session 这一种资源在场(本单的前提)', { timeout: 180_000 }, async () => {
    backend = await assemble()
    expect(backend.resources.registry.list().map(spec => spec.scheme)).toContain('session')
    const store = await import('../../../store.js')
    sessionId = store.createSession(`plugin-resources-${Date.now()}`, 'First name').id
  })

  it('① 声明了 resources:read 的插件读到的是真会话的摘要', async () => {
    const { api, state } = await makePlugin('reader', ['resources:read'])
    try {
      const outcome = await api.resources.read(`session:${sessionId}`, 'get')
      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') return
      const value = outcome.value as Record<string, unknown>
      expect(value).toMatchObject({ id: sessionId, title: 'First name' })
      // 摘要不带抄本(K3-a' 的口径);插件看到的与界面看到的是同一份。
      expect(value).not.toHaveProperty('messages')
    } finally {
      const { disposePlugin } = await import('../api.js')
      await disposePlugin(state)
    }
  })

  it('② 没声明就是结构化拒绝,而且熔断账一动不动', async () => {
    const { getPluginRuntimeHealth, resetPluginRuntimeHealthForTests } =
      await import('@onething/runtime/plugins/health')
    resetPluginRuntimeHealthForTests()

    // 三条权限一条都不声明。
    const { api, state } = await makePlugin('silent', [])
    try {
      const read = await api.resources.read(`session:${sessionId}`, 'get')
      expect(read).toEqual({ kind: 'denied', reason: 'resources:read' })

      const done = await api.resources.do(`session:${sessionId}`, 'rename', { title: 'nope' })
      expect(done).toEqual({ kind: 'denied', reason: 'resources:do' })

      const seen: unknown[] = []
      const stop = api.resources.watch('session:', event => seen.push(event))
      // 未声明的 watch 回的是一个诚实的空退订:它没订上,所以什么也收不到。
      await backend.resources.do(`session:${sessionId}`, 'rename', { title: 'still first' }, {
        principal: { kind: 'user', userId: 'local' },
      })
      expect(seen).toEqual([])
      stop()

      // 关键的一句:声明门**不是**运行期故障。
      expect(getPluginRuntimeHealth('silent')).toBeUndefined()
    } finally {
      const { disposePlugin } = await import('../api.js')
      await disposePlugin(state)
    }
  })

  it('③ do 走真管线:标题真的改了,审计行的主体是 system:plugin:<id>', async () => {
    const before = readResourceAuditRows().length
    const { api, state } = await makePlugin('renamer', ALL_PERMISSIONS)
    try {
      const outcome = await api.resources.do(`session:${sessionId}`, 'rename', { title: 'Second name' })
      expect(outcome.kind).toBe('ok')
    } finally {
      const { disposePlugin } = await import('../api.js')
      await disposePlugin(state)
    }

    const { sessionReads } = await import('../../../session/reads.js')
    expect(sessionReads.getSession(sessionId)?.name).toBe('Second name')

    const rows = readResourceAuditRows()
    expect(rows.length).toBeGreaterThan(before)
    const audit = rows[rows.length - 1]
    // 插件是**最小权限**那一支,带着自己的名字。不是 user(那是桌面主人的全部
    // 授权面),也不是 agent(那是会话里那个 AI 的身份,grant 会串味)。
    expect(audit.principal).toEqual({ kind: 'system', component: 'plugin:renamer' })
    expect(audit.toolId).toBe('session')
  })

  it('④ watch 收得到 renamed,拆除之后收不到', async () => {
    const { api, state } = await makePlugin('watcher', ALL_PERMISSIONS)
    const seen: Array<{ ref: string; event: string }> = []
    api.resources.watch('session:', event => seen.push({ ref: event.ref, event: event.event }))

    await api.resources.do(`session:${sessionId}`, 'rename', { title: 'Third name' })
    expect(seen.map(entry => entry.event)).toContain('renamed')
    expect(seen[seen.length - 1].ref).toBe(`session:${sessionId}`)

    const { disposePlugin } = await import('../api.js')
    await disposePlugin(state)

    const countAtDispose = seen.length
    await backend.resources.do(`session:${sessionId}`, 'rename', { title: 'Fourth name' }, {
      principal: { kind: 'user', userId: 'local' },
    })
    expect(seen).toHaveLength(countAtDispose)
  })

  it('⑤ 连败到阈值:这一个命名空间被降级,插件本身不被禁用', async () => {
    const { getPluginRuntimeHealth, isPluginSurfaceDegraded, resetPluginRuntimeHealthForTests } =
      await import('@onething/runtime/plugins/health')
    resetPluginRuntimeHealthForTests()

    // 一台**会抛**的内核:内核自己从不抛,所以这是这条罚则在真机上唯一的产地
    // (关机途中、内核刚被拆掉的那一瞬)。
    const exploding = {
      async read(): Promise<never> { throw new Error('kernel is gone') },
      async do(): Promise<never> { throw new Error('kernel is gone') },
      events: { watch: () => () => {} },
    }
    const { api, state } = await makePlugin('flaky', ALL_PERMISSIONS, () => exploding)
    try {
      for (let i = 0; i < 3; i += 1) {
        const outcome = await api.resources.do(`session:${sessionId}`, 'rename', { title: 'x' })
        // 抛出物照旧折成结局回给插件 —— 它看得见自己失败了。
        expect(outcome.kind).toBe('failed')
      }

      expect(isPluginSurfaceDegraded('flaky', 'resource:session')).toBe(true)
      // 罚则是**降级一个命名空间**,不是禁用插件。
      expect(getPluginRuntimeHealth('flaky')?.status).not.toBe('disabled')

      // 降级之后连内核都不调了:回的是那句「暂时停用」,不是第四次 30s 白等。
      const refused = await api.resources.do(`session:${sessionId}`, 'rename', { title: 'x' })
      expect(refused.kind === 'denied' && refused.reason).toMatch(/temporarily disabled/)

      // 另一个命名空间不连坐 —— 那正是「按 scheme 记账」的整句话。它照样抵达
      // (那台会抛的)内核并折成 `failed`,而不是在闸上被拦成 `denied`。
      const other = await api.resources.read('dir:/tmp', 'list')
      expect(other.kind).toBe('failed')
      expect(isPluginSurfaceDegraded('flaky', 'resource:dir')).toBe(false)
    } finally {
      const { disposePlugin } = await import('../api.js')
      await disposePlugin(state)
      resetPluginRuntimeHealthForTests()
    }
  })

  it('拆除之后 dispose 掉内核,后端能干净关掉', { timeout: 60_000 }, async () => {
    await backend.dispose()
    expect(() => backend.resources).toThrow()
  })
})
