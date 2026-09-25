import { memo, useCallback, useEffect } from 'react'
import { useT } from '../../i18n'
import { terminalListQuery } from '../../data/terminal-source'
import { useQuery } from '../../data/kernel'
import { Button } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { ReferenceChip } from '../../references/ReferenceChip'
import type { ToolRowModel } from '../model/segments'
// 引用种类表:谁要查表谁保证表装好(`file` 那一种画这一行的位置 chip)。
import '../../references'
import s from './ToolCard.module.css'

/**
 * **一步的卡脚**(ACP A2-c,正本 `docs/design/acp-integration-2026-09.md` §3.8 工具卡段)。
 *
 * 工具自报的两格「去哪儿看」—— 碰过的位置(`locations`)与嵌着的终端(`terminalId`)——
 * 摆在那一行**下面**、抽屉**外面**:它们是这次调用的出口,不是它的结果,收起着也该点得到。
 * 两格都缺席(本地工具的常态)时整只组件画 `null`,一个 DOM 节点都不多。
 *
 * ── ① 生命周期 ─────────────────────────────────────────────────────────
 * | 时刻 | 形 |
 * | --- | --- |
 * | 挂载 | 跟着那一行:行 `hidden` 它也不画(收起的多步卡里只有活槽位那一行有脚) |
 * | 首载 | 有终端才订一格 `terminal.list` 并 `ensure()` 一次;没有终端零往返 |
 * | 数据到 | 结局落账那一帧两格才出现(它们只在结局上,见 `result.toolKind` 那段) |
 * | 换宿主 | 卡本身在消息里,消息换叶是整行重挂 —— 这里没有自己的宿主状态 |
 * | 卸载 | 退订 `terminal.list`;名单留在格子里(下一张卡先画旧的再对账) |
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 * | 态 | 位置 | 终端钮 |
 * | --- | --- | --- |
 * | empty | 不画 | 不画 |
 * | loading(名单还没回) | — | 可点(不知道 ≠ 不在;点了就是 attach,那边答) |
 * | ready 在名单里 | 每处一枚 `path:line` chip | 可点 |
 * | ready 不在名单里 | — | 灰(`aria-disabled`)+ 提示「这格终端已经关了」 |
 * | error(名单拉不到) | — | 同 loading:不拿一次失败的读数去禁一颗钮 |
 * | 超量(一次碰了 30 处) | 行内换行铺开,不截;位置是事实,截掉哪一处都是在替人挑 | — |
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * | 件 | rest / hover / focus / active | pending | disabled |
 * | --- | --- | --- | --- |
 * | 位置 chip | 全由 `ReferenceChip` 那一只画(与正文里的文件引用同一件) | 文件打开是同步的,无 | 无 |
 * | 终端钮 | `ui/Button` ghost·sm 的配方 | 无(摆出来是一句 `placeRef`) | `aria-disabled` + Tooltip,点击恒等 |
 */
export const ToolStepFoot = memo(function ToolStepFoot({ row }: { row: ToolRowModel }) {
  const locations = row.locations
  const terminalId = row.terminalId
  if (!locations?.length && !terminalId) return null
  return (
    <div className={s.foot} data-tool-foot={row.callId}>
      {locations?.map((location, index) => (
        <span
          // 同一处可能被报两次(不同行号):键带下标,顺序是 agent 报的顺序。
          key={`${location.path}:${location.line ?? ''}:${index}`}
          className={s.footLocation}
          data-tool-location={location.line === undefined ? location.path : `${location.path}:${location.line}`}
        >
          <ReferenceChip
            kindId="file"
            value={{ kind: 'fileRef', path: location.path, ...(location.line === undefined ? {} : { line: location.line }) }}
          />
        </span>
      ))}
      {terminalId && <OpenTerminalButton terminalId={terminalId} />}
    </div>
  )
})

/**
 * 「打开终端」。摆出来走终端启动瓦那一只 `revealTerminal`(已经在屏上就召唤、不在就摆),
 * 与 Dock 右键菜单点一行、设置页「去登录」同一个口。
 *
 * 它是**动态 import** 的:`terminal-launcher` 带着舞台与菜单一整串模块,而工具卡长在每一条
 * 消息里 —— 静态 import 会把那一串挂进消息流的模块图(也多一条环的机会)。点一下晚一拍
 * 不可见。
 */
function OpenTerminalButton({ terminalId }: { terminalId: string }) {
  const t = useT()
  const list = useQuery(terminalListQuery)
  // 名单没有常驻订阅(判词在 `terminal-source.ts`):这颗钮挂上来就是它要新鲜的那一刻。
  useEffect(() => {
    terminalListQuery.invalidate()
    void terminalListQuery.ensure()
  }, [])
  // 「不在」只由一份**到手的**名单说;没到 / 拉失败都不算(见状态表第二张)。
  const gone = list.data !== undefined && !list.data.some((info) => info.id === terminalId)

  const open = useCallback(() => {
    if (gone) return
    void import('../terminal-launcher').then((mod) => mod.revealTerminal(terminalId))
  }, [gone, terminalId])

  const button = (
    <Button
      className={gone ? s.footGone : undefined}
      data-tool-terminal={terminalId}
      aria-disabled={gone || undefined}
      onClick={open}
    >
      {t('chat.tool.openTerminal')}
    </Button>
  )
  // 灰着的那颗要说出为什么灰:`aria-disabled` 留在 Tab 序里,提示因此键盘也够得着。
  return gone ? <Tooltip content={t('chat.tool.terminalGone')}>{button}</Tooltip> : button
}
