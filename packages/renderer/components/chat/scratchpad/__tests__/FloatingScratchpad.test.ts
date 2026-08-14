// @vitest-environment happy-dom
/**
 * 悬浮草稿垫的**壳**验收(2026-08-14 形态重构)。
 *
 * 钉的是形态本身,不是编辑器内部:垫子在不在场、收起后剩什么、拖过之后位置
 * 记不记得住、已读偏移有没有原样递给编辑器。编辑器自己的行为由它自己负责,
 * 这里一律 stub 掉 —— 在 happy-dom 里跑 ProseMirror 只会钉住 happy-dom 的怪癖。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FloatingScratchpad from '../FloatingScratchpad.vue'
import { PAD_STORAGE_KEY } from '../floating-pad-state'

const mocks = vi.hoisted(() => ({
  padOpen: true,
  record: null as any,
  consumedOffset: null as number | null,
}))

vi.mock('@/stores/scratchpad', () => ({
  useScratchpadStore: () => ({
    isPadOpen: () => mocks.padOpen,
    setPadOpen: vi.fn(),
    togglePad: vi.fn(),
    clearPadOpen: vi.fn(),
    getRecord: () => mocks.record,
    setContent: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    flushNow: vi.fn().mockResolvedValue(undefined),
    consumedOffset: () => mocks.consumedOffset,
    pendingText: () => mocks.record?.content ?? '',
  }),
}))

vi.mock('@/platform', () => ({ platformApi: {} }))

/** 编辑器换成一个只认 modelValue / consumedOffset 的空壳。 */
const EDITOR_STUB = {
  props: ['modelValue', 'consumedOffset'],
  template: '<div class="editor-stub" :data-consumed="String(consumedOffset)">{{ modelValue }}</div>',
  methods: { focus() {}, getSelectedText: () => '' },
}

const STUBS = {
  TiptapNoteEditor: EDITOR_STUB,
  Tooltip: { template: '<span><slot /></span>' },
  Button: { template: '<button><slot name="icon" /><slot /></button>' },
}

/**
 * 自备存储。Node 22 的 globalThis 上有一个没开 `--localstorage-file` 的空壳
 * localStorage(方法全是 undefined),happy-dom 环境下它照样在 —— 直接用会
 * 当场 TypeError(与 stores/__tests__/scratchpad.test.ts 同一条判例)。
 */
function createFakeStorage() {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
  }
}

let wrapper: VueWrapper | null = null

