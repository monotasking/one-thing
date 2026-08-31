import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    /*
     * 真后端的 stat 回的是**实际 stat 到的那条绝对路径**(`~` 已展开),别的原样奉还。
     * 假端口跟着这条口径 —— 从前一律回 '/home/me' 会让详情面上的路径凭空变成主目录,
     * 那不是「假数据」,那是假事实。
     */
    stat: vi.fn(async (path: string) => ({
      success: true,
      type: 'directory' as const,
      path: path === '~' ? '/home/me' : path,
    })),
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

/** 头上那条路径此刻说的是什么(面包屑的 textContent 逐字等于根路径)。 */
function shownRoot(): string {
  return screen.getByTestId('files-root').textContent ?? ''
}

/** 内容表那一格换人了没有 —— 这条在 FilesMock 还挂着时必红。 */
describe('内容表:files 这一格是真面板', () => {
  it('renderContent(\'files\') 画的是真树,不是写死的三行', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    // FilesMock 那三行里唯一不可能来自本用例假端口的字面量:它在场就说明旧面板还在。
    expect(screen.queryByText('model-capability.ts')).toBeNull()
    // 真面板才有的那件:头上那条真路径。
    expect(shownRoot()).toBe(ROOT)
  })

  /* 08-31「IDE 紧凑树」:面板内那个与 tab 重名的大标题退役。 */
  it('面板里不再有第二个「文件」大标题(tab 已经叫这个名字)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    expect(screen.queryByRole('heading', { name: '文件' })).toBeNull()
  })
})

describe('根:跟着活跃会话走', () => {
  it('根 = 活跃会话的工作目录,并且如实显示在面板头上', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(shownRoot()).toBe(ROOT))
    expect(port.listDirectory).toHaveBeenCalledWith(ROOT)
    expect(port.stat).not.toHaveBeenCalled()
  })

  it('会话没有工作目录时退主目录,并**说出来**(那句话现在长在底注上)', async () => {
    useExposeStore.setState({ currentSessionId: SESSION_WITHOUT_DIR })
    installPort({
      listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() =>
      expect(screen.getByText('这条会话没有工作目录,显示的是主目录')).toBeTruthy(),
    )
    expect(shownRoot()).toBe('/home/me')
  })
})

describe('面包屑:各段可点回跳', () => {
  it('路径逐段画出来,尾段是当前所在(不是钮)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(shownRoot()).toBe(ROOT))
    const parts = ROOT.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    // 尾段在屏幕上,但它不是按钮 —— 点它没有去处。
    expect(screen.queryByRole('button', { name: last })).toBeNull()
    // 祖先段各是一颗钮。
    for (const part of parts.slice(0, -1)) {
      expect(screen.getByRole('button', { name: part })).toBeTruthy()
    }
  })

  it('点一个祖先段 = 根挪过去,并拉那一层的内容', async () => {
    const parts = ROOT.split('/').filter(Boolean)
    const parent = `/${parts.slice(0, -1).join('/')}`
    const port = installPort({
      listDirectory: vi.fn(async (path: string) =>
        path === parent
          ? { success: true, entries: [entry('sibling', 'directory', parent)] }
          : TREE[path]
            ? { success: true, entries: TREE[path] }
            : { success: false, error: 'Failed to list directory' },
      ),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: parts[parts.length - 2] }))
    await waitFor(() => expect(shownRoot()).toBe(parent))
    expect(port.listDirectory).toHaveBeenCalledWith(parent)
    await waitFor(() => expect(screen.getByText('sibling')).toBeTruthy())
    // 走上去之后那句「显示的是主目录」不该冒出来 —— 这里既不是会话的根也不是主目录。
    expect(screen.queryByText('这条会话没有工作目录,显示的是主目录')).toBeNull()
  })
})

