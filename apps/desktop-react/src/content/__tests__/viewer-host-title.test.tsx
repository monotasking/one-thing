import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { FileViewer } from '../viewer/FileViewer'
import { HostTitle } from '../../components/HostTitle'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { useViewerSource } from '../../data/viewer-source'

/**
 * **一格一檐的另一半:身份交给檐**(09-01 立,W1 换键)。
 *
 * 檐怎么合由 `file-viewer.test.tsx` 那一组验(查看器自己那条整条不画);
 * 这一组验剩下那半 —— **文件名与未保存丸没有跟着一起消失**,它们改由檐说。
 * 少了这半,合檐就成了「把身份藏起来」,那比双檐更糟。
 *
 * W1 变的只有**键**:从瓦 id(`viewer`)换成 refId(`file:<path>`),形状一个字
 * 没变。变化背后是那件事本身变了 —— 从前全应用只有一份查看器,所以一个 id 够用;
 * 现在一个文件一份实例,身份当然要按实例记。
 */

const CODE = "export const gate = 'F2'\n"
const PATH = '/repo/a.ts'
const REF = `file:${PATH}`

function installPort(): FilesPort {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    stat: vi.fn(async () => ({ success: true, type: 'file' as const, path: PATH })),
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

describe('活标题:内容告诉檐它在显示什么', () => {
  it('打开一个文件 → 檐上说文件名(键 = refId)', async () => {
    installPort()
    await act(async () => {
      await useViewerSource.getState().openFile(PATH)
    })
    render(<FileViewer path={PATH} />)
    expect(useLiveTitleStore.getState().titles[REF]).toEqual({
      text: 'a.ts',
      dirty: false,
      // 提示给整条路径:檐上那格窄,两个目录里的同名文件在屏幕上长得一样
      // (禁令区:标题截断须配 Tooltip 全名)。
      tip: PATH,
    })
    render(<HostTitle id={REF} fallback="查看器" />)
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.queryByTestId('host-title-dirty')).toBeNull()
  })

  it('有没存的改动 → 檐上挂那颗丸(一格一檐没把「脏」弄丢)', async () => {
    installPort()
    await act(async () => {
      await useViewerSource.getState().openFile(PATH)
    })
    render(<FileViewer path={PATH} />)
    await act(async () => {
      useViewerSource.getState().setEditing(PATH, true)
      useViewerSource.getState().setDraft(PATH, 'changed')
    })
    expect(useLiveTitleStore.getState().titles[REF]?.dirty).toBe(true)
    render(<HostTitle id={REF} fallback="查看器" />)
    expect(screen.getByTestId('host-title-dirty')).toBeTruthy()
  })

  it('这一格 tab 关掉(实例卸载)→ 活标题收回', async () => {
    installPort()
    await act(async () => {
      await useViewerSource.getState().openFile(PATH)
    })
    const view = render(<FileViewer path={PATH} />)
    expect(useLiveTitleStore.getState().titles[REF]).toBeTruthy()
    view.unmount()
    expect(useLiveTitleStore.getState().titles[REF]).toBeUndefined()
  })

  it('**两份实例各说各的**(多实例的身份不串)', async () => {
    installPort()
    await act(async () => {
      await useViewerSource.getState().openFile('/repo/a.ts')
      await useViewerSource.getState().openFile('/repo/b.ts')
    })
    render(<FileViewer path="/repo/a.ts" />)
    render(<FileViewer path="/repo/b.ts" />)
    expect(useLiveTitleStore.getState().titles['file:/repo/a.ts']?.text).toBe('a.ts')
    expect(useLiveTitleStore.getState().titles['file:/repo/b.ts']?.text).toBe('b.ts')
  })

  /*
   * 「逐字相同就不 set」那条护栏:几个檐都订着这张表,一次无谓的 set 会让它们
   * 全重渲一遍。判据是**同一个对象引用**。
   */
  it('发布同一句话不制造新状态(几条檐都订着它)', () => {
    const { setLiveTitle } = useLiveTitleStore.getState()
    setLiveTitle('x', { text: 'a.ts', dirty: false })
    const first = useLiveTitleStore.getState().titles
    setLiveTitle('x', { text: 'a.ts', dirty: false })
    expect(useLiveTitleStore.getState().titles).toBe(first)
    setLiveTitle('x', { text: 'a.ts', dirty: true })
    expect(useLiveTitleStore.getState().titles).not.toBe(first)
  })
})
