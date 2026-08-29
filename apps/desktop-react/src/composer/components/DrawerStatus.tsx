import type { StatusState } from '../types'
import s from './Composer.module.css'

/**
 * 执行状态抽屉:上面是触发这次执行的那句话,下面是走到哪一步的流水。
 * 已走过的步子逐条留着(不是只显示当前步)—— 「它做了什么」和「它在做什么」
 * 是同一份账,收起来只是不看,不是没有。
 *
 * 这一批没有引擎:steps 与 stepIdx 全由 store 的 beginStatus / tickStatus 推,
 * 所以真接上引擎时,换的是产地,不是这个组件。
 */
export function DrawerStatus({ status }: { status: StatusState }) {
  const shown = status.steps.slice(0, status.stepIdx + 1)

  return (
    <div className={s.statusBody}>
      <div className={s.statusPrompt}>
        <span className={s.statusName}>{status.name}</span> {status.prompt}
      </div>
      {shown.map((step, i) => {
        const doing = i === status.stepIdx && status.running
        return (
          <div key={`${step.label}-${i}`} className={doing ? `${s.step} ${s.stepDoing}` : s.step}>
            <span className={s.stepLabel}>{step.label}</span>
            <span>
              {step.detail}
              {doing ? '…' : ' ✓'}
            </span>
          </div>
        )
      })}
    </div>
  )
}
