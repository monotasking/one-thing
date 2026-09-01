import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ViewerPanel } from '../viewer/ViewerPanel'
import { HostTitle } from '../../components/HostTitle'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { VIEWER_ITEM_ID } from '../../stage/items'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { useViewerSource } from '../../data/viewer-source'

/**
 * **合檐的另一半:身份交给宿主檐**(09-01 回炉)。
 *
 * 檐怎么合由 `file-viewer.test.tsx` 那一组验(查看器那条整条不画);这一组验
 * 剩下那半 —— **文件名与未保存丸没有跟着一起消失**,它们改由宿主檐说。
 * 少了这半,合檐就成了「把身份藏起来」,那比双檐更糟。
 */

const CODE = "export const gate = 'F2'\n"

function installPort(): FilesPort {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    stat: vi.fn(async () => ({ success: true, type: 'file' as const, path: '/repo/a.ts' })),
    readContent: vi.fn(async () => ({ success: true, content: CODE, size: CODE.length })),
    saveContent: vi.fn(async () => ({ success: true, mtimeMs: 42 })),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
  }
  configureFilesPort(port)
  return port
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useViewerSource.getState().reset()
  useLiveTitleStore.setState({ titles: {} })
})

describe('活标题:内容告诉宿主它在显示什么', () => {
  it('手上没有文件时**不发布** —— 宿主檐该说「查看器」(这块面是什么)', () => {
    installPort()
    render(<ViewerPanel />)
    expect(useLiveTitleStore.getState().titles[VIEWER_ITEM_ID]).toBeUndefined()
    render(<HostTitle id={VIEWER_ITEM_ID} fallback="查看器" />)
    expect(screen.getAllByText('查看器').length).toBeGreaterThan(0)
  })

  it('打开一个文件 → 宿主檐改说文件名', async () => {
    installPort()
    render(<ViewerPanel />)
    await act(async () => {
      await useViewerSource.getState().openFile('/repo/a.ts')
    })
    expect(useLiveTitleStore.getState().titles[VIEWER_ITEM_ID]).toEqual({
      text: 'a.ts',
      dirty: false,
      // 提示给整条路径:檐上那格窄,两个目录里的同名文件在屏幕上长得一样
      // (禁令区:标题截断须配 Tooltip 全名)。
      tip: '/repo/a.ts',
    })
    render(<HostTitle id={VIEWER_ITEM_ID} fallback="查看器" />)
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.queryByTestId('host-title-dirty')).toBeNull()
  })

  it('有没存的改动 → 宿主檐挂那颗丸(合檐没把「脏」弄丢)', async () => {
    installPort()
    render(<ViewerPanel />)
    await act(async () => {
      await useViewerSource.getState().openFile('/repo/a.ts')
    })
    await act(async () => {
      useViewerSource.getState().setEditing(true)
      useViewerSource.getState().setDraft('changed')
    })
    expect(useLiveTitleStore.getState().titles[VIEWER_ITEM_ID]?.dirty).toBe(true)
    render(<HostTitle id={VIEWER_ITEM_ID} fallback="查看器" />)
    expect(screen.getByTestId('host-title-dirty')).toBeTruthy()
  })

  it('瓦收回 Dock(面板卸载)→ 活标题收回,檐落回静态名字', async () => {
    installPort()
    const view = render(<ViewerPanel />)
    await act(async () => {
      await useViewerSource.getState().openFile('/repo/a.ts')
    })
    expect(useLiveTitleStore.getState().titles[VIEWER_ITEM_ID]).toBeTruthy()
    view.unmount()
    expect(useLiveTitleStore.getState().titles[VIEWER_ITEM_ID]).toBeUndefined()
  })

  /*
   * 「逐字相同就不 set」那条护栏:三个宿主(浮窗 / 舞台 / 盖)都订着这张表,
   * 一次无谓的 set 会让它们全重渲一遍。判据是**同一个对象引用**。
   */
  it('发布同一句话不制造新状态(三个宿主都订着它)', () => {
    const { setLiveTitle } = useLiveTitleStore.getState()
    setLiveTitle('x', { text: 'a.ts', dirty: false })
    const first = useLiveTitleStore.getState().titles
    setLiveTitle('x', { text: 'a.ts', dirty: false })
    expect(useLiveTitleStore.getState().titles).toBe(first)
    setLiveTitle('x', { text: 'a.ts', dirty: true })
    expect(useLiveTitleStore.getState().titles).not.toBe(first)
  })
})
