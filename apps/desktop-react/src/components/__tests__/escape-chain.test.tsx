import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { useWorkbenchStore } from '../../workbench/store'
import { initialStageState } from '../../stage/transitions'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import { useAgentMenu } from '../agent-menu'
import { focusTree } from '../../focus/registry'
import { AppShell } from '../AppShell'

/**
 * **Esc 退层链的宿主半边**(纯函数那一半在 stage/transitions.test.ts)。
 *
 * ── 宿主换了人,契约一个字没换(09-02 R1)────────────────────────────────
 * 从前它是 `components/useEscapeChain`:一条自己挂的 window 冒泡监听。
 * 现在它是**响应链根的 `onEscape`** —— `AppShell` 把 `escapeTopmost` 交给
 * `<FocusScope scope="root">`,由全壳唯一那个派发器沿活动路径由深到浅问下来,
 * 退层链是最后一环(设计 §4.4)。那只 hook 与它的用例文件一起退役,这一份是
 * 同一组契约在新宿主上的重写。
 *
 * 所以这里渲染的是**整台 `AppShell`** 而不是一只光秃秃的 hook:接线本身
 * (根有没有真的把 `escapeTopmost` 交出去)现在是这组契约的一部分,
 * 拆掉 `AppShell` 里那一句 `onEscape={escapeTopmost}`,下面每一条都红。
 *
 * 三条契约一条不少:
 *  ① 浮窗 / 舞台 / 全屏按 Esc 真的关得掉 —— 08-31 报障、真机复现的那一下
 *     (那时全仓只有 StageOverlay 挂 Esc,而它只在有舞台时才挂载);
 *  ② 内层已经消费过(defaultPrevented)时**不接**;
 *  ③ 没有面可退时**不 preventDefault** —— 一个「什么都没做却把事件吃掉」的
 *     监听器是这条链上最难查的一种故障(输入法组字、Composer 的两段式停止
 *     都还在等这一下)。
 */

const VIEWPORT = { w: 1440, h: 900 }

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  // 全屏那一格瞬态住在拼贴台那本账上(W2),所以它要在这里归零。
  useWorkbenchStore.setState({ full: null })
  useKeymapStore.setState({ ...initialKeymapState })
  useAgentMenu.setState({ open: false })
  window.innerWidth = VIEWPORT.w
  window.innerHeight = VIEWPORT.h
})

afterEach(() => {
  focusTree.reset()
})

/** 按一下 Esc,回答「这一下被拦下了吗」。 */
function pressEscape(): boolean {
  let prevented = false
  act(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(event)
    prevented = event.defaultPrevented
  })
  return prevented
}

const formOf = (id: string) => useStageStore.getState().placements[id]?.kind ?? 'dock'
/** 此刻铺满窗子的是哪一格(没有就是 null)。全屏不是一种 Placement,所以另问一处。 */
const fullRefId = () => {
  const full = useWorkbenchStore.getState().full
  return full ? `${full.ref.kind}:${full.ref.key}` : null
}

