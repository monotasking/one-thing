import { useEffect, useMemo, useRef } from 'react'
import { TOC_HOVER_MS } from '../components/motion'
import { whenFirstScreen } from '../data/first-screen'
import { useSessionChapters, useSessionMarkers, useSessionsSource } from '../data/sessions-source'
import { useT } from '../i18n'
import { PianoKeys } from './PianoKeys'
import { selectToc, useTocStore } from './store'
import { tocChapters, tocKeys } from './transitions'
import s from './TocPanel.module.css'

interface Props {
  /**
   * 这条 rail 说的是哪条会话的目录(W5-a:由摆它的那片叶给)。
   * 展开态也按它记(见 `toc/store.ts`)—— 两片会话叶各展各的。
   */
  sessionId: string
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
export function TocPanel({ sessionId, currentIndex, onPick }: Props) {
  const t = useT()
  const { open, hoverIndex } = useTocStore(selectToc(sessionId))
  const openPanel = useTocStore((st) => st.openPanel)
  const closePanel = useTocStore((st) => st.closePanel)
  const hoverKey = useTocStore((st) => st.hoverKey)

  /*
   * 两族各订一格(键 = 这条会话)。这里只用得着 `data` —— 目录的空态是
   * 「rail 整个不在场」,没有骨架也没有错误行,所以 `phase` / `inflight`
   * 在这块面上没有落点(判据表见 data/sessions-source.ts 文件头 ②)。
   */
  const chapterSource = useSessionChapters(sessionId).data
  const markerSource = useSessionMarkers(sessionId).data
  const ensureChapters = useSessionsSource((st) => st.ensureChapters)
  const ensureMarkers = useSessionsSource((st) => st.ensureMarkers)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /*
   * 目录的素材属于「当前会话」,所以换会话就重取一次(两个 ensure 自己幂等)。
   *
   * ── 为什么排在空闲里(2026-09-10 工单 5 ⑧)────────────────────────────
   * `getUserMarkers` 要的是**整条会话的用户消息锚点** —— 后端拿不到它的捷径:
   * 那份名单只有把整份账本折一遍才数得出来。真店夹具(50.8MB / 400 条)上单独
   * 量:**900ms**(交出去的只有 30KB —— 贵的不是字节是那一折)。
   *
   * 而 core 是单线程的:这一折跑起来,聊天区那一页(`resources.read(page)`,
   * 单独量 **59ms**)就排在它后面 —— 冷载首屏因此被拖到 1142ms,其中九成不是
   * 首屏自己的活。
   *
   * 所以这里改的是**时机**不是内容:rail 的素材照旧取、取的还是那一份,只是
   * 让出第一屏那一拍。目录是「看完这一屏之后才会用到的东西」,晚一个空闲周期
   * 出现在屏幕上,与 `ChatStream` 那条「空闲往前补一批」是同一条纪律。
   *
   * ── 光排进空闲**不够**(2026-09-10 工单 6 ①)────────────────────────────
   * 上面那一段写完之后真机仍然量到 ③ 偶发 989ms。病根:`requestIdleCallback`
   * 管得住「什么时候发」,管不住「core 那边排在谁后面」—— 页那一发在飞的时候
   * 主线程正好是**空的**(它在等网络),于是空闲回调准时开火,两发一起挤进 core
   * 的单线程队列,而这一发要把整份账本折一遍。
   *
   * 所以要等的是**页回来了**(`whenFirstScreen`),不是**这一帧闲了**;两件事
   * 都要:先让路(次序),再排空闲(不抢首屏那几帧的排版)。
   */
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let handle: number | undefined
    let idleHandle: number | undefined
    const run = () => {
      if (cancelled) return
      void ensureChapters(sessionId)
      void ensureMarkers(sessionId)
    }
    void whenFirstScreen(sessionId).then(() => {
      if (cancelled) return
      // `requestIdleCallback` 在 jsdom / 老 Safari 上缺席 —— 退到一发宏任务,
      // 它同样排在这一帧的提交之后(判词与 `ChatStream` 的空闲扩窗同源)。
      const idle = (window as IdleWindow).requestIdleCallback
      if (typeof idle === 'function') idleHandle = idle(run)
      else handle = window.setTimeout(run, 0)
    })
    return () => {
      cancelled = true
      if (idleHandle !== undefined) (window as IdleWindow).cancelIdleCallback?.(idleHandle)
      if (handle !== undefined) window.clearTimeout(handle)
    }
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
    timer.current = setTimeout(() => openPanel(sessionId), TOC_HOVER_MS)
  }

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    closePanel(sessionId)
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
        onHover={(index) => hoverKey(sessionId, index)}
        onPick={pick}
      />
    </nav>
  )
}

/**
 * `requestIdleCallback` 在 TS 的 DOM 库里是可选的(jsdom / 老 Safari 没有)。
 * 与 `content/ChatStream.tsx` 里那一份逐字相同 —— 它是 TS lib 的一处缺口,
 * 不是一件有主人的东西,所以两处各声明各的比让 toc/ 去引 content/ 干净。
 */
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void) => number
  cancelIdleCallback?: (handle: number) => void
}
