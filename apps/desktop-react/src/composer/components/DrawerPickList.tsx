import type { MouseEvent } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import type { CommandSpec } from '../types'
import s from './Composer.module.css'

/**
 * @ 文件与 / 命令共用同一种行 —— 它们是同一件事的两种内容,不是两个控件。
 * 行上用 mousedown + preventDefault 而不是 click:点下去的那一瞬间输入框会失焦,
 * 而插入 chip 要靠那个还没散的光标(demo 同一判例)。
 *
 * ── 列表封顶之后多出来的一件事:把选中项滚进视野 ──────────────────────────
 * 限高(`.pickScroll`,token `--composer-drawer-max`)之前,「选中的那条在不在
 * 屏幕上」不是个问题 —— 抽屉有多长就长多长。限高之后,↑↓ 走到第 12 条时它就在
 * 视野外面了:键盘还在动,屏幕上却什么都没变,那是**比不限高更糟**的手感。
 *
 * 所以限高与滚入视野是**同一件事的两半**,不许只做前一半。滚这件事已经收进
 * `ui/a11y/list-selection` 的 `rowRef`(`block:'nearest'`,理由同上:已经在
 * 视野里的一动不动)。焦点仍然留在输入框里(行是 mousedown 拾取的,从不落焦),
 * 所以滚的是**元素**,不是焦点 —— roving 那一套没有被碰。
 *
 * ── 09-01 修:mouseenter 不再写选中位 ────────────────────────────────────
 * 从前每一行挂着 `onMouseEnter={() => onHover(i)}`,把键盘位直接交给鼠标。
 * 两个后果:①鼠标停在列表上时按 ↑↓,↵ 落在鼠标那一行而不是键盘那一行;
 * ②上面那段滚入视野把列表滚一段,**鼠标一动没动**却换了脚下的行,浏览器
 * 补一发 mouseenter,键盘位当场被拽走(二次污染)。
 * 现在 hover 纯由 CSS 的 `.pickRow:hover` / `.pickSel:hover` 画,一个 JS
 * 状态都不占;改选中位的只剩键盘与**点击**。法条见 CLAUDE.md 禁令区。
 * ──────────────────────────────────────────────────────────────────────
 */
interface Props {
  kind: 'files' | 'commands'
  files: string[]
  commands: CommandSpec[]
  index: number
  /** 下标 → 行 ref。由 `useListSelection` 交下来,滚入视野靠它认行。 */
  rowRef: (i: number) => (el: HTMLElement | null) => void
  onPick: (i: number) => void
}

export function DrawerPickList({ kind, files, commands, index, rowRef, onPick }: Props) {
  const t = useT()
  const len = kind === 'files' ? files.length : commands.length
  const hold = (i: number) => (e: MouseEvent) => {
    e.preventDefault()
    onPick(i)
  }

  return (
    <div className={s.pickScroll}>
      <div className={s.pickHead}>
        {t(kind === 'files' ? 'composer.headFiles' : 'composer.headCommands')}
      </div>
      {len === 0 && <div className={s.pickEmpty}>{t('composer.noMatch')}</div>}
      {kind === 'files'
        ? files.map((f, i) => (
            <ButtonBase
              key={f}
              ref={rowRef(i)}
              className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
              onMouseDown={hold(i)}
            >
              <span className={s.pickMono}>{f}</span>
              <span className={s.pickHint}>{i === index ? t('composer.hintFile') : ''}</span>
            </ButtonBase>
          ))
        : commands.map((c, i) => (
            <ButtonBase
              key={c.name}
              ref={rowRef(i)}
              className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
              onMouseDown={hold(i)}
            >
              <span className={s.pickMono}>{c.name}</span>
              <span>{c.desc}</span>
              <span className={s.pickHint}>{i === index ? t('composer.hintCommand') : ''}</span>
            </ButtonBase>
          ))}
    </div>
  )
}
