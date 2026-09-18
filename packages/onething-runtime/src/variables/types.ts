/**
 * Where a variable lives and who sees it:
 * - 'session' (default): this session only.
 * - 'agent': shared by every session bound to the same agent.
 * - 'project': attached to the active workdir's project — visible in any
 *   session whose workdir points at that directory.
 * - 'global': shared across all sessions.
 */
export type VariableScope = 'global' | 'session' | 'agent' | 'project'

/**
 * Value type of a custom variable. `value` always holds the canonical string
 * serialization — scalars as plain text, collections as compact JSON — and
 * writes are validated/normalized against the declared type
 * (see typed-values.ts). 'set' is a list with unique elements.
 */
export type VariableType = 'string' | 'number' | 'bool' | 'list' | 'map' | 'set'

export interface ContextVariable {
  name: string
  value: string
  values?: string[]
  type?: VariableType
  scope?: VariableScope
  description?: string
  readonly?: boolean
  /**
   * 模型是否需要**一直**知道这个值(agent-self-state-variables.md §R)。
   *
   * true 的变量每回合全量进 `<context-update>` 尾部块;其余的一个字节都不进
   * 请求,只能用 `variable` 工具的 keys/get 读。判据是"要不要一直在眼前",
   * 不是"变得快不快":笔记目录几个月不变,但每次写笔记都要用,所以是 state。
   */
  state?: boolean
  updatedAt?: number
}

/**
 * 旧盘上的三档 `volatility` 读到即转成 `state`(§R.6),旧文件不回写。
 *
 * 'turn' 是三档里唯一"要一直在眼前"的那一档;'static' 与从未有 provider 产出过的
 * 'on-demand' 都归 false —— 用户自建的 static 变量因此从"每回合都在眼前"变成
 * "要自己去读",想要旧行为显式写 `state: true`。
 */
export function readStateFlag(
  raw: { state?: unknown; volatility?: unknown } | null | undefined,
): boolean | undefined {
  if (typeof raw?.state === 'boolean') return raw.state
  if (typeof raw?.volatility === 'string') return raw.volatility === 'turn'
  return undefined
}

export interface VariableContext {
  sessionId: string
  messageId?: string
  toolCallId?: string
}

export interface SetInput {
  name: string
  value: string
  scope?: VariableScope
  /**
   * Value type. On set: defaults to the variable's existing type, else
   * 'string'. On append to a missing variable: defaults to 'list'.
   */
  type?: VariableType
  description?: string
  /**
   * 显式声明这个变量要不要一直在模型眼前(见 ContextVariable.state)。
   * 自建变量默认 false —— 不写就是"要用时自己去读"。
   */
  state?: boolean
}

export interface VariableProvider {
  readonly id: string
  readonly priority?: number

  list(ctx: VariableContext): Promise<ContextVariable[]> | ContextVariable[]
  claims(name: string): boolean

  set?(ctx: VariableContext, input: SetInput): Promise<ContextVariable> | ContextVariable
  append?(ctx: VariableContext, input: SetInput): Promise<ContextVariable> | ContextVariable
  remove?(ctx: VariableContext, input: SetInput): Promise<ContextVariable> | ContextVariable
  delete?(ctx: VariableContext, name: string): Promise<void> | void

  onExternalChange?(emit: (ctx?: VariableContext) => void): () => void
}

export type VariableErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_VALUE'
  | 'READONLY'
  | 'NOT_FOUND'
  | 'RESERVED'
  | 'LIMIT_EXCEEDED'
  | 'WORKDIR_NOT_FOUND'
  | 'NO_PROVIDER'
  | 'PROVIDER_CONFLICT'
  | 'FORBIDDEN'

export class VariableError extends Error {
  constructor(public readonly code: VariableErrorCode, message: string) {
    super(message)
    this.name = 'VariableError'
  }
}

export const VARIABLE_LIMITS = {
  MAX_VALUE_BYTES: 4 * 1024,
  MAX_PER_PROVIDER: 64,
  MAX_NAME_LENGTH: 64,
} as const

/**
 * 「能力变量」:值不只是文字,系统会照着它动手。重指一个这样的变量等于改变助手
 * 够得着的范围,所以 `variable` 工具对它们**提一次审批**,而不是像写普通状态那样
 * 悄悄写掉。
 *
 * **这张表今天是空的**(P3,2026-09-18):唯一的两个成员 `user_note_dir` /
 * `work_note_dir` 随笔记领域退役了 —— 「笔记在哪」今天是设置里的一张库表,改它
 * 走设置页,不再是模型能提议的一次变量写入。
 *
 * 表空了而机制留着,是因为**机制本身是对的**:下一个「值即能力」的变量(某个
 * 沙箱根、某个凭证指向)加进来时,判据和审批路径已经在这里了,加的是一行名字。
 * 这也是真正的能力注册表的种子 —— 见 docs/design/capability-registry.md。
 */
export const CAPABILITY_VARIABLE_NAMES = Object.freeze([] as readonly string[])

export function isCapabilityVariable(name: string): boolean {
  return (CAPABILITY_VARIABLE_NAMES as readonly string[]).includes(name.trim())
}

/**
 * 资源自述 `state` 投影出来的变量名前缀(K4-a,`docs/design/atom-2026-09.md` §4
 * 「提示词」那一行)。
 *
 * 这些变量的名字是**按命名空间与状态名现生成**的(`resource_session_current`),
 * 所以下面那张 `RESERVED_NAMES` 静态表登记不了它们 —— 登记得了的只有这条**前缀
 * 规则**。它挡的是一次真实的事故形状:用户或模型自建一个同名变量,`registry.list`
 * 当场以 `PROVIDER_CONFLICT` 抛出,整块变量板连带没了。
 *
 * 为什么是一个独立的字面前缀,而不是「以某个已登记的 scheme 名打头」:后者要校验
 * 器去认识注册表(产品层的一只纯函数去问装配层的一张表),而且会顺手把
 * `session_notes` 这种正当的用户变量一起判死。一个前缀,一条规则,零个 scheme 名。
 */
export const RESOURCE_STATE_VARIABLE_PREFIX = 'resource_'

export const RESERVED_NAMES = Object.freeze([
  'workdir',
  'cwd',
  'home',
  'datetime',
  'git_branch',
  'background_jobs',
  'goal',
  // agent 自我状态的事实层(agent-self provider):只读、每回合现算。
  'my_cards',
  'my_rooms',
  'my_dms',
] as const)

export type ReservedName = (typeof RESERVED_NAMES)[number]
