import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { shouldRestoreReadingAnchor, useMessageScrollCoordinator } from '../useMessageScrollCoordinator'

describe('useMessageScrollCoordinator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  interface MutableScroller {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }

  function setupScroller() {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now())
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const scroller = {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 500,
    }

    const coordinator = useMessageScrollCoordinator({
      scroller: ref(scroller as HTMLElement),
      getSessionId: () => 'session-1',
      getMessageRowById: () => null,
    })

    return { coordinator, scroller: scroller as MutableScroller }
  }

  it('keeps semantic tail pinned through layout growth', () => {
    const { coordinator, scroller } = setupScroller()

    coordinator.setTail()
    expect(coordinator.isTail()).toBe(true)
    expect(scroller.scrollTop).toBe(500)

    scroller.scrollHeight = 1300
    coordinator.onLayoutChange()

    expect(scroller.scrollTop).toBe(800)
  })

  it('does not pin layout growth after tail mode is cleared', () => {
    const { coordinator, scroller } = setupScroller()

    coordinator.setTail()
    coordinator.clear()
    scroller.scrollHeight = 1300
    coordinator.onLayoutChange()

    expect(coordinator.isTail()).toBe(false)
    expect(scroller.scrollTop).toBe(500)
  })
})

describe('shouldRestoreReadingAnchor', () => {
  it('ignores the first observation — a baseline is not a change', () => {
    expect(shouldRestoreReadingAnchor(null, { width: 800, height: 600 })).toBe(false)
  })

  it('ignores height-only changes so tail / anchor / hold-top keep owning them', () => {
    expect(
      shouldRestoreReadingAnchor({ width: 800, height: 600 }, { width: 800, height: 900 }),
    ).toBe(false)
  })

  it('fires on width changes in both directions', () => {
    expect(
      shouldRestoreReadingAnchor({ width: 800, height: 600 }, { width: 640, height: 600 }),
    ).toBe(true)
    expect(
      shouldRestoreReadingAnchor({ width: 640, height: 600 }, { width: 900, height: 600 }),
    ).toBe(true)
  })

  it('treats sub-pixel jitter as no change', () => {
    expect(
      shouldRestoreReadingAnchor({ width: 800, height: 600 }, { width: 800.3, height: 600 }),
    ).toBe(false)
  })
})

describe('useMessageScrollCoordinator reading anchor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setupWithRows(initialScrollTop = 500) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now())
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const scroller = { scrollTop: initialScrollTop, scrollHeight: 5000, clientHeight: 500 }
    const rows: Record<string, { offsetTop: number }> = { 'm-1': { offsetTop: 480 } }
    let sessionId = 'session-1'

    const coordinator = useMessageScrollCoordinator({
      scroller: ref(scroller as unknown as HTMLElement),
      getSessionId: () => sessionId,
      getMessageRowById: (id: string) => (rows[id] as unknown as HTMLElement) ?? null,
    })

    return {
      coordinator,
      scroller,
      rows,
      setSessionId: (id: string) => { sessionId = id },
    }
  }

  it('restores the captured row to the same viewport offset after a reflow', () => {
    const { coordinator, scroller, rows } = setupWithRows(500)

    // 视口顶落在 m-1 内部 20px 处。
    coordinator.captureReadingAnchor({ messageId: 'm-1', offsetWithinMessage: 20 })

    // 变窄 → 上方消息重新换行长高 → 同一行被推到 900。
    rows['m-1'].offsetTop = 900
    expect(coordinator.restoreReadingAnchor()).toBe(true)
    expect(scroller.scrollTop).toBe(920)
  })

  it('does not capture or restore while tail owns the position', () => {
    const { coordinator, scroller, rows } = setupWithRows(500)

    coordinator.setTail()
    coordinator.captureReadingAnchor({ messageId: 'm-1', offsetWithinMessage: 20 })
    expect(coordinator.getReadingAnchor()).toBeNull()

    rows['m-1'].offsetTop = 900
    const before = scroller.scrollTop
    expect(coordinator.restoreReadingAnchor()).toBe(false)
    expect(scroller.scrollTop).toBe(before)
  })

  it('does not restore while an anchor (send / hold-top) is live', () => {
    const { coordinator, scroller, rows } = setupWithRows(500)

    coordinator.captureReadingAnchor({ messageId: 'm-1', offsetWithinMessage: 20 })
    coordinator.setAnchor('m-1', 0, 5000)
    scroller.scrollTop = 480

    rows['m-1'].offsetTop = 900
    expect(coordinator.restoreReadingAnchor()).toBe(false)
  })

  it('drops the anchor when the session changes', () => {
    const { coordinator, setSessionId } = setupWithRows(500)

    coordinator.captureReadingAnchor({ messageId: 'm-1', offsetWithinMessage: 20 })
    setSessionId('session-2')

    expect(coordinator.getReadingAnchor()).toBeNull()
    expect(coordinator.restoreReadingAnchor()).toBe(false)
  })

  it('is a no-op when the anchored row is gone', () => {
    const { coordinator, rows } = setupWithRows(500)

    coordinator.captureReadingAnchor({ messageId: 'm-1', offsetWithinMessage: 20 })
    delete rows['m-1']

    expect(coordinator.restoreReadingAnchor()).toBe(false)
  })

  it('clamps the restore target to the scrollable range', () => {
    const { coordinator, scroller, rows } = setupWithRows(4400)

    coordinator.captureReadingAnchor({ messageId: 'm-1', offsetWithinMessage: 20 })
    // 变宽 → 内容变矮,原目标越界。
    rows['m-1'].offsetTop = 4600
    scroller.scrollHeight = 4600
    coordinator.restoreReadingAnchor()

    expect(scroller.scrollTop).toBe(4100)
  })

  it('reports idle only when nothing else drives the position', () => {
    const { coordinator } = setupWithRows(500)

    expect(coordinator.isIdle()).toBe(true)
    coordinator.setTail()
    expect(coordinator.isIdle()).toBe(false)
    coordinator.clear()
    expect(coordinator.isIdle()).toBe(true)
  })
})
