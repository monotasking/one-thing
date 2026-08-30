import { useCallback, useState } from 'react'
import { useT, type TFn } from '../../i18n'
import { resolveIcon } from '../../components/icons'
import { Spinner } from '../../ui/Spinner'
import type { BlockCtx } from '../blocks/registry'
import type { ToolOutcomeModel, ToolRowModel, ToolStepModel } from '../model/segments'
import { ToolDrawer } from './ToolDrawer'
import {
  EXPANDABLE_STATUSES,
  formatDuration,
  toolStatusLabel,
  toolTone,
  type ToolTone,
} from './status'
import s from './ToolRow.module.css'

/**
 * 状态三表住 `./status.ts`(纯模块,不吃 React)—— 检索段的纯模型层要读同一张
 * busy 表。这里原样再导出,所以既有的 `from './ToolRow'` 一个都不用改。
 */
export { formatDuration, toolStatusLabel, toolTone, type ToolTone } from './status'

/**
 * 工具行(A1 卡行 + V2 图标即状态 + C1 行内抽屉)。
 *
 * ── V2:状态长在**图标**上,不是长成一个词 ────────────────────────────
 * 六轮定稿把「✓ 完成」这类**打卡词**判了出局:一条做完的调用不需要一句话来宣布
 * 它做完了 —— 它做完了是常态,值得占一格字的是**它做出了什么**(读了多少行、
 * 改了几加几减、退出码几)。所以:
 *
 *   成功 = 图标常灰(text-2),右端是成果词;
 *   失败 = 图标 danger,右端是**后端说的那句原话**;
 *   运行中 = 图标 accent + 呼吸,右端 spinner + 那一档状态。
 *
 * 三态之外还有第四种:**认不出的状态**。后端哪天加一档新枚举,这里既不猜它是
 * 哪一态(灰、不呼吸),也不吞掉它(右端原样摆那个英文枚举)。
 *
 * ── 一个组件两种形态,不是两个组件 ────────────────────────────────────
 * A1 卡行(单发,有边有底)与 B2 清单行(组内,一行素的)画的是**同一件事**:
 * 图标态 + 名 + 摘要 + 右端。差别只在外面那层壳,所以它是一个 `variant`,不是
 * 复制一份 JSX —— 复制之后「右端该显示什么」这条规则就有两个产地了。
 */

/** A1:单发的那张卡。 */
export function ToolRow({ step, ctx }: { step: ToolStepModel; ctx: BlockCtx }) {
  return <ToolRowBody step={step} ctx={ctx} variant="card" />
}

/** B2 清单里的一行(无卡壳)。 */
export function ToolStepRow({ step, ctx }: { step: ToolStepModel; ctx: BlockCtx }) {
  return <ToolRowBody step={step} ctx={ctx} variant="step" />
}

function ToolRowBody({
  step,
  ctx,
  variant,
}: {
  step: ToolStepModel
  ctx: BlockCtx
  variant: 'card' | 'step'
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])

  const { row, call } = step
  const tone = toolTone(row.status)
  // 抽屉状态住组件本地,**不进模型**:「这一行现在是开着的」是这台屏幕此刻的事,
  // 不是这次调用的事实。进了模型,同一条消息在两个窗口里就得共享展开态。
  //
  // 只有收场了的调用能展开:运行中的行**详情还在长**,拉开它会看到一份随时被
  // 替换的半成品,而 presenter 的 detail 是按「结局」写的(§5.1)。等它收场再看。
  const expandable = EXPANDABLE_STATUSES.has(row.status)

  return (
    <div
      className={variant === 'card' ? s.toolCard : s.toolStep}
      data-tool-status={row.status}
      data-tool-tone={tone}
    >
      {expandable ? (
        <button type="button" className={s.head} onClick={toggle} aria-expanded={open}>
          <ToolRowFace t={t} row={row} tone={tone} />
        </button>
      ) : (
        // 不能展开时**不画按钮**:一个按得动却什么也不发生的钮是「假按钮」,
        // 它比没有钮更费人 —— 焦点会停在它上面,读屏会念它可点。
        <div className={s.head}>
          <ToolRowFace t={t} row={row} tone={tone} />
        </div>
      )}
      {open && <ToolDrawer call={call} ctx={ctx} />}
    </div>
  )
}

/** 一行的四格:图标 · 名 · 摘要 · 右端。两种形态共用。 */
function ToolRowFace({ t, row, tone }: { t: TFn; row: ToolRowModel; tone: ToolTone }) {
  const Icon = resolveIcon(row.icon)
  return (
    <>
      <Icon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.toolName} title={row.title}>
        {row.name}
      </span>
      {row.summary && <span className={s.toolSummary}>{row.summary}</span>}
      <span className={s.toolRight}>
        {tone === 'busy' && <Spinner size="sm" className={s.toolSpinner} />}
        <ToolRightText t={t} row={row} tone={tone} />
      </span>
    </>
  )
}

/**
 * 右端那一格的文案。
 *
 * 成功那一支**允许什么都不显示**:没有成果词、也没算出耗时时,右端就是空的。
 * 这正是「无打卡词」的意思 —— 宁可空着,不拿一句「已完成」去填。
 */
function ToolRightText({ t, row, tone }: { t: TFn; row: ToolRowModel; tone: ToolTone }) {
  if (tone === 'ok') {
    return (
      <>
        {row.outcome && <span className={s.toolOutcome}>{outcomeText(t, row.outcome)}</span>}
        {row.durationMs !== undefined && (
          <span className={s.toolDuration}>{formatDuration(t, row.durationMs)}</span>
        )}
      </>
    )
  }
  // 失败 / 运行中 / 认不出:成果词缺席时退到那一档状态的说法(认不出就是英文枚举)。
  const text = row.outcome ? outcomeText(t, row.outcome) : toolStatusLabel(t, row.status)
  return <span className={s.toolOutcome}>{text}</span>
}

/** 模型说的是「哪一句 + 变量」;翻译发生在这里,所以切语言当场生效。 */
export function outcomeText(t: TFn, outcome: ToolOutcomeModel): string {
  return 'text' in outcome ? outcome.text : t(outcome.key, outcome.vars)
}
