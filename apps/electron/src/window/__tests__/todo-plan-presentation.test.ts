import { describe, expect, it, vi } from 'vitest'
import {
  isElectronTodoPlanWindowFrontmost,
  normalizeElectronTodoPlanWindowActionOptions,
  prepareElectronTodoPlanWindowAction,
  presentElectronTodoPlanWindow,
  resolveElectronTodoPlanDragPosition,
  shouldPreserveElectronCurrentMacApp,
} from '../todo-plan-presentation.js'

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
}))

function windowMock(overrides: Record<string, unknown> = {}) {
  return {
    showInactive: vi.fn(),
    moveTop: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isFocused: vi.fn(() => false),
    ...overrides,
  } as any
}

describe('electron todo plan presentation strategy', () => {
  it('normalizes default action options', () => {
    expect(normalizeElectronTodoPlanWindowActionOptions()).toEqual({
      activation: 'preserve-current-app',
      preserveMainWindowVisibility: true,
      mainWindowVisibilitySnapshot: undefined,
    })
    expect(normalizeElectronTodoPlanWindowActionOptions({
      activation: 'focus-if-app-active',
      preserveMainWindowVisibility: false,
    })).toEqual({
      activation: 'focus-if-app-active',
      preserveMainWindowVisibility: false,
      mainWindowVisibilitySnapshot: undefined,
    })
  })

  it('decides whether to preserve the current macOS app', () => {
    expect(shouldPreserveElectronCurrentMacApp({
      activation: 'preserve-current-app',
      preserveMainWindowVisibility: true,
    }, {
      platform: () => 'darwin',
      getFocusedWindow: () => ({} as any),
    })).toBe(true)

    expect(shouldPreserveElectronCurrentMacApp({
      activation: 'focus-if-app-active',
      preserveMainWindowVisibility: true,
    }, {
      platform: () => 'darwin',
      getFocusedWindow: () => null,
    })).toBe(true)

    expect(shouldPreserveElectronCurrentMacApp({
      activation: 'preserve-current-app',
      preserveMainWindowVisibility: true,
    }, {
      platform: () => 'linux',
      getFocusedWindow: () => null,
    })).toBe(false)
  })

  it('prepares snapshots and suppresses main-window activation only when preserving current app', () => {
    const snapshot = [{ window: {} as any, visible: false }]
    const suppressMainWindowActivation = vi.fn()
    const captureMainWindowVisibility = vi.fn(() => snapshot)

    expect(prepareElectronTodoPlanWindowAction({}, {
      platform: () => 'darwin',
      getFocusedWindow: () => null,
      suppressMainWindowActivation,
      captureMainWindowVisibility,
    })).toEqual({
      options: {
        activation: 'preserve-current-app',
        preserveMainWindowVisibility: true,
        mainWindowVisibilitySnapshot: undefined,
      },
      mainWindowVisibilitySnapshot: snapshot,
    })
    expect(suppressMainWindowActivation).toHaveBeenCalledTimes(1)
    expect(captureMainWindowVisibility).toHaveBeenCalledTimes(1)

    suppressMainWindowActivation.mockClear()
    captureMainWindowVisibility.mockClear()
    expect(prepareElectronTodoPlanWindowAction({ preserveMainWindowVisibility: false }, {
      platform: () => 'linux',
      getFocusedWindow: () => null,
      suppressMainWindowActivation,
      captureMainWindowVisibility,
    }).mainWindowVisibilitySnapshot).toEqual([])
    expect(suppressMainWindowActivation).not.toHaveBeenCalled()
    expect(captureMainWindowVisibility).not.toHaveBeenCalled()
  })

  it('presents inactive on macOS with Electron fallback when native show is unavailable', () => {
    const win = windowMock()
    presentElectronTodoPlanWindow(win, {
      activation: 'preserve-current-app',
      preserveMainWindowVisibility: true,
    }, {
      platform: () => 'darwin',
      getFocusedWindow: () => ({} as any),
      showNonActivatingPanel: () => false,
    })

    expect(win.showInactive).toHaveBeenCalledTimes(1)
    expect(win.moveTop).toHaveBeenCalledTimes(1)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('shows and focuses when activation is not preserving another app', () => {
    const win = windowMock()
    presentElectronTodoPlanWindow(win, {
      activation: 'focus-if-app-active',
      preserveMainWindowVisibility: true,
    }, {
      platform: () => 'darwin',
      getFocusedWindow: () => ({} as any),
      showNonActivatingPanel: () => true,
    })

    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.showInactive).not.toHaveBeenCalled()
  })

  it('checks frontmost state through the macOS native bridge when available', () => {
    const win = windowMock({ isFocused: vi.fn(() => false) })
    expect(isElectronTodoPlanWindowFrontmost(win, {
      platform: () => 'darwin',
      isNonActivatingPanelFrontmost: () => true,
    })).toBe(true)
    expect(isElectronTodoPlanWindowFrontmost(win, {
      platform: () => 'linux',
      isNonActivatingPanelFrontmost: () => true,
    })).toBe(false)
  })

  describe('manual window drag arithmetic', () => {
    const origin = { x: 100, y: 200 }

    it('places the window at origin + cumulative offset', () => {
      expect(resolveElectronTodoPlanDragPosition(origin, { phase: 'move', dx: 24, dy: -18 }))
        .toEqual({ x: 124, y: 182 })
    })

    it('never drifts: every frame is absolute, so a dropped frame costs nothing', () => {
      // 连续三帧的累计位移 —— 中间那一帧丢掉,结果和没丢一样。
      const frames = [{ dx: 10, dy: 10 }, { dx: 25, dy: 30 }, { dx: 40, dy: 55 }]
      const withAll = frames.map(frame => resolveElectronTodoPlanDragPosition(origin, { phase: 'move', ...frame }))
      const withGap = [frames[0], frames[2]]
        .map(frame => resolveElectronTodoPlanDragPosition(origin, { phase: 'move', ...frame }))
      expect(withAll[2]).toEqual(withGap[1])
      expect(withAll[2]).toEqual({ x: 140, y: 255 })
    })

    it('keeps negative screen coordinates (second display sits left of the main one)', () => {
      expect(resolveElectronTodoPlanDragPosition({ x: -1200, y: 40 }, { phase: 'move', dx: -300, dy: -80 }))
        .toEqual({ x: -1500, y: -40 })
    })

    it('refuses to move without a recorded origin, off the move phase, or on non-finite input', () => {
      expect(resolveElectronTodoPlanDragPosition(null, { phase: 'move', dx: 5, dy: 5 })).toBeNull()
      expect(resolveElectronTodoPlanDragPosition(origin, { phase: 'start' })).toBeNull()
      expect(resolveElectronTodoPlanDragPosition(origin, { phase: 'end' })).toBeNull()
      expect(resolveElectronTodoPlanDragPosition(origin, { phase: 'move' })).toBeNull()
      expect(resolveElectronTodoPlanDragPosition(origin, { phase: 'move', dx: Number.NaN, dy: 1 })).toBeNull()
    })

    it('rounds to whole pixels — setPosition takes integers', () => {
      expect(resolveElectronTodoPlanDragPosition(origin, { phase: 'move', dx: 0.4, dy: 1.6 }))
        .toEqual({ x: 100, y: 202 })
    })
  })
})
