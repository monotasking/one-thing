/**
 * 等级 spec 的解析(D191 从 `logging-configure.ts` 搬来,经入口交出)。
 *
 * 无副作用:只读环境变量,只引旧调试变量的别名表。configure 接线时用它定初始等级,诊断模式关掉时用它回到
 * 「环境给的那一份」—— 两处必须是同一个解析器,关掉诊断模式不该顺手丢掉 `ONETHING_DEBUG_*` 别名。
 */
import { composeLevelSpecWithLegacyAliases, resolveLegacyDebugAliases } from './logging-legacy-debug-env.js'

const DEFAULT_LEVEL_SPEC = 'info'

/**
 * 最终等级 spec = 显式参数 / `ONETHING_LOG` / 兜底 `info`,再拼上**已废弃**的
 * `ONETHING_DEBUG_*` 别名(见 `logging-legacy-debug-env.ts`,L5 删)。别名永远弱于显式 spec。
 */
export function resolveLevelSpec(explicit?: string): string {
  return composeLevelSpecWithLegacyAliases(
    explicit ?? process.env.ONETHING_LOG,
    DEFAULT_LEVEL_SPEC,
    resolveLegacyDebugAliases(process.env),
  )
}
