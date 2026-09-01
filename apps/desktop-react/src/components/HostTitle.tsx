import { Tooltip } from '../ui/Tooltip'
import { useLiveTitle } from '../stage/live-title'
import s from './HostTitle.module.css'

/**
 * 宿主檐上那格标题 —— **三个宿主共用一件**(浮窗 / 舞台 / 盖)。
 *
 * 它回答一句话:这条檐该写「这块面是什么」还是「它此刻在显示什么」。
 * 有活标题(`stage/live-title`)就写后者并挂一颗未保存丸;没有就写前者。
 * 判据在这里定一次 —— 三个宿主各写一遍必然分叉(而且第一个分叉出来的一定是
 * 那颗丸:它只在其中一处被记得)。
 *
 * 09-01 回炉判例:查看器摆进浮窗时自带一条檐,与浮窗檐上下叠着,两条 40px
 * 白占掉 520 高窗口的 15%。合檐的前提就是宿主檐说得出文件名。
 */
export function HostTitle({ id, fallback, className }: { id: string; fallback: string; className?: string }) {
  const live = useLiveTitle(id)
  const text = live?.text ?? fallback
  const body = (
    <span className={className} data-host-title={id}>
      {text}
      {live?.dirty && <span className={s.dot} data-testid="host-title-dirty" aria-hidden="true" />}
    </span>
  )
  // 截断的标题配 Tooltip 全名(禁令区那条)。没有全名可说就不挂 —— 一个与
  // 屏幕上一模一样的提示只是噪音。提示一律走 ui/Tooltip,禁 native `title=`。
  if (!live?.tip) return body
  return <Tooltip content={live.tip}>{body}</Tooltip>
}

/**
 * 无障碍名(`aria-label`)用的那一份。它与屏幕上那句话同源,但**不带丸** ——
 * 一个装饰点不该被念出来;「未保存」这件事由查看器脚上那格读数负责说。
 */
export function useHostTitleText(id: string | null | undefined, fallback: string): string {
  const live = useLiveTitle(id)
  return live?.text ?? fallback
}
