/**
 * K2c-1 / K2c-2 —— **`sessions` 域真的退成了投影,不是双写。**
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    // K2c-3。`capability_change` 是 `never-grantable`,但用户主体在 provider 的 plan 里
    // 拿到的是零效果 —— 所以这一条与上面五条一样,一张卡都没有、审计行也一样。
    ['updatePermissionMode', { permissionMode: 'auto-accept-edits' }, 'setPermissionMode', { permissionMode: 'auto-accept-edits' }],
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
   * K2c-2 —— **六条读面也退成了投影,而且读走的是读自己那条路。**
   *
   * 判据两条,与上面写面那一组一半相同、一半刻意相反:
   *
   *   ① 同一条会话、同一组参数,域这一路与直调 `backend.resources.read` 拿到的是
   *      **同一个答案**(信封的载荷 ↔ `ReadOutcome.value`);
   *   ② 两条路**一行审计都不落** —— 这是本单的核心断言。写面那一组要的是「两行
   *      长得一样」(证明同一条管线),读面要的是「一行都没有」(证明读**不**走
   *      那条管线)。读是查询,它不产生事实,而 `audit/resource.jsonl` 的流量假设
   *      写在 `wiring/toolkit/audit-sink.ts` 上:人点一次按钮的量级,不是界面
   *      每翻一页。
   *
   * 反证(施工时跑过):把 `ResourceKernel.read` 改回拼 `Invocation` 走
   * `runner.run`,② 当场红(每条读面各多落一行);而 ① 仍然绿 —— 契约门看不见
   * 这个差别,正是这一组用例存在的理由。
   */
  describe('六条读面 = 资源投影(K2c-2)', () => {
    /** 够大的一页:**同时**越过 4000 行与 256KB 两条预算线。 */
    const BIG_LINES = 40
    const bigContent = (index: number) => {
      const head = Array.from({ length: BIG_LINES }, (_, line) => `message ${index} line ${line}`).join('\n')
      return `${head}\n${'x'.repeat(2000)}`
    }
    const PAGE_SIZE = 200
    let bigSessionId = ''

    beforeAll(async () => {
      const store = await import('../../store.js')
      const { sessionCommands } = await import('../../session/commands.js')
      bigSessionId = store.createSession(`k2c2-${Date.now()}`, 'Big transcript').id
      for (let index = 0; index < PAGE_SIZE; index++) {
        sessionCommands.appendMessage(bigSessionId, {
          message: {
            id: `k2c2-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: bigContent(index),
            timestamp: 1_700_000_000_000 + index,
          } as never,
        })
      }
    }, 180_000)

    /** 一条读面跑两遍:先经域,再直调读路。两遍都数审计行。 */
    async function bothReads(
      method: string,
      payload: Record<string, unknown>,
      name: string,
      query: Record<string, unknown> = {},
    ) {
      const { dispatchRpc } = await import('../registry.js')

      const before = resourceAuditRows().length
      const viaDomain = await dispatchRpc({ domain: 'sessions', method, payload })
      const afterDomain = resourceAuditRows().length
      const viaKernel = await backend.resources.read(`session:${payload.sessionId}`, name, query, {
        principal: PRINCIPAL,
      })
      const afterKernel = resourceAuditRows().length

      return {
        data: (viaDomain as { ok: boolean; data: Record<string, unknown> }).data,
        viaKernel,
        domainRows: afterDomain - before,
        kernelRows: afterKernel - afterDomain,
      }
    }

    /**
     * K3-a':域的 `get` 读的是 **`record`**(它的契约要 `ChatSession` 本人),
     * 而自述里的 `get` 是不带抄本的摘要 —— 两条读法是两件事。所以这一例比的是
     * 域 ↔ `record`,并顺手钉住「`get` 不是它」:那一句才是本单改口的证据。
     */
    it('get:域交出的 session 就是 record 交出的那个值,而 get 是不带抄本的摘要', async () => {
      const seen = await bothReads('get', { sessionId }, 'record')
      expect(seen.data.success).toBe(true)
      expect(seen.viaKernel.kind).toBe('ok')
      expect(seen.data.session).toEqual((seen.viaKernel as { value: unknown }).value)
      expect(seen.domainRows).toBe(0)
      expect(seen.kernelRows).toBe(0)

      const summary = await backend.resources.read(`session:${sessionId}`, 'get', {}, { principal: PRINCIPAL })
      expect(summary.kind).toBe('ok')
      expect((summary as { value: Record<string, unknown> }).value).not.toHaveProperty('messages')
      expect((summary as { value: Record<string, unknown> }).value).toMatchObject({ id: sessionId })
    })

    it('getMessages:整份抄本 = messages 不带分页,两条路零审计', async () => {
      const seen = await bothReads('getMessages', { sessionId: bigSessionId }, 'messages')
      expect(seen.data.success).toBe(true)
      const messages = seen.data.messages as Array<{ id: string }>
      expect(messages).toHaveLength(PAGE_SIZE)
      expect(messages).toEqual((seen.viaKernel as { value: { messages: unknown } }).value.messages)
      expect(seen.domainRows).toBe(0)
      expect(seen.kernelRows).toBe(0)
    })

    it('getUserMarkers / getSegments / getTokenUsage:同值,零审计', async () => {
      const markers = await bothReads('getUserMarkers', { sessionId: bigSessionId }, 'markers')
      expect(markers.data.markers).toEqual((markers.viaKernel as { value: unknown }).value)
      expect(markers.domainRows + markers.kernelRows).toBe(0)

      const segments = await bothReads('getSegments', { sessionId: bigSessionId }, 'segments')
      expect(segments.data.segments).toEqual((segments.viaKernel as { value: unknown }).value)
      expect(segments.domainRows + segments.kernelRows).toBe(0)

      const usage = await bothReads('getTokenUsage', { sessionId: bigSessionId }, 'tokenUsage')
      expect(usage.data.usage).toEqual((usage.viaKernel as { value: unknown }).value)
      expect(usage.domainRows + usage.kernelRows).toBe(0)
    })

    /**
     * **真店那种规模的一页整份到达,一个字都没被截掉。**
     *
     * 200 条 × 41 行 × ~2KB 同时越过 `OutputBudget` 的两条线(4000 行 / 256KB)。
     * K1 那条路上这一页会变成一段带 `<truncation>` 的文本 —— 那是 K2c-1 在真店上
     * 量到、并因此把读面留给本单的那条硬伤。拆掉这一例,那条硬伤就再也没有门。
     */
    it('getMessagesPage:200 条的一页原样到达,没有 <truncation>,零审计', async () => {
      const seen = await bothReads(
        'getMessagesPage',
        { sessionId: bigSessionId, limit: PAGE_SIZE },
        'messages',
        { anchor: 'tail', limit: PAGE_SIZE },
      )
      expect(seen.data.success).toBe(true)
      const messages = seen.data.messages as Array<{ id: string; content: string }>
      expect(messages).toHaveLength(PAGE_SIZE)
      // 每一条都是完整的那一份,不是被截过的开头。
      expect(messages[0].content).toBe(bigContent(0))
      expect(messages[PAGE_SIZE - 1].content).toBe(bigContent(PAGE_SIZE - 1))
      expect(JSON.stringify(seen.data)).not.toContain('<truncation>')
      // 页信封那几格原样上抬。
      expect(seen.data.totalCount).toBe(PAGE_SIZE)
      expect(seen.data.hasMoreBefore).toBe(false)
      expect(seen.domainRows).toBe(0)
      expect(seen.kernelRows).toBe(0)
    })

    /**
     * K3-a' —— **模型翻页夹在 100 条以内,界面那 200 条一格不动。**
     *
     * 上一例证的是界面那一半(200 条原样到达);这一例证的是另一半,而两例必须
     * 同时绿:无条件夹会让上一例红(那是 K2c-2 的判例,不许回退),不夹则模型可以
     * 一次要走整份抄本再被预算截断。判据是主体,与 `removeMessage` 那一处同一个维度。
     */
    it('模型主体翻页:要 500 条只给 100,缺省给 20;界面那一路不受影响', async () => {
      const agent = { principal: { kind: 'agent' as const, agentId: 'k3a2-agent' } }
      const ref = `session:${bigSessionId}`

      const capped = await backend.resources.read(ref, 'messages', { anchor: 'tail', limit: 500 }, agent)
      expect(capped.kind).toBe('ok')
      expect((capped as { value: { messages: unknown[] } }).value.messages).toHaveLength(100)

      // 说了分页的话但没说要多少 —— 缺省 20(自述 `limit` 那一格上写着同一个数)。
      const defaulted = await backend.resources.read(ref, 'messages', { anchor: 'tail' }, agent)
      expect((defaulted as { value: { messages: unknown[] } }).value.messages).toHaveLength(20)

      // 同一组参数,用户主体拿到的是它要的那 200 条。
      const shell = await backend.resources.read(ref, 'messages', { anchor: 'tail', limit: 500 }, {
        principal: PRINCIPAL,
      })
      expect((shell as { value: { messages: unknown[] } }).value.messages).toHaveLength(PAGE_SIZE)
    })
  })

  /**
   * K2c-3 —— **域剩下那批也退了**,三种形状各钉一条。
   *
   * 与前面两组的判据一脉相承:写面「两条路各留一行同形的审计」、读面「两条路一行
   * 审计都不落」。本组多出的第三种形状是**回执里带着东西**(`deletedCount` /
   * `removedId`):它们从 `Result.details` 上抬,而 `Outcome.ok` 只装文本这条 K2c-1
   * 量出来的硬伤对它们不成立 —— 回执是三五个字段,不是一页抄本。
   */
  describe('剩下那批 = 资源投影(K2c-3)', () => {
    it('addSystemMessage:两条路各写进一条系统消息,同一形状的审计', async () => {
      const { dispatchRpc } = await import('../registry.js')
      const { sessionReads } = await import('../../session/reads.js')
      const message = (id: string) => ({ id, role: 'system' as const, content: '{"type":"note"}', timestamp: 1 })

      const before = resourceAuditRows().length
      const viaDomain = await dispatchRpc({
        domain: 'sessions',
        method: 'addSystemMessage',
        payload: { sessionId, message: message('k2c3-domain') },
      })
      const afterDomain = resourceAuditRows()
      const viaKernel = await backend.resources.do(
        `session:${sessionId}`,
        'appendSystemMessage',
        { message: message('k2c3-kernel') },
        { principal: PRINCIPAL },
      )
      const afterKernel = resourceAuditRows()

      expect(viaDomain).toEqual({ ok: true, data: { success: true } })
      expect(viaKernel.kind).toBe('ok')
      expect(afterDomain.length - before).toBe(1)
      expect(afterKernel.length - afterDomain.length).toBe(1)
      expect(comparableAudit(afterDomain[afterDomain.length - 1]))
        .toEqual(comparableAudit(afterKernel[afterKernel.length - 1]))

      const ids = sessionReads.listMessages(sessionId).messages.map(m => m.id)
      expect(ids).toContain('k2c3-domain')
      expect(ids).toContain('k2c3-kernel')
    })

    /**
     * 两条标记消息的删除 = `removeMessage` 的 `marker` 那一格,而回执里那个
     * `removedId` 走 `Result.details`。
     *
     * 三件事一起钉:①真的按标记找到了那一条(`removedId` 是它的 id);②本来就没有
     * 那条标记时是 `{ success: true, removedId: null }` 而不是一次失败;③域这一路与
     * 直调资源面拿到同一个 `removedId`。
     */
    it('removeFilesChangedMessage / removeGitStatusMessage:按标记删,removedId 从 details 上抬', async () => {
      const { dispatchRpc } = await import('../registry.js')
      const { sessionCommands } = await import('../../session/commands.js')
      const marked = (id: string, type: string) =>
        ({ id, role: 'system' as const, content: `{"type":"${type}","files":[]}`, timestamp: 2 })
      sessionCommands.appendMessage(sessionId, { message: marked('k2c3-files', 'files-changed') as never })
      sessionCommands.appendMessage(sessionId, { message: marked('k2c3-git', 'git-status') as never })

      await expect(dispatchRpc({
        domain: 'sessions',
        method: 'removeFilesChangedMessage',
        payload: { sessionId },
      })).resolves.toEqual({ ok: true, data: { success: true, removedId: 'k2c3-files' } })

      // 删过一次就没有第二条了 —— 「本来就没有」是成功,不是失败。
      await expect(dispatchRpc({
        domain: 'sessions',
        method: 'removeFilesChangedMessage',
        payload: { sessionId },
      })).resolves.toEqual({ ok: true, data: { success: true, removedId: null } })

      // 直调资源面:同一条做法、另一种标记,`details` 里是同一格。
      const viaKernel = await backend.resources.do(
        `session:${sessionId}`,
        'removeMessage',
        { marker: 'git-status' },
        { principal: PRINCIPAL },
      )
      expect(viaKernel.kind).toBe('ok')
      expect(viaKernel.kind === 'ok' && viaKernel.result.details).toEqual({ removedId: 'k2c3-git' })
    })

    /**
     * 列表:读法 `list`,地址是那个**保留坐标**。两条路同值、**零审计**(读不落账),
     * 而归属过滤留在域适配器里 —— 这台宿主上调用方就是那个本机主人,所以两边给出的
     * 是同一批行,这一例证的正是「域没有在投影之外再挑一遍字段」。
     */
    it('list / listMeta:域这一路与 session:@all 的 list 同值,两条路零审计', async () => {
      const { dispatchRpc } = await import('../registry.js')

      const before = resourceAuditRows().length
      const viaDomain = await dispatchRpc({ domain: 'sessions', method: 'listMeta', payload: {} })
      const afterDomain = resourceAuditRows().length
      const viaKernel = await backend.resources.read('session:@all', 'list', {}, { principal: PRINCIPAL })
      const afterKernel = resourceAuditRows().length

      const data = (viaDomain as { data: { success: boolean; sessions: Array<{ id: string }> } }).data
      expect(data.success).toBe(true)
      expect(viaKernel.kind).toBe('ok')
      expect(data.sessions).toEqual((viaKernel as { value: { sessions: unknown } }).value.sessions)
      expect(data.sessions.map(row => row.id)).toContain(sessionId)
      expect(afterDomain - before).toBe(0)
      expect(afterKernel - afterDomain).toBe(0)

      // 一条会话的地址问集合级读法 = 说不清楚的请求,不是一份空列表。
      const misaddressed = await backend.resources.read(`session:${sessionId}`, 'list', {}, { principal: PRINCIPAL })
      expect(misaddressed.kind).toBe('failed')
      expect(misaddressed.kind === 'failed' && misaddressed.error.name)
        .toBe('SessionCollectionRefRequiredError')
    })

    /**
     * **删,在真装配上,按主体分档。**
     *
     * 这是本单最值钱的一条:`delete` 从前整串副作用只长在域的处理器里,于是只有界面
     * 删得掉会话。退成投影之后 AI 也删得掉 —— 所以它必须**停在一张真权限卡上**。
     *
     * 一次说四句话:①用户主体删,一张卡都不弹;②AI 主体删同一形状的另一条会话,停在
     * 一张 `session_destructive` 卡上,答 allow 才真删;③删掉之后索引里真的没有它了;
     * ④那条会话的 AI todo 跟着走(它按会话 id 记账,不清就是永远留在盘上的孤儿)。
     *
     * 反证①的落点就是这里:把 provider `plan` 里 `delete` 那句主体分叉拆掉(恒 `[]`),
     * ②的「停在卡上」当场红。
     */
    it('delete:用户删不弹卡,AI 删停在真权限卡上;删完索引没了、AI todo 也没了', async () => {
      const { Permission } = await import('../../wiring/permission/index.js')
      const store = await import('../../store.js')
      const { dispatchRpc } = await import('../registry.js')

      const byUser = store.createSession(`k2c3-user-${Date.now()}`, 'Deleted by the user').id
      const byAgent = store.createSession(`k2c3-agent-${Date.now()}`, 'Deleted by the model').id
      // 发起坐标:审计与权限卡都挂在「从哪条会话里发起的」那一条上,而删的是另一条。
      const origin = store.createSession(`k2c3-origin-${Date.now()}`, 'Where the model is working').id

      // 那条会话的 AI todo —— 删完必须跟着走。
      const todoPath = backend.todoPlans.store.sessionAiTodoPath(byAgent)
      fs.mkdirSync(path.dirname(todoPath), { recursive: true })
      fs.writeFileSync(todoPath, '# AI Todo\n\n- [ ] something\n', 'utf-8')

      const seen: Array<{ event: string; payload: unknown }> = []
      const stop = backend.resources.events.watch('session:', event => {
        if (event.event === 'deleted') seen.push({ event: event.event, payload: event.payload })
      })

      try {
        // ① 用户主体(= 侧栏那个删除按钮):零效果 → 一张卡都没有。
        await expect(dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: byUser } }))
          .resolves.toEqual({ ok: true, data: { success: true, deletedCount: 1 } })
        expect(Permission.getPendingPrompts(origin)).toHaveLength(0)

        // ② AI 主体:顶格 `session_destructive`(policy `ask`)→ 真的停在一张卡上。
        const deleting = backend.resources.do(`session:${byAgent}`, 'delete', {}, {
          principal: { kind: 'agent', agentId: 'k2c3-agent' },
          sessionId: origin,
        })
        await vi.waitFor(() => expect(Permission.getPendingPrompts(origin)).toHaveLength(1))
        const card = Permission.getPendingPrompts(origin)[0]
        expect(card.type).toBe('session_destructive')
        // 卡上那句话说的是**整条会话**,不是「有人要删点什么」。
        expect(card.title).toBe('Delete the session and its branches')
        Permission.respond({ sessionId: origin, permissionId: card.id, response: 'once' })
        expect((await deleting).kind).toBe('ok')

        // ③ 索引里真的没有它们了。
        const ids = store.getSessionsList().map(meta => meta.id)
        expect(ids).not.toContain(byUser)
        expect(ids).not.toContain(byAgent)

        // ④ AI todo 跟着会话走(它是 fire-and-forget 的,所以等一下)。
        await vi.waitFor(() => expect(fs.existsSync(todoPath)).toBe(false))

        // 两条路各发一发 `deleted`,载荷里是这次真删掉的那几条(§10.3 的通用名)。
        expect(seen).toEqual([
          { event: 'deleted', payload: { cascadedSessionIds: [byUser] } },
          { event: 'deleted', payload: { cascadedSessionIds: [byAgent] } },
        ])
      } finally {
        stop()
      }
    })
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
