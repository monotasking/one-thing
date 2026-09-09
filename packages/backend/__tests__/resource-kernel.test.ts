/**
 * K1 —— 资源内核在**真装配**里的门(`docs/design/atom-2026-09.md` §9 K1)。
 *
 * 它跑的是一整只 `createOnethingBackend`(临时 store),因为 K1 要证的三句话没有
 * 一句在单测里说得出口:
 *
 *   ① `backend.resources.read('session:<id>', 'get')` 拿到的是**真会话**的元数据 ——
 *      读走的是 `sessionReads`,不是一个 mock;
 *   ② `do(..., 'rename')` 之后 `sessionReads.getSession` 看得见新标题、事件总线上
 *      收得到 `renamed`、**`events.jsonl` 里多了一条 `tool/audit`** —— 最后这条是
 *      「界面点按钮也走管线」唯一看得见的证据(审计不是靠自觉,是管线发的);
 *   ③ 同一次重命名,经 `kernel.do` 与经 `createAppToolRunner` 直接 `run` 那只工具
 *      (= AI 路径)拿到**同形**的 `Outcome`。
 *
 * 外加两条 K1 的自我约束:dispose 之后 `backend.resources` 抛;以及**装配之后
 * 工具目录里没有 `session`** —— 资源工具进不进目录、在哪种场子露面归 K3,本单
 * 不注册,于是设置页的工具清单与 CLI 的 listTools 与今天逐字一样。
 *
 * store 隔离与全动态 import 的写法照 `assembly-lifecycle.test.ts`:
 * `stores/sessions.ts` / `stores/settings.ts` 在 **import 期**就解析 store 根。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-kernel-'))
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
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

function callOptions(sessionId: string) {
  return { principal: PRINCIPAL, sessionId }
}

/**
 * `tool/audit` 那一行在不在这条会话的账本里。
 *
 * 读之前先 `flushSessionEventLog`:账本的 append 走一条异步写队列(`event-log.ts`
 * 把每条记录的完成 promise 记在 `state.writes` 里),所以「刚发生的事已经落到文件上」
 * 要等那一条 —— 这不是测试的取巧,是那份账本自己的契约(关机链上的
 * `flushSessionEventLedger` 等的是同一件事)。
 */
async function auditRowsFor(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const { flushSessionEventLog } = await import('../session/event-log.js')
  await flushSessionEventLog(sessionId)
  return readAuditRows(sessionId)
}