function mountPad(props: Record<string, unknown> = {}) {
  wrapper = mount(FloatingScratchpad, {
    props: { sessionId: 's1', available: true, ...props },
    global: { stubs: STUBS },
  })
  return wrapper
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createFakeStorage())
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 800)
  mocks.padOpen = true
  mocks.consumedOffset = null
  mocks.record = reactive({
    content: '第一行\n第二行',
    version: 3,
    filePath: '/store/scratchpads/s1.md',
    loaded: true,
    dirty: false,
    consumedVersion: 0,
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

describe('悬浮草稿垫 · 在不在场', () => {
  it('关着的时候什么都不画 —— 连小圆钮都不留', () => {
    mocks.padOpen = false
    const pad = mountPad()

    expect(pad.find('.scratchpad-pad').exists()).toBe(false)
    expect(pad.find('.scratchpad-bubble').exists()).toBe(false)
  })

  it('开着就是一张浮卡:标题 / 保存状态 / 编辑器', () => {
    const pad = mountPad()

    expect(pad.find('.scratchpad-pad').exists()).toBe(true)
    expect(pad.find('.pad-title').text()).toBe('草稿纸')
    expect(pad.find('.pad-sync').text()).toContain('已保存')
    expect(pad.find('.editor-stub').text()).toContain('第一行')
  })

  it('messenger 形态(available=false)整块不出现', () => {
    const pad = mountPad({ available: false })

    expect(pad.find('.scratchpad-pad').exists()).toBe(false)
  })

  it('本地脏着时说的是「未保存」,不是编一个"已保存"', async () => {
    const pad = mountPad()
    mocks.record.dirty = true
    await nextTick()

    expect(pad.find('.pad-sync').text()).toContain('未保存')
  })
})

describe('悬浮草稿垫 · 收起与展开', () => {
  it('收起后只剩一枚小圆钮,浮卡整个退场', async () => {
    const pad = mountPad()

    localStorage.setItem(PAD_STORAGE_KEY, JSON.stringify({ collapsed: true }))
    pad.unmount()
    wrapper = mountPad()

    expect(wrapper.find('.scratchpad-bubble').exists()).toBe(true)
    expect(wrapper.find('.scratchpad-pad').exists()).toBe(false)
  })

  it('收起档写进 localStorage —— 重开窗口还是收着的', async () => {
    const pad = mountPad()
    // 头部的最后一枚钮是收起。
    const buttons = pad.findAll('.pad-header button')
    await buttons[buttons.length - 1].trigger('click')
    await nextTick()

    expect(pad.find('.scratchpad-bubble').exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem(PAD_STORAGE_KEY) || '{}').collapsed).toBe(true)
  })

  it('收起时把焦点还给输入框(returnFocus)', async () => {
    const pad = mountPad()
    const buttons = pad.findAll('.pad-header button')
    await buttons[buttons.length - 1].trigger('click')

    expect(pad.emitted('returnFocus')).toBeTruthy()
  })
})

describe('悬浮草稿垫 · 几何持久化', () => {
  it('拖动头部栏改坐标,松手后落进 localStorage', async () => {
    const pad = mountPad()
    const before = JSON.parse(JSON.stringify(
      parseRect(pad.find('.scratchpad-pad').attributes('style') || ''),
    ))

    await pad.find('.pad-header').trigger('mousedown', { button: 0, clientX: 500, clientY: 300 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 460, clientY: 260 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    const after = parseRect(pad.find('.scratchpad-pad').attributes('style') || '')
    expect(after.left).toBe(before.left - 40)
    expect(after.top).toBe(before.top - 40)

    const stored = JSON.parse(localStorage.getItem(PAD_STORAGE_KEY) || '{}')
    expect(stored.rect.x).toBe(after.left)
  })

  it('存着的坐标在下次挂载时被读回来', () => {
    localStorage.setItem(PAD_STORAGE_KEY, JSON.stringify({
      rect: { x: 111, y: 222, width: 400, height: 500 },
    }))
    const pad = mountPad()

    const rect = parseRect(pad.find('.scratchpad-pad').attributes('style') || '')
    expect(rect.left).toBe(111)
    expect(rect.top).toBe(222)
  })
})

describe('悬浮草稿垫 · 已读水位', () => {
  it('没有 consumed 事件时:头部不编"已读",偏移原样是 null 递给编辑器', () => {
    const pad = mountPad()

    expect(pad.find('.pad-watermark').text()).toBe('AI 尚未读过')
    expect(pad.find('.editor-stub').attributes('data-consumed')).toBe('null')
  })

  it('有偏移时:头部说到第几字,同一个数原样递给编辑器去画线', async () => {
    mocks.consumedOffset = 3
    const pad = mountPad()
    await nextTick()

    expect(pad.find('.pad-watermark').text()).toContain('已读至 3 字')
    expect(pad.find('.editor-stub').attributes('data-consumed')).toBe('3')
  })

  it('读完全文时头部改口说「已读全部」', async () => {
    mocks.consumedOffset = mocks.record.content.length
    const pad = mountPad()
    await nextTick()

    expect(pad.find('.pad-watermark').text()).toBe('AI 已读全部')
  })
})

function parseRect(style: string): { left: number, top: number } {
  const left = /left:\s*(-?[\d.]+)px/.exec(style)?.[1] ?? '0'
  const top = /top:\s*(-?[\d.]+)px/.exec(style)?.[1] ?? '0'
  return { left: Number(left), top: Number(top) }
}
