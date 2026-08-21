/**
 * 「这条消息是系统内部驱动的吗」—— 纯字符串判定,零依赖。
 *
 * 住在产品层而不是装配层(P3'e-A2a):引擎本体归位到 `runtime/src/engine/` 之后,
 * 路由旁路与 principal 铸造这两处判据都在产品层,而判据本身只是一个集合加两个
 * 前缀,没有任何脊柱依赖。`packages/backend/channel/origin.ts` 原样再导出这里的
 * 每一个符号,所以「**这是 system-internal 的唯一定义**」这句话仍然成立:
 * 加一个新的内部发射源仍然只改这一处。
 */

/**
 * Message sources stamped by system-internal re-drives (goal kicks /
 * continuations). This set is THE single definition of "system-internal":
 * the stream engine's router bypass and every counterpart-identity scan key
 * off it. When a new internal emitter appears (scheduler re-drive, ...),
 * adding its source here updates all of them at once.
 *
 * Plugin pushes (N1) belong to the same class but form a PREFIX family rather
 * than members — one source per plugin id — so they are matched in
 * `isSystemInternalSource`, not listed here.
 */
export const SYSTEM_INTERNAL_MESSAGE_SOURCES: ReadonlySet<string> = new Set([
  'goal',
  // The radio conductor's DJ wake: a curation turn driven into the dedicated
  // radio session when the programme runs low.
  'radio',
  // Room-coordinator activation drives (multi-agent collab). These carry no
  // human counterpart; routing them would remap the room session and corrupt
  // memory attribution (docs/design/multi-agent-collab.md D8).
  'collab',
])

/**
 * 插件注入消息的 source 前缀:`plugin:<pluginId>`(N1)。
 *
 * 它是一个**前缀族**而不是集合里的一个成员,因为 id 是运行期的:每个插件一个
 * source。归属仍然是 SYSTEM_INTERNAL 那一类 —— 插件推送背后没有渠道身份,
 * 让路由去给它解析一个匿名身份的后果与 goal/radio 一模一样(命令被改派到身份
 * 会话、会话的 memory-profile 元数据被覆写)。
 */
export const PLUGIN_MESSAGE_SOURCE_PREFIX = 'plugin:'

export function pluginMessageSource(pluginId: string): string {
  return `${PLUGIN_MESSAGE_SOURCE_PREFIX}${pluginId}`
}

/**
 * 派工完成回投的 source 前缀:`task:<taskSessionId>`
 * (`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-5)。
 *
 * 与插件同为**前缀族**、同为 SYSTEM_INTERNAL:报告背后没有渠道身份,让路由去给它
 * 解析一个匿名身份的后果与 goal / radio / plugin 一模一样(命令被改派到身份会话、
 * 会话的 memory-profile 元数据被覆写)。一条派工回来的报告必须落在**派它出去的那条
 * 会话**上,这是它存在的全部理由。
 */
export const TASK_MESSAGE_SOURCE_PREFIX = 'task:'

export function taskMessageSource(taskSessionId: string): string {
  return `${TASK_MESSAGE_SOURCE_PREFIX}${taskSessionId}`
}

export function isSystemInternalSource(source: string | undefined): boolean {
  if (source === undefined) return false
  return SYSTEM_INTERNAL_MESSAGE_SOURCES.has(source)
    || source.startsWith(PLUGIN_MESSAGE_SOURCE_PREFIX)
    || source.startsWith(TASK_MESSAGE_SOURCE_PREFIX)
}
