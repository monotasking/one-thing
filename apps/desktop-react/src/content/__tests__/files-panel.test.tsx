import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FilesDirectoryEntry } from '@shared/ipc/files'
import { renderContent } from '../index'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { useFilesSource } from '../../data/files-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'
import { useNotifyStore } from '../../services/notify-store'
import { ONETHING_DIR, seedSessionsSource } from '../../data/__fixtures__/sessions'

/**
 * 文件面板(D5)。这一批验的是**面板长在真数据上**:
 * 根从活跃会话的工作目录来、懒展开、三态诚实、点文件出预览、reveal 失败看得见。
 *
 * 取数一律走假端口(单元测试不碰盘)。
 */

const ROOT = ONETHING_DIR
/** 带工作目录的那条会话(fixtures 里 os-provider 的 workingDirectory 就是 ROOT)。 */
const SESSION_WITH_DIR = 'os-provider'
/** 没有工作目录的那条(独立会话)。 */
const SESSION_WITHOUT_DIR = 'lo-notes'

function entry(name: string, type: 'file' | 'directory', at = ROOT): FilesDirectoryEntry {
  return { name, path: `${at}/${name}`, type }
}

const TREE: Record<string, FilesDirectoryEntry[]> = {
  [ROOT]: [entry('packages', 'directory'), entry('README.md', 'file')],
  [`${ROOT}/packages`]: [entry('core', 'directory', `${ROOT}/packages`)],
  [`${ROOT}/packages/core`]: [entry('engine.ts', 'file', `${ROOT}/packages/core`)],
}

function installPort(overrides: Partial<FilesPort> = {}): FilesPort {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async (path: string) =>
      TREE[path]
        ? { success: true, entries: TREE[path] }
        : { success: false, error: 'Failed to list directory' },
    ),
    stat: vi.fn(async () => ({ success: true, type: 'directory' as const, path: '/home/me' })),
    readContent: vi.fn(async () => ({
      success: true,
      content: 'export const engine = 1\n',
      size: 24,
    })),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
    ...overrides,
  }
  configureFilesPort(port)
  return port
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  seedSessionsSource()
  useExposeStore.setState({ currentSessionId: SESSION_WITH_DIR })
  useFilesSource.getState().reset()
  useNotifyStore.setState({ items: [] })
})

/** 内容表那一格换人了没有 —— 这条在 FilesMock 还挂着时必红。 */
describe('内容表:files 这一格是真面板', () => {
  it('renderContent(\'files\') 画的是真树,不是写死的三行', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    // FilesMock 那三行里唯一不可能来自本用例假端口的字面量:它在场就说明旧面板还在。
    expect(screen.queryByText('model-capability.ts')).toBeNull()
    // 真面板才有的两件:面板标题与根条。
    expect(screen.getByText('文件')).toBeTruthy()
    expect(screen.getByText(ROOT)).toBeTruthy()
  })
})

describe('根:跟着活跃会话走', () => {
  it('根 = 活跃会话的工作目录,并且如实显示在面板头上', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText(ROOT)).toBeTruthy())
    expect(port.listDirectory).toHaveBeenCalledWith(ROOT)
    expect(port.stat).not.toHaveBeenCalled()
  })

  it('会话没有工作目录时退主目录,并**说出来**', async () => {
    useExposeStore.setState({ currentSessionId: SESSION_WITHOUT_DIR })
    installPort({
      listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() =>
      expect(screen.getByText('这条会话没有工作目录,显示的是主目录')).toBeTruthy(),
    )
    expect(screen.getByText('/home/me')).toBeTruthy()
  })
})

describe('树:懒展开', () => {
  it('一开始只有一层;点目录才把下一层拉回来', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    expect(screen.queryByText('core')).toBeNull()
    expect(port.listDirectory).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())

    fireEvent.click(screen.getByText('core'))
    await waitFor(() => expect(screen.getByText('engine.ts')).toBeTruthy())
    expect(port.listDirectory).toHaveBeenCalledTimes(3)
  })

  it('再点一下收起,但缓存留着 —— 不重新问一遍', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.queryByText('core')).toBeNull())
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    expect(port.listDirectory).toHaveBeenCalledTimes(2)
  })
})

describe('三态诚实', () => {
  it('空目录说自己是空的', async () => {
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('这个目录是空的')).toBeTruthy())
  })

  it('没权限说没权限,并把后端原话原样带上', async () => {
    installPort({
      listDirectory: vi.fn(async () => ({
        success: false,
        error: 'EACCES: permission denied, scandir',
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('没有权限读这个目录')).toBeTruthy())
    expect(screen.getByText('EACCES: permission denied, scandir')).toBeTruthy()
  })

  it('别的失败说读不到 —— 与「空」「没权限」三句不同的话', async () => {
    installPort({ listDirectory: vi.fn(async () => ({ success: false, error: 'boom' })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('读不到这个目录')).toBeTruthy())
  })
})

describe('预览', () => {
  it('点文件出只读预览:正文走的是聊天区那条代码块渲染路径', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() =>
      expect(screen.getByText('export const engine = 1')).toBeTruthy(),
    )
    expect(port.readContent).toHaveBeenCalledWith(`${ROOT}/README.md`, expect.any(Number))
    // 代码块的檐:左端是语言(md → markdown),右端是复制 —— 都是壳白给的。
    expect(screen.getByText('markdown')).toBeTruthy()
  })

  it('二进制不画乱码,明说读不成文本', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: true, content: '', isBinary: true, size: 900 })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() =>
      expect(screen.getByText('这是二进制文件,没法按文本预览')).toBeTruthy(),
    )
  })

  it('读不到就说读不到,并留下后端原话', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: false, error: 'Permission denied' })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('没有权限读这个文件')).toBeTruthy())
    expect(screen.getByText('Permission denied')).toBeTruthy()
  })

  it('关掉预览回到树', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('markdown')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('关闭预览'))
    await waitFor(() => expect(screen.queryByText('markdown')).toBeNull())
  })
})

describe('reveal', () => {
  it('每一行都带一枚「在文件管理器中显示」,点它把整条路径交下去', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const buttons = screen.getAllByLabelText('在文件管理器中显示')
    expect(buttons.length).toBe(2)
    fireEvent.click(buttons[1])
    await waitFor(() => expect(port.reveal).toHaveBeenCalledWith(`${ROOT}/README.md`))
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('做不到就弹一条 error —— 点了没反应是最坏的那一种', async () => {
    installPort({
      reveal: vi.fn(async () => ({
        success: false,
        error: 'Revealing local files is not available in the web server runtime.',
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getAllByLabelText('在文件管理器中显示')[1])
    await waitFor(() =>
      expect(useNotifyStore.getState().items.map((x) => [x.level, x.title])).toEqual([
        ['error', '没能在文件管理器中定位'],
      ]),
    )
  })
})
