// @vitest-environment happy-dom
/**
 * 草稿纸的渲染层账本。
 *
 * 三件容易出错的事被钉在这里:
 * 1. **防抖落盘** —— 打字不能一个字一次 IPC,但离开时欠的账必须结掉。
 * 2. **回声抑制** —— 自己写出去的那一份会原样广播回来;把它当"远端改动"应用
 *    等于在用户打字的中途把光标位置洗掉。
 * 3. **已读水位只认事件** —— 没有 `scratchpad:consumed` 就没有水位,不猜。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScratchpadStore } from '../scratchpad'

const mocks = vi.hoisted(() => ({
  getScratchpad: vi.fn(),
  updateScratchpad: vi.fn(),
  deleteScratchpad: vi.fn(),
  adoptScratchpad: vi.fn(),
  onScratchpadChanged: vi.fn(() => () => {}),
}))

vi.mock('@/platform', () => ({
  platformApi: {
    getScratchpad: mocks.getScratchpad,
    updateScratchpad: mocks.updateScratchpad,
    deleteScratchpad: mocks.deleteScratchpad,
    adoptScratchpad: mocks.adoptScratchpad,
    onScratchpadChanged: mocks.onScratchpadChanged,
  },
}))

/**
 * 自备存储。Node 22 的 globalThis 上有一个没开 `--localstorage-file` 的空壳
 * localStorage(方法全是 undefined),happy-dom 环境下它照样在 —— 直接用会
 * 当场 TypeError。测试里换成一个真会存东西的替身,与生产同一个接口。
 */
function createFakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    get length() { return map.size },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
  }
}

const PATH = '/store/scratchpads/s1.md'

function document(content: string, version: number) {
  return { sessionId: 's1', filePath: PATH, content, version, updatedAt: version }
}

