/**
 * 工具链路只有一条 —— 目录 + runner(设计文档 §10.2-④)。
 *
 * 前身是 R3b 的 `no-legacy-registry-readers.test.ts`:它把旧 registry 的十一个读
 * 函数换成「被调用即抛」再跑真链路,以此证明 R4 可以删旧树。R4b 真的删了,那道
 * 闸随之失去意义(模块不存在,没有第二条路可走),但它钉的**三个问题面**一格不
 * 少地留在这里:
 *
 *  · 跑一个工具 —— read / write / edit / bash / 一个插件工具 / task(参数错的那
 *    一路也要在新树里落成 invalid);
 *  · 有哪些工具 —— 设置页的工具列表(与 `apps/electron/src/main/ipc/tools.ts` 同
 *    一条装配:`listOnethingSettingsTools` + 目录投影);
 *  · 工具的 schema / 描述 / guard —— 提示词快照那一支用的两个函数
 *    (`resolveToolkitSurface` + `toolDefinitionFromToolkitTool`)。
 */

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@shared/json.js'

const harness = vi.hoisted(() => {
  const tmp = process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'
  const root = `${tmp}/toolkit-no-legacy-${process.pid}`
  process.env.ONETHING_STORE_PATH = root
  return { root, enforce: vi.fn(async () => undefined) }
})

vi.mock('../../tools/core/permission-policy.js', () => ({
  enforcePermissionPolicy: harness.enforce,
}))

const { configureToolkitCatalog, resolveToolkitSurface } = await import('@onething/runtime/toolkit')
const { createDesktopCatalog } = await import('../catalog.js')
const { resetToolkitCatalogForTests } = await import('../wiring.js')
const { registerPluginToolInCatalog } = await import('@onething/runtime/toolkit/plugin-tools')
const { toolDefinitionFromToolkitTool, toolkitCatalogToolDefinitions } = await import('@onething/runtime/toolkit/catalog-projection.wiring')
const { executeToolDirectly } = await import('../../engine/stream/tool-execution.js')
const { listOnethingSettingsTools } = await import('@onething/runtime/tools')
const { z } = await import('zod')

const SESSION_ID = 'no-legacy-session'
const workspace = path.join(harness.root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(path.join(harness.root, 'sessions', SESSION_ID), { recursive: true })

const PLUGIN_TOOL_ID = 'plugin:demo:hello'

function contextFor() {
  return {
    sessionId: SESSION_ID,
    messageId: 'no-legacy-message',
    toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
    workingDirectory: workspace,
    workingDirectoryRoots: [workspace],
    principal: { kind: 'user' as const, userId: 'local' },
  } as Parameters<typeof executeToolDirectly>[2]
}

beforeEach(() => {
  harness.enforce.mockReset()
  harness.enforce.mockResolvedValue(undefined)
  configureToolkitCatalog(createDesktopCatalog({
    read: { getDefaultWorkingDirectory: () => workspace },
    mutatingFile: {
      getDefaultWorkingDirectory: () => workspace,
      getFileMutationsDir: () => path.join(harness.root, 'file-mutations'),
    },
    bash: {
      getDefaultWorkingDirectory: () => workspace,
      getToolOutputsDir: () => path.join(harness.root, 'tool-outputs'),
      createOperations: () => ({
        exec: async (_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
          options.onData(Buffer.from('ok\n'))
          return { exitCode: 0 }
        },
      }),
    },
  }))
  registerPluginToolInCatalog({
    toolId: PLUGIN_TOOL_ID,
    definition: {
      name: 'hello',
      description: 'says hello',
      parameters: z.object({ who: z.string() }),
    },
    execute: async args => ({ title: 'hello', output: `hi ${String(args.who)}`, metadata: {} }),
  })
})

afterEach(() => {
  resetToolkitCatalogForTests()
  vi.clearAllMocks()
})

afterAll(async () => {
  await fsp.rm(harness.root, { recursive: true, force: true })
})

describe('工具链路只有一条:目录 + runner', () => {
  it('跑一个工具:read / write / edit / bash / 插件工具 / task 全部在新树里判', async () => {
    const write = await executeToolDirectly('write', { path: 'note.txt', content: 'hello\n' }, contextFor())
    expect(write.success).toBe(true)

    const read = await executeToolDirectly('read', { path: 'note.txt' }, contextFor())
    expect(read.success).toBe(true)

    const edit = await executeToolDirectly(
      'edit',
      { path: 'note.txt', edits: [{ oldText: 'hello', newText: 'bye' }] },
      contextFor(),
    )
    expect(edit.success).toBe(true)
    expect(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf-8')).toBe('bye\n')

    const bash = await executeToolDirectly('bash', { command: 'echo ok' }, contextFor())
    expect(bash.success).toBe(true)

    const plugin = await executeToolDirectly(PLUGIN_TOOL_ID, { who: 'world' }, contextFor())
    expect(plugin.success).toBe(true)

    // 派工:参数错的那一路同样必须在新树里落成 invalid —— 掉回旧管线的话上面那道
    // 闸会当场抛。
    const task = await executeToolDirectly('task', {} as JsonObject, contextFor())
    expect(task.success).toBe(false)
  })

  it('有哪些工具:设置页那张列表由目录回答(与 electron 的 IPC 处理器同一条装配)', async () => {
    const tools = await listOnethingSettingsTools({
      getAllToolsAsync: async () => toolkitCatalogToolDefinitions() ?? [],
      getMCPToolDefinitions: () => [],
    })
    const ids = tools.map(tool => tool.id)
    expect(ids).toContain('read')
    expect(ids).toContain('bash')
    expect(ids).toContain(PLUGIN_TOOL_ID)
    expect(tools.find(tool => tool.id === PLUGIN_TOOL_ID)?.source).toBe('plugin')
  })

  it('工具的 schema / 描述 / guard:提示词快照那一支用的两个函数,一格不问旧树', () => {
    const surface = resolveToolkitSurface({ session: null, enabledSkillNames: [] })
    expect(surface).toBeDefined()
    const definitions = surface!.tools().map(toolDefinitionFromToolkitTool)
    const byId = new Map(definitions.map(definition => [definition.id, definition]))
    // §12.3 的派生表:五格逐字等于旧工具身上那个字符串。
    expect(byId.get('read')?.permissionGuard).toBe('sandboxed')
    expect(byId.get('write')?.permissionGuard).toBe('permission-gated')
    expect(byId.get('edit')?.permissionGuard).toBe('permission-gated')
    expect(byId.get('bash')?.permissionGuard).toBe('internal-check')
    expect(byId.get('time')?.permissionGuard).toBe('safe')
    // 插件工具:`plugin_exec` → permission-gated(旧路写死的那句话的新出处)。
    expect(byId.get(PLUGIN_TOOL_ID)?.permissionGuard).toBe('permission-gated')
    // schema 与描述也来自目录。
    expect(byId.get('read')?.description).toBeTruthy()
    expect(byId.get('read')?.parameterSchema).toBeTruthy()
  })
})
