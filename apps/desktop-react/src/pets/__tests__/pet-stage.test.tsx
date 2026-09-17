import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { zh } from '../../i18n/zh'
import { useStageStore } from '../../stage/store'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { HEIDOU } from '../builtin/heidou'
import type { ReactionGroup } from '../manifest'
import { STILL_DOZE_MS } from '../pose'
import { PetStage } from '../PetStage'
import type { PetStageProps } from '../PetStage'

/**
 * 栖位的用例。判的是 §7 三张表里**跨 DOM 的那几条**(纯判据在 pose / bubble 两份单测里):
 *  ① 点一下 → 嘀咕气泡 + onGesture;开口中点一下不换气泡;
 *  ② 撸 → 撸姿势,松手 → stroked 嘀咕 + onGesture;
 *  ③ 选项:亮出来第一颗拿焦点,点选项 → onChoice(value),Esc → onChoice(null);
 *  ④ still 满 9s 进打盹,被叫醒 startle + woke;off → 任何播 wake;
 *  ⑤ 卸载清全部计时器。
 */

// jsdom 没有 PointerEvent:手搓一个带 button 与坐标的 MouseEvent,类型名仍是 pointer*
// (与 content/__tests__/music-panel.test.tsx 同一条判词)。
const pointer = (type: string, x: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: 0 })

function linesOf(group: ReactionGroup): string[] {
  return HEIDOU.mutters[group].map((line) => zh[line.key])
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

function mount(props: Partial<PetStageProps> = {}) {
  const base: PetStageProps = { manifest: HEIDOU, activity: { kind: 'rhythm', bpm: 90 }, size: 'stage', ...props }
  const view = render(
    <Shell>
      <PetStage {...base} />
    </Shell>,
  )
  const rerender = (next: Partial<PetStageProps>) =>
    view.rerender(
      <Shell>
        <PetStage {...base} {...next} />
      </Shell>,
    )
  return { ...view, rerender }
}

const petButton = () => screen.getByTestId('pet-button')
const bubble = () => screen.getByTestId('pet-bubble')
const bubbleText = () => screen.queryByTestId('pet-bubble-text')?.textContent ?? ''

function poke() {
  const button = petButton()
  act(() => {
    button.dispatchEvent(pointer('pointerdown', 50))
    window.dispatchEvent(pointer('pointermove', 53))
    window.dispatchEvent(pointer('pointerup', 53))
  })
}

/** 一次性动画的重播要等一帧(先撤后给),所以 rAF 也得归假时钟管。 */
function nextFrame() {
  act(() => void vi.advanceTimersToNextFrame())
}

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

describe('点一下(§7.3)', () => {
  it('松手位移 < 8px → 压一下 + 按活动嘀咕 + onGesture(poke)', () => {
    const onGesture = vi.fn()
    mount({ onGesture })
    poke()
    expect(onGesture).toHaveBeenCalledWith({ kind: 'poke' })
    expect(bubble().dataset.show).toBe('true')
    expect(bubble().dataset.mode).toBe('mutter')
    expect(linesOf('poked')).toContain(bubbleText())
    nextFrame()
    expect(screen.getByTestId('pet-rig').dataset.oneShot).toBe('squish')
    // 嘀咕停留 1.4s(台词表指定)之后收起
    act(() => void vi.advanceTimersByTime(1400))
    expect(bubble().dataset.show).toBeUndefined()
  })

  it('开口中点一下:只抖耳朵,不换气泡', () => {
    const onGesture = vi.fn()
    const { rerender } = mount({ onGesture })
    rerender({ onGesture, utterance: { mode: 'speak', text: '雨还没停。这首我替你开大了一点。' } })
    act(() => void vi.advanceTimersByTime(600))
    const before = bubbleText()
    expect(before.length).toBeGreaterThan(0)
    expect(petButton().dataset.pose).toBe('speaking')
    poke()
    expect(onGesture).toHaveBeenCalledWith({ kind: 'poke' })
    expect(bubble().dataset.mode).toBe('speak')
    expect(bubbleText().startsWith(before)).toBe(true)
    nextFrame()
    expect(screen.getByTestId('pet-rig').dataset.oneShot).toBe('twitch')
  })

  it('8–90px 之间松手什么都不发生', () => {
    const onGesture = vi.fn()
    mount({ onGesture })
    act(() => {
      petButton().dispatchEvent(pointer('pointerdown', 0))
      window.dispatchEvent(pointer('pointermove', 40))
      window.dispatchEvent(pointer('pointerup', 40))
    })
    expect(onGesture).not.toHaveBeenCalled()
    expect(bubble().dataset.show).toBeUndefined()
  })

  it('4s 内第 5 次点 → annoyed', () => {
    mount()
    for (let i = 0; i < 4; i += 1) {
      poke()
      act(() => void vi.advanceTimersByTime(500))
    }
    poke()
    expect(bubbleText()).toBe(linesOf('annoyed')[0])
  })

  it('键盘 Enter / Space(按钮合成的 click,detail = 0)等同点', () => {
    const onGesture = vi.fn()
    mount({ onGesture, activity: 'off' })
    fireEvent.click(petButton(), { detail: 0 })
    expect(onGesture).toHaveBeenCalledWith({ kind: 'poke' })
    expect(linesOf('sleepy')).toContain(bubbleText())
  })
})

describe('撸(§7.3)', () => {
  it('按住累计 > 90px 进撸姿势、嘀咕收起;松手 → stroked + onGesture(stroke)', () => {
    const onGesture = vi.fn()
    mount({ onGesture })
    poke()
    expect(bubble().dataset.show).toBe('true')
    act(() => {
      petButton().dispatchEvent(pointer('pointerdown', 0))
      window.dispatchEvent(pointer('pointermove', 60))
      window.dispatchEvent(pointer('pointermove', 0))
    })
    expect(petButton().dataset.pose).toBe('petted')
    expect(bubble().dataset.show).toBeUndefined()
    act(() => void window.dispatchEvent(pointer('pointerup', 0)))
    expect(onGesture).toHaveBeenLastCalledWith({ kind: 'stroke' })
    expect(petButton().dataset.pose).toBe('grooving')
    expect(bubbleText()).toBe(linesOf('stroked')[0])
  })

  it('撸到一半来了开口:撸结束,松手不再嘀咕', () => {
    const onGesture = vi.fn()
    const { rerender } = mount({ onGesture })
    act(() => {
      petButton().dispatchEvent(pointer('pointerdown', 0))
      window.dispatchEvent(pointer('pointermove', 100))
    })
    expect(petButton().dataset.pose).toBe('petted')
    rerender({ onGesture, utterance: { mode: 'speak', text: '醒了醒了。' } })
    expect(petButton().dataset.pose).toBe('speaking')
    act(() => void window.dispatchEvent(pointer('pointerup', 100)))
    expect(bubble().dataset.mode).toBe('speak')
    expect(onGesture).not.toHaveBeenCalled()
  })
})

describe('选项(§7.3 末行 / §7.4)', () => {
  const ask = {
    mode: 'speak' as const,
    text: '换个方向？',
    choices: [
      { value: 'fast', label: '来点快的' },
      { value: 'quiet', label: '安静点' },
    ],
  }

  it('出完字亮选项、第一颗拿焦点;点选项 → onChoice(value),气泡收起,焦点回宠物', () => {
    const onChoice = vi.fn()
    const onSpeakingChange = vi.fn()
    const { rerender } = mount({ onChoice, onSpeakingChange })
    rerender({ onChoice, onSpeakingChange, utterance: ask })
    expect(onSpeakingChange).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: '来点快的' })).toBeNull()
    act(() => void vi.advanceTimersByTime(3000))
    expect(onSpeakingChange).toHaveBeenLastCalledWith(false)
    const first = screen.getByRole('button', { name: '来点快的' })
    expect(document.activeElement).toBe(first)
    // 选项在等人:停留计时器不收它
    act(() => void vi.advanceTimersByTime(10_000))
    fireEvent.click(screen.getByRole('button', { name: '安静点' }))
    expect(onChoice).toHaveBeenCalledWith('quiet')
    expect(bubble().dataset.show).toBeUndefined()
    expect(screen.queryByRole('button', { name: '安静点' })).toBeNull()
    expect(document.activeElement).toBe(petButton())
  })

  it('Esc = 不选 → onChoice(null)', () => {
    const onChoice = vi.fn()
    const { rerender } = mount({ onChoice })
    rerender({ onChoice, utterance: ask })
    act(() => void vi.advanceTimersByTime(3000))
    const first = screen.getByRole('button', { name: '来点快的' })
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(onChoice).toHaveBeenCalledWith(null)
    expect(bubble().dataset.show).toBeUndefined()
  })

  it('选项在等时点一下:压一下,但不拿嘀咕把选项顶掉', () => {
    const { rerender } = mount()
    rerender({ utterance: ask })
    act(() => void vi.advanceTimersByTime(3000))
    poke()
    expect(screen.getByRole('button', { name: '来点快的' })).toBeTruthy()
    expect(bubbleText()).toBe(ask.text)
  })
})