describe('scratchpad store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createFakeStorage())
    setActivePinia(createPinia())
    vi.useFakeTimers()
    mocks.getScratchpad.mockResolvedValue({ success: true, document: document('', 0) })
    mocks.updateScratchpad.mockImplementation(async ({ content }: { content: string }) =>
      ({ success: true, document: document(content, 100) }))
    mocks.deleteScratchpad.mockResolvedValue({ success: true })
    mocks.adoptScratchpad.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('装载一次就够 —— 第二次 load 不再打宿主', async () => {
    const store = useScratchpadStore()
    mocks.getScratchpad.mockResolvedValue({ success: true, document: document('已有内容', 42) })

    await store.load('s1')
    await store.load('s1')

    expect(mocks.getScratchpad).toHaveBeenCalledTimes(1)
    expect(store.getRecord('s1')).toMatchObject({ content: '已有内容', version: 42, loaded: true })
  })

  it('连打三个字只落一次盘,落的是最后那一版', async () => {
    const store = useScratchpadStore()
    await store.load('s1')

    store.setContent('s1', 'a')
    store.setContent('s1', 'ab')
    store.setContent('s1', 'abc')
    expect(mocks.updateScratchpad).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600)

    expect(mocks.updateScratchpad).toHaveBeenCalledTimes(1)
    expect(mocks.updateScratchpad).toHaveBeenCalledWith({ sessionId: 's1', content: 'abc' })
    expect(store.getRecord('s1')?.dirty).toBe(false)
  })

  it('本地内容立刻可见,不等落盘', async () => {
    const store = useScratchpadStore()
    await store.load('s1')

    store.setContent('s1', '刚写的')

    expect(store.getRecord('s1')?.content).toBe('刚写的')
    expect(store.getRecord('s1')?.dirty).toBe(true)
  })

  it('flushNow 把欠的账立刻结掉(切会话 / 卸载走的就是它)', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', '还没到点')

    await store.flushNow('s1')

    expect(mocks.updateScratchpad).toHaveBeenCalledWith({ sessionId: 's1', content: '还没到点' })
  })

  it('回声抑制:内容逐字相同的广播只抬版本号,不动正文', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', 'same')
    await store.flushNow('s1')

    store.applyChanged({ sessionId: 's1', document: document('same', 300) })

    expect(store.getRecord('s1')).toMatchObject({ content: 'same', version: 300 })
  })

  it('版本更旧的广播直接丢掉', async () => {
    const store = useScratchpadStore()
    mocks.getScratchpad.mockResolvedValue({ success: true, document: document('new', 500) })
    await store.load('s1')

    store.applyChanged({ sessionId: 's1', document: document('old', 100) })

    expect(store.getRecord('s1')?.content).toBe('new')
  })

  it('本地正脏着时,远端快照先压住,flush 落地后才应用', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', '我正在打字')

    store.applyChanged({ sessionId: 's1', document: document('AI 改的', 900) })
    expect(store.getRecord('s1')?.content).toBe('我正在打字')

    await store.flushNow('s1')
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getRecord('s1')?.content).toBe('AI 改的')
  })

  it('没装载过的会话不接广播 —— 下次 load 自然读到最新', async () => {
    const store = useScratchpadStore()

    store.applyChanged({ sessionId: 'never-opened', document: document('x', 1) })

    expect(store.getRecord('never-opened')).toBeNull()
  })

  it('水位只认 consumed 事件;没有事件就没有水位', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', '0123456789')
    await store.flushNow('s1')

    expect(store.consumedOffset('s1')).toBeNull()

    store.noteConsumed('s1', 100)

    expect(store.consumedOffset('s1')).toBe(10)
  })

  it('水位之后又写了东西 → pendingText 只给没读过的那一段', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', 'AAAAA')
    await store.flushNow('s1')
    store.noteConsumed('s1', 100)

    store.setContent('s1', 'AAAAABBB')

    expect(store.pendingText('s1')).toBe('BBB')
  })

  it('从没被读过的纸,pendingText 就是全文', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', '全都没读过')

    expect(store.pendingText('s1')).toBe('全都没读过')
  })

  it('水位不倒退 —— 迟到的旧版本事件不改账', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.noteConsumed('s1', 500)

    store.noteConsumed('s1', 100)

    expect(store.getRecord('s1')?.consumedVersion).toBe(500)
  })

  it('remove 把本地账与宿主上的文件一起清掉', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setPadOpen('s1', true)

    await store.remove('s1')

    expect(store.getRecord('s1')).toBeNull()
    expect(store.isPadOpen('s1')).toBe(false)
    expect(mocks.deleteScratchpad).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('adopt 把纸和垫子开关一起搬到新 id 下', async () => {
    const store = useScratchpadStore()
    await store.load('s1')
    store.setContent('s1', '带走')
    store.setPadOpen('s1', true)

    await store.adopt('s1', 's2')

    expect(mocks.adoptScratchpad).toHaveBeenCalledWith({ fromSessionId: 's1', toSessionId: 's2' })
    expect(store.isPadOpen('s2')).toBe(true)
    expect(store.isPadOpen('s1')).toBe(false)
  })

  it('垫子开关按会话记,缺省是关的', () => {
    const store = useScratchpadStore()

    expect(store.isPadOpen('s1')).toBe(false)
    expect(store.togglePad('s1')).toBe(true)
    expect(store.isPadOpen('s1')).toBe(true)
    expect(store.togglePad('s1')).toBe(false)
    // 别的会话不受影响。
    expect(store.isPadOpen('s2')).toBe(false)
  })

  it('开关落到 localStorage,坏数据不炸', () => {
    const store = useScratchpadStore()
    store.setPadOpen('s1', true)

    expect(JSON.parse(localStorage.getItem('onething:scratchpad-open:v1') || '{}'))
      .toEqual({ s1: true })

    localStorage.setItem('onething:scratchpad-open:v1', 'not json at all')
    setActivePinia(createPinia())
    expect(useScratchpadStore().isPadOpen('s1')).toBe(false)
  })
})
