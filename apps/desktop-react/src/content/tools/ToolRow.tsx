import { useT, type MessageKey, type TFn } from '../../i18n'
import { resolveIcon } from '../../components/icons'
import type { ToolRowModel } from '../model/segments'
import s from './ToolRow.module.css'

/**
 * 工具卡行(A1)。
 *
 * P0 的画法是从 ChatStream **逐字搬过来的**:图标 + mono 工具名 + 状态文案,
 * 一行。V2 的图标即状态(成功常灰 / 失败红 / 运行中紫呼吸)与右端成果词是 P2 ——
 * 模型上那两格(`summary` / `outcome`)已经留好,但今天没有 presenter 产得出来,
 * 所以这里也不画:P0 的纪律是可感知行为零变化。
 *
 * 组件读的是 `ToolRowModel`,不是 `ProjectedToolCall` —— 中间隔着 presenter 表。
 * 这一层隔断买到的是:换一个工具的展示方式,只写一个 presenter 文件,
 * 这个组件一行不动。
 */
export function ToolRow({ row }: { row: ToolRowModel }) {
  const t = useT()
  const Icon = resolveIcon(row.icon)

  return (
    <div className={s.toolCard} data-tool-status={row.status}>
      <Icon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.toolName}>{row.name}</span>
      <span className={s.toolStatus}>{toolStatusLabel(t, row.status)}</span>
    </div>
  )
}

/**
 * 工具状态:**后端枚举 → 字典键**的一张明表。
 *
 * 不用 `` `chat.tool.${status}` as MessageKey `` 拼键 —— 那个断言会骗过类型检查,
 * 后端哪天加一档新状态就在运行时炸(`format` 拿到 undefined)。列成表之后,
 * 认不出来的状态**原样显示那个英文枚举**:那是事实,而编一句中文是猜。
 */
const TOOL_STATUS_KEYS: Record<string, MessageKey> = {
  pending: 'chat.tool.pending',
  queued: 'chat.tool.queued',
  received: 'chat.tool.received',
  executing: 'chat.tool.executing',
  completed: 'chat.tool.completed',
  failed: 'chat.tool.failed',
  cancelled: 'chat.tool.cancelled',
  'input-streaming': 'chat.tool.inputStreaming',
}

export function toolStatusLabel(t: TFn, status: string): string {
  const key = TOOL_STATUS_KEYS[status]
  return key ? t(key) : status
}
