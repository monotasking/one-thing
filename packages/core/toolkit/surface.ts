/**
 * §3 内核 —— `Surface`:这一回合的工具面。
 *
 * 「模型这一回合看得见谁」今天是三处口径拼出来的:一张集中式场景表、agent 的
 * allowlist、设置页的 per-tool 开关,谁先谁后没人说得清。这里它是一个对象,由
 * `Catalog × Scene × 白名单 × 设置` 一次解析出来,顺序写死在一个函数里。
 *
 * `names()` 额外接受一组 **provider 追加名**(§10.2-⑥):Codex 这类 provider 自带
 * 一批原生工具名,它们不是我们的 Tool(没有 spec、不进 Catalog、Runner 也跑不了),
 * 但"这个名字在这一回合是不是一个合法工具名"必须能答对,否则模型调它时会被当成
 * 未知工具。所以追加名只进 `names()`,进不了 `tools()`/`get()`。
 */

import type { Catalog } from './catalog.js'
import type { ToolUserSetting } from './ports.js'
import type { Scene } from './spec.js'
import type { Tool } from './tool.js'

/**
 * R2a 决定⑤ —— 空数组的两种读法,一处归一。
 *
 * 内核语义(不变):`undefined` = 不限制,**空数组 = 明确的"一个工具都不给"**。
 * 一个空的白名单是一句说出口的话,把它读成"随便你"是让一次收紧变成一次放开。
 *
 * 但旧路(`core/engine/agent-loop-runtime.ts` 的
 * `allowedToolIds && allowedToolIds.length > 0 ? new Set(...) : null`)把空数组读成
 * "不限制"。两者对同一个值给出**相反**的工具面,所以接线时必须显式归一,而不是
 * 让两套语义在同一个字段上碰运气。
 *
 * 这个函数就是那道显式的归一门:R2b 在把旧的 `allowedToolIds` 递给 `Surface.resolve`
 * 之前过一次,行为与今天逐字一致;内核自己**不调用它**,内核的语义不因为有个转换器
 * 就变软。
 */
export function normalizeLegacyAllowlist(
  list: readonly string[] | null | undefined,
): readonly string[] | undefined {
  if (!list || list.length === 0) return undefined
  return list
}

export interface SurfaceResolveInput {
  readonly catalog: Catalog
  readonly scene: Scene
  /** agent 白名单。`undefined` = 不限;空数组 = 一个都不给。 */
  readonly allowlist?: readonly string[]
  readonly settings?: Readonly<Record<string, ToolUserSetting>>
  /** provider 自带的原生工具名。 */
  readonly extraNames?: readonly string[]
}

export class Surface {
  private readonly entries: readonly Tool[]
  private readonly byId: ReadonlyMap<string, Tool>
  private readonly extras: readonly string[]
  private readonly settings: Readonly<Record<string, ToolUserSetting>>
  readonly scene: Scene

  private constructor(input: SurfaceResolveInput, entries: readonly Tool[]) {
    this.entries = entries
    this.byId = new Map(entries.map(tool => [tool.spec.id, tool]))
    this.extras = [...(input.extraNames ?? [])]
    this.settings = input.settings ?? {}
    this.scene = input.scene
  }

  /**
   * R2a 决定⑨:解析出来的是一份**快照**。
   *
   * `catalog.all()` 在这里被求值一次,结果冻在 `entries` 里 —— 之后目录再变
   * (插件卸载、MCP 断连、热注册)都不影响这一回合已经解析好的面。这不是实现细节
   * 而是协议:模型这一回合看到的工具清单,与它这一回合能调到的工具,必须是同一份
   * 名单;若 Surface 跟着目录活着变,就会出现"schema 里列了、真调时说不存在"的
   * 一回合内自相矛盾。目录是可变的,面是不可变的(见 catalog.ts 的头注释)。
   */
  static resolve(input: SurfaceResolveInput): Surface {
    const allowlist = input.allowlist ? new Set(input.allowlist) : undefined
    const entries = input.catalog.all().filter(tool => {
      if (allowlist && !allowlist.has(tool.spec.id)) return false
      // 用户在设置页关掉的工具直接不进面 —— 不是"进了面再拒绝",模型根本看不见它。
      if (input.settings?.[tool.spec.id]?.enabled === false) return false
      return tool.visibleIn(input.scene)
    })
    return new Surface(input, entries)
  }

  tools(): readonly Tool[] {
    return this.entries
  }

  get(id: string): Tool | undefined {
    return this.byId.get(id)
  }

  /** 本回合的合法工具名全集 = 面上的工具 + provider 追加名(去重,工具在前)。 */
  names(): readonly string[] {
    const names = this.entries.map(tool => tool.spec.id)
    const seen = new Set(names)
    for (const extra of this.extras) {
      if (seen.has(extra)) continue
      seen.add(extra)
      names.push(extra)
    }
    return names
  }

  has(name: string): boolean {
    return this.byId.has(name) || this.extras.includes(name)
  }

  /** provider schema 由投影器产出 —— 内核不认识任何一家 provider 的格式。 */
  schemas<T>(projector: (tool: Tool) => T): T[] {
    return this.entries.map(projector)
  }

  settingFor(id: string): ToolUserSetting | undefined {
    return this.settings[id]
  }
}
