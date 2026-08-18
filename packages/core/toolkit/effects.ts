/**
 * §3 内核 —— EffectClass 目录 + 默认策略表(§10.2-② 列为 R0 的第一件事)。
 *
 * 权限只认效果、不认工具。既然如此,「有哪些效果类」和「每一类默认怎么处理」
 * 就必须是**一张表**,而不是散在判定函数里的一串 if —— 今天
 * `core/permission/permission-policy.ts` 逐 kind 写死的口径就是那串 if 的样子:
 * `read` 静默、写/bash/mcp 询问、`capability_change` 永不可授。那份口径原样搬到
 * 这里,同目录的测试钉住「每个 kind 都有策略行」以及「与 core 的 barrier 判定
 * 不矛盾」。
 *
 * 纪律(§9 风险 2 的处理):kind 名沿用 core 现有的 9 个,**只许新增不许改名**;
 * 新增一个 kind = 在这张表里加一行(policy + 权限卡文案),没有行就等于这个效果
 * 类不存在。未知 kind 一律按 `ask` 兜底 —— 内核宁可多问一次,也不静默放行。
 */

import type { JsonObject } from '../json.js'

/**
 * 效果类。前 9 个与 `core/tools/tool-effect.ts` 的 `ToolEffectKind` 逐字对应
 * (这是唯一一处已经"按效果"思考的旧代码,不重命名它);后 4 个是 §10.2-② 决议
 * 新增的,命名沿用下划线风格。
 */
export type EffectClass =
  | 'read'
  | 'file_edit'
  | 'file_write'
  | 'file_destructive_edit'
  | 'bash'
  | 'mcp'
  | 'external_directory'
  | 'sensitive_file_read'
  | 'capability_change'
  | 'net_fetch'
  | 'user_ask'
  | 'session_message'
  | 'session_spawn'
  | 'plugin_exec'

/**
 * 默认处置:
 * - `silent`         无需询问(权限核里就是"不进 promptEffects"的那一类)
 * - `ask`            要问,答案可被 grant 记住
 * - `never-grantable` 每次都问,答案永不可记忆(它改变的是系统自己能够到哪里)
 */
export type EffectPolicy = 'silent' | 'ask' | 'never-grantable'

export interface EffectPolicyRow {
  readonly kind: EffectClass
  readonly policy: EffectPolicy
  /** 权限卡的默认标题。工具在 `Intent.preview.title` 给了更具体的就用工具的。 */
  readonly prompt: string
  /** 并发屏障。与 `core/tools/tool-effect.ts` 的 `isBarrierEffect` 同口径。 */
  readonly barrier: boolean
}

