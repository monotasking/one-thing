import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
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
 * 所以限高与滚入视野是**同一件事的两半**,不许只做前一半。
 * `block: 'nearest'` 而不是 'center':已经在视野里的选中项一动不动
 * (SearchPanel 的同一条判例),只有真的走出去了才滚最短的那一段。
 * 焦点仍然留在输入框里(行是 mousedown 拾取的,从不落焦),所以这里滚的是
 * **元素**,不是焦点 —— roving 那一套没有被碰。
 */
interface Props {
  kind: 'files' | 'commands'
  files: string[]
  commands: CommandSpec[]
  index: number
  onHover: (i: number) => void
  onPick: (i: number) => void
}

export function DrawerPickList({ kind, files, commands, index, onHover, onPick }: Props) {
  const t = useT()
  const len = kind === 'files' ? files.length : commands.length
  const hold = (i: number) => (e: MouseEvent) => {
    e.preventDefault()
    onPick(i)
  }

  /** 下标 → 行元素。行是按 index 画的,所以这张表跟着 index 就够了。 */
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    // `?.` 两处都是真的:换 kind 的那一帧 refs 还是上一份,而 jsdom 里
    // scrollIntoView 是 setup.ts 补的空实现 —— 两边都不该让一次选中崩掉抽屉。
    rowRefs.current[index]?.scrollIntoView?.({ block: 'nearest' })
  }, [index, kind, len])

  return (
    <div className={s.pickScroll}>
      <div className={s.pickHead}>
        {t(kind === 'files' ? 'composer.headFiles' : 'composer.headCommands')}
      </div>
      {len === 0 && <div className={s.pickEmpty}>{t('composer.noMatch')}</div>}
      {kind === 'files'
        ? files.map((f, i) => (
            <button
              key={f}
              type="button"
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
              onMouseEnter={() => onHover(i)}
              onMouseDown={hold(i)}
            >
              <span className={s.pickMono}>{f}</span>
              <span className={s.pickHint}>{i === index ? t('composer.hintFile') : ''}</span>
            </button>
          ))
        : commands.map((c, i) => (
            <button
              key={c.name}
              type="button"
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
              onMouseEnter={() => onHover(i)}
              onMouseDown={hold(i)}
            >
              <span className={s.pickMono}>{c.name}</span>
              <span>{c.desc}</span>
              <span className={s.pickHint}>{i === index ? t('composer.hintCommand') : ''}</span>
            </button>
          ))}
    </div>
  )
}
