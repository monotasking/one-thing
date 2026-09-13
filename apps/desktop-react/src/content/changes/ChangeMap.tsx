import { ButtonBase } from '../../ui/ButtonBase'
import type { CodeLine } from '../code/CodeLines'
import s from './ChangesPanel.module.css'

/**
 * **右缘的改动地图**(「改动」面整文件视图,正本 §3 的 ③-b)。
 *
 * 一条竖带,每个改动块一格,位置 = 那一块首行在整篇里的**比例**。它回答的是
 * 「这份文件改在哪几段、我此刻在哪一段」—— 一条五千行的文件滚到中间时,除了它
 * 没有别的东西说得出这句话。
 *
 * ── 它是**鼠标的路**,键盘的路是檐上那两颗钮 ────────────────────────────
 * 所以整条带子是**一颗**钮(`aria-hidden` + `tabIndex -1`),里面那些格子是纯装饰。
 * 反过来做——每一格一颗真钮——在一份两千处改动的文件上等于往 Tab 序里塞两千个
 * 停靠点,读屏念起来是一列没有名字的按钮;而同一件事檐上那两颗钮已经说得清清楚楚
 * (「上一处 / 下一处」+ 一句 `第 k 处,共 n 处`)。VS Code 的缩略图是同一条取舍。
 *
 * 点哪儿跳哪儿:按点击位置在带子里的比例找**最近的那一块**,不是按格子的命中区 ——
 * 两千处改动时格子只有半个像素高,按命中区点等于点不中。
 */
export interface ChangeMapProps {
  lines: readonly CodeLine[]
  /** 每个改动块首行的下标(`content/code/line-diff.ts` 算的那张表)。 */
  blocks: readonly number[]
  /** 此刻停在第几块(下标)。 */
  active: number
  onPick: (block: number) => void
}

export function ChangeMap({ lines, blocks, active, onPick }: ChangeMapProps) {
  if (blocks.length === 0 || lines.length === 0) return null

  return (
    <ButtonBase
      className={s.map}
      aria-hidden="true"
      tabIndex={-1}
      data-testid="changes-map"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        if (box.height <= 0) return
        const ratio = (event.clientY - box.top) / box.height
        onPick(nearestBlock(blocks, lines.length, ratio))
      }}
    >
      {blocks.map((at, index) => (
        <span
          key={at}
          className={markClass(lines[at]?.mark)}
          data-change-block={index}
          data-active={index === active ? 'true' : undefined}
          style={{ top: `${(at / lines.length) * 100}%` }}
        />
      ))}
    </ButtonBase>
  )
}

/** 比例 → 最近的那一块。 */
export function nearestBlock(
  blocks: readonly number[],
  total: number,
  ratio: number,
): number {
  const wanted = Math.max(0, Math.min(1, ratio)) * total
  let best = 0
  let bestGap = Number.POSITIVE_INFINITY
  for (let i = 0; i < blocks.length; i += 1) {
    const gap = Math.abs(blocks[i] - wanted)
    if (gap < bestGap) {
      bestGap = gap
      best = i
    }
  }
  return best
}

/** 一块的颜色按它**首行**的标记走:加是绿、删是红(混合块首行说了算)。 */
function markClass(mark: CodeLine['mark']): string {
  return `${s.mapTick} ${mark === 'del' ? s.mapDel : s.mapAdd}`
}
