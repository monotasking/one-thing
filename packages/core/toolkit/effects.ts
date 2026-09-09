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
 * (这是唯一一处已经"按效果"思考的旧代码,不重命名它);其余是后来各期在这张表里
 * 加的行(§10.2-② 四条、R3a 的 `plugin_exec`、R4b 的 `external-agent`、原子 K2a' 的
 * `ui_change`),命名沿用下划线风格 —— `external-agent` 那一条的连字符有它自己的
 * 理由,写在它那一行上。
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
  | 'session_destructive'
  | 'plugin_exec'
  | 'external-agent'
  | 'ui_change'

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
  /**
   * K3-a —— **拿掉会话账本里已经存在的东西**:删一条消息、删一条会话、清空一段
   * 抄本(`docs/design/atom-2026-09.md` §9 K3;`app-intents-2026-09.md` §7 盲点 3
   * 「破坏性动作(删邮件、发消息、清空歌单)走 `ask`」)。
   *
   * ## 为什么它不是 `session_message` 的一档
   *
   * `session_message` 说的是「往会话里写一条消息」,而写与删在授权上不是同一件事:
   * 前者今天全仓都不打扰人(插件信使、`/files` 补一条系统消息),后者动的是**账本
   * 本身** —— `events.jsonl` 是这个产品唯一的事实来源(F 线三定律),删掉的东西
   * 没有第二个地方还留着。硬套过去会让「补一条」与「删一条」在权限卡、grant 表和
   * 审计账里长成同一句话,而账本是要被人读的(`plugin_exec` 不复用 `mcp` 的同一
   * 条理由)。
   *
   * ## `ask` 而不是 `never-grantable`
   *
   * `never-grantable` 留给「改变系统自己能够到哪里」那一档(`capability_change`)。
   * 删一条消息是这个人自己的数据、在这个人自己的会话里,他说一次「这类总是可以」
   * 应该算数。真正不可逆到该进 `never-grantable` 的(清空账户那种)今天没有产地。
   *
   * `barrier: true`:它与同一条会话上并发的读 / 写在账本上抢同一批坐标。
   */
  { kind: 'session_destructive', policy: 'ask', prompt: 'Remove session content', barrier: true },
  // R3a:跑一段**插件**写的代码。旧路把这句话写成 `permissionGuard:
  // 'permission-gated'`(`app/plugins/api.ts` 写死,插件填什么都会被覆盖:
  // "插件不能给自己发免检通行证")。新树里 guard 是派生值,所以那句话必须由
  // 一条效果说出来。不复用 `mcp`:那会在权限账本与卡片文案里把一个插件写成
  // 一台 MCP 服务器,而账本是要被人读的。
  { kind: 'plugin_exec', policy: 'ask', prompt: 'Run plugin tool', barrier: true },
  /**
   * R4b —— 一台**外部 agent**(Claude Code SDK / ACP)要动手做一件我们认不出的事。
   *
   * 它在 R4b 之前是一条**不在任何表里**的手搓 kind,由
   * `app/external-agents/index.ts` 与 `app/acp/permission-bridge.ts` 各自直接喂给
   * 权限核 —— 一个不在任何表里的效果类,策略靠"权限核不认识它所以走 ask"这条
   * 巧合成立。§15.5-7 记的就是这一条:要让那两处改调 `Authorizer.decide`,它得先
   * 是一行。名字**逐字沿用**那条旧字符串(连字符,与本表其余下划线风格不同):
   * 它同时是权限卡的 `type`,而渲染器与它的测试都按这个字面量分支 —— 改成
   * `external_agent` 会是一次悄悄的契约变更。
   *
   * `ask`(可被 grant 记住,pattern 是工具名),`barrier` 为真:外部这一步与本地
   * 工具一样可能写盘/跑命令,认不出内容时按最强的那一档排队。
   */
  { kind: 'external-agent', policy: 'ask', prompt: 'Run an external agent tool', barrier: true },
  /**
   * K2b-1 留账的拍点(`docs/design/atom-2026-09.md` §6):壳里开一格、激活一格、
   * 移动一格、把一格撕成浮窗 —— 这类做法的效果类。
   *
   * **它不是「没有副作用」,是「副作用只在界面上,而且主体本来就拥有它」。** 那扇
   * 窗是这个人的窗;为「把面板挪到右边」弹一张权限卡,与 08-18「弹卡是噪音」那条
   * 判例是同一件事。所以 `silent`,而且 `barrier: false` —— 两条界面动作彼此无关,
   * 排队没有任何东西可保护(资源上的做法要串行是 `ResourceTool` 自己说的事)。
   * silent 不等于不留痕:它照样落 `tool/audit`,照样发事件。
   *
   * **`close` 这类可能丢掉未保存内容的动作不另立一类。** 立 `ui_destructive` 要的
   * 事实是「这一格里有没有没保存的东西」,而那个事实**只有壳知道** —— core 的效果
   * 表里再多一行也说不出它,只能变成一个恒真或恒假的标签。那道闸留在壳侧的
   * `beforeClose` 确认上,那里才有那个事实。
   */
  { kind: 'ui_change', policy: 'silent', prompt: 'Change the interface', barrier: false },
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
