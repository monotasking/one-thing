import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Real wheel input plus compositor frames, in the isolated recorded replay. */
export async function startManualFollowProbe(page, cdp, outDir, { thinkingScroll = false } = {}) {
  const dir = path.join(outDir, 'manual-scroll')
  mkdirSync(dir, { recursive: true })
  const viewport = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-stream"]')
    const r = el.getBoundingClientRect()
    window.__manualScroll = { frames: [], events: [], stopped: false }
    const snapshot = () => {
      const replay = window.__recordedReplay
      const state = window.__recordedSource.getState()
      const row = [...el.querySelectorAll('[data-message-id]')].find(row => row.dataset.messageId === state.activeMessageId)
      const thoughts = row ? [...row.querySelectorAll('[data-testid="chat-thought"]')] : []
      const thought = thoughts.at(-1)
      const box = thought?.getBoundingClientRect()
      return { epoch: performance.timeOrigin + performance.now(),
        replay: replay?.sourceTime, st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight,
        status: state.status, activeMessageId: state.activeMessageId,
        reasoningChars: replay?.reasoningChars, lastReasoningAt: replay?.lastReasoningAt,
        lastStreamType: replay?.lastStreamType, thoughtChars: thought?.textContent.length ?? 0,
        thoughtTop: box?.top, thoughtBottom: box?.bottom,
        thoughtVisible: !!box && box.bottom > r.top && box.top < r.bottom }
    }
    window.__manualEvent = (type, extra = {}) => {
      window.__manualScroll.events.push({ type, ...snapshot(), ...extra })
    }
    el.addEventListener('wheel', event => window.__manualEvent('wheel', {
      dy: event.deltaY, trusted: event.isTrusted,
    }), { passive: true })
    el.addEventListener('scroll', () => window.__manualEvent('scroll'), { passive: true })
    const ids = new WeakMap()
    let nextId = 1
    const tick = () => {
      if (window.__manualScroll.stopped) return
      const anchors = []
      for (const y of [r.top + 120, r.top + 330, r.top + 550]) {
        const hit = document.elementFromPoint(r.left + r.width / 2, y)
        const block = hit?.closest('p, pre, [data-tool-card], [data-prose]')
        if (!block || !el.contains(block)) continue
        if (!ids.has(block)) ids.set(block, nextId++)
        const box = block.getBoundingClientRect()
        anchors.push({ id: ids.get(block), top: box.top, bottom: box.bottom,
          chars: block.textContent.length, tag: block.tagName })
      }
      window.__manualScroll.frames.push({ ...snapshot(), anchors })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  const captures = []
  let captureError
  const onFrame = event => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    try {
      const file = `${String(captures.length).padStart(5, '0')}.jpg`
      writeFileSync(path.join(dir, file), Buffer.from(event.data, 'base64'))
      captures.push({ file, ...event.metadata })
    } catch (error) { captureError = error }
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80,
    maxWidth: 1280, maxHeight: 860, everyNthFrame: 3 })
  const schedule = thinkingScroll ? [
    { at: 5000, dy: -120, count: 4, gap: 100, name: 'live-small-up' },
    { at: 6000, dy: 600, count: 3, gap: 80, name: 'live-down' },
    { at: 8000, dy: -400, count: 3, gap: 80, name: 'live-medium-up' },
    { at: 9000, dy: 800, count: 3, gap: 80, name: 'live-medium-down' },
    { at: 11000, dy: -900, count: 4, gap: 70, name: 'live-fast-up' },
    { at: 12000, dy: 1600, count: 4, gap: 70, name: 'live-fast-down' },
    { at: 14000, dy: -150, count: 5, gap: 80, name: 'live-gentle-up' },
    { at: 15000, dy: 600, count: 4, gap: 80, name: 'live-gentle-down' },
  ] : [
    { at: 8000, dy: -120, count: 4, gap: 100, name: 'small-up' },
    { at: 12000, dy: -500, count: 4, gap: 120, name: 'read-thought-above' },
    { at: 18000, dy: 100, count: 3, gap: 100, name: 'small-down' },
    { at: 24000, dy: 400, count: 10, gap: 80, name: 'return-bottom' },
    { at: 30000, dy: -700, count: 6, gap: 70, name: 'leave-growing-tail' },
    { at: 38000, dy: 700, count: 6, gap: 70, name: 'return-to-tail' },
    { at: 44000, dy: -1600, count: 10, gap: 60, name: 'cross-history-up' },
    { at: 50000, dy: 1600, count: 10, gap: 60, name: 'cross-history-down' },
    { at: 58000, dy: -90, count: 6, gap: 100, name: 'gentle-up' },
    { at: 62000, dy: 90, count: 6, gap: 100, name: 'gentle-down' },
  ]
  const actions = (async () => {
    for (const action of schedule) {
      while (await page.evaluate(() => window.__recordedReplay.sourceTime) < action.at) await delay(50)
      await page.evaluate(action => window.__manualEvent('gesture', action), action)
      const x = viewport.left + viewport.width / 2
      const y = viewport.top + Math.min(350, viewport.height / 2)
      await page.mouse.move(x, y)
      for (let i = 0; i < action.count; i++) {
        await page.mouse.wheel(0, action.dy)
        await delay(action.gap)
      }
      console.log(`[manual-scroll] ${action.name}`)
    }
  })()
  return {
    async finish() {
      await actions
      await cdp.send('Page.stopScreencast')
      cdp.off('Page.screencastFrame', onFrame)
      const data = await page.evaluate(() => {
        window.__manualScroll.stopped = true
        return window.__manualScroll
      })
      writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ viewport, schedule, captures, ...data }))
      if (captureError) throw captureError
      console.log(`[manual-scroll] ${captures.length} compositor frames, ${data.frames.length} geometry samples`)
    },
  }
}
