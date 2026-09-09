/**
 * K2c-1 —— **`sessions` 域的写面真的退成了投影,不是双写。**
 *
 * `sessions-domain.test.ts` 那 25 例证的是「对外契约一个字没变」;这一组证的是
 * 另一半,而那一半在信封上看不出来:**域这一路与直接调资源面走的是同一条管线**。
 * 判据两条,缺一条就说明还有第二条路:
 *
 *   ① 同一条会话、同一组参数,两条路产出**同一个结果**(信封 ↔ Outcome 一一对应);
 *   ② 两条路各自在 `<store>/audit/resource.jsonl` 上留下**同一形状的一行**
 *      —— 同一个 `toolId`、同一份效果、同一个主体、同一种结局。审计是管线发的
 *      (`AuditProjector` 只读 lifecycle,工具伪造不了),所以「审计行长得一样」
 *      就是「跑的是同一条管线」在文件上留下的证据。
 *
 * 反证(施工时跑过):把某一条处理器改回直接调仓库端口(绕过管线),① 仍然绿
 * ——信封是一样的——而 ② 当场红:那一路一行审计都不落。这正是本组用例存在的
 * 理由:契约门看不见绕过,这一组看得见。
 *
 * 它跑在**真装配**上(临时 store),写法照 `__tests__/resource-kernel.test.ts`:
 * `stores/sessions.ts` / `stores/settings.ts` 在 import 期就解析 store 根,所以
 * 环境变量要在任何 import 之前钉好,并且全程动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-sessions-projection-'))
process.env.ONETHING_STORE_PATH = storeRoot

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../../backend.js')['createOnethingBackend']>>

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

/** 无会话那本账。同步写(`wiring/toolkit/audit-sink.ts`),所以不用 flush。 */
function resourceAuditRows(): Array<Record<string, unknown>> {
  const ledger = path.join(storeRoot, 'audit', 'resource.jsonl')
  if (!fs.existsSync(ledger)) return []
  return fs
    .readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * 一行审计的**可比较**部分。`callId` 与 `at` 逐次不同(它们正是「这是两次不同的
 * 调用」的证据),其余每一格都必须一模一样。
 */
function comparableAudit(
  row: Record<string, unknown> | undefined,
  options: { dropPreview?: boolean } = {},
): Record<string, unknown> {
  // 这本账的一行是**扁的**(`{ type, at, callId, toolId, principal, … }`),不像
  // 会话抄本那一侧包着一层 `data` —— 见 `wiring/toolkit/audit-sink.ts`。
  const data = { ...row }
  delete data.callId
  delete data.at
  // `previewTitle` 是给人看的那句话,里面带着这次调用的参数。两条路做的是**同一
  // 件事**时它一模一样;`removeMessage` 那一例两条路必须删不同的消息(删过一次
  // 就没有第二次了),所以只有那一例把它摘掉,并各自单独断言。
  if (options.dropPreview) delete data.previewTitle
  return data
}

describe('sessions 域的写面 = 资源投影(K2c-1)', () => {
  let backend: Backend
  let restoreTrust: (() => void) | undefined
  let sessionId = ''

  beforeAll(async () => {
    const { createOnethingBackend } = await import('../../backend.js')
    backend = await createOnethingBackend({
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
    // 默认那只 dispatch context 是桌面那条(`{ transport: 'ipc' }`,没有 ownerUid),
    // 所以主体靠「本机可信」这一条铸(`rpc/principal.ts` 第一条)。
    const { configureHostLocalTrust } = await import('../../server/host-trust.js')
    restoreTrust = configureHostLocalTrust({ origin: 'desktop-embedded' })

    const store = await import('../../store.js')
    sessionId = store.createSession(`k2c1-${Date.now()}`, 'First name').id
  }, 180_000)

  afterAll(async () => {
    restoreTrust?.()
    await backend?.dispose()
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    fs.rmSync(storeRoot, { recursive: true, force: true })
  })

  /**
   * 一条方法跑两遍:先经域(`dispatchRpc`),再直调资源面。两遍都用**同一组参数**,
   * 所以两次的写是幂等的同一件事,比的是结果与审计。
   */
  async function bothPaths(
    method: string,
    payload: Record<string, unknown>,
    op: string,
    params: Record<string, unknown>,
  ) {
    const { dispatchRpc } = await import('../registry.js')

    const beforeDomain = resourceAuditRows().length
    const viaDomain = await dispatchRpc({ domain: 'sessions', method, payload })
    const domainAudit = resourceAuditRows()

    const viaKernel = await backend.resources.do(`session:${sessionId}`, op, params, {
      principal: PRINCIPAL,
    })
    const kernelAudit = resourceAuditRows()

    return {
      viaDomain,
      viaKernel,
      domainRows: domainAudit.length - beforeDomain,
      kernelRows: kernelAudit.length - domainAudit.length,
      domainAudit: comparableAudit(domainAudit[domainAudit.length - 1]),
      kernelAudit: comparableAudit(kernelAudit[kernelAudit.length - 1]),
    }
  }

  const CONVERTED: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['rename', { newName: 'Projected name' }, 'rename', { title: 'Projected name' }],
    ['updatePin', { isPinned: true }, 'setPinned', { pinned: true }],
    ['updateArchived', { isArchived: true, archivedAt: 1234 }, 'setArchived', { archived: true, archivedAt: 1234 }],
    ['updateModel', { provider: 'deepseek', model: 'deepseek-chat' }, 'setModel', { provider: 'deepseek', model: 'deepseek-chat' }],
    ['updateAgent', {}, 'setAgent', {}],
  ]

  for (const [method, payload, op, params] of CONVERTED) {
    it(`${method}:域这一路与直调资源面同结果、同一条 tool/audit`, async () => {
      const seen = await bothPaths(method, { sessionId, ...payload }, op, params)

      // ① 同结果。
      expect(seen.viaDomain).toEqual({ ok: true, data: { success: true } })
      expect(seen.viaKernel.kind).toBe('ok')

      // ② 各留一行,而且两行同形 —— 同一个工具、同一份效果、同一个主体、同一种结局。
      expect(seen.domainRows).toBe(1)
      expect(seen.kernelRows).toBe(1)
      expect(seen.domainAudit).toEqual(seen.kernelAudit)
      expect(seen.domainAudit).toMatchObject({
        toolId: 'session',
        outcome: 'ok',
        effects: [],
        effectCount: 0,
        principal: { kind: 'user', userId: 'local' },
      })
    })
  }

  it('updateWorkingDirectory:同上,且沙箱夹持留在域里(管线没有 per-caller 沙箱这一格)', async () => {
    const target = path.join(storeRoot, 'projected-project')
    fs.mkdirSync(target, { recursive: true })

    const seen = await bothPaths(
      'updateWorkingDirectory',
      { sessionId, workingDirectory: target },
      'setWorkingDirectory',
      { path: target },
    )

    expect(seen.viaDomain).toEqual({ ok: true, data: { success: true } })
    expect(seen.viaKernel.kind).toBe('ok')
    expect(seen.domainAudit).toEqual(seen.kernelAudit)

    const { sessionReads } = await import('../../session/reads.js')
    expect(sessionReads.getSession(sessionId)?.workingDirectory).toBe(target)
  })

  /**
   * 不存在的会话:**两条路各自说各自的话,而说的是同一件事。**
   *
   * 域答的是它二十六条方法共用的那个信封(`Session not found`),资源面答的是
   * `Outcome.failed` 带着 `SessionNotFoundError` —— 折叠发生在
   * `rpc/resource-envelope.ts` 的 `describeError` 那一格,而不是在 provider 里
   * 让「不存在」长成两种事实。
   */
  it('不存在的会话:域回信封、资源面回 Outcome.failed,而且一行审计都没落丢', async () => {
    const { sessionsRpcHandlers } = await import('../domains/sessions.js')
    const { DESKTOP_RPC_CONTEXT } = await import('@shared/ipc/rpc.js')
    const missing = '00000000-0000-4000-8000-000000000000'

    // 直接问处理器,不经 `dispatchRpc`:派发器在处理器之前还有一道**会话归属**闸
    // (契约里的 `session` 授权表),它对一条根本不在索引里的会话先一步说不
    // (`{ ok:false }`)。那道闸不是本单动的东西,也不是本例的题目 —— 本例问的是
    // 「管线报 `SessionNotFoundError` 时,信封折出来还是不是那句老话」。
    const viaDomain = await sessionsRpcHandlers.rename(
      { sessionId: missing, newName: 'nope' },
      DESKTOP_RPC_CONTEXT,
    )
    expect(viaDomain).toEqual({ success: false, error: 'Session not found' })

    const viaKernel = await backend.resources.do(`session:${missing}`, 'rename', { title: 'nope' }, {
      principal: PRINCIPAL,
    })
    expect(viaKernel.kind).toBe('failed')
    expect(viaKernel.kind === 'failed' && viaKernel.error.name).toBe('SessionNotFoundError')

    // 失败也是一次调用:管线照样留下证词(结局是 failed)。
    const rows = resourceAuditRows()
    expect(comparableAudit(rows[rows.length - 1])).toMatchObject({ toolId: 'session', outcome: 'failed' })
  })

  /**
   * `removeMessage` 单独一例:它动的是账本本身,所以要有一条真消息可删,
   * 而「同结果 + 同审计」这两条判据与上面那五条逐字相同。
   */
  it('removeMessage:两条路同结果、同一条 tool/audit', async () => {
    const { dispatchRpc } = await import('../registry.js')
    const { sessionCommands } = await import('../../session/commands.js')
    const { sessionReads } = await import('../../session/reads.js')

    const message = (id: string) => ({
      id,
      role: 'system' as const,
      content: 'projected',
      timestamp: Date.now(),
    })
    sessionCommands.appendMessage(sessionId, { message: message('k2c1-a') as never })
    sessionCommands.appendMessage(sessionId, { message: message('k2c1-b') as never })

    const before = resourceAuditRows().length
    const viaDomain = await dispatchRpc({
      domain: 'sessions',
      method: 'removeMessage',
      payload: { sessionId, messageId: 'k2c1-a' },
    })
    const afterDomain = resourceAuditRows()

    const viaKernel = await backend.resources.do(
      `session:${sessionId}`,
      'removeMessage',
      { messageId: 'k2c1-b' },
      { principal: PRINCIPAL },
    )
    const afterKernel = resourceAuditRows()

    expect(viaDomain).toEqual({ ok: true, data: { success: true } })
    expect(viaKernel.kind).toBe('ok')
    expect(afterDomain.length - before).toBe(1)
    expect(afterKernel.length - afterDomain.length).toBe(1)
    expect(comparableAudit(afterDomain[afterDomain.length - 1], { dropPreview: true }))
      .toEqual(comparableAudit(afterKernel[afterKernel.length - 1], { dropPreview: true }))
    // 各自那句预览说的是各自删的那一条 —— 两行不是同一次调用的复印件。
    expect(afterDomain[afterDomain.length - 1]?.previewTitle).toBe('Remove message k2c1-a')
    expect(afterKernel[afterKernel.length - 1]?.previewTitle).toBe('Remove message k2c1-b')

    const ids = sessionReads.listMessages(sessionId).messages.map(m => m.id)
    expect(ids).not.toContain('k2c1-a')
    expect(ids).not.toContain('k2c1-b')
  })

  /**
   * 审计落的是**无会话**那本账,不是被改的那条会话的抄本(K1 留账、K2a 的答案)。
   *
   * 界面上改一条会话的名字与那条会话正在跑的回合无关 —— 拿它当发起坐标,账本就
   * 读成「A 自己改了自己」。
   */
  it('域这一路的审计落 audit/resource.jsonl,被改那条会话的抄本一行不多', async () => {
    const { dispatchRpc } = await import('../registry.js')
    const { flushSessionEventLog } = await import('../../session/event-log.js')

    const ledger = path.join(storeRoot, 'sessions', sessionId, 'events.jsonl')
    await flushSessionEventLog(sessionId)
    const auditRowsInSession = () => (fs.existsSync(ledger)
      ? fs.readFileSync(ledger, 'utf-8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(row => row.type === 'tool/audit').length
      : 0)
    const before = auditRowsInSession()
    const beforeResource = resourceAuditRows().length

    await dispatchRpc({
      domain: 'sessions',
      method: 'rename',
      payload: { sessionId, newName: 'No origin' },
    })

    await flushSessionEventLog(sessionId)
    expect(auditRowsInSession()).toBe(before)
    expect(resourceAuditRows().length).toBe(beforeResource + 1)
  })
})