const ROWS: readonly EffectPolicyRow[] = [
  // 读在根内是静默的。越界读与敏感读不是"读"的加强版参数,而是**另外两个 kind**
  // —— 由 plan 阶段决定报哪一个,权限层因此不需要认识路径。
  { kind: 'read', policy: 'silent', prompt: 'Read files', barrier: false },
  { kind: 'file_edit', policy: 'ask', prompt: 'Edit file', barrier: true },
  { kind: 'file_write', policy: 'ask', prompt: 'Write file', barrier: true },
  { kind: 'file_destructive_edit', policy: 'ask', prompt: 'Overwrite file', barrier: true },
  { kind: 'bash', policy: 'ask', prompt: 'Run bash command', barrier: true },
  { kind: 'mcp', policy: 'ask', prompt: 'Run MCP tool', barrier: true },
  { kind: 'external_directory', policy: 'ask', prompt: 'Access directory outside project', barrier: false },
  { kind: 'sensitive_file_read', policy: 'ask', prompt: 'Read sensitive file', barrier: false },
  // 它改的是"助手能够到哪里",提议可以由助手发起,但答案永远不进 grant 表。
  { kind: 'capability_change', policy: 'never-grantable', prompt: 'Repoint capability', barrier: true },
  // 以下四行是新增 kind。它们默认静默,因为今天 web_search / ask_user / 跨会话
  // 投递都不弹权限卡 —— 按 §9"未知=恒 ask"处理会凭空多出三张卡,那是退步。
  { kind: 'net_fetch', policy: 'silent', prompt: 'Fetch a URL', barrier: false },
  { kind: 'user_ask', policy: 'silent', prompt: 'Ask the user a question', barrier: false },
  { kind: 'session_message', policy: 'silent', prompt: 'Post a message to a session', barrier: false },
  /**
   * 开一条子会话。**silent,不是 ask**(R3a 复盘裁定)。
   *
   * R0 把它定成 `ask` 时的理由是「让另一个主体开始花钱和动手」。但派工的**本义**
   * 就是"派出去继续干" —— 为它弹一张卡等于让用户为「要不要开始」点一次同意,再
   * 为那条会话里的每一次真实副作用点第二次。真正的风险由两道既有的闸兜住:
   * 每条会话的并发上限(`TASK_MAX_CONCURRENT_PER_SESSION`),以及子会话自己的
   * 权限卡(它继承调用方的权限模式,每一次写盘/跑命令照常审批)。
   *
   * 效果**保留**而不是删掉:barrier 仍然为真(两次并发登记会把并发闸算错),
   * 而且它是审计里唯一能回答「这一回合派出去过一条会话」的那条证词。
   * 「不惊动人」与「不留痕迹」是两件事,策略表管前者,审计管后者。
   */
  { kind: 'session_spawn', policy: 'silent', prompt: 'Start a sub-session', barrier: true },
  // R3a:跑一段**插件**写的代码。旧路把这句话写成 `permissionGuard:
  // 'permission-gated'`(`app/plugins/api.ts` 写死,插件填什么都会被覆盖:
  // "插件不能给自己发免检通行证")。新树里 guard 是派生值,所以那句话必须由
  // 一条效果说出来。不复用 `mcp`:那会在权限账本与卡片文案里把一个插件写成
  // 一台 MCP 服务器,而账本是要被人读的。
  { kind: 'plugin_exec', policy: 'ask', prompt: 'Run plugin tool', barrier: true },
]

export const EFFECT_POLICY: Readonly<Record<EffectClass, EffectPolicyRow>> = Object.freeze(
  Object.fromEntries(ROWS.map(row => [row.kind, Object.freeze(row)])) as Record<EffectClass, EffectPolicyRow>,
)

export const EFFECT_CLASSES: readonly EffectClass[] = Object.freeze(ROWS.map(row => row.kind))

/** 一条具体效果(plan 产出的,带资源)。上界是 `ToolSpec.effects` 里的类。 */
export interface Effect {
  readonly kind: EffectClass
  readonly resources: readonly string[]
  /** 覆盖策略表的屏障判定。工具知道得更细时(只读某个文件)可以放松。 */
  readonly barrier?: boolean
  /** 落在项目根之外 —— `auto-accept-edits` 不吃这一位(见 permission-policy 的注释)。 */
  readonly external?: boolean
  readonly sensitive?: boolean
  readonly metadata?: JsonObject
}

export function isKnownEffectClass(kind: string): kind is EffectClass {
  return Object.prototype.hasOwnProperty.call(EFFECT_POLICY, kind)
}

/**
 * 不认识的 kind 不抛错、也不放行:合成一条 `ask` 行。内核在这里选择"多问一次"
 * 而不是"崩掉这次调用",因为一个拼错的效果名不该让工具不可用,但更不该静默。
 */
export function effectPolicyFor(kind: string): EffectPolicyRow {
  if (isKnownEffectClass(kind)) return EFFECT_POLICY[kind]
  return { kind: kind as EffectClass, policy: 'ask', prompt: `Use ${kind}`, barrier: true }
}

export function policyOf(effect: Effect): EffectPolicy {
  return effectPolicyFor(effect.kind).policy
}

export function isBarrierEffect(effect: Effect): boolean {
  return effect.barrier ?? effectPolicyFor(effect.kind).barrier
}

/** 这一组效果里有没有需要人回答的。`silent` 全集 = 这次调用不必打扰任何人。 */
export function requiresAuthorization(effects: readonly Effect[]): boolean {
  return effects.some(item => policyOf(item) !== 'silent')
}

export function makeEffect(
  kind: EffectClass,
  resources: readonly string[] = [],
  extra: Omit<Effect, 'kind' | 'resources'> = {},
): Effect {
  return { kind, resources, ...extra }
}
