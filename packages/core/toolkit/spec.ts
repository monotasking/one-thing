/**
 * §3 内核 —— `ToolSpec`:一个工具的**不可变值部分**。
 *
 * 它只回答"你是谁、你的契约长什么样、你最多可能做什么",不含任何行为,也不含
 * registry / 权限 / 渲染的知识。core 禁 zod,所以契约在内核里只是 JSON Schema
 * 加一个 `Validator` 端口;runtime 侧的工具照旧用 zod 写,经一次转换喂进来。
 *
 * `Scene` 与 `PrepareEnv` 也放在这里(而不是各自的使用方文件里),纯粹是为了让
 * `tool.ts` 不必反向依赖 `catalog.ts` / `surface.ts` —— 值类型集中在最底下一层,
 * 依赖就永远是单向的。
 */

import type { JsonObject } from '../json.js'
import type { CoreToolPromptContribution } from '../engine/prompt-fragments.js'
import type { EffectClass } from './effects.js'

/** 内核对"契约"的全部认识:一坨 JSON Schema。解释权归 `Validator` 端口。 */
export type JsonSchema = JsonObject

/**
 * R2a 决定②:工具的提示词贡献**复用 core 现有的 `CoreToolPromptContribution`**,
 * 内核不再另立一个 `{ section?, text }` 的一格结构。
 *
 * 理由是 R1 的实测(设计文档 §11.5 偏差 2):现有工具的贡献分三类
 * (`guidelines[]` / `workspaceRules[]` / `sections[]`),variable 三类全用。把它们
 * 硬映射进一格 = 一次静默的信息损失,于是 R1 只能把三个常量原样导出、`spec.prompt`
 * 空着 —— 一个从来没人填的字段等于不存在。改成复用之后 write / edit / variable 的
 * 提示词回到了它们的 spec 上,`promptFragmentsFromToolContribution` 直接吃得下。
 *
 * 这不破坏"内核零依赖":`prompt-fragments.ts` 是同一个包(core)里的纯类型模块,
 * 且这里是 `import type` —— 运行时一个字节都不引入。
 */
export type ToolPromptContribution = CoreToolPromptContribution

export type ToolPresentationKind =
  | 'text'
  | 'bash'
  | 'diff'
  | 'file'
  | 'search'
  | 'image'
  | 'custom'

export interface ToolPresentation {
  readonly kind: ToolPresentationKind
  /** `self` = 工具自带外壳(卡片自己画边框),`default` = 用宿主的通用外壳。 */
  readonly shell: 'default' | 'self'
}

/**
 * 输出预算的每工具覆盖。缺省走 `OutputBudget` 的默认阈值 —— 绝大多数工具不该
 * 关心这件事(尺子①:工具里不出现"截断"这个词)。
 */
export interface ToolBudgetHint {
  readonly maxLines?: number
  readonly maxBytes?: number
}

export interface ToolSpec {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: JsonSchema
  /**
   * 静态上界:这个工具**可能**产生哪些类的效果。`plan` 产出的具体效果不得超出
   * 它 —— 越界是工具的 bug,由 Runner 判 `failed`(见 runner.ts)。
   */
  readonly effects: readonly EffectClass[]
  readonly presentation: ToolPresentation
  /** N3 的单读者不变:agent-loop runner 的并发屏障只读这一个字段。 */
  readonly concurrency: 'parallel' | 'sequential'
  readonly prompt?: CoreToolPromptContribution
  readonly budget?: ToolBudgetHint
  /**
   * 这只工具是**别的东西的投影**,不是一件独立注册的工具(K3-a)。
   *
   * 今天唯一的值是 `'resource'`,唯一的产地是 `core/resource/`(一个命名空间一只
   * `ResourceTool`,加一只元工具 `resources`)。
   *
   * 它答的问题只有一个:**这只工具进不进「工具清单」那个出口** —— 设置页的工具
   * 列表与 CLI 的 `listTools` 读的那一份(`runtime/toolkit/catalog-projection.wiring.ts`)。
   * 那份清单答的是「这台宿主注册了哪些工具」,而资源的呈现(图标、标题、每个应用
   * 一格的许可)归应用登记表,不归工具清单;K1 的审查打回记的就是这一条:资源
   * 工具进目录时那份清单凭空多出一行 `session`,是一次没人裁定过的、用户可感知的
   * 变化(08-18 判例:默认保持旧行为)。
   *
   * **它与「露不露面」无关**:模型照常看得见这些工具,回合面的判据是 §10.4 那四个
   * 事实加每只工具自己的 `visibleIn`。一个出口的减法不许顺手变成另一个出口的减法。
   *
   * 为什么是一格数据而不是让读点去 `instanceof ResourceTool`:投影层(产品层)那样
   * 就得反向 import core 的资源实现类,而它今天只认识 `ToolSpec`。一格枚举是值,
   * 一条 import 是依赖。
   */
  readonly projection?: 'resource'
}

/**
 * 一回合的"场子"。`Tool.visibleIn(scene)` 是唯一的场景判定入口,取代今天那张
 * 集中式的 scene-surface 表(§5 SceneResolver)。字段刻意保持开放:内核不该知道
 * 产品有哪些形态,它只负责把 scene 原样递给工具。
 */
export interface Scene {
  /** 会话形态(chat / collab / …)。内核不枚举它。 */
  readonly kind?: string
  readonly sessionId?: string
  /** 本回合启用的 skills —— `feature_*` 这类工具靠它决定露不露面。 */
  readonly skills?: readonly string[]
  readonly workspaceRoot?: string
  readonly metadata?: JsonObject
  /**
   * R3a 新增的三格。它们都是**已经归一化过的判定结果**,不是原始会话字段 ——
   * 内核仍然不枚举产品有哪些形态,它只是把产品算好的答案原样递给工具。
   *
   * 为什么不让工具自己从 `kind` / `metadata` 里推:那正是旧 `scene-surface.ts`
   * 存在的理由(四个协作工具各手写一遍 kind 判据,漏一份就是一个静默的授权洞)。
   * 判据留在产品层的 `resolveScene` 一处,场上每个 `visibleIn` 只读结论。
   */
  /** 协作场子(room / agent / work / chat)。归一化规则见产品层的场子表。 */
  readonly venue?: string
  /** 这条会话此刻有一个 `active` 目标。 */
  readonly goalActive?: boolean
  /** 这条会话本身是一条被派出去的工作会话(禁止套娃的判据)。 */
  readonly taskSession?: boolean
}

/** `Tool.prepare()` 拿到的环境。懒初始化(MCP 连接、异步 schema)用得上。 */
export interface PrepareEnv {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly values?: Readonly<Record<string, unknown>>
}
