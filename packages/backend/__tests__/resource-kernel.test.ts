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
import { afterAll, describe, expect, it } from 'vitest'
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

    const target = path.join(storeRoot, 'a-project')
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

  it('dispose 之后 backend.resources 抛', async () => {
    await backend.dispose()
    expect(() => backend.resources).toThrow()
  })
})