/** 无会话那本账(`<store>/audit/resource.jsonl`)。同步写,所以不用 flush。 */
function readResourceAuditRows(): Array<Record<string, unknown>> {
  const ledger = path.join(storeRoot, 'audit', 'resource.jsonl')
  if (!fs.existsSync(ledger)) return []
  return fs
    .readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function readAuditRows(sessionId: string): Array<Record<string, unknown>> {
  const ledger = path.join(storeRoot, 'sessions', sessionId, 'events.jsonl')
  if (!fs.existsSync(ledger)) return []
  return fs
    .readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(row => row.type === 'tool/audit')
}

describe('资源内核在真装配里(K1)', () => {
  let backend: Backend
  let sessionId: string

  it('装配之后内核在位,内置资源已登记,内核自己交得出那只 session 工具', { timeout: 180_000 }, async () => {
    backend = await assemble()
    expect(backend.resources).toBeTruthy()
    expect(backend.resources.registry.list().map(spec => spec.scheme)).toEqual(['session'])
    expect(backend.resources.tools().map(tool => tool.spec.id)).toEqual(['session'])
    expect(backend.ownedLabels()).toEqual(
      expect.arrayContaining(['resourceKernel', 'builtinResources']),
    )
  })

  it('工具目录里没有 session —— 资源工具的注册归 K3,今天的工具清单一字不变', async () => {
    // 直接问产品层那台目录端口(设置页工具清单与 CLI listTools 读的就是它),
    // 而不是 backend 私有的 `getOrBuildToolkitCatalog`:这样断言的是**用户看得见
    // 的那一份**,不是装配的内部账。
    const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
    const catalog = getToolkitCatalog()
    expect(catalog).toBeTruthy()
    expect(catalog?.has('session')).toBe(false)
  })

  it('read 拿到的是真会话的元数据', async () => {
    const store = await import('../store.js')
    const created = store.createSession(`resource-k1-${Date.now()}`, 'First name')
    sessionId = created.id

    const outcome = await backend.resources.read(`session:${sessionId}`, 'get', {}, callOptions(sessionId))
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const summary = JSON.parse(outcome.result.content[0]?.text ?? '')
    expect(summary).toMatchObject({ id: sessionId, title: 'First name', messageCount: 0 })
    expect(typeof summary.createdAt).toBe('number')
  })

  it('读一条不存在的会话,如实说不存在(不是一个空对象)', async () => {
    const outcome = await backend.resources.read('session:nope', 'get', {}, callOptions('nope'))
    expect(outcome.kind === 'failed' && outcome.error.name).toBe('SessionNotFoundError')
  })

  it('do rename:读面看得见新标题、总线上收到 renamed、账本里多一条 tool/audit', async () => {
    const seen: Array<{ ref: string; event: string; payload: unknown }> = []
    const stop = backend.resources.events.watch('session:', event => seen.push(event))
    const auditBefore = (await auditRowsFor(sessionId)).length

    const outcome = await backend.resources.do(
      `session:${sessionId}`,
      'rename',
      { title: 'Second name' },
      callOptions(sessionId),
    )
    stop()

    expect(outcome.kind).toBe('ok')
    const { sessionReads } = await import('../session/reads.js')
    expect(sessionReads.getSession(sessionId)?.name).toBe('Second name')
    expect(seen).toEqual([
      { ref: `session:${sessionId}`, event: 'renamed', payload: { title: 'Second name' } },
    ])

    const rows = await auditRowsFor(sessionId)
    expect(rows.length).toBe(auditBefore + 1)
    // 审计那一行说得出「谁、对什么、什么结局」—— 而它是**管线**发的,不是 provider。
    expect(rows[rows.length - 1]).toMatchObject({
      type: 'tool/audit',
      data: expect.objectContaining({ toolId: 'session', outcome: 'ok' }),
    })
  })

  it('setWorkingDirectory 同形:落到会话上,并发出 workingDirectoryChanged', async () => {
    const seen: string[] = []
    const stop = backend.resources.events.watch(`session:${sessionId}`.concat('/'), () => seen.push('nested'))
    const stopAll = backend.resources.events.watch('session:', event => seen.push(event.event))

    // K2c-1:这条做法的实现改走域今天那一只端口(`workdirGateway.write`),而那条
    // 路上的规则书(`updateOnethingSessionWorkingDirectory`)会先判「是不是一个真
    // 存在的目录」—— AI 走资源面从此与界面同判据,所以这里得真的有这个目录。
    const target = path.join(storeRoot, 'a-project')
    fs.mkdirSync(target, { recursive: true })
    const outcome = await backend.resources.do(
      `session:${sessionId}`,
      'setWorkingDirectory',
      { path: target },
      callOptions(sessionId),
    )
    stop()
    stopAll()

    expect(outcome.kind).toBe('ok')
    const { sessionReads } = await import('../session/reads.js')
    expect(sessionReads.getSession(sessionId)?.workingDirectory).toBe(target)
    // 前缀卡在段边界上:`session:<id>/` 底下没有东西,所以只有整命名空间那条收得到。
    expect(seen).toEqual(['workingDirectoryChanged'])
  })

  it('AI 路径(直接 run 那只工具)与 do 拿到同形的 Outcome', async () => {
    const { createAppToolRunner } = await import('../wiring/toolkit/runner.js')
    const runner = createAppToolRunner({ observer: { on: () => {} } })
    const tool = backend.resources.tools()[0]

    const viaModel = await runner.run(tool, {
      callId: 'ai-path-1',
      toolId: 'session',
      input: { op: 'rename', ref: `session:${sessionId}`, title: 'Third name' },
      sessionId,
      principal: PRINCIPAL,
    })
    const viaKernel = await backend.resources.do(
      `session:${sessionId}`,
      'rename',
      { title: 'Third name' },
      callOptions(sessionId),
    )
    expect(viaModel).toEqual(viaKernel)
  })

  it('资源事件转发上事件总线:do 之后总线收到一条 resource:event(K2a)', async () => {
    const seen: Array<Record<string, unknown>> = []
    const stop = backend.eventBus.onGlobal('resource:event', envelope => {
      seen.push(envelope.event as unknown as Record<string, unknown>)
    })

    const before = Date.now()
    const outcome = await backend.resources.do(
      `session:${sessionId}`,
      'rename',
      { title: 'Bus name' },
      callOptions(sessionId),
    )
    stop()

    expect(outcome.kind).toBe('ok')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      type: 'resource:event',
      ref: `session:${sessionId}`,
      event: 'renamed',
      payload: { title: 'Bus name' },
    })
    // 时刻由**装配层**盖(hub 有意没有时刻)—— 所以它得是一个真的当下,不是 0。
    expect(typeof seen[0].at).toBe('number')
    expect(seen[0].at as number).toBeGreaterThanOrEqual(before)
  })

  it('转发的订阅名单来自注册表,不是写死的 scheme 名(K2a)', async () => {
    // 装一个 core 从没听说过的命名空间,不碰装配一行代码 —— 它的事件照样上总线。
    // 这是 §8 陌生能力演练在**事件**这一侧的那半句。
    const { planFromSpec } = await import('@onething/core/resource')
    const { textResult } = await import('@onething/core/toolkit')
    const spec = {
      scheme: 'drill',
      title: 'Drill things',
      reads: {},
      ops: {
        poke: {
          title: 'Poke it',
          params: { type: 'object', properties: {}, required: [] },
          effects: [] as const,
          home: 'core' as const,
        },
      },
      events: { poked: { title: 'It was poked', payload: { type: 'object' } } },
    }
    let hub: { emit: (ref: string, event: string, payload: unknown) => void } | undefined
    const unmount = backend.resources.mount({
      spec,
      attach: (h: never) => { hub = h },
      read: async () => ({}),
      plan: async (op: string, ref: never) => planFromSpec(spec, op, ref, null),
      apply: async (op: string) => {
        hub?.emit('drill:1', 'poked', { op })
        return textResult('poked')
      },
    } as never)

    const seen: Array<Record<string, unknown>> = []
    const stop = backend.eventBus.onGlobal('resource:event', envelope => {
      seen.push(envelope.event as unknown as Record<string, unknown>)
    })
    const outcome = await backend.resources.do('drill:1', 'poke', {}, callOptions(sessionId))
    stop()
    // K2a':注销是异步的(先让在飞的收场,再摘 —— §10.2 那张表的「在飞」一行)。
    await unmount()

    expect(outcome.kind).toBe('ok')
    expect(seen).toEqual([
      expect.objectContaining({ type: 'resource:event', ref: 'drill:1', event: 'poked' }),
    ])
  })

  it('无会话的 do:管线照跑,审计落 <store>/audit/resource.jsonl,会话账本一行不多(K2a)', async () => {
    const auditBefore = (await auditRowsFor(sessionId)).length
    const ledgerBefore = readResourceAuditRows().length

    const outcome = await backend.resources.do(
      `session:${sessionId}`,
      'rename',
      { title: 'From nowhere' },
      // **不给 sessionId** —— 调度 / deeplink / CLI / 一个与当前会话无关的按钮。
      { principal: PRINCIPAL },
    )

    expect(outcome.kind).toBe('ok')
    const { sessionReads } = await import('../session/reads.js')
    expect(sessionReads.getSession(sessionId)?.name).toBe('From nowhere')

    // 被改的那条会话的抄本里**一行都没多**:它是操作对象,不是发起方。
    // (K1 留账说的正是这件事:借它的坐标,审计就读成「A 自己改了自己」。)
    expect((await auditRowsFor(sessionId)).length).toBe(auditBefore)

    const rows = readResourceAuditRows()
    expect(rows.length).toBe(ledgerBefore + 1)
    expect(rows[rows.length - 1]).toMatchObject({
      type: 'tool/audit',
      toolId: 'session',
      outcome: 'ok',
      // K2a' §10.5:**主体是这本账唯一的线索** —— 它没有会话可回溯,少了这一格
      // 就只知道「有人改过」。
      principal: { kind: 'user', userId: 'local' },
    })
    expect(typeof rows[rows.length - 1].at).toBe('number')
    // 它在 `log/` **之外** —— 日志管家(LogDirJanitor)那棵树碰不到它。
    expect(fs.existsSync(path.join(storeRoot, 'audit', 'resource.jsonl'))).toBe(true)
  })

  it('resources RPC 域:list / describe / read / do 都通,而且是通用的(K2a)', async () => {
    const { dispatchRpc } = await import('../rpc/registry.js')
    // 本机可信 = 桌面那条路,主体铸成本机用户(`rpc/principal.ts` 第一条)。
    const { configureHostLocalTrust, resetHostLocalTrustForTests } = await import('../server/host-trust.js')
    const restore = configureHostLocalTrust({ origin: 'desktop-embedded' })

    try {
      const list = await dispatchRpc({ domain: 'resources', method: 'list', payload: {} })
      expect(list.ok && (list.data as { schemes: Array<{ scheme: string }> }).schemes.map(s => s.scheme))
        .toEqual(['session'])

      const described = await dispatchRpc({
        domain: 'resources',
        method: 'describe',
        payload: { scheme: 'session' },
      })
      expect(described.ok).toBe(true)
      const spec = (described as { data: Record<string, unknown> }).data
      // K2c-1:域退成投影那一批把会话的写面补齐到七条(自述里为什么只有做法没有
      // 读法,理由在 `runtime/sessions/resource-spec.ts` 文件头)。
      expect(Object.keys(spec.ops as object).sort()).toEqual([
        'removeMessage',
        'rename',
        'setAgent',
        'setArchived',
        'setModel',
        'setPinned',
        'setWorkingDirectory',
      ])
      // 函数没过线,但「带不带场子闸」这件事说得出口(会话这两条都不带)。
      expect(JSON.stringify(spec)).not.toContain('function')
      expect((spec.ops as Record<string, { whenGated?: boolean }>).rename.whenGated).toBeUndefined()

      const read = await dispatchRpc({
        domain: 'resources',
        method: 'read',
        payload: { ref: `session:${sessionId}`, name: 'get' },
      })
      expect(read.ok).toBe(true)
      expect((read as { data: { kind: string; text: string } }).data.kind).toBe('ok')

      const done = await dispatchRpc({
        domain: 'resources',
        method: 'do',
        payload: { ref: `session:${sessionId}`, op: 'rename', params: { title: 'Via RPC' } },
      })
      expect((done as { data: { kind: string } }).data.kind).toBe('ok')
      const { sessionReads } = await import('../session/reads.js')
      expect(sessionReads.getSession(sessionId)?.name).toBe('Via RPC')

      // 未知 op 走**校验器**那条路:是 invalid,不是 failed,而且不是一次异常 ——
      // 五态是结局,不是错误(`ok:true` 的信封里装着一个 `invalid`)。
      const bogus = await dispatchRpc({
        domain: 'resources',
        method: 'do',
        payload: { ref: `session:${sessionId}`, op: 'nope' },
      })
      expect(bogus.ok).toBe(true)
      expect((bogus as { data: { kind: string } }).data.kind).toBe('invalid')
    } finally {
      restore()
      resetHostLocalTrustForTests()
    }
  })

  it('未认证的联网调用方:四条面一律说不出自己是谁(K2a)', async () => {
    const { dispatchRpc } = await import('../rpc/registry.js')
    const { resetHostLocalTrustForTests } = await import('../server/host-trust.js')
    resetHostLocalTrustForTests()

    for (const [method, payload] of [
      ['list', {}],
      ['describe', { scheme: 'session' }],
      ['read', { ref: `session:${sessionId}`, name: 'get' }],
      ['do', { ref: `session:${sessionId}`, op: 'rename', params: { title: 'nope' } }],
    ] as const) {
      const answer = await dispatchRpc({ domain: 'resources', method, payload }, { transport: 'http' })
      expect(answer.ok).toBe(false)
      expect(answer.ok === false && answer.error.message).toContain('no identity')
    }
    // 读也没发生过。
    const { sessionReads } = await import('../session/reads.js')
    expect(sessionReads.getSession(sessionId)?.name).toBe('Via RPC')
  })

  /**
   * K2a' §10.1 —— **关机时内核在飞的「做」以 `Outcome.aborted` 收场,而且关机不悬着。**
   *
   * 它跑在真装配上而不是单测里,因为要证的正是「`backend.dispose()` 到得了
   * `resourceKernel.dispose()`」这条接线:内核那一侧的行为由
   * `core/resource/__tests__/kernel.test.ts` 钉,这里钉的是 `own()` 那一格真的登记了。
   */
  it('backend.dispose():内核里在飞的做被掐成 aborted,关机不悬着(K2a\')', async () => {
    const { planFromSpec } = await import('@onething/core/resource')
    const spec = {
      scheme: 'drill',
      title: 'Drill things',
      reads: {},
      ops: {
        hang: {
          title: 'Hang until aborted',
          params: { type: 'object', properties: {}, required: [] },
          effects: [] as const,
          home: 'core' as const,
        },
      },
      events: {},
    }
    let applied = false
    backend.resources.mount({
      spec,
      read: async () => ({}),
      plan: async (op: string, ref: never) => planFromSpec(spec, op, ref, null),
      // 只在收到取消信号之后才回来 —— 不这么写就测不出区别:一个正常返回的 apply
      // 无论内核有没有拉那只 AbortController 都会按时收场。
      apply: async (_op: string, _intent: never, ctx: { abort: { onAbort: (cb: () => void) => void } }) =>
        new Promise(resolve => {
          applied = true
          ctx.abort.onAbort(() => resolve({ kind: 'text', text: 'aborted' }))
        }),
    } as never)

    const inflight = backend.resources.do('drill:1', 'hang', {}, callOptions(sessionId))
    await vi.waitFor(() => expect(applied).toBe(true))

    await backend.dispose()
    expect((await inflight).kind).toBe('aborted')
  })

  it('dispose 之后 backend.resources 抛', async () => {
    await backend.dispose()
    expect(() => backend.resources).toThrow()
  })
})
