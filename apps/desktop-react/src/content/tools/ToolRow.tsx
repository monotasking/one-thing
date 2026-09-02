import { useCallback, useState } from 'react'
import { useT, type TFn } from '../../i18n'
import { resolveIcon } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { Tooltip } from '../../ui/Tooltip'
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

/**
 * 单发那张卡的**壳属性** —— 长相(类名 + 三个数据属性)只有这一个产地。
 *
 * 为什么把壳拆出来给别人用:一组只有一次调用时,**那张卡就是组自己那个元素**
 * (`ToolGroup`)—— 中间不许再套一层 div(「段只渲染一个元素、不加包裹层」),
 * 而组与卡必须是**同一个 DOM 节点**,第二次调用到达时 React 才是打补丁不是重挂
 * (09-01 P2:真机 t=6614 单卡整行消失换成组卡)。
 */
export function toolCardShell(row: ToolRowModel) {
  return {
    className: s.toolCard,
    'data-tool-status': row.status,
    'data-tool-tone': toolTone(row.status),
    // 节奏表的钩子(content/ChatStream.module.css):工具卡是**一件东西**,
    // 上下留白按物件档 --pr-obj,不按段距。
    'data-prose': 'object',
  } as const
}

/** A1:单发的那张卡(壳 + 身)。 */
export function ToolRow({ step, ctx }: { step: ToolStepModel; ctx: BlockCtx }) {
  return (
    <div {...toolCardShell(step.row)}>
      <ToolCardBody step={step} ctx={ctx} />
    </div>
  )
}

/** B2 清单里的一行(无卡壳)。 */
export function ToolStepRow({ step, ctx }: { step: ToolStepModel; ctx: BlockCtx }) {
  const { row } = step
  return (
    <div
      className={s.toolStep}
      data-tool-status={row.status}
      data-tool-tone={toolTone(row.status)}
      // 组里的行不是消息框的直接子项,这个属性对它们只是无害的多余标记。
      data-prose="object"
    >
      <ToolCardBody step={step} ctx={ctx} />
    </div>
  )
}

/** 壳里那一身:一行脸 + 拉开的抽屉。壳由谁画不一定,身永远是这一份。 */
export function ToolCardBody({ step, ctx }: { step: ToolStepModel; ctx: BlockCtx }) {
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
    <>
      {expandable ? (
        /* 一行工具是**结构件**(图标 · 名 · 摘要 · 右端读数,视觉本该定制)——
         * 三类判的第三类,皮肤留本地、清 UA 归 `ui/ButtonBase`。 */
        <ButtonBase className={s.head} onClick={toggle} aria-expanded={open}>
          <ToolRowFace t={t} row={row} tone={tone} />
        </ButtonBase>
      ) : (
        // 不能展开时**不画按钮**:一个按得动却什么也不发生的钮是「假按钮」,
        // 它比没有钮更费人 —— 焦点会停在它上面,读屏会念它可点。
        <div className={s.head}>
          <ToolRowFace t={t} row={row} tone={tone} />
        </div>
      )}
      {open && <ToolDrawer call={call} ctx={ctx} />}
    </>
  )
}

/** 一行的四格:图标 · 名 · 摘要 · 右端。两种形态共用。 */
function ToolRowFace({ t, row, tone }: { t: TFn; row: ToolRowModel; tone: ToolTone }) {
  const Icon = resolveIcon(row.icon)
  return (
    <>
      <Icon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
      {/* 全名走 `ui/Tooltip`(禁 native `title=`):行上画的是短名,长的那一句
        * (带参数的标题)在悬停时说。cloneElement 注入,不多包一层 DOM。 */}
      <Tooltip content={row.title}>
        <span className={s.toolName}>{row.name}</span>
      </Tooltip>
      {row.summary && <span className={s.toolSummary}>{row.summary}</span>}
      <span className={s.toolRight}>
        {/*
          * **这里不转圈**(09-02 批 6 兑现禁令)。判的是这一格算不算「状态栏」:
          * 不算 —— 它是一行工具自己的右端读数,长在聊天正文流里,不是壳的状态栏。
          * 而且这一格已经有**两个**产地在说同一件事:右端那句话在忙态下说
          * 「运行中」(ToolRightText 的第二支),行首那枚图标同时按
          * `[data-tool-tone='busy']` 呼吸成 accent。转圈是第三遍。
          */}
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
