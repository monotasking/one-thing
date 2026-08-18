import { describe, expect, it, vi } from 'vitest'

import { Catalog } from '../catalog.js'
import { Intent } from '../intent.js'
import type { Result } from '../result.js'
import type { Scene, ToolSpec } from '../spec.js'
import { normalizeLegacyAllowlist, Surface } from '../surface.js'
import { Tool } from '../tool.js'
import { ScriptedTool } from './fakes.js'

describe('Catalog', () => {
  it('注册/查找/枚举', () => {
    const catalog = new Catalog()
    const read = new ScriptedTool({ id: 'read' })
    catalog.register(read).register(new ScriptedTool({ id: 'bash' }))
    expect(catalog.size).toBe(2)
    expect(catalog.get('read')).toBe(read)
    expect(catalog.all().map(tool => tool.spec.id)).toEqual(['read', 'bash'])
    expect(catalog.has('nope')).toBe(false)
  })

  it('重复 id 直接报错(注册表里只有一种工具,也只能有一个同名工具)', () => {
    const catalog = new Catalog()
    catalog.register(new ScriptedTool({ id: 'read' }))
    expect(() => catalog.register(new ScriptedTool({ id: 'read' }))).toThrow(/already registered/)
  })

  it('ensurePrepared 并发只跑一次', async () => {
    const prepare = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    const catalog = new Catalog()
    catalog.register(new ScriptedTool({ id: 'mcp:fs', prepare }))

    await Promise.all([
      catalog.ensurePrepared('mcp:fs'),
      catalog.ensurePrepared('mcp:fs'),
      catalog.ensurePrepared('mcp:fs'),
      catalog.ensurePrepared('mcp:fs'),
      catalog.ensurePrepared('mcp:fs'),
    ])
    await catalog.ensurePrepared('mcp:fs')

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(catalog.isPrepared('mcp:fs')).toBe(true)
  })

  it('prepare 失败不会把工具永久毒死:下一次可以重试', async () => {
    let attempts = 0
    const catalog = new Catalog()
    catalog.register(new ScriptedTool({
      id: 'mcp:flaky',
      prepare: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connect ETIMEDOUT')
      },
    }))

    await expect(catalog.ensurePrepared('mcp:flaky')).rejects.toThrow('connect ETIMEDOUT')
    await expect(catalog.ensurePrepared('mcp:flaky')).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('isPrepared 只在初始化真正完成后为真', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const catalog = new Catalog()
    catalog.register(new ScriptedTool({ id: 'mcp:slow', prepare: () => gate }))

    const pending = catalog.ensurePrepared('mcp:slow')
    expect(catalog.isPrepared('mcp:slow')).toBe(false)
    release()
    await pending
    expect(catalog.isPrepared('mcp:slow')).toBe(true)
  })

  it('unregister 摘掉工具,连同它的初始化记录(插件卸载 / MCP 断连)', async () => {
    const prepare = vi.fn(async () => {})
    const catalog = new Catalog()
    catalog.register(new ScriptedTool({ id: 'plugin:x', prepare }))
    await catalog.ensurePrepared('plugin:x')
    expect(catalog.unregister('plugin:x')).toBe(true)
    expect(catalog.has('plugin:x')).toBe(false)
    expect(catalog.isPrepared('plugin:x')).toBe(false)
    expect(catalog.unregister('plugin:x')).toBe(false)

    // 同名工具装回来是另一个实例,不继承上一次的 prepare 结果。
    catalog.register(new ScriptedTool({ id: 'plugin:x', prepare }))
    await catalog.ensurePrepared('plugin:x')
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('未知 id 抛错', async () => {
    await expect(new Catalog().ensurePrepared('ghost')).rejects.toThrow(/Unknown tool/)
  })
})

describe('Surface', () => {
  function catalogOf(...ids: string[]): Catalog {
    const catalog = new Catalog()
    for (const id of ids) catalog.register(new ScriptedTool({ id }))
    return catalog
  }

  it('settings[id].enabled === false 的工具不进面', () => {
    const surface = Surface.resolve({
      catalog: catalogOf('read', 'bash'),
      scene: {},
      settings: { bash: { enabled: false } },
    })
    expect(surface.names()).toEqual(['read'])
    expect(surface.get('bash')).toBeUndefined()
  })

  it('visibleIn 为 false 的工具不进面', () => {
    const catalog = new Catalog()
    catalog.register(new ScriptedTool({ id: 'read' }))
    catalog.register(new ScriptedTool({ id: 'feature_mount', visible: false }))
    const surface = Surface.resolve({ catalog, scene: { kind: 'chat' } })
    expect(surface.names()).toEqual(['read'])
  })

  it('provider 追加名只进 names(),进不了 tools()/get()(§10.2-⑥)', () => {
    const surface = Surface.resolve({
      catalog: catalogOf('read'),
      scene: {},
      extraNames: ['shell', 'read'],
    })
    expect(surface.names()).toEqual(['read', 'shell'])
    expect(surface.tools().map(tool => tool.spec.id)).toEqual(['read'])
    expect(surface.get('shell')).toBeUndefined()
    expect(surface.has('shell')).toBe(true)
  })

  it('allowlist 收窄面;空数组 = 一个都不给', () => {
    expect(Surface.resolve({ catalog: catalogOf('read', 'bash'), scene: {}, allowlist: ['bash'] }).names())
      .toEqual(['bash'])
    expect(Surface.resolve({ catalog: catalogOf('read', 'bash'), scene: {}, allowlist: [] }).names())
      .toEqual([])
  })

  it('schemas 由投影器产出 —— 内核不认识任何 provider 格式', () => {
    const surface = Surface.resolve({ catalog: catalogOf('read', 'bash'), scene: {} })
    expect(surface.schemas(tool => ({ name: tool.spec.id, parameters: tool.spec.input })))
      .toEqual([
        { name: 'read', parameters: { type: 'object' } },
        { name: 'bash', parameters: { type: 'object' } },
      ])
  })

  it('R2a 决定⑤:内核语义不变 —— 空数组一个都不给,undefined 才是不限制', () => {
    const catalog = catalogOf('read', 'bash')
    expect(Surface.resolve({ catalog, scene: {}, allowlist: [] }).names()).toEqual([])
    expect(Surface.resolve({ catalog, scene: {}, allowlist: undefined }).names()).toEqual(['read', 'bash'])
  })

  it('R2a 决定⑤:normalizeLegacyAllowlist 是接线处那道显式的归一门', () => {
    // 旧路把空数组读成"不限制"。归一之后旧行为逐字保留,而内核的语义没被改软。
    expect(normalizeLegacyAllowlist([])).toBeUndefined()
    expect(normalizeLegacyAllowlist(null)).toBeUndefined()
    expect(normalizeLegacyAllowlist(undefined)).toBeUndefined()
    expect(normalizeLegacyAllowlist(['bash'])).toEqual(['bash'])

    const catalog = catalogOf('read', 'bash')
    expect(Surface.resolve({ catalog, scene: {}, allowlist: normalizeLegacyAllowlist([]) }).names())
      .toEqual(['read', 'bash'])
  })

  it('R2a 决定⑨:Surface 是解析那一刻的快照 —— 之后目录再变也不影响它', () => {
    const catalog = catalogOf('read', 'bash')
    const surface = Surface.resolve({ catalog, scene: {} })

    catalog.unregister('bash')
    catalog.register(new ScriptedTool({ id: 'write' }))

    // 面上仍是解析时的那两个:模型这一回合看到的清单,与它能调到的工具,必须同一份。
    expect(surface.names()).toEqual(['read', 'bash'])
    expect(surface.get('bash')).toBeDefined()
    expect(surface.get('write')).toBeUndefined()
    // 目录本身当然已经变了 —— 变的是目录,不是这一回合的面。
    expect(catalog.all().map(tool => tool.spec.id)).toEqual(['read', 'write'])
  })

  it('settingFor 把用户设置带到 Authorizer 那一侧', () => {
    const surface = Surface.resolve({
      catalog: catalogOf('bash'),
      scene: {},
      settings: { bash: { autoExecute: false } },
    })
    expect(surface.settingFor('bash')).toEqual({ autoExecute: false })
    expect(surface.settingFor('read')).toBeUndefined()
  })
})

/**
 * R3a —— `Scene` 的三格新字段。
 *
 * 它们都是**已经归一化过的结论**(协作场子、有没有 active 目标、是不是被派出去的
 * 工作会话),由产品层的 `resolveScene` 算好递进来;内核仍然不枚举产品有哪些形态,
 * 它只负责把 scene 原样交给 `Tool.visibleIn`。
 */
class SceneGatedTool extends Tool<unknown, unknown> {
  readonly spec: ToolSpec = {
    id: 'gated',
    title: 'Gated',
    description: '',
    input: { type: 'object' },
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'parallel',
  }

  constructor(private readonly gate: (scene: Scene) => boolean) {
    super()
  }

  override visibleIn(scene: Scene): boolean {
    return this.gate(scene)
  }

  async plan(): Promise<Intent<unknown>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [] }
  }
}

describe('Scene 的 R3a 新字段', () => {
  it('venue / goalActive / taskSession 原样到达 visibleIn', () => {
    const seen: Scene[] = []
    const catalog = new Catalog().register(new SceneGatedTool(scene => {
      seen.push(scene)
      return scene.venue === 'room' && scene.goalActive === true && scene.taskSession === false
    }))

    expect(Surface.resolve({
      catalog,
      scene: { venue: 'room', goalActive: true, taskSession: false },
    }).names()).toEqual(['gated'])

    expect(Surface.resolve({
      catalog,
      scene: { venue: 'chat', goalActive: true, taskSession: false },
    }).names()).toEqual([])

    expect(seen[0]).toEqual({ venue: 'room', goalActive: true, taskSession: false })
  })

  it('三格都是可选的 —— 不给就是 undefined,内核不替产品编默认值', () => {
    const catalog = new Catalog().register(new SceneGatedTool(scene =>
      scene.venue === undefined && scene.goalActive === undefined && scene.taskSession === undefined))
    expect(Surface.resolve({ catalog, scene: {} }).names()).toEqual(['gated'])
  })
})
