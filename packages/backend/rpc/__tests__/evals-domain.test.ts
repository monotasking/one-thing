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
 *    `runCancel` 只发信号(清空由后台跑批自己的 finally 做);
 *  - **`listRecords` 的过滤 / 分页 / 预览**与迁移前逐字相同;
 *  - **`readSnapshot` 的两种快照类型 + http 侧拒绝**(按 wire 路径读盘的四条
 *    在 `transport: 'http'` 上一律拒绝,与渲染侧能力位 `evals` 同口径)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'

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
  let dispose: (() => void) | undefined
  let tmpDir: string

  beforeEach(async () => {
    const [registry, domain, ports] = await Promise.all([
      import('../registry.js'),
      import('../domains/evals.js'),
      import('../../wiring/evals/host-ports.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    configureEvalsHost = ports.configureEvalsHost
    registry.resetRpcRegistryForTests()
    domain.resetEvalsRunStateForTests()
    dispose = domain.registerEvalsRpcDomain()
    configureEvalsHost({})
    settings.getSettings.mockReturnValue({})
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-domain-'))
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    configureEvalsHost({})
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

  it('reads prompt and context snapshots, and refuses both over http', async () => {
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

    // http 上一律拒绝(evals 是桌面独占面)
    for (const method of ['readSnapshot', 'readFixture', 'promoteFixture', 'readRunDetail']) {
      expect(unwrap(await call(method, { path: promptPath, fixturePath: promptPath, detailPath: 'x' }, HTTP_CONTEXT))).toEqual({
        success: false,
        error: 'Evals is not supported in the web build',
      })
    }
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
    release?.()
    // 后台跑批退出之后闸才放开(清空在它自己的 finally 里,不在 cancel 里)
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
