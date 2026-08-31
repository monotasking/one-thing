import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '../../ui/Input'
import { useT } from '../../i18n'
import type { ViewerFile } from '../../data/viewer-source'
import { listNavigators, navigatorFor } from './registry'
import s from './FileViewer.module.css'

/**
 * **⌘L 跳转条 —— 跳转的唯一入口**(定稿)。
 *
 * 屏幕上它只是一条输入 + 几行候选,但它买到的是一条结构性质的东西:「跳到某处」
 * 在这台上永远是**同一件事、同一条路、同一套键**。行号、符号、检索命中、diff
 * 的上一处下一处 —— 它们的差别只在「这串字对应哪几行」,而那正是 navigator 的
 * 全部职责(registry.ts)。滚动、高亮当前行、关掉自己,统统归壳。
 *
 * ── 没接上的那几档**画出来**,不藏起来 ─────────────────────────────────────
 * 符号 `#` / 检索 `/` / diff `@` 三档已经在表里,但 `list` 缺席。输入它们的前缀时
 * 这里画一行灰的、写着「还没接上」——与「打开方式」那六档同一条诚实降级:
 * 藏起来的能力,接上那天没有人会去找它。
 *
 * 空输入时列出全部前缀当提示 —— 这条输入行没有别的地方能说出「还能怎么跳」。
 */
export function JumpBar({
  file,
  lineCount,
  onJump,
  onClose,
}: {
  file: ViewerFile
  lineCount: number
  onJump: (line: number) => void
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const navigators = listNavigators()

  const active = query ? navigatorFor(query) : undefined
  const candidates = useMemo(() => {
    if (!active?.list || !query) return []
    return active.list(query, { file, lineCount })
  }, [active, query, file, lineCount])

  // 一出现就把光标放进去 —— 用户刚按了 ⌘L,焦点跟着那一下走正是他要的结果
  // (同 FilesPanel 那条「绑定…」输入行的判例:回调 ref,不是 autoFocus)。
  const focusOnMount = useRef((node: HTMLDivElement | null) => {
    node?.querySelector('input')?.focus()
  }).current

  // Esc 关掉。它长在这一层而不是全局:跳转条开着时这一下属于它。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const first = candidates[0]

  return (
    <div className={s.jump} data-testid="viewer-jump-bar" ref={focusOnMount}>
      <Input
        size="sm"
        className={s.jumpInput}
        value={query}
        onValueChange={setQuery}
        aria-label={t('viewer.jumpLabel')}
        placeholder={t('viewer.jumpPlaceholder')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) onJump(first.line)
        }}
      />
      <ul className={s.jumpList} data-testid="viewer-jump-list">
        {!query &&
          navigators.map((navigator) => (
            <li key={navigator.id} className={s.jumpHint}>
              <span className={s.jumpSigil}>{navigator.sigil || '123'}</span>
              <span className={s.jumpLabel}>{t(navigator.labelKey)}</span>
              {!navigator.list && <span className={s.jumpSoon}>{t('files.openModeSoon')}</span>}
            </li>
          ))}
        {query && active && !active.list && (
          <li className={s.jumpHint} data-testid="viewer-jump-soon">
            <span className={s.jumpLabel}>{t(active.labelKey)}</span>
            <span className={s.jumpSoon}>{t('files.openModeSoon')}</span>
          </li>
        )}
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <button type="button" className={s.jumpRow} onClick={() => onJump(candidate.line)}>
              <span className={s.jumpLabel}>{candidate.label}</span>
              {candidate.hint && <span className={s.jumpSoon}>{candidate.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
