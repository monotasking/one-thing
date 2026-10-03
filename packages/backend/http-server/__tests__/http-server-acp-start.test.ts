/**
 * A5(方案 `docs/design/acp-integration-2026-09.md` §11.6;A1-a 留账):独立 server 装配完产品后端
 * 之后调 `backend.acp.start()`,与 React 壳 / daemon 同口径。从前不调,名册只在第一次名册 RPC 时
 * 惰性喂进管家 —— 崩溃重连、认领这类不经名册读面的动作读到的是空表。
 *
 * 真装配一台 backend(临时 store),只把 `AcpSubsystem.start` 换成计数的替身:它本身只读种子喂管家,
 * 这里要证的是「server 叫了它」,不是它做了什么。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSubsystem } from '@onething/backend/acp/subsystem'
import { createDevelopmentOnethingServerRuntime, type OnethingServerRuntime } from '../http-server-runtime.js'

describe('server runtime starts the ACP subsystem', () => {
  let runtime: OnethingServerRuntime | undefined
  let storePath: string | undefined
  let previousStorePath: string | undefined

  afterEach(async () => {
    await runtime?.shutdown()
    runtime = undefined
    vi.restoreAllMocks()
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    previousStorePath = undefined
    if (storePath) rmSync(storePath, { recursive: true, force: true })
    storePath = undefined
  })

  it('calls backend.acp.start() once after assembling the real backend', async () => {
    storePath = mkdtempSync(join(tmpdir(), 'onething-acp-start-'))
    previousStorePath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = storePath
    const start = vi.spyOn(AcpSubsystem.prototype, 'start').mockResolvedValue(undefined)

    runtime = await createDevelopmentOnethingServerRuntime({
      storePath,
      workspaceRoot: join(storePath, 'workspaces'),
      dataRoot: storePath,
    })

    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.contexts[0]).toBe(runtime.backend?.acp)
  }, 60_000)
})