describe('活动与计时(§7.1)', () => {
  it('still 满 9s 进打盹;被叫回 rhythm 播 startle 并嘀咕 woke', () => {
    const { rerender } = mount({ activity: 'still' })
    expect(petButton().dataset.pose).toBe('sitting')
    act(() => void vi.advanceTimersByTime(STILL_DOZE_MS - 1))
    expect(petButton().dataset.pose).toBe('sitting')
    act(() => void vi.advanceTimersByTime(1))
    expect(petButton().dataset.pose).toBe('dozing')
    rerender({ activity: { kind: 'rhythm', bpm: 104 } })
    expect(petButton().dataset.pose).toBe('grooving')
    nextFrame()
    expect(screen.getByTestId('pet-rig').dataset.oneShot).toBe('startle')
    expect(bubbleText()).toBe(linesOf('woke')[0])
  })

  it('挂载不播 wake;off → 任何播 wake', () => {
    const { rerender } = mount({ activity: 'off' })
    expect(screen.getByTestId('pet-rig').dataset.oneShot).toBeUndefined()
    expect(petButton().dataset.pose).toBe('sleeping')
    rerender({ activity: 'idle' })
    nextFrame()
    expect(screen.getByTestId('pet-rig').dataset.oneShot).toBe('wake')
  })

  it('挂载时带着的话语不算新话语', () => {
    mount({ utterance: { mode: 'mutter', text: '早就在这儿了' } })
    expect(bubble().dataset.show).toBeUndefined()
  })

  it('卸载清全部计时器', () => {
    const onSpeakingChange = vi.fn()
    const { rerender, unmount } = mount({ activity: 'still', onSpeakingChange })
    rerender({ activity: 'still', onSpeakingChange, utterance: { mode: 'speak', text: '一句很长很长的话' } })
    act(() => void vi.advanceTimersByTime(400))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(onSpeakingChange).toHaveBeenLastCalledWith(false)
  })
})
