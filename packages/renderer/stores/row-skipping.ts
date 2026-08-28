/**
 * **消息行惰性渲染的开关**(U3,§17.8.8)。
 *
 * 惰性渲染本身 2026-08-19 就在生产上了(`MessageList.vue` 的
 * `.message-list-content.rows-skippable .message-list-row { content-visibility: auto }`
 * + 每行 `contain-intrinsic-size: auto 240px`)。这个文件只加一件事:**一个可以关掉
 * 它的把手** —— 没有它就没法做 A/B 读数,也没法在真机上一键回退对照。
 *
 * 与 `fold-tree.ts` 的开关同款,理由也同款:
 *
 *  - 覆盖值挂 `globalThis`(测试 `vi.resetModules()` 冲不掉);
 *  - 持久化走 `localStorage`,双端(dev / 打包 / web)一致;
 *  - **不进设置页**(设置极简判例):它是工程开关,不是产品选项。
 *
 * 关掉之后每一行都照旧完整 layout / paint —— 那正是 2026-08-19 之前的行为,
 * 用来做对照。
 */

const STORAGE_KEY = 'onething.rowSkipping'
const OVERRIDE_KEY = '__onethingRowSkippingOverride'

function readOverride(): boolean | undefined {
  return (globalThis as Record<string, unknown>)[OVERRIDE_KEY] as boolean | undefined
}

/** 默认**开**(生产上它已经开着一年半)。 */
export function isRowSkippingEnabled(): boolean {
  const override = readOverride()
  if (override !== undefined) return override
  try {
    if (globalThis.localStorage?.getItem(STORAGE_KEY) === 'off') return false
  } catch {
    // 隐私模式 / storage 被禁:当没设置过。
  }
  return true
}

/** 仅测试与现场把手。 */
export function setRowSkippingEnabled(enabled: boolean | undefined): void {
  if (enabled === undefined) delete (globalThis as Record<string, unknown>)[OVERRIDE_KEY]
  else (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = enabled
}

/**
 * 装现场把手:`window.__onethingRowSkipping.disable()` / `.enable()` / `.status()`。
 * 与 fold-tree 那个把手一样,**改完刷新页面**(类是渲染时读的)。
 */
export function installRowSkippingHandle(): void {
  try {
    ;(globalThis as { __onethingRowSkipping?: unknown }).__onethingRowSkipping = {
      status: () => ({ enabled: isRowSkippingEnabled() }),
      disable: () => {
        try {
          globalThis.localStorage?.setItem(STORAGE_KEY, 'off')
        } catch { /* ignore */ }
        setRowSkippingEnabled(false)
        return 'row skipping off — 刷新页面生效(每行都完整 layout/paint)'
      },
      enable: () => {
        try {
          globalThis.localStorage?.removeItem(STORAGE_KEY)
        } catch { /* ignore */ }
        setRowSkippingEnabled(undefined)
        return 'row skipping on'
      },
    }
  } catch {
    // 把手装不上不影响渲染。
  }
}
