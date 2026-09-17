import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { MusicRadioState } from '@shared/ipc/music'
import { MUSIC_ARM_MOVE_MS, MUSIC_STOW_MS, MUSIC_SWAP_MS } from '../../../components/motion'
import type { MusicNowPlayingView, MusicProgrammeView } from '../../../data/music-source'
import { FocusScope } from '../../../focus/FocusScope'
import { focusTree } from '../../../focus/registry'
import { useStageStore } from '../../../stage/store'
import { FocusDispatchHarness } from '../../../test/focus-harness'
import { ARM_LENGTH, ARM_PIVOT, angleForProgress, progressForAngle } from '../scene-geometry'
import { TurntableScene } from '../TurntableScene'
import type { TurntableSceneProps } from '../TurntableScene'

/**
 * 唱机场景跨 DOM 的那几条(纯判据在 scene-geometry / scene-controller / pet-activity 三份单测):
 *  ① 拖唱头松手 → 恰好一次 seek,位置是指针那一点映射的进度;
 *  ② 拖到一半指针被收走 → 一发都不发,唱臂回到拖之前;
 *  ③ 唱头聚焦 ←/→ → 各一次 ±10s;
 *  ④ 换歌那一串跑着时唱头不接手;
 *  ⑤ 歌名变 → 跑那一串;卸载 → 计时器清零;
 *  ⑥ brief.starting 出现 + 节目单有匹配的 say → 黑豆开口。
 *
 * jsdom 里容器宽是 0,视口 = 原大不缩放,所以 client 坐标就是画布坐标。
 */

// jsdom 没有 PointerEvent:手搓一个带 button 与坐标的 MouseEvent,类型名仍是 pointer*
// (与 music-panel.test.tsx / pet-stage.test.tsx 同一条判词)。
const pointer = (type: string, x: number, y: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y })

const RAD = Math.PI / 180
function needleAt(progress: number) {
  const deg = angleForProgress(progress)
  return { deg, x: ARM_PIVOT.x - ARM_LENGTH * Math.sin(deg * RAD), y: ARM_PIVOT.y + ARM_LENGTH * Math.cos(deg * RAD) }
}

const PLAYING: MusicNowPlayingView = {
  playing: true,
  status: 'playing',
  title: '雨棚下 - 旧电扇',
  position: 40,
  duration: 200,
  queueLength: 1,
  currentIndex: 0,
}
const RADIO: MusicRadioState = { active: true, intent: '下雨天', programmeLength: 2, canResume: true }
const PROGRAMME: MusicProgrammeView = {
  entries: [
    { encryptedId: 'a', title: '慢车 - 林间录音', say: '第一条的话。' },
    { encryptedId: 'b', title: '潮汐表 - 北岸电台', say: '潮汐表。' },
  ],
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <FocusDispatchHarness />
          {children}
        </div>
      )}
    </FocusScope>
  )
}

function mount(props: Partial<TurntableSceneProps> = {}) {
  const onSeek = vi.fn()
  const base: TurntableSceneProps = {
    brief: RADIO,
    nowPlaying: PLAYING,
    programme: PROGRAMME,
    position: 40,
    onSeek,
    frames: null,
    ...props,
  }
  const view = render(
    <Shell>
      <TurntableScene {...base} />
    </Shell>,
  )
  const rerender = (next: Partial<TurntableSceneProps>) =>
    view.rerender(
      <Shell>
        <TurntableScene {...base} {...next} />
      </Shell>,
    )
  return { ...view, rerender, onSeek }
}

const grab = () => screen.getByTestId('music-arm')
const arm = () => grab().parentElement as HTMLElement
const scene = () => screen.getByTestId('music-turntable').firstElementChild as HTMLElement

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'],
  })
  useStageStore.setState({ locale: 'zh' })
})

afterEach(() => {
  cleanup()
  focusTree.reset()
  vi.useRealTimers()
})

describe('唱头:跳到这里', () => {
  it('拖到进度一半的地方松手 → 恰好一次 seek,拖动期间一发都不发', () => {
    const { onSeek } = mount()
    const target = needleAt(0.5)
    act(() => {
      grab().dispatchEvent(pointer('pointerdown', 400, 330))
    })
    expect(arm().dataset.dragging).toBe('true')
    act(() => {
      window.dispatchEvent(pointer('pointermove', 300, 300))
      window.dispatchEvent(pointer('pointermove', target.x, target.y))
    })
    expect(onSeek).not.toHaveBeenCalled()
    expect(Number.parseFloat(arm().style.getPropertyValue('--arm-drag-deg'))).toBeCloseTo(target.deg, 9)
    act(() => {
      window.dispatchEvent(pointer('pointerup', target.x, target.y))
    })
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(Math.round(progressForAngle(target.deg) * 200))
    expect(onSeek.mock.calls[0][0]).toBe(100)
    expect(arm().dataset.dragging).toBeUndefined()
    expect(arm().style.getPropertyValue('--arm-drag-deg')).toBe('')
  })

  it('拖到一半指针被收走 → 什么都不发,唱臂回到拖之前', () => {
    const { onSeek } = mount()
    const before = arm().style.getPropertyValue('--arm-deg')
    const target = needleAt(0.9)
    act(() => {
      grab().dispatchEvent(pointer('pointerdown', 400, 330))
      window.dispatchEvent(pointer('pointermove', target.x, target.y))
      window.dispatchEvent(pointer('pointercancel', target.x, target.y))
    })
    act(() => {
      window.dispatchEvent(pointer('pointerup', target.x, target.y))
    })
    expect(onSeek).not.toHaveBeenCalled()
    expect(arm().style.getPropertyValue('--arm-drag-deg')).toBe('')
    expect(arm().style.getPropertyValue('--arm-deg')).toBe(before)
  })

  it('聚焦 ←/→ 各一次 ±10s', () => {
    const { onSeek } = mount()
    expect(grab().getAttribute('role')).toBe('slider')
    expect(grab().getAttribute('aria-valuetext')).toBe('0:40 / 3:20')
    fireEvent.keyDown(grab(), { key: 'ArrowRight' })
    fireEvent.keyDown(grab(), { key: 'ArrowLeft' })
    fireEvent.keyDown(grab(), { key: 'ArrowUp' })
    expect(onSeek.mock.calls).toEqual([[50], [30]])
  })

  it('不知道总长 → 不接拖也不接键盘', () => {
    const { onSeek } = mount({ nowPlaying: { ...PLAYING, duration: undefined } })
    expect(grab().getAttribute('aria-disabled')).toBe('true')
    act(() => {
      grab().dispatchEvent(pointer('pointerdown', 400, 330))
      window.dispatchEvent(pointer('pointerup', 300, 300))
    })
    fireEvent.keyDown(grab(), { key: 'ArrowRight' })
    expect(onSeek).not.toHaveBeenCalled()
  })
})

