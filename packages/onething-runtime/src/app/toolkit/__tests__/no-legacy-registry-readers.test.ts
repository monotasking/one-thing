/**
 * R3b 的总覆盖 —— **开关开时,没有任何一条生产链路再去问旧 registry**
 * (设计文档 §10.2-④)。
 *
 * 这是 R4 敢删旧树的判据,所以判据不是"结果对",而是一条更硬的话:旧 registry
 * 的六个**读**函数(`getTool` / `getAllTools` / `getAllToolsAsync` /
 * `getEnabledToolsAsync` / `executeTool` / `getToolsForAI` / `analyzeTool`)在这条
 * 测试里被换成「被调用即抛」,然后把真链路跑一遍 —— 谁碰它谁当场红。
 *
 * 覆盖的问题面(§10.2-④ 那张清单里"会被人问到"的五格):
 *  · 跑一个工具 —— read / edit / bash / 一个插件工具 / task(参数错的那一路也要
 *    在新树里判,不能掉回旧管线);
 *  · 有哪些工具 —— 设置页的工具列表(与 `apps/electron/src/main/ipc/tools.ts` 同一
 *    条装配:`listOnethingSettingsTools` + 目录投影);
 *  · 工具的 schema / 描述 / guard —— 提示词快照那一支用的两个函数
 *    (`resolveToolkitSurface` + `toolDefinitionFromToolkitTool`)。
 *
 * **写**函数(`registerTool` / `unregisterTool` / `initializeToolRegistry`)不在
 * 禁用之列:切换期两棵树并行维护,旧树的注册足迹要等 R4 才删。
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

/**
 * 旧 registry 的读面 —— 被调用即抛。
 *
 * 直接改模块而不是 `vi.spyOn`:消费方是按名 import 的(ESM 活绑定),spy 装不上去
 * 那个名字;而 `app/tools/index.ts` 是逐名再导出 registry 的清单,所以只要换掉
 * registry 这一处,两条 import 路径都被覆盖。
 */
const LEGACY_READERS = [
  'getTool',
  'getToolAsync',
  'getAllTools',
  'getAllToolsAsync',
  'getEnabledTools',
  'getEnabledToolsAsync',
  'getAllStaticTools',
  'getAllAsyncTools',
  'executeTool',
  'getToolsForAI',
  'analyzeTool',
] as const

vi.mock('../../tools/registry.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const trapped: Record<string, unknown> = { ...actual }
  for (const name of LEGACY_READERS) {
    trapped[name] = () => {
      throw new Error(`legacy tool registry reader called: ${name}`)
    }
  }
  return trapped
})

const { configureToolkitCatalog, resolveToolkitSurface } = await import('@onething/runtime/toolkit')
const { createDesktopCatalog } = await import('../catalog.js')
const { resetToolkitCatalogForTests } = await import('../wiring.js')
const { registerPluginToolInCatalog } = await import('../plugin-tools.js')
const { toolDefinitionFromToolkitTool, toolkitCatalogToolDefinitions } = await import('../catalog-projection.js')
const { executeToolDirectly } = await import('../../engine/stream/tool-execution.js')
const { listOnethingSettingsTools } = await import('@onething/runtime/tools')
const legacyRegistry = await import('../../tools/registry.js')
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
  process.env.ONETHING_TOOLKIT = '1'
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
  delete process.env.ONETHING_TOOLKIT
  resetToolkitCatalogForTests()
  vi.clearAllMocks()
})

afterAll(async () => {
  await fsp.rm(harness.root, { recursive: true, force: true })
})

describe('R3b:开关开时没有旧 registry 的读者', () => {
  it('闸本身是活的 —— 旧读面确实被换成了「调用即抛」', () => {
    for (const name of LEGACY_READERS) {
      expect(
        () => (legacyRegistry as unknown as Record<string, () => unknown>)[name](),
        name,
      ).toThrow(/legacy tool registry reader called/)
    }
  })

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
      getSessionsList: () => [],
      getSession: () => null,
      getAllToolsAsync: async () => toolkitCatalogToolDefinitions() ?? [],
      getMCPToolDefinitions: () => [],
      setInitContext: () => undefined,
      cwd: () => workspace,
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
