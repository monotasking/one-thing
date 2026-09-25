/**
 * K2b-2 —— **壳侧提供者在真装配里**(`docs/design/atom-2026-09.md` §5 / §10.2)。
 *
 * 它跑的是一整只 `createOnethingBackend`(临时 store),理由与
 * `resource-kernel.test.ts` 逐字相同:要证的每一句话都跨了两三层,单测说不出口。
 *
 *   ① 一份**壳交上来的**自述进得了同一台内核 —— 内核对「壳资源」这三个字一无所知;
 *   ② 一次 `do` 走完 core 这一侧的整条管线(校验 → plan → 效果上界 → 授权 → 审计),
 *      `apply` 那一步变成总线上一条 `resource:shell-command`,壳回执之后结局是 `ok`;
 *   ③ 读走**同一条**通道,只是载荷上那一格 `kind` 是 `'read'`;
 *   ④ §10.2「在飞」那一行:注销撞上在飞 → `ResourceHomeUnavailableError`,
 *      **不是** `aborted`、**不是**一个泛泛的超时错;超时同理;
 *   ⑤ §10.2「已注销」那一行:摘掉之后再调,回到「未登记」(`ResourceSchemeUnknownError`);
 *   ⑥ 一个 scheme 只能有一个主人 —— 另一扇壳、以及 core 自己那份同名自述,都是
 *      `scheme-taken`;
 *   ⑦ `ui_change` 不弹卡(经真 `PermissionAuthorizer`,不是一次对策略表的断言);
 *   ⑧ (K2b-2b)§10.3 那三条通用事件名的入口 `emit`:壳报的事实骑 K2a 那条既有的路
 *      上总线,而「谁能替谁说话」在 core 判 —— 一扇壳发不出别人命名空间的事实。
 *
 * store 隔离与全动态 import 的写法照 `resource-kernel.test.ts` /
 * `assembly-lifecycle.test.ts`:`stores/sessions.ts` 在 **import 期**就解析 store 根。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ResourceShellCommandEvent } from '@shared/events/index.js'
import type { SerializedResourceSpec } from '@shared/ipc/resources.js'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-shell-'))
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

async function assemble(): Promise<Backend> {
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
      speechOutput: null,
      dialog: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

const PRINCIPAL = { kind: 'user', userId: 'local' } as const
const SHELL = 'shell-a'
const OTHER_SHELL = 'shell-b'

function callOptions(sessionId: string) {
  return { principal: PRINCIPAL, sessionId }
}

/**
 * 一份假的壳自述。它是 §8「陌生能力演练」的活体:内核、装配、RPC 域里一个
 * `workbench` 字都没有,而它照样接得上。
 *
 * `open` 的参数叫 `target` 而不是 `ref`:`ref` 是**地址那一格的键**
 * (`RESOURCE_REF_KEY`),一条做法的参数用这个名字会被内核填进去的真地址盖掉。
 */
const WORKBENCH_SPEC: SerializedResourceSpec = {
  scheme: 'workbench',
  title: 'Workbench',
  reads: {
    layout: {
      title: 'Current layout',
      query: { type: 'object', properties: {}, required: [] },
      result: { type: 'object' },
    },
  },
  ops: {
    open: {
      title: 'Open a tile',
      params: { type: 'object', properties: { target: { type: 'string' } }, required: [] },
      effects: ['ui_change'],
      home: 'shell',
    },
  },
  events: { opened: { title: 'A tile opened', payload: { type: 'object' } } },
}

/** 总线上那条命令。所有用例都靠它拿 `callId` 去回执 —— 那是唯一的缝合线。 */
function watchCommands(backend: Backend): { seen: ResourceShellCommandEvent[]; stop: () => void } {
  const seen: ResourceShellCommandEvent[] = []
  const stop = backend.eventBus.onGlobal('resource:shell-command', envelope => {
    seen.push(envelope.event as unknown as ResourceShellCommandEvent)
  })
  return { seen, stop }
}

async function auditRowsFor(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const { flushSessionEventLog } = await import('../session/event-log.js')
  await flushSessionEventLog(sessionId)
  const ledger = path.join(storeRoot, 'sessions', sessionId, 'events.jsonl')
  if (!fs.existsSync(ledger)) return []
  return fs
    .readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(row => row.type === 'tool/audit')
}

