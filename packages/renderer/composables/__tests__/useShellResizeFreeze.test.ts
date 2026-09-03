// @vitest-environment happy-dom
/**
 * 拖拽中冻结宽护罩(2026-08-25 拖拽掉帧根治)。
 *
 * 钉的是闸门语义:`shellResizing` 立起时把目标元素当下的宽度写成内联 width,
 * 放下时清掉 —— 重内容(Monaco/终端)因此在拖拽期间收不到任何宽度变化。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useShellResizeFreeze } from '../useShellResizeFreeze'
import { resetShellLayoutRuntime, setShellResizing } from '../useShellLayout'

function fakeElement(width: number): HTMLElement {
  return { getBoundingClientRect: () => ({ width }) } as unknown as HTMLElement
}

afterEach(() => {
  resetShellLayoutRuntime()
})

describe('useShellResizeFreeze', () => {
  it('拖拽开始冻结在起拖宽,结束解冻', async () => {
    const target = ref<HTMLElement | null>(fakeElement(512))
    const style = useShellResizeFreeze(target)

    expect(style.value).toBeUndefined()

    setShellResizing(true)
    await nextTick()
    expect(style.value).toEqual({ width: '512px' })

    // 拖拽中目标实际宽度变了也不跟 —— 冻结的意义所在
    target.value = fakeElement(900)
    await nextTick()
    expect(style.value).toEqual({ width: '512px' })

    setShellResizing(false)
    await nextTick()
    expect(style.value).toBeUndefined()
  })

  it('目标还没挂上时开拖,不写 width', async () => {
    const target = ref<HTMLElement | null>(null)
    const style = useShellResizeFreeze(target)

    setShellResizing(true)
    await nextTick()
    expect(style.value).toBeUndefined()
  })

  it('resetShellLayoutRuntime 连拖拽标志一起拨回', async () => {
    const target = ref<HTMLElement | null>(fakeElement(300))
    const style = useShellResizeFreeze(target)

    setShellResizing(true)
    await nextTick()
    expect(style.value).toEqual({ width: '300px' })

    resetShellLayoutRuntime()
    await nextTick()
    expect(style.value).toBeUndefined()
  })
})
