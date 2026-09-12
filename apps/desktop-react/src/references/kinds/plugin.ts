import { useEffect, useMemo } from 'react'
import { useCommandsSource, withoutBuiltinCollisions } from '../../data/commands-source'
import type { CommandEntry } from '../../data/commands-source'
import { matchCommands } from '../../composer/transitions'
import { registerReferenceKind } from '../registry'
import { commandDraft, commandRow } from './command'
import type { PickContext, PickResult, ReferenceKind } from '../kind'

/**
 * **插件命令**。`/` 抽屉里的第三组。
 *
 * ── 它**只有拾取与落稿两格** ──────────────────────────────────────────────
 * 一条插件命令发出去之后,气泡里它长得与内置命令一模一样(一枚不可点的药丸)——
 * 那是**命令**这一种的认出与呈现,不是插件自己的。所以这里没有 `parse` / `render`
 * / `open`:一种引用只登记它真正拥有的那几格,缺席不是疏漏。
 *
 * ── 懒拉一次、失败静默降级 ────────────────────────────────────────────────
 * 抽屉第一次开的时候才发;拉失败**不弹提示**(人此刻正在打字选命令,一条 toast
 * 只会挡住他要点的那一行),抽屉里于是只是没有「插件」那一组。所以它照实答
 * `ready` —— 静默降级的意思就是「没有取数态要说给抽屉听」。
 */
function usePluginCommands(ctx: PickContext): PickResult<CommandEntry> {
  const { active, query } = ctx
  const commands = useCommandsSource((st) => st.pluginCommands)
  const ensurePluginCommands = useCommandsSource((st) => st.ensurePluginCommands)
  useEffect(() => {
    if (!active) return
    void ensurePluginCommands()
  }, [active, ensurePluginCommands])
  const hits = useMemo(
    () => (active ? matchCommands(withoutBuiltinCollisions(commands), query) : []),
    [active, commands, query],
  )
  return { hits, status: 'ready' }
}

export const pluginCommandReferenceKind: ReferenceKind<CommandEntry, never> = {
  id: 'plugin',

  source: {
    trigger: '/',
    where: 'line-start',
    tokenChars: ':-',
    group: { key: 'composer.headPlugins' },
    hint: 'composer.hintCommand',
    useQuery: usePluginCommands,
    row: commandRow,
  },

  draft: commandDraft,
}

registerReferenceKind(pluginCommandReferenceKind, import.meta.hot)
