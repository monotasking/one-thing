import { StatusDot } from '../ui/StatusDot'
import { Tooltip } from '../ui/Tooltip'
import { useHomeDir } from '../data/home-dir'
import { renderTitleTip } from '../content/title-tip'
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
  // 家目录:一格宿主事实,拿到之前是 null = 不缩(判词在 `data/home-dir`)。
  const home = useHomeDir()
  const text = live?.text ?? fallback
  const body = (
    <span className={className} data-host-title={id}>
      {text}
      {/*
        未保存丸走 `ui/StatusDot`(09-02 批 8b 收编;批 8a 给它补了 `sm` 5px 那一档,
        与这里从前借 `--files-open-dot` 画的那颗**逐字同色同大小**)。
        外面这一格 span 只管**落位**(左边距 + 与文字的垂直对齐)——那是宿主檐的
        排版事实,不是「一枚状态点」的事实;它 inline-flex + 内容 flex:none,
        所以盒子逐像素等于那颗 5px 的丸本身。

        `data-testid` 落在**丸自己**身上(09-02 批 8c:`ui/StatusDot` 开了
        `HTMLAttributes` 透传)。批 8b 时它只能挂在外面这格落位上 —— 那件当时
        是封闭的四格,读到的是「落位」不是「那颗丸」;既有契约的两条断言只问
        「在不在」,所以挪到丸上逐字等价,而这一格落位仍是它该在的地方。
      */}
      {live?.dirty && (
        <span className={s.dirtySlot}>
          <StatusDot tone="warn" size="sm" data-testid="host-title-dirty" />
        </span>
      )}
    </span>
  )
  // 截断的标题配 Tooltip 全名(禁令区那条)。没有全名可说就不挂 —— 一个与
  // 屏幕上一模一样的提示只是噪音。提示一律走 ui/Tooltip,禁 native `title=`。
  //
  // **只读表,不猜**(09-13):这句提示是不是一条路径由产地说了算,檐这一侧
  // 只把它交给 `renderTitleTip`(判词在 `content/model/title-tip.ts`)。
  if (!live?.tip) return body
  return <Tooltip content={renderTitleTip(live.tip, home)}>{body}</Tooltip>
}

/**
 * 无障碍名(`aria-label`)用的那一份。它与屏幕上那句话同源,但**不带丸** ——
 * 一个装饰点不该被念出来;「未保存」这件事由查看器脚上那格读数负责说。
 */
export function useHostTitleText(id: string | null | undefined, fallback: string): string {
  const live = useLiveTitle(id)
  return live?.text ?? fallback
}
