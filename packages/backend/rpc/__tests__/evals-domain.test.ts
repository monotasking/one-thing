/**
 * evals 域,端到端穿过 dispatcher(结构债 P4c 第十批)。
 *
 * 接的是被删掉的那批测试位:`@main/ipc/evals.ts` 里那十四条裸 `ipcMain.handle`。
 * 值得钉的是:
 *  - **`getRepoDir` 的端口口径**:未注入宿主 = 视为非打包 = `process.cwd()`;
 *    注入 `isPackaged: () => true` 且设置里没配 = null,于是 `listResults` /
 *    `listCases` 回空表、`getCase` 回「Evals repo not configured」——
 *    与迁移前 `!app.isPackaged` 那条分支逐字同义;
 *  - **单跑闸**:第二次 `runStart` 拿到「A run is already in progress」,
 *    `runCancel` 只发信号(真实后台任务结束后才释放单跑闸);
 *  - **`listRecords` 的过滤 / 分页 / 预览**与迁移前逐字相同;
 *  - **`readSnapshot` 的两种快照类型**,以及 **http 侧的路径夹紧**(P4 终态批 B:
 *    按 wire 路径读盘的四条不再一律拒,改成必须落在 evals 面自己那两棵树里)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { evalsRouter } from '@shared/ipc/evals.js'
import { EvalsTaskOwner, configureEvalsTaskOwner } from '../../wiring/evals/task-owner.js'

const runtime = vi.hoisted(() => ({
  loadMergedRecords: vi.fn(() => [] as Array<Record<string, unknown>>),
  recordHasNegative: vi.fn(() => true),
  recordExplicitDown: vi.fn(() => '/tmp/fixture.json'),
  parseCaseYaml: vi.fn(() => ({
    id: '',
    description: '',
    fixture: '',
    userMessage: '',
    expect: {},
  })),
  generateCaseYaml: vi.fn(() => 'id: x\n'),
  filterRecordsByWeeks: vi.fn((records: unknown[]) => records),
  generateTriageReport: vi.fn(() => '# report'),
  runEvals: vi.fn(async () => {}),
}))
const settings = vi.hoisted(() => ({ getSettings: vi.fn(() => ({} as Record<string, unknown>)) }))

vi.mock('@onething/runtime', () => runtime)
vi.mock('../../stores/settings.js', () => settings)
vi.mock('../../store.js', () => ({
  getSettings: settings.getSettings,
  getSession: vi.fn(() => undefined),
}))
vi.mock('../../wiring/skills/session-skills.js', () => ({ getSkillsForSession: vi.fn(() => []) }))
vi.mock('../../wiring/evals/incident.js', () => ({ createIncidentForTurn: vi.fn(async () => null) }))
vi.mock('../../wiring/evals/provider-adapter.js', () => ({
  resolveEvalsCredentials: vi.fn(() => ({ ok: true, apiKey: 'k', baseUrl: 'https://x' })),
  createEvalsModelCaller: vi.fn(() => async () => ({ content: '', toolCalls: [], finishReason: 'stop' })),
}))

const HTTP_CONTEXT: RpcDispatchContext = { transport: 'http', sandboxRoot: '/tmp' }

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('evals RPC domain', () => {
  let dispatchRpc: (typeof import('../registry.js'))['dispatchRpc']
  let configureEvalsHost: (typeof import('../../wiring/evals/host-ports.js'))['configureEvalsHost']
  let configureHostLocalTrust: (typeof import('../../server/host-trust.js'))['configureHostLocalTrust']
  let resetHostLocalTrustForTests: (typeof import('../../server/host-trust.js'))['resetHostLocalTrustForTests']
  let dispose: (() => void) | undefined
  let tmpDir: string
  let tasks: EvalsTaskOwner
  let unbindTasks: () => void

  beforeEach(async () => {
    const [registry, domain, ports, trust] = await Promise.all([
      import('../registry.js'),
      import('../domains/evals.js'),
      import('../../wiring/evals/host-ports.js'),
      import('../../server/host-trust.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    configureEvalsHost = ports.configureEvalsHost
    configureHostLocalTrust = trust.configureHostLocalTrust
    resetHostLocalTrustForTests = trust.resetHostLocalTrustForTests
    // 可信是**进程级单槽**:每条用例从"未声明"起跑。
    resetHostLocalTrustForTests()
    registry.resetRpcRegistryForTests()
    tasks = new EvalsTaskOwner()
    unbindTasks = configureEvalsTaskOwner(tasks)
    dispose = registry.registerRouterHandlers(evalsRouter, domain.evalsRpcHandlers)
    configureEvalsHost({})
    settings.getSettings.mockReturnValue({})
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-domain-'))
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    tasks.quiesce()
    await tasks.drain()
    unbindTasks()
    configureEvalsHost({})
    resetHostLocalTrustForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  const call = (method: string, payload: unknown = {}, context?: RpcDispatchContext) =>
    dispatchRpc({ domain: 'evals', method, payload }, context)

  it('lists records with the negative filter, the page window and the fixture preview', async () => {
    const fixturePath = path.join(tmpDir, 'fx.json')
    fs.writeFileSync(fixturePath, JSON.stringify({ userMessage: 'hello world' }), 'utf-8')
    runtime.loadMergedRecords.mockReturnValue([
      { ts: '2026-08-01T00:00:00.000Z', fixtureRef: fixturePath, judge: { category: 'a' } },
      { ts: '2026-08-02T00:00:00.000Z', fixtureRef: null, judge: { category: 'b' } },
    ])
    runtime.recordHasNegative.mockImplementation(() => true)

    const all = unwrap(await call('listRecords', {}))
    expect(all.total).toBe(2)
    // 默认按 ts 倒序
    expect((all.records as Array<{ ts: string }>)[0].ts).toBe('2026-08-02T00:00:00.000Z')

    const filtered = unwrap(await call('listRecords', { category: 'a' }))
    expect(filtered.total).toBe(1)
    expect((filtered.records as Array<Record<string, unknown>>)[0]).toMatchObject({
      hasFixture: true,
      userMessagePreview: 'hello world',
    })
  })

  it('reads prompt and context snapshots', async () => {
    // 桌面 = 本机可信(B2 之后这是「路径不夹」的判据,见下面那条夹紧用例)。
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const promptPath = path.join(tmpDir, 'a.prompt.json')
    fs.writeFileSync(promptPath, JSON.stringify({ system: 'S' }), 'utf-8')
    const contextPath = path.join(tmpDir, 'a.context.jsonl')
    fs.writeFileSync(
      contextPath,
      ['{"header":1}', '{"m":{"role":"user"}}', '{"m":{"role":"assistant"}}'].join('\n'),
      'utf-8',
    )

    expect(unwrap(await call('readSnapshot', { path: promptPath }))).toMatchObject({
      success: true,
      snapshotType: 'prompt',
      promptSnapshot: { system: 'S' },
    })
    expect(unwrap(await call('readSnapshot', { path: contextPath, limit: 1 }))).toMatchObject({
      success: true,
      snapshotType: 'context',
      total: 2,
      hasMore: true,
    })
    // 未知后缀与不存在的路径,文案逐字沿用迁移前
    expect(unwrap(await call('readSnapshot', { path: path.join(tmpDir, 'nope.txt') }))).toEqual({
      success: false,
      error: 'Snapshot file not found',
    })
  })

  /**
   * P4 终态批 B(拍板 #15):渲染侧能力位 `evals` 放开之后,按 wire 路径读盘的四条
   * 不能再一律拒 —— 拒了就是位开着面死着。改成**夹紧**:路径必须落在 evals 面自己
   * 的两棵树里(`<repoDir>/evals` 与 `~/.onething/evals/fixtures/auto`)。
   *
   * 三支都要钉:树里的读得到、树外的结构化失败、本机可信的宿主一格没动。
   *
   * B2(`docs/design/backend-transport-forks-2026-09.md` §2.2)把判据从
   * `transport === 'http'` 换成 `isHostLocallyTrusted()`,所以"一格没动"那一支
   * 现在由**声明可信**指认,而不是由 transport 指认。
   */
  it('clamps wire paths into the evals roots on an untrusted host instead of refusing them', async () => {
    configureEvalsHost({ repoDir: () => tmpDir })
    const fixturesDir = path.join(tmpDir, 'evals', 'fixtures')
    fs.mkdirSync(fixturesDir, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'evals', 'runs'), { recursive: true })

    const insidePrompt = path.join(fixturesDir, 'a.prompt.json')
    fs.writeFileSync(insidePrompt, JSON.stringify({ system: 'S' }), 'utf-8')
    const insideFixture = path.join(fixturesDir, 'fx.json')
    fs.writeFileSync(insideFixture, JSON.stringify({ userMessage: 'hi' }), 'utf-8')
    fs.writeFileSync(
      path.join(tmpDir, 'evals', 'runs', 'r.json'),
      JSON.stringify({ id: 'r' }),
      'utf-8',
    )

    // 树里:http 上照读(位开着,面就得真的能用)
    expect(unwrap(await call('readSnapshot', { path: insidePrompt }, HTTP_CONTEXT))).toMatchObject({
      success: true,
      snapshotType: 'prompt',
      promptSnapshot: { system: 'S' },
    })
    expect(unwrap(await call('readFixture', { fixturePath: insideFixture }, HTTP_CONTEXT))).toMatchObject({
      success: true,
      fixture: { userMessage: 'hi' },
    })
    expect(unwrap(await call('readRunDetail', { detailPath: 'evals/runs/r.json' }, HTTP_CONTEXT))).toEqual({
      success: true,
      detail: { id: 'r' },
    })

    // 树外:结构化失败,一个字节都不读
    const outside = path.join(tmpDir, 'outside.prompt.json')
    fs.writeFileSync(outside, JSON.stringify({ system: 'X' }), 'utf-8')
    const outsidePayloads: Array<[string, Record<string, unknown>]> = [
      ['readSnapshot', { path: outside }],
      ['readFixture', { fixturePath: outside }],
      ['promoteFixture', { fixturePath: outside, expect: {} }],
      // `..` 在与仓根拼完之后就塌掉了,所以 `readRunDetail` 也没有出路
      ['readRunDetail', { detailPath: '../outside.prompt.json' }],
    ]
    for (const [method, payload] of outsidePayloads) {
      expect(unwrap(await call(method, payload, HTTP_CONTEXT))).toEqual({
        success: false,
        error: 'Path is outside the evals workspace',
      })
    }

    // 本机可信一格没动:桌面就是本机那个人,树外照读 —— 而且 B2 之后
    // **两种 transport 同一个答案**(桌面内嵌 HTTP 面与 IPC 同权)。
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const trustedIpc = unwrap(await call('readSnapshot', { path: outside }))
    const trustedHttp = unwrap(await call('readSnapshot', { path: outside }, HTTP_CONTEXT))
    expect(trustedIpc).toMatchObject({
      success: true,
      snapshotType: 'prompt',
      promptSnapshot: { system: 'X' },
    })
    expect(trustedHttp).toEqual(trustedIpc)
    resetHostLocalTrustForTests()

    // fail-closed:不可信宿主没接沙箱根 = 宿主接线漏了,拒而不是「不夹」
    const noSandbox = unwrap(
      await call('readSnapshot', { path: insidePrompt }, { transport: 'http' }),
    )
    expect(noSandbox.success).toBe(false)
    expect(String(noSandbox.error)).toContain('sandboxRoot')
  })

  it('keeps the single-run gate: a second runStart is refused, cancel only signals', async () => {
    configureEvalsHost({ repoDir: () => tmpDir })
    // runEvals 挂住,后台跑批因此不会清空单跑闸
    let release: (() => void) | undefined
    runtime.runEvals.mockImplementation(
      () => new Promise<void>(resolve => { release = resolve }),
    )

    const first = unwrap(await call('runStart', { providerId: 'deepseek', model: 'm', runs: 1 }))
    expect(first).toEqual({ success: true })
    // 后台跑批是 fire-and-forget,等它真的进到 runEvals 里再往下走
    await vi.waitFor(() => expect(typeof release).toBe('function'))

    const second = unwrap(await call('runStart', { providerId: 'deepseek', model: 'm', runs: 1 }))
    expect(second).toEqual({ success: false, error: 'A run is already in progress' })

    expect(unwrap(await call('runCancel'))).toEqual({ success: true })
    expect(unwrap(await call('runStart', { providerId: 'deepseek', model: 'm', runs: 1 }))).toEqual({
      success: false, error: 'A run is already in progress',
    })
    release?.()
    // 后台跑批退出之后闸才放开。
    await vi.waitFor(async () => {
      expect(unwrap(await call('runCancel'))).toEqual({
        success: false,
        error: 'No run in progress',
      })
    })
  })

  it('resolves the repo dir through the host port: unwired = cwd, packaged = unconfigured', async () => {
    const { resolveEvalsRepoDir } = await import('../../wiring/evals/host-ports.js')
    // 未注入 = 视为非打包 = process.cwd(),与迁移前 `!app.isPackaged` 逐字同义
    expect(resolveEvalsRepoDir()).toBe(process.cwd())

    configureEvalsHost({ isPackaged: () => true })
    expect(resolveEvalsRepoDir()).toBeNull()
    expect(unwrap(await call('listResults'))).toEqual({ success: true, entries: [] })
    expect(unwrap(await call('listCases'))).toEqual({ success: true, cases: [] })
    expect(unwrap(await call('getCase', { caseId: 'x' }))).toEqual({
      success: false,
      error: 'Evals repo not configured',
    })

    // 设置里显式配了就用设置里的,连 isPackaged 都不问
    fs.mkdirSync(path.join(tmpDir, 'evals'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'evals', 'results.jsonl'),
      `${JSON.stringify({ ts: '2026-08-01', provider: 'p', runs: 1 })}\n`,
      'utf-8',
    )
    settings.getSettings.mockReturnValue({ evals: { repoDir: tmpDir } })
    const results = unwrap(await call('listResults'))
    expect(results.success).toBe(true)
    expect((results.entries as unknown[]).length).toBe(1)
  })
})
