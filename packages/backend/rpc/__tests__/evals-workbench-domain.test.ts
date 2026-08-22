/**
 * evalsWorkbench 域,端到端穿过 dispatcher(结构债 P4c 第十批)。
 *
 * 接的是被整只删掉的 `@main/ipc/evals-workbench.ts` 的测试位。值得钉的是:
 *  - `incidentList` / `incidentGet` 的投影(事故 + 封面 markdown + runs 摘要);
 *  - **每事故单飞**:同一个 incidentId 上第二次 `replayStart` 被拒,
 *    `replayCancel` 在没有在飞操作时回「No operation in progress」;
 *  - `incidentPromote` 走的是**端口**上的 repoDir(不再跨文件 import
 *    `getRepoDirForEvals`),未配 = 「Evals repo not configured」;
 *  - `incidentReadFile` 的 containment guard 原样还在。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@shared/ipc/rpc.js'

const incidentDirs = vi.hoisted(() => ({ root: '' }))
const runtime = vi.hoisted(() => ({
  listIncidents: vi.fn(() => [{ id: 'inc-1', title: 't' }]),
  readIncident: vi.fn(() => ({
    id: 'inc-1',
    title: 't',
    note: 'n',
    provider: 'deepseek',
    model: 'm',
    userMessage: 'u',
    sessionId: 's',
    turnId: 'turn',
    status: 'new',
  })),
  updateIncident: vi.fn((_id: string, patch: Record<string, unknown>) => ({ id: 'inc-1', ...patch })),
  getIncidentDir: vi.fn(() => incidentDirs.root),
  loadSceneFromIncident: vi.fn(() => ({ params: { provider: 'deepseek', model: 'm' } })),
  createAiToolSimulator: vi.fn(() => vi.fn()),
  runReplay: vi.fn(async () => ({ transcript: { header: {}, events: [] }, verdict: { pass: true } })),
  writeTranscript: vi.fn(),
  readIncidentTurnTrace: vi.fn(() => ({})),
  analyzeIncident: vi.fn(async () => ({ title: 'T', category: 'c', rubric: 'r' })),
  renderAnalyzedMarkdown: vi.fn(() => '# md'),
  readTraceRounds: vi.fn(() => []),
  readTraceRoundsFromDir: vi.fn(() => []),
  replayRound: vi.fn(async () => ({ attempts: [], edited: false })),
  diagnoseIncident: vi.fn(async () => ({ conclusion: 'c', reportPath: '' })),
}))
const credentials = vi.hoisted(() => ({
  resolveEvalsCredentials: vi.fn(() => ({ ok: true, apiKey: 'k', baseUrl: 'https://x' })),
  createEvalsModelCaller: vi.fn(() => async () => ({ content: '', toolCalls: [], finishReason: 'stop' })),
}))
const settings = vi.hoisted(() => ({ getSettings: vi.fn(() => ({} as Record<string, unknown>)) }))

vi.mock('@onething/runtime', () => runtime)
vi.mock('../../store.js', () => ({ getSettings: settings.getSettings }))
vi.mock('../../stores/settings.js', () => settings)
vi.mock('../../wiring/evals/provider-adapter.js', () => credentials)

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('evalsWorkbench RPC domain', () => {
  let dispatchRpc: (typeof import('../registry.js'))['dispatchRpc']
  let configureEvalsHost: (typeof import('../../wiring/evals/host-ports.js'))['configureEvalsHost']
  let dispose: (() => void) | undefined
  let tmpDir: string

  beforeEach(async () => {
    const [registry, domain, ports] = await Promise.all([
      import('../registry.js'),
      import('../domains/evals-workbench.js'),
      import('../../wiring/evals/host-ports.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    configureEvalsHost = ports.configureEvalsHost
    registry.resetRpcRegistryForTests()
    domain.resetEvalsWorkbenchOpsForTests()
    dispose = domain.registerEvalsWorkbenchRpcDomain()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-wb-'))
    incidentDirs.root = tmpDir
    // 打包态 + 设置里没配 = 没有 repoDir(晋升那条要的就是这个分支)
    configureEvalsHost({ isPackaged: () => true })
    settings.getSettings.mockReturnValue({})
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    configureEvalsHost({})
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  const call = (method: string, payload: unknown = {}) =>
    dispatchRpc({ domain: 'evalsWorkbench', method, payload })

  it('lists incidents and projects one incident with its cover and run summaries', async () => {
    expect(unwrap(await call('incidentList'))).toEqual({
      success: true,
      incidents: [{ id: 'inc-1', title: 't' }],
    })

    fs.writeFileSync(path.join(tmpDir, 'incident.md'), '# cover', 'utf-8')
    const runDir = path.join(tmpDir, 'runs', 'replay-2026')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify({ startedAt: 'now', kind: 'replay', attempts: 2, passes: 1 }),
      'utf-8',
    )
    fs.writeFileSync(path.join(runDir, 'attempt-1.jsonl'), '', 'utf-8')

    const detail = unwrap(await call('incidentGet', { incidentId: 'inc-1' }))
    expect(detail.success).toBe(true)
    expect(detail.markdown).toBe('# cover')
    expect(detail.runs).toEqual([
      {
        runId: 'replay-2026',
        startedAt: 'now',
        kind: 'replay',
        attempts: 2,
        passes: 1,
        disabledSections: undefined,
        attemptFiles: ['attempt-1.jsonl'],
      },
    ])
  })

  it('keeps the per-incident single-flight gate for replay', async () => {
    let release: (() => void) | undefined
    runtime.runReplay.mockImplementation(
      () => new Promise(resolve => { release = () => resolve({ transcript: { header: {}, events: [] }, verdict: { pass: true } }) }),
    )

    expect(unwrap(await call('replayCancel', { incidentId: 'inc-1' }))).toEqual({
      success: false,
      error: 'No operation in progress',
    })

    const first = unwrap(await call('replayStart', { incidentId: 'inc-1', runs: 1 }))
    expect(first.success).toBe(true)
    expect(String(first.runId)).toMatch(/^replay-/)

    expect(unwrap(await call('replayStart', { incidentId: 'inc-1', runs: 1 }))).toEqual({
      success: false,
      error: 'An operation is already running for this incident',
    })

    expect(unwrap(await call('replayCancel', { incidentId: 'inc-1' }))).toEqual({ success: true })
    release?.()
  })

  it('promotes through the host repo-dir port and guards incident-bundle reads', async () => {
    // 端口说「打包态 + 没配」= 没有仓,晋升逐字回旧文案
    expect(unwrap(await call('incidentPromote', { incidentId: 'inc-1', caseId: 'c1' }))).toEqual({
      success: false,
      error: 'Evals repo not configured',
    })

    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-repo-'))
    fs.mkdirSync(path.join(tmpDir, 'scene'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'scene', 'params.json'), '{}', 'utf-8')
    configureEvalsHost({ repoDir: () => repoDir })

    const promoted = unwrap(await call('incidentPromote', { incidentId: 'inc-1', caseId: 'c 1!' }))
    expect(promoted.success).toBe(true)
    // caseId 的字符白名单逐字保留(非法字符 → '-')
    expect(String(promoted.casePath)).toBe(
      path.join(repoDir, 'evals', 'cases', 'c-1-', 'case.yaml'),
    )
    expect(fs.existsSync(path.join(repoDir, 'evals', 'cases', 'c-1-', 'scene', 'params.json'))).toBe(true)
    expect(runtime.updateIncident).toHaveBeenCalledWith('inc-1', {
      status: 'case-created',
      caseId: 'c-1-',
    })
    fs.rmSync(repoDir, { recursive: true, force: true })

    // containment guard
    expect(
      unwrap(await call('incidentReadFile', { incidentId: 'inc-1', relativePath: '../escape.txt' })),
    ).toEqual({ success: false, error: 'Path escapes incident bundle' })
  })
})