describe('壳侧资源提供者在真装配里(K2b-2)', () => {
  let backend: Backend
  let sessionId: string

  it('mountShell:壳交上来的自述进得了同一台内核,而且 home 一律是 shell', async () => {
    backend = await assemble()
    const store = await import('../store.js')
    sessionId = store.createSession(`resource-k2b2-${Date.now()}`, 'Shell drill').id

    // 壳可以把 `home` 写成任何东西 —— 反序列化不读那一格。这份自述里写的是 'core',
    // 而登记之后它是 'shell':core 这边没有第二份实现能跑一条 home:'core' 的做法。
    const lying = { ...WORKBENCH_SPEC, ops: { open: { ...WORKBENCH_SPEC.ops.open, home: 'core' as const } } }
    expect(await backend.shellResources.mountShell(SHELL, lying)).toEqual({ ok: true })

    /*
     * 问的是「`workbench` 在不在表里」,不是「表里正好有哪几个」(K3-c 改法):
     * 这只文件证的是**壳交上来的自述**进没进同一台内核,内置资源有几种与它无关 ——
     * 写死一张全表,每加一种内置资源就要回来改一次,而那次改动读起来像是这条壳的
     * 用例出了问题。
     */
    expect(backend.resources.registry.list().map(spec => spec.scheme)).toContain('workbench')
    expect(backend.shellResources.schemesOf(SHELL)).toEqual(['workbench'])
    expect(backend.resources.registry.get('workbench')?.ops.open?.home).toBe('shell')

    // 装的是真自述之后的那一份(把上面那句谎话换回来,后面的用例用它)。
    expect(await backend.shellResources.mountShell(SHELL, WORKBENCH_SPEC)).toEqual({ ok: true })
  }, 180_000)

  it('do:管线在 core 里跑完,apply 变成总线上一条命令,回执之后结局是 ok 且审计落了一行', async () => {
    const { seen, stop } = watchCommands(backend)
    const auditBefore = (await auditRowsFor(sessionId)).length

    const pending = backend.resources.do(
      'workbench:center',
      'open',
      { target: `session:${sessionId}` },
      callOptions(sessionId),
    )
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()

    const command = seen[0]
    expect(command).toMatchObject({
      type: 'resource:shell-command',
      shellId: SHELL,
      kind: 'op',
      ref: 'workbench:center',
      op: 'open',
      params: { target: `session:${sessionId}` },
    })
    expect(typeof command.callId).toBe('string')
    expect(command.callId.length).toBeGreaterThan(0)
    expect(typeof command.at).toBe('number')

    expect(backend.shellResources.settleResult(SHELL, command.callId, { kind: 'ok', text: 'opened center' })).toBe(true)
    const outcome = await pending
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.result.content[0]?.text).toBe('opened center')

    // 审计是**管线**发的,不是 provider —— 一条住在另一个进程里的做法照样落账。
    const rows = await auditRowsFor(sessionId)
    expect(rows.length).toBe(auditBefore + 1)
    expect(rows[rows.length - 1]).toMatchObject({
      type: 'tool/audit',
      data: expect.objectContaining({ toolId: 'workbench', outcome: 'ok' }),
    })
  })

  it('ui_change 不弹卡:同一条 do 经真 PermissionAuthorizer 走完,没有一张待答的权限卡', async () => {
    const { Permission } = await import('../wiring/permission/index.js')
    const { seen, stop } = watchCommands(backend)

    // 兜底的掐:`ui_change` 万一进了 ask 那一支,`Permission.ask` 会一直等人回答,
    // 这条 `do` 就永远不返回。给它一个取消源,于是反证是「一秒半之后 aborted」
    // 而不是「用例超时」—— 一条红得慢的反证读起来像是环境抖了。
    const guard = new AbortController()
    const cutoff = setTimeout(() => guard.abort(), 1500)
    const pending = backend.resources.do(
      'workbench:center',
      'open',
      {},
      { ...callOptions(sessionId), signal: guard.signal },
    )
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()
    backend.shellResources.settleResult(SHELL, seen[0].callId, { kind: 'ok', text: 'ok' })
    const outcome = await pending
    clearTimeout(cutoff)

    expect(outcome.kind).toBe('ok')
    expect(Permission.getPendingPrompts(sessionId)).toEqual([])
  })

  it('read 走同一条通道,只是 kind 是 read;回执里那段 JSON 就是读法的返回值', async () => {
    const { seen, stop } = watchCommands(backend)

    const pending = backend.resources.read('workbench:center', 'layout', {}, callOptions(sessionId))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()

    expect(seen[0]).toMatchObject({ shellId: SHELL, kind: 'read', ref: 'workbench:center', op: 'layout' })
    backend.shellResources.settleResult(SHELL, seen[0].callId, {
      kind: 'ok',
      text: JSON.stringify({ tiles: 2 }),
    })

    const outcome = await pending
    expect(outcome.kind).toBe('ok')
    // K2c-2:读的结局带的是**值**。壳那一侧的回执仍然是一段 JSON 文本(那条通道
    // 只走得了文本),解开它的是 `ShellResourceProvider.read`,不再是调用方。
    if (outcome.kind === 'ok') expect(outcome.value).toEqual({ tiles: 2 })
  })

  it('壳说没跑成:结局是 failed(ShellCommandFailedError),不是 ok', async () => {
    const { seen, stop } = watchCommands(backend)
    const pending = backend.resources.do('workbench:center', 'open', {}, callOptions(sessionId))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()

    backend.shellResources.settleResult(SHELL, seen[0].callId, { kind: 'failed', message: 'that tile is gone' })
    const outcome = await pending
    expect(outcome.kind === 'failed' && outcome.error.name).toBe('ShellCommandFailedError')
    expect(outcome.kind === 'failed' && outcome.message).toBe('that tile is gone')
  })

  it('一条回执认 shellId:别扇壳替不了它收场,陌生 shellId 直接抛', async () => {
    const { seen, stop } = watchCommands(backend)
    const pending = backend.resources.do('workbench:center', 'open', {}, callOptions(sessionId))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()

    // 登记过、但不是这条命令的主人 → 对不上账(不抛,因为它是一次合法的调用)。
    await backend.shellResources.mountShell(OTHER_SHELL, { ...WORKBENCH_SPEC, scheme: 'drill' })
    expect(backend.shellResources.settleResult(OTHER_SHELL, seen[0].callId, { kind: 'ok', text: 'stolen' })).toBe(false)
    // 压根没登记过 → 抛:这条通道被一个不该说话的人用了。
    expect(() => backend.shellResources.settleResult('nobody', seen[0].callId, { kind: 'ok', text: 'x' }))
      .toThrow(/No shell is registered/)

    backend.shellResources.settleResult(SHELL, seen[0].callId, { kind: 'ok', text: 'mine' })
    expect((await pending).kind).toBe('ok')
    await backend.shellResources.unmountShell(OTHER_SHELL)
  })

  it('§10.2 在飞:注销撞上在飞 → ResourceHomeUnavailableError(不是 aborted,不是超时)', async () => {
    const { seen, stop } = watchCommands(backend)
    const pending = backend.resources.do('workbench:center', 'open', {}, callOptions(sessionId))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()

    await backend.shellResources.unmountShell(SHELL)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.name).toBe('ResourceHomeUnavailableError')
  })

  it('§10.2 已注销:摘掉之后再调,回到「未登记」那一行', async () => {
    // 同上:摘干净的判据是「`workbench` 不在表里了」,不是内置资源的名单。
    expect(backend.resources.registry.list().map(spec => spec.scheme)).not.toContain('workbench')
    const outcome = await backend.resources.do('workbench:center', 'open', {}, callOptions(sessionId))
    expect(outcome.kind === 'failed' && outcome.error.name).toBe('ResourceSchemeUnknownError')
  })

  /**
   * K3-a —— §10.4 的露面规则在**壳资源**上的样子:provider 随连接来,工具就随连接
   * 进工具目录;壳断线(`unmountShell`)之后它当场不在面上。
   *
   * 这一条就是反证①的落点:拆掉 `wiring/resource/catalog-sync.ts` 对账里的
   * `catalog.unregister`,第二句断言红 —— 目录里会留着一只调不动的 `workbench`。
   */
  it('K3-a 露面:mountShell 之后 workbench 在工具目录里,unmountShell 之后不在', async () => {
    const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
    const catalog = getToolkitCatalog()!
    // 上一条用例把这扇壳摘掉了 —— 所以此刻它本来就不该在目录里。
    expect(catalog.has('workbench')).toBe(false)

    expect(await backend.shellResources.mountShell(SHELL, WORKBENCH_SPEC)).toEqual({ ok: true })
    // 对账排在一个微任务上(理由写在 catalog-sync.ts 的头注释里)。
    await Promise.resolve()
    expect(catalog.has('workbench')).toBe(true)
    // 它不进「这台宿主注册了哪些工具」那份清单 —— 与 session 同一条判据。
    const { toolkitCatalogToolDefinitions } = await import('@onething/runtime/toolkit/catalog-projection.wiring')
    expect((toolkitCatalogToolDefinitions() ?? []).map(tool => tool.id)).not.toContain('workbench')

    await backend.shellResources.unmountShell(SHELL)
    await Promise.resolve()
    expect(catalog.has('workbench')).toBe(false)
  })

  it('超时:壳不回执,结局也是 ResourceHomeUnavailableError —— 家不在了,不是跑得慢', async () => {
    expect(await backend.shellResources.mountShell(SHELL, WORKBENCH_SPEC)).toEqual({ ok: true })
    const previous = backend.shellResources.dispatch.timeoutMs
    backend.shellResources.dispatch.timeoutMs = 50
    try {
      const outcome = await backend.resources.do('workbench:center', 'open', {}, callOptions(sessionId))
      expect(outcome.kind === 'failed' && outcome.error.name).toBe('ResourceHomeUnavailableError')
      expect(backend.shellResources.dispatch.pendingCount).toBe(0)
    } finally {
      backend.shellResources.dispatch.timeoutMs = previous
    }
  })

  it('一个 scheme 一个主人:另一扇壳是 scheme-taken,core 自己那份同名自述也是', async () => {
    expect(await backend.shellResources.mountShell(OTHER_SHELL, WORKBENCH_SPEC))
      .toEqual({ ok: false, reason: 'scheme-taken' })
    // 抢不到,也就一格都没留下 —— 一次失败的登记不该长出半张表。
    expect(backend.shellResources.has(OTHER_SHELL)).toBe(false)

    expect(await backend.shellResources.mountShell(OTHER_SHELL, { ...WORKBENCH_SPEC, scheme: 'session' }))
      .toEqual({ ok: false, reason: 'scheme-taken' })
    expect(backend.resources.registry.get('session')?.title).not.toBe('Workbench')
  })

  it('续命是幂等的:同一份自述再交一次,注册表不重建(引用恒等)', async () => {
    const before = backend.resources.registry.get('workbench')
    expect(await backend.shellResources.mountShell(SHELL, WORKBENCH_SPEC)).toEqual({ ok: true })
    expect(backend.resources.registry.get('workbench')).toBe(before)

    // 自述**变了**才走「先注销再登记」。
    const grown = {
      ...WORKBENCH_SPEC,
      ops: {
        ...WORKBENCH_SPEC.ops,
        close: { ...WORKBENCH_SPEC.ops.open, title: 'Close a tile' },
      },
    }
    expect(await backend.shellResources.mountShell(SHELL, grown)).toEqual({ ok: true })
    expect(backend.resources.registry.get('workbench')).not.toBe(before)
    expect(Object.keys(backend.resources.registry.get('workbench')?.ops ?? {}).sort()).toEqual(['close', 'open'])
  })

  it('§10.3 emit:壳报一条事实,骑 K2a 那条既有的路上总线;越权与陌生壳都抛', async () => {
    const seen: Array<{ ref: string; event: string; payload: unknown }> = []
    const stop = backend.eventBus.onGlobal('resource:event', envelope => {
      seen.push(envelope.event as unknown as { ref: string; event: string; payload: unknown })
    })
    try {
      backend.shellResources.emitEvent(SHELL, 'workbench:center', 'opened', { ref: 'session:x' })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]).toMatchObject({
        ref: 'workbench:center',
        event: 'opened',
        payload: { ref: 'session:x' },
      })
    } finally {
      stop()
    }

    // 归属:这扇壳交的是 `workbench`,`session:` 不是它的 —— 它替不了别人说话。
    expect(() => backend.shellResources.emitEvent(SHELL, `session:${sessionId}`, 'deleted', {}))
      .toThrow(/does not own/)
    // 陌生壳:与 `shellResult` 同一句话。
    expect(() => backend.shellResources.emitEvent('nobody', 'workbench:center', 'opened', {}))
      .toThrow(/No shell is registered/)
    // 地址不成形 / 事件名为空:壳交上来的东西不成形,是错不是结局。
    expect(() => backend.shellResources.emitEvent(SHELL, 'not-a-ref', 'opened', {})).toThrow(/well-formed ref/)
    expect(() => backend.shellResources.emitEvent(SHELL, 'workbench:center', '', {})).toThrow(/non-empty event/)
  })

  it('四条壳面都走得通 RPC 域,而且未认证的联网调用方一条都用不了', async () => {
    const { dispatchRpc } = await import('../rpc/registry.js')
    const { configureHostLocalTrust, resetHostLocalTrustForTests } = await import('../server/host-trust.js')

    // 未认证:三条面一律说不出自己是谁(与 K2a 的四条面同一条规则)。
    resetHostLocalTrustForTests()
    for (const [method, payload] of [
      ['mountShell', { shellId: 'http-shell', spec: { ...WORKBENCH_SPEC, scheme: 'drill' } }],
      ['unmountShell', { shellId: 'http-shell' }],
      ['shellResult', { shellId: SHELL, callId: 'x', result: { kind: 'ok', text: 'x' } }],
      ['emit', { shellId: SHELL, ref: 'workbench:center', event: 'opened', payload: {} }],
    ] as const) {
      const answer = await dispatchRpc({ domain: 'resources', method, payload }, { transport: 'http' })
      expect(answer.ok).toBe(false)
      expect(answer.ok === false && answer.error.message).toContain('no identity')
    }

    const restore = configureHostLocalTrust({ origin: 'desktop-embedded' })
    try {
      const mounted = await dispatchRpc({
        domain: 'resources',
        method: 'mountShell',
        payload: { shellId: 'rpc-shell', spec: { ...WORKBENCH_SPEC, scheme: 'drill' } },
      })
      expect(mounted.ok && mounted.data).toEqual({ ok: true })

      // `describe` 看得见它,而且 `home` 是 shell。
      const described = await dispatchRpc({ domain: 'resources', method: 'describe', payload: { scheme: 'drill' } })
      expect((described as { data: { ops: Record<string, { home: string }> } }).data.ops.open.home).toBe('shell')

      const { seen, stop } = watchCommands(backend)
      const pending = dispatchRpc({
        domain: 'resources',
        method: 'do',
        payload: { ref: 'drill:1', op: 'open', sessionId },
      })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      stop()
      const settled = await dispatchRpc({
        domain: 'resources',
        method: 'shellResult',
        payload: { shellId: 'rpc-shell', callId: seen[0].callId, result: { kind: 'ok', text: 'done' } },
      })
      expect(settled.ok && settled.data).toEqual({ ok: true })
      expect((await pending as { data: { kind: string } }).data.kind).toBe('ok')

      // `emit` 也走同一扇门:事实进 core 之后骑 K2a 那条既有的路。
      const emitted = await dispatchRpc({
        domain: 'resources',
        method: 'emit',
        payload: { shellId: 'rpc-shell', ref: 'drill:1', event: 'opened', payload: {} },
      })
      expect(emitted.ok && emitted.data).toEqual({ ok: true })

      const unmounted = await dispatchRpc({
        domain: 'resources',
        method: 'unmountShell',
        payload: { shellId: 'rpc-shell' },
      })
      expect(unmounted.ok && unmounted.data).toEqual({ ok: true })
      expect(backend.resources.registry.has('drill')).toBe(false)
      // 幂等:再撤一次还是成功。
      expect((await dispatchRpc({
        domain: 'resources',
        method: 'unmountShell',
        payload: { shellId: 'rpc-shell' },
      })).ok).toBe(true)
    } finally {
      restore()
      resetHostLocalTrustForTests()
    }
  })

  it('backend.dispose():壳交上来的资源跟着走,登记簿之后抛', async () => {
    expect(backend.ownedLabels()).toEqual(expect.arrayContaining(['shellResources']))
    await backend.dispose()
    expect(() => backend.shellResources).toThrow()
  })
})
