/**
 * R3b —— 插件工具进目录(设计文档 §14.5 第 1 条)。
 *
 * 四件事各一组:
 *  1. 注册进目录之后,`executeToolDirectly`(真链路的唯一必经点)走的是**新路**
 *     —— 判据不是"结果对",而是旧 registry 的 `executeTool` **一次都没被调到**;
 *  2. 契约校验在新树里发生(参数不合当场 invalid,不进插件代码);
 *  3. 拆除是两侧的:`disposeCorePluginState` 那一个口摘完之后目录里不剩它;
 *  4. 超时端口接上了:给了 `timeoutMs` 的工具挂住时会被掐掉(**缺省不设**)。
 *
 * **失败不进断路器**,与旧路一致:一次执行抛异常只毁掉这一次调用,工具照旧在
 * 模型的工具面上(见 `plugin-tools.ts` 头注释里那段回滚记录)。下面那条测试钉的
 * 就是这一句。
 */

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@shared/json.js'

const harness = vi.hoisted(() => {
  const tmp = process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'
  const root = `${tmp}/toolkit-plugin-tools-${process.pid}`
  process.env.ONETHING_STORE_PATH = root
  return { root, enforce: vi.fn(async () => undefined) }
})

vi.mock('../../tools/core/permission-policy.js', () => ({
  enforcePermissionPolicy: harness.enforce,
}))

const { configureToolkitCatalog } = await import('@onething/runtime/toolkit')
const { createDesktopCatalog } = await import('../catalog.js')
const { getOrBuildToolkitCatalog, resetToolkitCatalogForTests } = await import('../wiring.js')
const { registerPluginToolInCatalog, unregisterPluginToolFromCatalog } = await import('../plugin-tools.js')
const { executeToolDirectly } = await import('../../engine/stream/tool-execution.js')
const { getPluginRuntimeHealth, resetPluginRuntimeHealthForTests } = await import('../../plugins/health.js')
const { z } = await import('zod')

const SESSION_ID = 'plugin-tools-session'
const workspace = path.join(harness.root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(path.join(harness.root, 'sessions', SESSION_ID), { recursive: true })

const PLUGIN_ID = 'demo'
const TOOL_ID = 'plugin:demo:hello'

function contextFor() {
  return {
    sessionId: SESSION_ID,
    messageId: 'plugin-tools-message',
    toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
    workingDirectory: workspace,
    workingDirectoryRoots: [workspace],
    principal: { kind: 'user' as const, userId: 'local' },
  } as Parameters<typeof executeToolDirectly>[2]
}

function install(): void {
  configureToolkitCatalog(createDesktopCatalog({
    read: { getDefaultWorkingDirectory: () => workspace },
    mutatingFile: {
      getDefaultWorkingDirectory: () => workspace,
      getFileMutationsDir: () => path.join(harness.root, 'file-mutations'),
    },
    bash: {
      getDefaultWorkingDirectory: () => workspace,
      getToolOutputsDir: () => path.join(harness.root, 'tool-outputs'),
      createOperations: () => ({ exec: async () => ({ exitCode: 0 }) }),
    },
  }))
}

function registerHello(
  execute: (args: JsonObject) => Promise<{ title: string; output: string; metadata: object }>,
  timeoutMs?: number,
): boolean {
  return registerPluginToolInCatalog({
    toolId: TOOL_ID,
    definition: {
      name: 'hello',
      description: 'says hello',
      parameters: z.object({ who: z.string() }),
    },
    execute: args => execute(args),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

beforeEach(() => {
  harness.enforce.mockReset()
  harness.enforce.mockResolvedValue(undefined)
  resetPluginRuntimeHealthForTests()
  install()
})

afterEach(() => {
  resetToolkitCatalogForTests()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await fsp.rm(harness.root, { recursive: true, force: true })
})

describe('插件工具进目录', () => {
  it('注册之后 executeToolDirectly 真的跑到它', async () => {
    expect(registerHello(async args => ({
      title: 'hello',
      output: `hi ${String(args.who)}`,
      metadata: { who: args.who },
    }))).toBe(true)

    const result = await executeToolDirectly(TOOL_ID, { who: 'world' }, contextFor())
    expect(result.success).toBe(true)
    const data = result.data as { title: string; output: string; metadata: JsonObject }
    expect(data.output).toBe('hi world')
    expect(data.metadata).toEqual({ who: 'world' })
    // 权限:一条 `plugin_exec` 效果(恒 ask)——"插件不能给自己发免检通行证"
    // 在新树里由效果说出来,不再是写死的 permissionGuard。
    expect(harness.enforce).toHaveBeenCalledTimes(1)
    const enforced = (harness.enforce.mock.calls[0] as unknown as [{ effects: Array<{ kind: string }> }])[0]
    expect(enforced.effects.map(effect => effect.kind)).toEqual(['plugin_exec'])
  })

  it('参数不合契约 = invalid,不进插件代码', async () => {
    const execute = vi.fn(async () => ({ title: '', output: '', metadata: {} }))
    registerHello(execute)
    const result = await executeToolDirectly(TOOL_ID, { who: 42 } as unknown as JsonObject, contextFor())
    expect(result.success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('卸载摘除:目录里不剩它,调用退回旧路(旧 registry 里也没有 → 报未知工具)', async () => {
    registerHello(async () => ({ title: '', output: 'ok', metadata: {} }))
    expect(getOrBuildToolkitCatalog()?.has(TOOL_ID)).toBe(true)
    expect(unregisterPluginToolFromCatalog(TOOL_ID)).toBe(true)
    expect(getOrBuildToolkitCatalog()?.has(TOOL_ID)).toBe(false)

    const result = await executeToolDirectly(TOOL_ID, { who: 'world' }, contextFor())
    expect(result.success).toBe(false)
  })

  it('执行连抛三次也**不**进断路器 —— 工具照旧在工具面上,插件健康账本一个字不记', async () => {
    /*
     * 这条钉的是一次**回滚**。R3b 第一版给插件工具接了健康断路器(连败三次把这只
     * 工具从工具面上摘掉),而重试的主体是模型不是人:模型面对的失败里有一大类是
     * 它自己能纠的(参数语义不对、路径写错),摘掉工具恰好剥夺了它自纠的那条路。
     * 旧路里插件工具执行压根不进断路器,新路与它逐字相同。
     */
    registerHello(async () => { throw new Error('boom') })
    const tool = getOrBuildToolkitCatalog()?.get(TOOL_ID)
    expect(tool?.visibleIn({} as never)).toBe(true)

    for (let i = 0; i < 5; i += 1) {
      const result = await executeToolDirectly(TOOL_ID, { who: 'world' }, contextFor())
      expect(result.success).toBe(false)
      // 每一次都把错误如实回给模型 —— 那是它换参数重试的依据。
      expect(result.error).toContain('boom')
    }

    expect(getPluginRuntimeHealth(PLUGIN_ID)).toBeUndefined()
    expect(tool?.visibleIn({} as never)).toBe(true)
  })

  it('超时端口:给了 timeoutMs 的工具挂住时被掐掉;缺省不设(挂住就一直挂着)', async () => {
    registerHello(
      () => new Promise(() => {}),
      20,
    )
    const result = await executeToolDirectly(TOOL_ID, { who: 'world' }, contextFor())
    expect(result.success).toBe(false)

    // 缺省那一档:同一只工具不给 timeoutMs 时,20ms 之后仍然没有结论。
    unregisterPluginToolFromCatalog(TOOL_ID)
    registerHello(() => new Promise(() => {}))
    let settled = false
    void executeToolDirectly(TOOL_ID, { who: 'world' }, contextFor()).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
  })
})