describe('换歌那一串', () => {
  it('歌名变 → 归位、收片、换封套、放片;跑着时唱头不接手;卸载清掉全部计时器', () => {
    const { rerender, onSeek, unmount } = mount()
    const sleeve = () => screen.getByTestId('music-scene-sleeve')
    expect(sleeve().dataset.title).toBe(PLAYING.title)
    expect(scene().dataset.disc).toBe('on')

    rerender({ nowPlaying: { ...PLAYING, title: '慢车 - 林间录音', position: 0 }, position: 0 })
    expect(scene().dataset.busy).toBe('true')
    expect(arm().dataset.seekable).toBeUndefined()
    expect(arm().dataset.motion).toBe('move')

    // 跑着时拖唱头:什么都不发生
    act(() => {
      grab().dispatchEvent(pointer('pointerdown', 400, 330))
      window.dispatchEvent(pointer('pointerup', 300, 300))
    })
    fireEvent.keyDown(grab(), { key: 'ArrowRight' })
    expect(onSeek).not.toHaveBeenCalled()
    expect(arm().dataset.dragging).toBeUndefined()

    act(() => void vi.advanceTimersByTime(MUSIC_ARM_MOVE_MS))
    expect(scene().dataset.disc).toBe('stowed')
    act(() => void vi.advanceTimersByTime(MUSIC_STOW_MS))
    expect(scene().dataset.sleeve).toBe('out')
    act(() => void vi.advanceTimersByTime(MUSIC_SWAP_MS / 2))
    expect(sleeve().dataset.title).toBe('慢车 - 林间录音')
    act(() => void vi.advanceTimersByTime(MUSIC_SWAP_MS / 2 + MUSIC_STOW_MS))
    expect(scene().dataset.disc).toBe('on')
    expect(scene().dataset.busy).toBeUndefined()
    expect(arm().dataset.seekable).toBe('true')

    // 又换一首,跑到一半卸载
    rerender({ nowPlaying: { ...PLAYING, title: '潮汐表 - 北岸电台', position: 0 }, position: 0 })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('黑豆', () => {
  const bubble = () => screen.getByTestId('pet-bubble')

  it('brief.starting 出现 + 节目单有匹配的 say → 一句开口', () => {
    const { rerender } = mount()
    expect(bubble().dataset.show).toBeUndefined()
    rerender({ brief: { ...RADIO, starting: '潮汐表 - 北岸电台' } })
    expect(bubble().dataset.show).toBe('true')
    expect(bubble().dataset.mode).toBe('speak')
    expect(bubble().textContent).toContain('潮汐表。')
  })

  it('挂载时就带着的 starting 不算「出现」;匹配那条没有 say → 不说', () => {
    const { rerender } = mount({ brief: { ...RADIO, starting: '慢车 - 林间录音' } })
    expect(bubble().dataset.show).toBeUndefined()
    rerender({
      brief: { ...RADIO, starting: '十二楼的风' },
      programme: { entries: [...PROGRAMME.entries, { encryptedId: 'c', title: '十二楼的风' }] },
    })
    expect(bubble().dataset.show).toBeUndefined()
  })

  it('读数到了才挂栖位;挑歌时唱片堆翘起来,关台时屋里暗', () => {
    const { rerender } = mount({ nowPlaying: undefined })
    expect(screen.queryByTestId('pet-stage')).toBeNull()
    rerender({ nowPlaying: { ...PLAYING, playing: false, status: 'stopped', title: undefined }, programme: { entries: [] } })
    expect(screen.getByTestId('pet-stage')).toBeTruthy()
    expect(screen.getByTestId('pet-button').dataset.pose).toBe('busy')
    expect(screen.getByTestId('music-turntable').querySelector('[data-show="true"]')).toBeTruthy()
    rerender({
      brief: { ...RADIO, active: false },
      nowPlaying: { ...PLAYING, playing: false, status: 'stopped', title: undefined },
    })
    expect(screen.getByTestId('music-turntable').dataset.room).toBe('dim')
    expect(screen.getByTestId('pet-button').dataset.pose).toBe('sleeping')
  })
})
