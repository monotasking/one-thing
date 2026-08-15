// @vitest-environment happy-dom
/**
 * Todo 窗的形态账本。
 *
 * 两件事被钉在这里:
 * 1. **认不出来就回 Todo** —— 这个键既是本窗口的偏好,也是**另一个窗口写进来的
 *    信号**,所以它随时可能是任何东西(旧版本、手改、半截 JSON)。回到默认永远
 *    比信一个认不出的值安全。
 * 2. **两个形态分账** —— 独立窗与内嵌卡片各记各的,写一个不许动另一个。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeTodoPanelMode,
  readTodoPanelMode,
  requestTodoPlanWindowScratchpadMode,
  TODO_PANEL_CARD_STORAGE_PREFIX,
  TODO_PANEL_WINDOW_STORAGE_PREFIX,
  todoPanelModeStorageKey,
  writeTodoPanelMode,
} from '../todo-panel-mode'

/**
 * 自备存储:Node 22 的 globalThis 上有一个方法全是 undefined 的空壳
 * localStorage,直接用会当场 TypeError(与 scratchpad store 的测试同一条坑)。
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

const WINDOW_KEY = todoPanelModeStorageKey(TODO_PANEL_WINDOW_STORAGE_PREFIX)
const CARD_KEY = todoPanelModeStorageKey(TODO_PANEL_CARD_STORAGE_PREFIX)

describe('todo panel mode', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createFakeStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只认识 scratchpad,别的一律回 Todo', () => {
    expect(normalizeTodoPanelMode('scratchpad')).toBe('scratchpad')
    expect(normalizeTodoPanelMode('todo')).toBe('todo')
    expect(normalizeTodoPanelMode(null)).toBe('todo')
    expect(normalizeTodoPanelMode(undefined)).toBe('todo')
    expect(normalizeTodoPanelMode('SCRATCHPAD')).toBe('todo')
    expect(normalizeTodoPanelMode({ mode: 'scratchpad' })).toBe('todo')
  })

  it('读写走同一个键,没写过就是 Todo', () => {
    expect(readTodoPanelMode(WINDOW_KEY)).toBe('todo')

    writeTodoPanelMode(WINDOW_KEY, 'scratchpad')

    expect(readTodoPanelMode(WINDOW_KEY)).toBe('scratchpad')
  })

  it('独立窗与内嵌卡片各记各的', () => {
    writeTodoPanelMode(WINDOW_KEY, 'scratchpad')

    expect(readTodoPanelMode(CARD_KEY)).toBe('todo')
    expect(WINDOW_KEY).not.toBe(CARD_KEY)
  })

  it('composer 的入口只把独立窗那一份定成草稿纸', () => {
    requestTodoPlanWindowScratchpadMode()

    expect(localStorage.getItem(WINDOW_KEY)).toBe('scratchpad')
    expect(localStorage.getItem(CARD_KEY)).toBeNull()
  })

  it('没有 localStorage 时读到默认、写不炸', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(readTodoPanelMode(WINDOW_KEY)).toBe('todo')
    expect(() => writeTodoPanelMode(WINDOW_KEY, 'scratchpad')).not.toThrow()
  })
})