describe('行:真图标 + 零 meta', () => {
  it('目录是 Folder(展开换 FolderOpen),文件按扩展名各画各的', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())

    const dir = document.querySelector(`[data-file-path="${ROOT}/packages"]`)
    const md = document.querySelector(`[data-file-path="${ROOT}/README.md"]`)
    expect(dir?.getAttribute('data-file-icon')).toBe('Folder')
    expect(dir?.getAttribute('data-file-tone')).toBe('dir')
    expect(md?.getAttribute('data-file-icon')).toBe('FileText')
    expect(md?.getAttribute('data-file-tone')).toBe('doc')

    fireEvent.click(screen.getByText('packages'))
    await waitFor(() =>
      expect(
        document
          .querySelector(`[data-file-path="${ROOT}/packages"]`)
          ?.getAttribute('data-file-icon'),
      ).toBe('FolderOpen'),
    )
    // 展开出来的 .ts 拿的是 js 族的色,与 README.md 那一枚不是同一种。
    fireEvent.click(screen.getByText('core'))
    await waitFor(() => expect(screen.getByText('engine.ts')).toBeTruthy())
    const ts = document.querySelector(`[data-file-path="${ROOT}/packages/core/engine.ts"]`)
    expect(ts?.getAttribute('data-file-icon')).toBe('FileCode')
    expect(ts?.getAttribute('data-file-tone')).toBe('js')
  })

  it('隐藏文件整行标出来(淡显靠这一格,不靠正则散在组件里)', async () => {
    installPort({
      listDirectory: vi.fn(async () => ({
        success: true,
        entries: [entry('.gitignore', 'file'), entry('README.md', 'file')],
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('.gitignore')).toBeTruthy())
    expect(
      document.querySelector(`[data-file-path="${ROOT}/.gitignore"]`)?.getAttribute('data-file-hidden'),
    ).toBe('true')
    expect(
      document.querySelector(`[data-file-path="${ROOT}/README.md"]`)?.getAttribute('data-file-hidden'),
    ).toBeNull()
  })

  it('行上没有大小 / 时间 —— 那两个数只活在详情面上', async () => {
    installPort({
      listDirectory: vi.fn(async () => ({
        success: true,
        entries: [{ name: 'README.md', path: `${ROOT}/README.md`, type: 'file' as const, size: 4096, mtimeMs: 1_700_000_000_000 }],
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const row = document.querySelector(`[data-file-path="${ROOT}/README.md"]`)
    expect(row?.textContent).toBe('README.md')
  })

  it('行尾那枚常驻 reveal 钮已随本批退役(它的活儿挪进了详情面)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    expect(screen.queryAllByLabelText('在文件管理器中显示')).toEqual([])
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

describe('详情:双击任一行', () => {
  /** 双击一行(先一次 click 走单击那条路,再一次带 detail:2 的 click,最后 dblClick)。 */
  async function openDetail(name: string) {
    const row = screen.getByText(name)
    fireEvent.click(row, { detail: 1 })
    fireEvent.click(row, { detail: 2 })
    fireEvent.doubleClick(row)
    await waitFor(() => expect(screen.getByTestId('files-detail')).toBeTruthy())
  }

  it('双击文件:四格都在(类型 / 大小 / 修改时间 / 完整路径),数走 stat 那一口', async () => {
    const port = installPort({
      stat: vi.fn(async () => ({
        success: true,
        type: 'file' as const,
        path: `${ROOT}/README.md`,
        size: 4096,
        mtimeMs: Date.UTC(2026, 7, 31, 4, 5),
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')

    expect(port.stat).toHaveBeenCalledWith(`${ROOT}/README.md`)
    expect(screen.getByText('类型')).toBeTruthy()
    expect(screen.getByText('文件')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId('files-detail-size').textContent).toBe('4.0 KB'),
    )
    // 时间是绝对时间(带年),不是「昨天」那种相对说法。
    expect(screen.getByTestId('files-detail-mtime').textContent).toMatch(/2026/)
    expect(screen.getByText('完整路径')).toBeTruthy()
    /*
     * 在详情面**里面**找那条路径:双击文件时第一下已经把预览打开了(单击语义
     * 本批一个字没改),预览头上也写着同一条路径 —— 屏幕上有两份是**预期**,
     * 不是重复渲染。
     */
    expect(within(screen.getByTestId('files-detail')).getByText(`${ROOT}/README.md`)).toBeTruthy()
  })

  it('双击目录:一样出详情,类型说「目录」,而且没有「预览打开」那颗钮', async () => {
    installPort({
      stat: vi.fn(async () => ({
        success: true,
        type: 'directory' as const,
        path: `${ROOT}/packages`,
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    await openDetail('packages')

    expect(screen.getByText('目录')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '预览打开' })).toBeNull()
    // 后端没给大小 / 时间就画缺席格,**不拿 0 B 和 1970 顶**。
    expect(screen.getByTestId('files-detail-size').textContent).toBe('—')
    expect(screen.getByTestId('files-detail-mtime').textContent).toBe('—')
  })

  it('双击一个目录只翻一次展开 —— 两次 click 里的第二次被 e.detail 挡掉', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    await openDetail('packages')
    // 展开了(而不是展开又收起),所以那一层被拉了回来。
    expect(port.listDirectory).toHaveBeenCalledWith(`${ROOT}/packages`)
  })

  it('「在文件管理器中显示」把整条路径交下去;做不到弹一条 error', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示' }))
    await waitFor(() => expect(port.reveal).toHaveBeenCalledWith(`${ROOT}/README.md`))
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('reveal 做不到就弹一条 error —— 点了没反应是最坏的那一种', async () => {
    installPort({
      reveal: vi.fn(async () => ({
        success: false,
        error: 'Revealing local files is not available in the web server runtime.',
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示' }))
    await waitFor(() =>
      expect(useNotifyStore.getState().items.map((x) => [x.level, x.title])).toEqual([
        ['error', '没能在文件管理器中定位'],
      ]),
    )
  })

  it('复制路径:就地反馈(⧉ 换 ✓),**不产生一条通知**', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')

    const copy = screen.getByRole('button', { name: '复制路径' })
    expect(copy.querySelector('svg')?.getAttribute('class')).toBeTruthy()
    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ROOT}/README.md`))
    // 反馈落在被按的那颗钮上,而不是通知中心里。
    await waitFor(() =>
      expect(document.body.textContent).toContain('已复制'),
    )
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('stat 失败:说读不到,并留下后端原话(不借预览那句「这个文件」)', async () => {
    installPort({
      stat: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied, stat' })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    await openDetail('packages')
    await waitFor(() => expect(screen.getByText('没有权限读这一项的信息')).toBeTruthy())
    expect(screen.getByText('EACCES: permission denied, stat')).toBeTruthy()
  })

  it('Esc 关掉详情(逃生口)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('files-detail')).toBeNull())
  })
})
