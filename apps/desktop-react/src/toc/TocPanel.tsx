import { useEffect, useMemo, useRef } from 'react'
import { TOC_HOVER_MS } from '../components/motion'
import { CHAT_CHAPTERS, CHAT_TURNS } from '../data/chat-mock'
import { useT } from '../i18n'
import { PianoKeys } from './PianoKeys'
import { useTocStore } from './store'
import { tocKeys } from './transitions'
import s from './TocPanel.module.css'

interface Props {
  /** 视口内最近一条用户消息的下标 —— 由 useChatToc 从滚动位置投影出来 */
  currentIndex: number
  /** 点行 / 点键 = 跳到那条消息(滚动 + 落点高亮),动作归渲染层 */
  onPick: (index: number) => void
}

/**
 * 钢琴键会话目录的**接线层**:决定什么时候展开、什么时候收,以及键列钉在哪。
 * 行怎么画、几何怎么守,全在 PianoKeys(+ 它的 module.css 顶部那段不变式)。
 *
 * 展开的两个入口:
 * - 鼠标进入键列区域,停够 TOC_HOVER_MS(150ms)才长出来 —— 路过不算意图;
 *   移出整个 rail(展开后 rail 就是 panel 本身)立刻收。
 * - ⌘⇧O 开合。它是常驻监听:目录收着的时候也得能把它叫起来。
 */
export function TocPanel({ currentIndex, onPick }: Props) {
  const t = useT()
  const open = useTocStore((st) => st.open)
  const hoverIndex = useTocStore((st) => st.hoverIndex)
  const openPanel = useTocStore((st) => st.openPanel)
  const closePanel = useTocStore((st) => st.closePanel)
  const togglePanel = useTocStore((st) => st.togglePanel)
  const hoverKey = useTocStore((st) => st.hoverKey)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const keys = useMemo(() => tocKeys(CHAT_CHAPTERS, CHAT_TURNS.length), [])
  const labels = useMemo(() => CHAT_TURNS.map((turn) => turn.user), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'o') return
      e.preventDefault()
      togglePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel])

  // 卸载时把待发的展开定时器掐掉,免得组件没了还在 set。
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const armOpen = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => openPanel(), TOC_HOVER_MS)
  }

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    closePanel()
  }

  const pick = (index: number) => {
    cancel()
    onPick(index)
  }

  return (
    <nav
      className={s.rail}
      aria-label={t('toc.title')}
      data-testid="toc-rail"
      data-open={open ? 'true' : 'false'}
      onMouseEnter={armOpen}
      onMouseLeave={cancel}
    >
      <PianoKeys
        keys={keys}
        chapters={CHAT_CHAPTERS}
        labels={labels}
        open={open}
        currentIndex={currentIndex}
        hoverIndex={hoverIndex}
        onHover={hoverKey}
        onPick={pick}
      />
    </nav>
  )
}
