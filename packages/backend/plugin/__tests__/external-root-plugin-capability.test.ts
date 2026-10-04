/**
 * 能力面验收:**一个把用户目录当家的插件,在真内核上跑得起来**。
 *
 * 这份测试的来历值得写清楚。它接手的是 `memory-wiki.integration.test.ts` ——
 * memory-wiki 曾是内置插件,那份集成测试用它当被试,验的却从来不是"记忆记得对
 * 不对"(那验在插件自己旁边),而是宿主这一侧的四段链路。2026-08-12 memory-wiki
 * 退出内置搬进市场仓之后,被试跟着走了,**要验的东西一条没走**:
 *
 *  1. `createCorePluginAPI` 装出来的 api 上,`registerTool` /
 *     `registerPromptContextProvider` 真的把东西交到宿主手里;
 *  2. manifest 里那行 `storage:external-root` **真的是门** —— 不声明就写不进
 *     用户目录,而且是结构化拒绝(`not-declared`),不是假装成功;
 *  3. 走 `executeCorePluginTool` 这条宿主执行路径(而不是直接 await execute)时,
 *     写进去的字节真的出现在用户选的那个目录里;
 *  4. 拆除之后晚到的写被丢弃,而**用户的目录一个文件不少** —— 卸载一个插件
 *     不该动到用户自己的资料。
 *
 * 于是被试换成一个合成的最小插件:它只做"往外根写一行、读回来"这一件事。
 * 用合成插件而不是再挑一个真插件当被试,是因为这四条是**能力面**的性质 ——
 * 拿具体产品当被试,下一次那个产品搬家时这份测试又会跟着一起消失。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT } from '../plugin-sessions.js'
import { createCorePluginAPI, executeCorePluginTool } from '../plugin-api-builder.js'
import { createCorePluginFiles } from '../plugin-storage-files.js'

const tempRoots: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

const EXTERNAL = { root: 'external' } as const

interface RegisteredTool {
  name: string
  execute(args: unknown, ctx: unknown): Promise<{ title: string; output: string; metadata: object }>
}

/**
 * 合成被试:一个"把用户目录当家"的最小插件。
 *
 * 它只用注入的 api —— 与任何一个市场插件同一条路,不 import 宿主模块。
 */
function externalRootPlugin(api: {
  storage: { files: { writeText(p: string, c: string, o?: object): void
                      readText(p: string, o?: object): string | undefined } }
  registerTool(tool: RegisteredTool): void
  registerPromptContextProvider(id: string, provider: () => unknown): void
}): void {
  api.registerTool({
    name: 'probe_write',
    async execute(args: unknown) {
      const { file, text } = args as { file: string; text: string }
      try {
        api.storage.files.writeText(file, text, EXTERNAL)
        return { title: 'probe_write', output: `wrote ${file}`, metadata: {} }
      } catch (error) {
        // 结构化拒绝 → 一句人话(插件侧的老规矩:能预料的拒绝不抛给宿主)。
        const code = (error as { code?: string })?.code
        if (typeof code === 'string') return { title: 'probe_write', output: `refused:${code}`, metadata: {} }
        throw error
      }
    },
  })
  api.registerPromptContextProvider('probe-context', () => ({
    role: 'developer', source: 'probe-context', content: 'probe',
  }))
}

function createKernel(options: { external?: string; declared?: boolean } = {}) {
  const homeRoot = makeTempDir('cap-home-')
  const registered = new Map<string, RegisteredTool>()
  const providers = new Map<string, () => unknown>()
  let disposed = false

  const files = createCorePluginFiles({
    pluginId: 'probe-plugin',
    homeRoot,
    externalRootDeclared: options.declared ?? true,
    resolveExternalRoot: () => options.external,
    isDisposed: () => disposed,
  })

  const { api } = createCorePluginAPI<
    Parameters<typeof externalRootPlugin>[0],
    RegisteredTool,
    () => void,
    { name: string },
    object,
    () => unknown,
    () => void,
    () => void,
    () => [],
    object,
    object
  >({
    pluginId: 'probe-plugin',
    store: {},
    scheduler: {},
    files,
    declaredPermissions: options.declared === false ? [] : [PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT],
    logger: { log: () => {}, error: () => {} },
    host: {
      registerTool: (_pluginId, _toolId, tool) => { registered.set(tool.name, tool) },
      subscribeEvent: () => () => {},
      steer: () => {},
      followUp: () => {},
      notify: () => {},
      registerPromptContextProvider: (_pluginId, id, provider) => {
        providers.set(id, provider)
        return () => providers.delete(id)
      },
      registerBeforeContextCompactHook: () => () => {},
      registerAfterAssistantResponseHook: () => () => {},
      registerSkillRoot: () => () => {},
    },
  })

  externalRootPlugin(api)

  return {
    registered,
    providers,
    // 宿主执行路径 —— 与 app/plugins/api.ts 里那条同一个函数。
    run: async (name: string, args: unknown) => executeCorePluginTool(
      registered.get(name) as never,
      args as never,
      { sessionId: 's1', messageId: 'm1', toolCallId: 'call-1' } as never,
    ),
    demolish: () => { disposed = true },
  }
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('能力面 —— 用户目录型插件跑在真内核上', () => {
  it('注册面真的把工具与注入 provider 交到宿主手里', () => {
    const kernel = createKernel({ external: makeTempDir('cap-external-') })
    expect([...kernel.registered.keys()]).toEqual(['probe_write'])
    expect(kernel.providers.get('probe-context')!()).toMatchObject({ role: 'developer' })
  })

  it('走宿主执行路径写外根 → 字节真出现在用户选的目录里', async () => {
    const external = makeTempDir('cap-external-')
    const kernel = createKernel({ external })

    const result = await kernel.run('probe_write', { file: 'notes/one.md', text: 'hello' })
    expect(result.output).toBe('wrote notes/one.md')
    expect(fs.readFileSync(path.join(external, 'notes', 'one.md'), 'utf-8')).toBe('hello')
  })

  it('manifest 少了 storage:external-root 就写不进去 —— 声明门是真的', async () => {
    const external = makeTempDir('cap-external-')
    const kernel = createKernel({ external, declared: false })

    const result = await kernel.run('probe_write', { file: 'x.md', text: 'x' })
    expect(result.output).toBe('refused:not-declared')
    // 一个字节都没落地(不是"写了但报错")。
    expect(fs.readdirSync(external)).toEqual([])
    expect(PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT).toBe('storage:external-root')
  })

  it('没配目录时结构化拒绝,而不是偷偷写进家目录兜底', async () => {
    const kernel = createKernel({ external: undefined })
    const result = await kernel.run('probe_write', { file: 'x.md', text: 'x' })
    expect(result.output).toBe('refused:not-configured')
  })

  it('拆除之后晚到的写被丢弃,用户目录一个文件不少', async () => {
    const external = makeTempDir('cap-external-')
    const kernel = createKernel({ external })
    await kernel.run('probe_write', { file: 'kept.md', text: '留着的' })
    const before = fs.readdirSync(external).sort()

    kernel.demolish()
    await kernel.run('probe_write', { file: 'late.md', text: '不该落地' })

    expect(fs.readdirSync(external).sort()).toEqual(before)
    expect(fs.readFileSync(path.join(external, 'kept.md'), 'utf-8')).toBe('留着的')
  })
})
