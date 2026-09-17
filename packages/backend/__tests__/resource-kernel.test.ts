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
      speechOutput: null,
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
    // 不按全表断言:第二种资源(dir / music / workbench …)落地时这条不该跟着红。
    expect(backend.resources.registry.list().map(spec => spec.scheme)).toContain('session')
    expect(backend.resources.tools().map(tool => tool.spec.id)).toContain('session')
    expect(backend.ownedLabels()).toEqual(
      expect.arrayContaining(['resourceKernel', 'builtinResources']),
    )
  })

  it('K3-a:资源工具与元工具在工具目录里(模型看得见),而工具清单那个出口一字不变', async () => {
    // 直接问产品层那台目录端口(回合面 `Surface.resolve` 与设置页工具清单读的都是
    // 它),而不是 backend 私有的 `getOrBuildToolkitCatalog`:这样断言的是**用户与
    // 模型真正看见的那一份**,不是装配的内部账。
    const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
    const { toolkitCatalogToolDefinitions } = await import('@onething/runtime/toolkit/catalog-projection.wiring')
    const catalog = getToolkitCatalog()
    expect(catalog).toBeTruthy()
    // 露面规则(§10.4 第三行):provider 在注册表里 = 那只工具在目录里。
    expect(catalog?.has('session')).toBe(true)
    expect(catalog?.has('resources')).toBe(true)

    // 但「这台宿主注册了哪些工具」那份清单(设置页 / CLI listTools)一行都没多 ——
    // K1 审查打回的就是这一条,判据是 `ToolSpec.projection` 那一格。
    const listed = toolkitCatalogToolDefinitions() ?? []
    expect(listed.map(tool => tool.id)).not.toContain('session')
    expect(listed.map(tool => tool.id)).not.toContain('resources')
    // 少掉的正好是「全部资源工具 + 一只元工具」,不写死几只。
    expect(listed.length).toBe(catalog!.all().length - (backend.resources.tools().length + 1))
  })

  it('K3-a:元工具 resources 列的是注册表当下的样子(它自己不认识任何命名空间)', async () => {
    const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
    const meta = getToolkitCatalog()?.get('resources')
    expect(meta).toBeTruthy()
    const intent = await meta!.plan({ list: true }, { invocation: { sessionId } } as never)
    const result = await meta!.apply(intent, { invocation: { sessionId } } as never)
    expect(result.content[0]?.text).toContain('session — Sessions')
  })

  /**
   * K2c-2:读走的是**读自己那条路**,所以 `ok` 带的是值,不是一段要 `JSON.parse`
   * 回来的文本。这一例因此从「解开那段 JSON」改成「直接读那个值」——判据没变
   * (读到的是真会话),变的是它到手时是不是还包着一层。
   *
   * K3-a':`get` 还给摘要,整份记录另立一条 `record`。两条一起断言 —— 本单要证的
   * 正是它们**是两件事**:一条不带抄本、一条带。
   */
  it('read get 拿到的是摘要(不带抄本),record 拿到的是整份记录', async () => {
    const store = await import('../store.js')
    const created = store.createSession(`resource-k1-${Date.now()}`, 'First name')
    sessionId = created.id

    const summary = await backend.resources.read(`session:${sessionId}`, 'get', {}, callOptions(sessionId))
    expect(summary.kind).toBe('ok')
    if (summary.kind !== 'ok') return
    const value = summary.value as Record<string, unknown>
    expect(value).toMatchObject({ id: sessionId, title: 'First name', pinned: false, archived: false })
    expect(typeof value.createdAt).toBe('number')
    expect(value.messageCount).toBe(0)
    // 摘要里没有抄本 —— 那正是 K3-a' 把 `get` 从整份记录还回来的整句话。
    expect(value).not.toHaveProperty('messages')

    const record = await backend.resources.read(`session:${sessionId}`, 'record', {}, callOptions(sessionId))
    expect(record.kind).toBe('ok')
    if (record.kind !== 'ok') return
    const full = record.value as { id: string; name: string; messages: unknown[] }
    expect(full).toMatchObject({ id: sessionId, name: 'First name' })
    expect(Array.isArray(full.messages)).toBe(true)
  })

  /**
   * 工单 4 A —— **首屏那一页**经真管线(`kernel.read` 一条路)。
   *
   * 它要证的是三句在单测里说不出口的话:
   *   ① `page` 这条读法在**真自述**里,经**真内核**答得出来(不是 provider 上的
   *      一个方法);
   *   ② 交出来的是**折好的**消息 + `hasMoreBefore` + `nextBefore` + **水位**,
   *      而水位与这一页是同一时刻的事实;
   *   ③ 拿 `nextBefore` 往上翻,翻得到头。
   *
   * 反证:把 provider 的 `page` 那一支删掉 → 「读法不在自述里」当场红;把水位
   * 那一格摘掉 → ② 红。
   */
  it('工单 4 A:read page 给出尾页 + 水位,nextBefore 往上翻得到头', async () => {
    const { sessionCommands } = await import('../session/commands.js')
    const store = await import('../store.js')
    const created = store.createSession(`resource-page-${Date.now()}`, 'Paged')

    for (let index = 1; index <= 7; index++) {
      sessionCommands.appendMessage(created.id, {
        message: { id: `p${index}`, role: 'system' as const, content: `line ${index}`, timestamp: index } as never,
      })
    }

    const first = await backend.resources.read(`session:${created.id}`, 'page', { limit: 3 }, callOptions(created.id))
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const page = first.value as {
      messages: Array<{ id: string }>
      hasMoreBefore: boolean
      nextBefore?: string
      watermark: number
    }
    // 缺省就是尾页:最后三条,最旧在前。
    expect(page.messages.map(message => message.id)).toEqual(['p5', 'p6', 'p7'])
    expect(page.hasMoreBefore).toBe(true)
    expect(typeof page.nextBefore).toBe('string')
    // 水位 = 这一页折到账本第几条。它至少要盖住页里最新那条消息,否则壳会把
    // 它当成"还没折过"的新事件再折一遍。
    expect(page.watermark).toBeGreaterThanOrEqual(7)

    // 往上翻:`nextBefore` 就是"上面那一页从哪要"。
    const seen = [...page.messages.map(message => message.id)]
    let cursor = page.nextBefore
    for (let guard = 0; cursor && guard < 10; guard++) {
      const next = await backend.resources.read(
        `session:${created.id}`, 'page', { limit: 3, before: cursor }, callOptions(created.id),
      )
      expect(next.kind).toBe('ok')
      if (next.kind !== 'ok') break
      const older = next.value as { messages: Array<{ id: string }>; hasMoreBefore: boolean; nextBefore?: string }
      seen.unshift(...older.messages.map(message => message.id))
      cursor = older.hasMoreBefore ? older.nextBefore : undefined
    }
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
  })

  /**
   * 工单 5 ①② —— **侧表与取正文那条读法**经真管线。
   *
   * 单测(`session/page-results.test.ts`)判的是抽取那只纯函数;这里判的是两句
   * 只有真内核说得出的话:①页交出来的形状**带 `results` 这一格**(它进了自述的
   * `required`,壳按它挂回三处);②`toolResult` 是**自述里的一条读法**,经
   * `kernel.read` 答得出来 —— 而不是 provider 上一个谁都调不到的方法。
   *
   * 反证:把自述里 `toolResult` 那一条摘掉 → 第二段「读法不在自述里」当场红;
   * 把 provider 的 `results` 那一格摘掉 → 第一段红。
   */
  it('工单 5 ①②:页带 results 侧表,toolResult 是自述里的一条读法', async () => {
    const { sessionCommands } = await import('../session/commands.js')
    const store = await import('../store.js')
    const created = store.createSession(`resource-results-${Date.now()}`, 'Results')
    sessionCommands.appendMessage(created.id, {
      message: { id: 'q1', role: 'system' as const, content: 'one line', timestamp: 1 } as never,
    })

    const paged = await backend.resources.read(`session:${created.id}`, 'page', { limit: 3 }, callOptions(created.id))
    expect(paged.kind).toBe('ok')
    if (paged.kind !== 'ok') return
    // 侧表恒在场(这一条会话里没有工具调用,所以它是空的 —— 空表与缺席不是
    // 一件事:壳按它挂回三处,缺席就得在壳里加一格判空)。
    expect((paged.value as { results: unknown }).results).toEqual({})

    const body = await backend.resources.read(
      `session:${created.id}`, 'toolResult', { toolCallId: 'never-called' }, callOptions(created.id),
    )
    expect(body.kind).toBe('ok')
    if (body.kind !== 'ok') return
    // 「这条会话在,但这一格结果不在」—— 如实说,不编一个空串。
    expect(body.value).toMatchObject({ toolCallId: 'never-called', slot: 'result', found: false })
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
    // `tools()` 按 scheme 字典序,不能拿 [0] 当 session。
    const tool = backend.resources.toolFor('session')!

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

  /**
   * K3-a' —— **同一条 `removeMessage`,效果按主体分档**,在真授权者上验一遍。
   *
   * K3-a 那一版拿一个陌生命名空间 `shred:` 试 `session_destructive` 是不是 `ask`,
   * 因为当时 `removeMessage.effects` 还是空数组(理由:那条做法唯一的调用方是界面
   * 上的删除按钮,给它换上这一类会让界面当场多一张卡)。K3-a 把资源工具放进工具
   * 目录之后那个前提没了 —— 模型现在也拿得到这只 `session` 工具,空效果就是一个
   * 「AI 不问一声删消息」的洞。所以这一例改成真会话上的真做法,一次说两句话:
   *
   *   ① `user` 主体(= 界面那个删除按钮)删自己的消息:**一张卡都不弹**,直接 ok;
   *   ② `agent` 主体(= 模型调那只工具)删同一条会话里的另一条:停在一张真
   *      `session_destructive` 卡上,答 allow 才 ok、答 reject 就是 `denied`。
   *
   * 反证①的落点就是这里:把 provider `plan` 里那句主体分叉拆掉(恒 `[]`),②
   * 的「停在卡上」当场红;把 `session_destructive` 那一行的 policy 改成 `silent`,
   * 红的也是同一句。
   */
  it("K3-a':removeMessage 按主体分档 —— 用户删不弹卡,AI 删停在真权限卡上", async () => {
    const { Permission } = await import('../wiring/permission/index.js')
    const { sessionCommands } = await import('../session/commands.js')
    const { sessionReads } = await import('../session/reads.js')

    const message = (id: string) => ({ id, role: 'system' as const, content: 'k3a2', timestamp: Date.now() })
    for (const id of ['k3a2-user', 'k3a2-ai', 'k3a2-refused']) {
      sessionCommands.appendMessage(sessionId, { message: message(id) as never })
    }

    // ① 用户主体:零效果 → 授权者静默放行,一张卡都没有。
    const byUser = await backend.resources.do(
      `session:${sessionId}`,
      'removeMessage',
      { messageId: 'k3a2-user' },
      callOptions(sessionId),
    )
    expect(byUser.kind).toBe('ok')
    expect(Permission.getPendingPrompts(sessionId)).toHaveLength(0)

    // ② AI 主体:顶格 `session_destructive`(policy `ask`)→ 真的停在一张卡上。
    const agent = { principal: { kind: 'agent' as const, agentId: 'k3a2-agent' }, sessionId }
    const allowed = backend.resources.do(
      `session:${sessionId}`,
      'removeMessage',
      { messageId: 'k3a2-ai' },
      agent,
    )
    await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
    const card = Permission.getPendingPrompts(sessionId)[0]
    expect(card.type).toBe('session_destructive')
    // 卡上那句话是 `Intent.preview.title`(它盖过效果表那句通用的 `Remove session
    // content`)—— 所以人看得见删的是**哪一条消息**,不只是「有人要删点什么」。
    expect(card.title).toBe('Remove message k3a2-ai')
    // `'once'` = 这一次同意(`Permission.Response` 的四支里最保守的那一支)。
    Permission.respond({ sessionId, permissionId: card.id, response: 'once' })
    expect((await allowed).kind).toBe('ok')

    // ③ 答「不」→ denied,不是 failed:被拒绝是一个正常结局,而且那条消息还在。
    const refused = backend.resources.do(
      `session:${sessionId}`,
      'removeMessage',
      { messageId: 'k3a2-refused' },
      agent,
    )
    await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
    const second = Permission.getPendingPrompts(sessionId)[0]
    Permission.respond({ sessionId, permissionId: second.id, response: 'reject' })
    expect((await refused).kind).toBe('denied')

    const ids = sessionReads.listMessages(sessionId).messages.map(m => m.id)
    expect(ids).not.toContain('k3a2-user')
    expect(ids).not.toContain('k3a2-ai')
    expect(ids).toContain('k3a2-refused')
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
        .toContain('session')

      const described = await dispatchRpc({
        domain: 'resources',
        method: 'describe',
        payload: { scheme: 'session' },
      })
      expect(described.ok).toBe(true)
      const spec = (described as { data: Record<string, unknown> }).data
      // K2c-1 把会话的写面补齐到七条;K2c-3 再补三条(`delete` /
      // `setPermissionMode` / `appendSystemMessage`)—— 域剩下那批退成投影时长出来的。
      // 哪几条没进来、为什么(`create` / `createBranch` 卡在归属印上,`activate` /
      // `switch` 是视图状态,缓存那两条是进程内务),写在
      // `runtime/sessions/resource-spec.ts` 的文件头。
      expect(Object.keys(spec.ops as object).sort()).toEqual([
        'appendSystemMessage',
        'delete',
        'removeMessage',
        'rename',
        'setAgent',
        'setArchived',
        'setModel',
        'setPermissionMode',
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