describe('Esc 退层链(root 作用域的 onEscape)', () => {
  it('**浮窗关得掉** —— 修前这一下掉进空里(真机复现:placements 一个字节不变)', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('sessions', { kind: 'float' }))
    expect(formOf('sessions')).toBe('float')

    expect(pressEscape()).toBe(true)
    expect(formOf('sessions')).toBe('dock')
  })

  it('舞台照旧关得掉(两次搬家都没有弄丢原来那条行为)', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('files', { kind: 'stage' }))
    expect(pressEscape()).toBe(true)
    expect(formOf('files')).toBe('dock')
  })

  it('**全屏也退得掉**(W2:接替「盖」的那一层,它排在链的第一站)', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('apps', { kind: 'full' }))
    expect(fullRefId()).toBe('panel:apps')
    expect(pressEscape()).toBe(true)
    expect(fullRefId()).toBe(null)
    // 退出 = 回 Dock:那一支落定时已经把它从每棵树里摘干净了(投影缺席即 dock)。
    expect(formOf('apps')).toBe('dock')
  })

  it('架子不退 —— 常驻家具不该被一下 Esc 搬走,而且这一下不拦', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('files', { kind: 'edge', side: 'right' }))
    expect(pressEscape()).toBe(false)
    expect(formOf('files')).toBe('edge')
  })

  it('内层已消费(defaultPrevented)时**不接**:让位契约的宿主半边', () => {
    /*
     * ── R2:这条契约的**站位**变了,契约本身一个字没变 ──────────────────────
     * R1 时壳里还有四家没接树(ExposeView / composer / viewer / files),它们各在
     * 自己的相位上,所以「别人先吃掉了这一下」靠 `defaultPrevented` 在派发器的
     * 冒泡半开头成立。R2 把那四家全接进了树:壳里再没有第二个 keydown 监听,
     * 派发器合成**一个捕获相位**的监听 —— 于是「比它更早」只剩一种可能:
     * **在它之前登记的另一个捕获监听**。所以这只探针要在 `render` 之前挂。
     *
     * 那一句 `if (e.defaultPrevented) return` 因此在今天恒不触发,但它留着:
     * 它是一条契约(别人真接住了就让开),不是一处优化。删掉它 → 这一条红。
     */
    const consume = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', consume, true)
    try {
      render(<AppShell />)
      act(() => useStageStore.getState().openAs('sessions', { kind: 'float' }))
      pressEscape()
    } finally {
      window.removeEventListener('keydown', consume, true)
    }
    expect(formOf('sessions')).toBe('float')
  })

  it('没有面可退时不 preventDefault —— 后面还有别的层在等这一下', () => {
    render(<AppShell />)
    expect(pressEscape()).toBe(false)
  })

  it('退一层就是一层:三级链按 z 序 —— 全屏 → 舞台 → 最上面那扇浮窗', () => {
    render(<AppShell />)
    act(() => {
      useStageStore.getState().openAs('files', { kind: 'float' })
      useStageStore.getState().openAs('sessions', { kind: 'stage' })
      useStageStore.getState().openAs('apps', { kind: 'full' })
    })
    // ① 全屏最先退(--z-full 550 压得过 overlay 500 与 float 200)。
    expect(pressEscape()).toBe(true)
    expect(fullRefId()).toBe(null)
    expect(formOf('sessions')).toBe('stage')
    expect(formOf('files')).toBe('float')
    // ② 然后是舞台。
    expect(pressEscape()).toBe(true)
    expect(formOf('sessions')).toBe('dock')
    expect(formOf('files')).toBe('float')
    // ③ 最后才轮到浮窗。
    expect(pressEscape()).toBe(true)
    expect(formOf('files')).toBe('dock')
  })

  it('别的键一概不碰', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    act(() => void fireEvent.keyDown(window, { key: 'Enter' }))
    expect(formOf('files')).toBe('float')
  })
})

/**
 * **浮层压在面板上:一下 Esc 只退一层**(08-31 报障「文件面板里开详情浮层,
 * 一下 Esc 两层一起关」)。
 *
 * 这一组的判据换过一次:从前靠**传播相位**(浮层听捕获、外壳听冒泡),现在靠
 * **树的深度**(浮层是那块面的孩子,由深到浅第一个答 true 的消费掉)。相位那条
 * 判例没有作废,它只是降级成了 R1 的过渡形(`focus/dispatch.ts` 文件头那张表):
 * 还没接树的那四家仍然在各自的相位上,所以两半的分界仍然是那条相位线。
 *
 * 真浮层(`ui/Menu` 那一族)在树上的层叠归 `focus/__tests__/layers.test.tsx`;
 * 这里只钉宿主这一头:**内层认领了,面板就一动不动**。
 */
describe('浮层压在面板上:一下 Esc 只退一层', () => {
  /** 模仿一层认领了这一下的浮层(捕获相位 —— 与派发器的捕获半同相)。 */
  function mountOverlayLike(capture: boolean, onEsc: () => void) {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onEsc()
    }
    window.addEventListener('keydown', handler, capture)
    return () => window.removeEventListener('keydown', handler, capture)
  }

  it('浮层先退,面板一动不动', () => {
    // R2:探针要比派发器**先登记**才排得到它前面(同一相位按登记序),
    // 理由与上一组那条「让位契约」逐字相同。
    let overlayClosed = false
    const off = mountOverlayLike(true, () => {
      overlayClosed = true
    })
    try {
      render(<AppShell />)
      act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
      pressEscape()
    } finally {
      off()
    }
    expect(overlayClosed).toBe(true)
    expect(formOf('files')).toBe('float')
  })

  it('浮层退掉之后,下一下 Esc 才轮到面板', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    const off = mountOverlayLike(true, () => {})
    off() // 浮层已经关了 —— 它的监听器随之摘掉
    pressEscape()
    expect(formOf('files')).toBe('dock')
  })
})
