import { setOnethingProviderRequestDumpEnabled } from '@onething/runtime/providers'
import { getLogger, setLogLevelSpec } from './index.js'

/**
 * 「诊断模式」(拍板 E②):设置页**一个**开关 = 全域 debug + provider 请求正文
 * 转储打开。精细控制仍然走 env `ONETHING_LOG`(它是这个开关的下层,不被替代)。
 *
 * 关掉时回到 env 给的 spec —— 而不是硬编码 `info`:一个开着
 * `ONETHING_LOG=engine.*=debug` 跑的开发者不该因为关掉诊断模式就丢掉它。
 */
const DIAGNOSTICS_LEVEL_SPEC = 'debug'

function baseLevelSpec(): string {
  return process.env.ONETHING_LOG ?? 'info'
}

let applied: boolean | undefined

export function applyDiagnosticsMode(enabled: boolean): void {
  if (applied === enabled) return
  applied = enabled
  setLogLevelSpec(enabled ? DIAGNOSTICS_LEVEL_SPEC : baseLevelSpec())
  setOnethingProviderRequestDumpEnabled(enabled ? true : undefined)
  getLogger('logging').info(enabled ? 'diagnostics mode enabled' : 'diagnostics mode disabled', {
    levelSpec: enabled ? DIAGNOSTICS_LEVEL_SPEC : baseLevelSpec(),
    providerRequestDump: enabled,
  })
}

export function isDiagnosticsModeApplied(): boolean {
  return applied === true
}

/** 测试用。 */
export function resetDiagnosticsModeForTests(): void {
  applied = undefined
}
