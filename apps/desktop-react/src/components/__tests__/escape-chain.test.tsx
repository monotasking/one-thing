import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useEscapeChain } from '../useEscapeChain'

/**
 * Esc 退层链的宿主半边(纯函数那一半在 stage/transitions.test.ts)。
 *
 * 这一份钉的是**宿主的三条契约**,一条都不是形态机能表达的:
 *  ① 浮窗按 Esc 真的关得掉 —— 这正是 08-31 报障、真机复现的那一下
 *     (修前全仓只有 StageOverlay 挂 Esc,而它只在有舞台时才挂载);
 *  ② 内层已经消费过(defaultPrevented)时**不接**;
 *  ③ 没有面可退时**不 preventDefault** —— 一个「什么都没做却把事件吃掉」的
 *     监听器,是这条链上最难查的一种故障(输入法组字、Composer 的两段式停止
 *     都还在等这一下)。
 */

/** 只挂那条 hook,不画任何东西 —— 测的是监听器,不是某个组件的长相。 */
function EscHost() {
  useEscapeChain()
  return null
}

const VIEWPORT = { w: 1440, h: 900 }

beforeEach(() => {
  useStageStore.setState({ ...initialStageState })
  window.innerWidth = VIEWPORT.w
  window.innerHeight = VIEWPORT.h
})

/** 按一下 Esc,回答「这一下被拦下了吗」。 */
function pressEscape(init?: KeyboardEventInit): boolean {
  let prevented = false
  act(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init })
    window.dispatchEvent(event)
    prevented = event.defaultPrevented
  })
  return prevented
}

const formOf = (id: string) => useStageStore.getState().placements[id]?.kind ?? 'dock'

describe('Esc 退层链(宿主)', () => {
  it('**浮窗关得掉** —— 修前这一下掉进空里(真机复现:placements 一个字节不变)', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('sessions', { kind: 'float' }))
    expect(formOf('sessions')).toBe('float')

    expect(pressEscape()).toBe(true)
    expect(formOf('sessions')).toBe('dock')
  })

  it('舞台照旧关得掉(搬家没有弄丢原来那条行为)', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('files', { kind: 'stage' }))
    expect(pressEscape()).toBe(true)
    expect(formOf('files')).toBe('dock')
  })

  it('盖也关得掉', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('apps', { kind: 'cover' }))
    expect(pressEscape()).toBe(true)
    expect(formOf('apps')).toBe('dock')
  })

  it('架子不退 —— 常驻家具不该被一下 Esc 搬走,而且这一下不拦', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('files', { kind: 'edge', side: 'right' }))
    expect(pressEscape()).toBe(false)
    expect(formOf('files')).toBe('edge')
  })

  it('内层已消费(defaultPrevented)时**不接**:让位契约的宿主半边', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('sessions', { kind: 'float' }))

    // 模拟内容层(捕获相位)先把这一下吃掉。
    const consume = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', consume, true)
    try {
      pressEscape()
    } finally {
      window.removeEventListener('keydown', consume, true)
    }
    expect(formOf('sessions')).toBe('float')
  })

  it('没有面可退时不 preventDefault —— 后面还有别的层在等这一下', () => {
    render(<EscHost />)
    expect(pressEscape()).toBe(false)
  })

  it('退一层就是一层:两块面要按两下,次序照 z 序', () => {
    render(<EscHost />)
    act(() => {
      useStageStore.getState().openAs('files', { kind: 'float' })
      useStageStore.getState().openAs('apps', { kind: 'cover' })
    })
    pressEscape()
    expect(formOf('apps')).toBe('dock')
    expect(formOf('files')).toBe('float')
    pressEscape()
    expect(formOf('files')).toBe('dock')
  })

  it('别的键一概不碰', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    act(() => void fireEvent.keyDown(window, { key: 'Enter' }))
    expect(formOf('files')).toBe('float')
  })
})

/**
 * 浮层压在面板上时,一下 Esc 只退一层 —— 08-31 报障「文件面板里开详情浮层,
 * 一下 Esc 两层一起关」。
 *
 * 这一组钉的是**相位**而不是 preventDefault:两者缺一不可,而只有相位是
 * 结构保证。退层链在应用启动时就挂上了 window,浮层是后来才开的 ——
 * 同相位(都冒泡)下注册序说了算,外壳必先跑,浮层那句 preventDefault 来不及。
 * 所以 ui/Menu、ui/Popover、ui/Dialog 的 Esc 一律**捕获**相位。
 *
 * 反证:把那三处的 `true` 去掉(或把这里的 capture 改成 false)→ 本组必红。
 */
describe('浮层压在面板上:一下 Esc 只退一层', () => {
  /** 模仿 ui/Menu · Popover · Dialog 那一族:捕获相位 + 认领这一下。 */
  function mountOverlayLike(capture: boolean, onEsc: () => void) {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onEsc()
    }
    window.addEventListener('keydown', handler, capture)
    return () => window.removeEventListener('keydown', handler, capture)
  }

  it('浮层(捕获相位)先退,面板一动不动', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    let overlayClosed = false
    const off = mountOverlayLike(true, () => { overlayClosed = true })
    try {
      pressEscape()
    } finally {
      off()
    }
    expect(overlayClosed).toBe(true)
    expect(formOf('files')).toBe('float')
  })

  it('浮层退掉之后,下一下 Esc 才轮到面板', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    const off = mountOverlayLike(true, () => {})
    off() // 浮层已经关了 —— 它的监听器随之摘掉
    pressEscape()
    expect(formOf('files')).toBe('dock')
  })

  it('**反证**:同相位(冒泡)时外壳先跑,两层一起关 —— 这正是修前那一下', () => {
    render(<EscHost />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    let overlayClosed = false
    // 退层链先注册(它在启动时就挂了),浮层后注册 —— 同相位下它排在后面。
    const off = mountOverlayLike(false, () => { overlayClosed = true })
    try {
      pressEscape()
    } finally {
      off()
    }
    expect(overlayClosed).toBe(true)
    // 面板也被收了:两层一起关。这条断言是那个 bug 的**存在证明**,
    // 它的意义是「把相位改回冒泡就会退回这里」,不是「这样是对的」。
    expect(formOf('files')).toBe('dock')
  })
})
