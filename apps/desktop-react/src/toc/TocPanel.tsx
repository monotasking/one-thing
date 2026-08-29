import { useEffect, useMemo, useRef } from 'react'
import { TOC_HOVER_MS } from '../components/motion'
import { useSessionsSource } from '../data/sessions-source'
import { useExposeStore } from '../expose/store'
import { useT } from '../i18n'
import { PianoKeys } from './PianoKeys'
import { useTocStore } from './store'
import { tocChapters, tocKeys } from './transitions'
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
 *
 * ── D1:素材接真数据 ────────────────────────────────────────────────────
 * 键来自当前会话的用户消息锚点(`sessions.getUserMarkers`),章来自
 * `sessions.getSegments`。**空态 = 这条 rail 整个不在场**:目录是「会话里有
 * 哪些段」,一条会话还没有段(新会话 / 后端还没推导出来)时,一条空的细边
 * 既没有可悬停的目标也没有可看的内容 —— 画一条出来只是在占位。
 *
 * ── D3:落点与键同源 ──────────────────────────────────────────────────
 * onPick 抛给 useChatToc,后者按 `data-message-id` 找锚点滚过去 —— 而键本身
 * 就是这条会话的用户消息锚点(`getUserMarkers` 的 id)。D1 那条「键的下标与
 * 页面上的锚点不同源」的尾巴就此收掉:两边说的是同一个 id。
 */
export function TocPanel({ currentIndex, onPick }: Props) {
  const t = useT()
  const open = useTocStore((st) => st.open)
  const hoverIndex = useTocStore((st) => st.hoverIndex)
  const openPanel = useTocStore((st) => st.openPanel)
  const closePanel = useTocStore((st) => st.closePanel)
  const hoverKey = useTocStore((st) => st.hoverKey)

  const sessionId = useExposeStore((st) => st.currentSessionId)
  const chapterSource = useSessionsSource((st) => st.chapters[sessionId])
  const markerSource = useSessionsSource((st) => st.markers[sessionId])
  const ensureChapters = useSessionsSource((st) => st.ensureChapters)
  const ensureMarkers = useSessionsSource((st) => st.ensureMarkers)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 目录的素材属于「当前会话」,所以换会话就重取一次(两个 ensure 自己幂等)。
  useEffect(() => {
    if (!sessionId) return
    void ensureChapters(sessionId)
    void ensureMarkers(sessionId)
  }, [sessionId, ensureChapters, ensureMarkers])

  const markers = useMemo(() => markerSource ?? [], [markerSource])
  const chapters = useMemo(
    () => tocChapters(chapterSource ?? [], markers),
    [chapterSource, markers],
  )
  const keys = useMemo(() => tocKeys(chapters, markers.length), [chapters, markers.length])
  const labels = useMemo(() => markers.map((marker) => marker.preview), [markers])

  // ⌘⇧O 已收编进 keymap 注册表('toc.toggle'),这里不再挂第二个 window keydown。

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

  // 空态:没有章、或者没有键 —— 两者缺一就没有目录可看,rail 整个不在场。
  if (chapters.length === 0 || keys.length === 0) return null

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
        chapters={chapters}
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
