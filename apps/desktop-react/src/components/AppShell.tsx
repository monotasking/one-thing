import { useCallback, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useExposeStore } from '../expose/store'
import { ExposeOverlay } from '../expose/components/ExposeOverlay'
import { TopBar } from './TopBar'
import { ChatMock } from './ChatMock'
import { ComposerMock } from './ComposerMock'
import { Dock } from './Dock'
import { StageOverlay } from './StageOverlay'
import { PinnedPanel } from './PinnedPanel'
import { TocPanel } from '../toc/TocPanel'
import { useChatToc } from '../toc/useChatToc'
import { SCROLL_SETTLE_MS } from './motion'
import s from './AppShell.module.css'

export function AppShell() {
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const pinnedCount = useStageStore((st) => st.pinned.length)
  // L2 接线:总览开着时主区缩暗,总览层自己盖在上面。
  const exposeOpen = useExposeStore((st) => st.view.mode !== 'closed')

  // 聊天滚动容器只有一个 ref,两个消费者:Dock 降淡 与 TOC 当前键。
  const chatRef = useRef<HTMLDivElement>(null)
  const { currentIndex, flashIndex, syncFromScroll, pickTurn } = useChatToc(chatRef)

  // 滚动降淡:只在这里存一次,Dock 拿到的是结论而不是滚动事件。
  const [dimmed, setDimmed] = useState(false)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onScroll = useCallback(() => {
    setDimmed(true)
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => setDimmed(false), SCROLL_SETTLE_MS)
    // 聊天滚动 → 当前键跟随。两件事共用同一个滚动事件,不各挂各的监听。
    syncFromScroll()
  }, [syncFromScroll])

  const [peeking, setPeeking] = useState(false)
  const autohide = dockDisplay === 'autohide'

  return (
    <div className={s.shell}>
      <TopBar />

      <main className={exposeOpen ? `${s.main} ${s.mainDimmed}` : s.main}>
        <div className={s.center}>
          {/* 键列钉在聊天区(不含输入框)的右缘,所以定位参考系是这一层 */}
          <div className={s.chatArea}>
            <ChatMock scrollRef={chatRef} onScroll={onScroll} flashIndex={flashIndex} />
            <TocPanel currentIndex={currentIndex} onPick={pickTurn} />
          </div>
          <ComposerMock />
        </div>
        {pinnedCount > 0 && <PinnedPanel />}
      </main>

      <div className={autohide ? `${s.band} ${s.bandCollapsed}` : s.band}>
        {!autohide && <Dock dimmed={dimmed} />}
      </div>

      {autohide && (
        <>
          <div className={s.hotzone} onMouseEnter={() => setPeeking(true)} />
          <div
            className={peeking ? `${s.floating} ${s.floatingUp}` : s.floating}
            onMouseLeave={() => setPeeking(false)}
          >
            <Dock dimmed={dimmed} />
          </div>
        </>
      )}

      <StageOverlay />
      <ExposeOverlay />
    </div>
  )
}
