import type { MouseEvent } from 'react'
import { useT } from '../../i18n'
import type { CommandSpec } from '../types'
import s from './Composer.module.css'

/**
 * @ 文件与 / 命令共用同一种行 —— 它们是同一件事的两种内容,不是两个控件。
 * 行上用 mousedown + preventDefault 而不是 click:点下去的那一瞬间输入框会失焦,
 * 而插入 chip 要靠那个还没散的光标(demo 同一判例)。
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

  return (
    <>
      <div className={s.pickHead}>
        {t(kind === 'files' ? 'composer.headFiles' : 'composer.headCommands')}
      </div>
      {len === 0 && <div className={s.pickEmpty}>{t('composer.noMatch')}</div>}
      {kind === 'files'
        ? files.map((f, i) => (
            <button
              key={f}
              type="button"
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
              className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
              onMouseEnter={() => onHover(i)}
              onMouseDown={hold(i)}
            >
              <span className={s.pickMono}>{c.name}</span>
              <span>{c.desc}</span>
              <span className={s.pickHint}>{i === index ? t('composer.hintCommand') : ''}</span>
            </button>
          ))}
    </>
  )
}
