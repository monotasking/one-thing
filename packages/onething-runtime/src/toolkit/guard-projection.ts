/**
 * R2a —— `permissionGuard` 的**派生投影**(设计文档 §10.2-③ / §11.2)。
 *
 * `permissionGuard` 这个概念在新树里已经不存在了:权限只认 `Intent.effects`。但它
 * 泄漏进了契约层(契约包的 `ipc/tools.ts`、`ipc/chat.ts`、
 * `core/mcp/tool-definition.ts`、`core/plugins/types.ts`、提示词快照、设置页与
 * `SystemPromptPanel.vue`),而 R2 的验收之一是「渲染器与 IPC 契约一行不改」。
 *
 * 于是它降级成一个**派生值**:由 `spec.effects` 这组静态上界推出五个字符串之一,
 * 规则**只在这一处**。工具作者仍然一个字都不写;`core/tools/permission-guards.ts`
 * 里读它的那两个判据(能不能注入给 provider、能不能 autoExecute)照旧成立。
 *
 * ## 为什么是 kind 而不是资源
 *
 * `spec.effects` 是一组 **kind**,表达不了资源级的上界(§11.2)。所以 read 在目录里
 * "看起来"永远可能读敏感文件,尽管 99% 的调用只报 `read` —— 这与旧的 `sandboxed`
 * 恰好是同一个口径(旧值也是一个静态字符串,与具体路径无关),不是新引入的失真。
 */

import { isKnownEffectClass, type EffectClass, type ToolSpec } from '@onething/core/toolkit'
import type { CoreToolPermissionGuard } from '@onething/core/tools'

/** 写文件的三个 kind。任意一个出现 = 旧的 `permission-gated`。 */
const FILE_MUTATION: ReadonlySet<EffectClass> = new Set<EffectClass>([
  'file_edit',
  'file_write',
  'file_destructive_edit',
])

/** 沙箱内的读面。它们合起来正是旧 read 的 `sandboxed` 的含义。 */
const READ_FAMILY: ReadonlySet<EffectClass> = new Set<EffectClass>([
  'read',
  'external_directory',
  'sensitive_file_read',
])

export interface DeriveGuardOptions {
  /**
   * 这只工具跑在别处(远程工具、将来的 `ExternalTool`)。
   *
   * R4b 之前 `external` 是五个值里唯一推不出来的那个。现在 `external-agent`
   * 这条效果把它说了出来(见下面那一句),这个开关因此只剩"宿主知道这只工具
   * 跑在别处,但它的效果表没说"这一种用法。
   */
  readonly external?: boolean
}

export function deriveLegacyPermissionGuard(
  spec: Pick<ToolSpec, 'effects'>,
  options: DeriveGuardOptions = {},
): CoreToolPermissionGuard {
  if (options.external) return 'external'

  const effects = spec.effects
  /**
   * R4b:`external-agent` 是唯一一条**推得出** `external` 的效果 —— 它说的正是
   * "执行体不在本进程里"。所以那个"推不出来"的旧注解从此只对 `options.external`
   * 那条显式开关成立。
   */
  if (effects.includes('external-agent')) return 'external'
  // 零效果 = 旧的 `safe`。time 就是这一格。
  if (effects.length === 0) return 'safe'

  // 认不出的 kind(插件/MCP 送进来的将来效果)一律按最保守的可注入档处理 ——
  // 「不认识」不该被读成「无害」。
  if (effects.some(kind => !isKnownEffectClass(kind))) return 'permission-gated'

  // 会改文件 = 旧的 `permission-gated`(write / edit)。
  if (effects.some(kind => FILE_MUTATION.has(kind))) return 'permission-gated'
  // MCP 的远端调用在旧目录里也是 `permission-gated`(core/mcp/tool-definition.ts)。
  if (effects.includes('mcp')) return 'permission-gated'
  // 插件工具在旧目录里恒 `permission-gated`(`app/plugins/api.ts` 写死的那一行)。
  if (effects.includes('plugin_exec')) return 'permission-gated'
  // 开一个新会话 = 让另一个主体开始花钱和动手,与写文件同档。
  //
  // 注意它与策略表的**分工**:这里派生的是旧契约层那个字符串,策略表答的是「要不要
  // 惊动人」,两个问题各有各的答案,不许互相推。合表(2026-09-10)合的是「要不要
  // 问」那两张表,**这一张不在其中**——那五个值里 `safe/sandboxed/internal-check/
  // permission-gated` 四个在 `CORE_INJECTABLE_*` 与 `CORE_AUTO_EXECUTE_*` 两张表里
  // **完全同权**,派生值落在其中哪一格都不改变任何行为,所以它跟着策略表动只会白白
  // 改掉一个契约层字符串。今天的分歧样本是 `session_message`:策略表 `ask`,这里
  // `safe`(旧目录里 send_message 就是这一档)。
  if (effects.includes('session_spawn')) return 'permission-gated'
  /**
   * **重指助手够得着的东西 = permission-gated。**(R3a 复盘裁定)
   *
   * `capability_change` 是 策略表(`core/toolkit/effects.ts`)里唯一一行 `never-grantable`:每次都问,
   * 答案永不可记住。一个 never-grantable 的效果**不可能**派生出 `safe` —— 那两句话
   * 直接互斥。
   *
   * R2a 这里曾为 variable 写死一格 `safe`(§12.4 第 1 条),理由是"保住现状"。
   * 现状本身是旧树的一个 bug:variable 的 `permissionGuard: 'safe'` 与它
   * `analyze` 报的 `capability_change` 自相矛盾,而那个字符串的两个读者
   * (`isInjectablePermissionGuard` / `isAutoExecutePermissionGuard`)对这四个值
   * 一视同仁,`canAutoExecute` 今天也没有任何调用方。所以按真相派生是**修复**,
   * 不是回归:执行期一个字不变(那条效果照旧走 never-grantable 的卡),变的只是
   * 目录里那个从来没人据以做过判定的标签。
   *
   * 附带结清 feature_mount:它旧值本来就是 `permission-gated`,R3a 因此不再有
   * 那条"第二个受害者"的偏差。
   */
  if (effects.includes('capability_change')) return 'permission-gated'

  // 跑命令 = 旧的 `internal-check`(bash 自己带分类器)。注意它排在文件之后:
  // 一只既跑命令又改文件的工具,更强的那一档赢。
  if (effects.includes('bash')) return 'internal-check'

  // 只读面 = 旧的 `sandboxed`(read)。
  if (effects.some(kind => READ_FAMILY.has(kind))) return 'sandboxed'

  // 剩下的是 net_fetch / user_ask / session_message —— web_search / ask_user /
  // 跨会话投递,旧值都是 `safe`。(合表之后前两类在策略表里也是 `silent`,
  // session_message 是 `ask`;这一张表不跟着动,理由见 session_spawn 那一段。)
  return 'safe'
}
