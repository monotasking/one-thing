import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { PREVIEW_DELAY_MS } from '../motion'
import type { Placement } from '../../stage/types'

/**
 * 预览泡出现的**条件**,不是它长什么样:泡是「还没打开的东西给你的一眼」,
 * 所以已经看得见的项不该再出泡。判据只有一条「它还收在坞里吗」——
 * 去接管化之后会话总览也按这一条判,没有第二种瓦。
 * 延迟是 token 的镜像,所以这里用假时钟走完 PREVIEW_DELAY_MS 而不是真等 600ms。
 */
beforeEach(() => {
  vi.useFakeTimers()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 悬停坞里的那一块瓦,并把假时钟推过预览延迟。
 * 必须限定在坞条内 —— 同一块内容开在舞台/浮窗里时,那扇面也叫同一个名字。
 */
function hoverTile(name: string) {
  const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
  const tile = within(strip).getByLabelText(name)
  fireEvent.mouseEnter(tile.parentElement as HTMLElement)
  act(() => {
    vi.advanceTimersByTime(PREVIEW_DELAY_MS)
  })
}

function place(id: string, placement: Placement) {
  act(() => useStageStore.getState().openAs(id, placement))
}

describe('Dock 预览泡', () => {
  it('还收在坞里的:悬停到时长就出泡,内容走同一张 renderContent 表', () => {
    render(<AppShell />)
    hoverTile('文件')
    expect(document.querySelector('[data-preview="files"]')).toBeTruthy()
  })

  it('已经看得见的不出泡(打开着的东西不必再给一眼)', () => {
    render(<AppShell />)
    place('files', { kind: 'edge', side: 'right' })
    hoverTile('文件')
    expect(document.querySelector('[data-preview="files"]')).toBeNull()
    place('diff', { kind: 'stage' })
    hoverTile('改动')
    expect(document.querySelector('[data-preview="diff"]')).toBeNull()
  })

  it('会话总览照常出泡:它是普通瓦,判据仍是「还收在坞里吗」', () => {
    render(<AppShell />)
    hoverTile('会话总览')
    expect(document.querySelector('[data-preview="sessions"]')).toBeTruthy()
    place('sessions', { kind: 'stage' })
    hoverTile('会话总览')
    expect(document.querySelector('[data-preview="sessions"]')).toBeNull()
  })

  it('一次一个主角:泡出现时名字标签隐掉', () => {
    render(<AppShell />)
    hoverTile('文件')
    expect(document.querySelector('[data-preview="files"]')).toBeTruthy()
    // 标签是一段纯文本节点,泡里那句标题在 [data-preview] 里面;泡外不该再有第二处。
    const outside = Array.from(document.querySelectorAll('span')).filter(
      (el) => el.textContent === '文件' && !el.closest('[data-preview]'),
    )
    expect(outside).toHaveLength(0)
  })
})
