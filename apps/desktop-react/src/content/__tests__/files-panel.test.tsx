import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FilesDirectoryEntry } from '@shared/ipc/files'
import { renderContent } from '../index'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { FILES_ROW_H, useFilesSource } from '../../data/files-source'
import { useFileOpenMode } from '../../data/file-open-mode'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'
import { useNotifyStore } from '../../services/notify-store'
import { ONETHING_DIR, seedSessionsSource } from '../../data/__fixtures__/sessions'

/**
 * 文件面板。这一批验的是**面板长在真数据上** + **定稿那六处改判**:
 * 二形标识 / 打开与选中分离 / 行菜单七选 / 详情浮层 / 窗口化 / 三种「还没有内容」。
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
  useFileOpenMode.setState({ mode: 'panel' })
})

/**
 * 头上那条路径此刻说的是什么。
 *
 * **取件口是 `data-root` 而不是 textContent**:面包屑的中段现在会折成 `…`,
 * 折过之后屏幕上那串字就不再逐字等于路径了。屏幕说「我在哪儿」,属性说
 * 「那条路径本身」—— 这里问的是后者。
 */
function shownRoot(): string {
  return screen.getByTestId('files-root').getAttribute('data-root') ?? ''
}

function row(path: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-file-path="${path}"]`)
  if (!el) throw new Error(`树上没有这一行:${path}`)
  return el
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

  it('会话没有工作目录时退主目录,并**说出来**(那句话现在长在告知条上)', async () => {
    useExposeStore.setState({ currentSessionId: SESSION_WITHOUT_DIR })
    installPort({
      listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() =>
      expect(screen.getByText('这条会话没有工作目录,显示的是主目录')).toBeTruthy(),
    )
    expect(screen.getByTestId('files-no-workdir')).toBeTruthy()
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

  it('深路径把**中段**折成 `…`;那条完整路径仍然原样挂在 data-root 上', async () => {
    const deep = '/a/b/c/d/e/f'
    useExposeStore.setState({ currentSessionId: SESSION_WITH_DIR })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(shownRoot()).toBe(ROOT))
    await act(async () => {
      await useFilesSource.getState().navigateRoot(deep)
    })
    await waitFor(() => expect(shownRoot()).toBe(deep))
    const crumbs = screen.getByTestId('files-root')
    expect(crumbs.textContent).toContain('…')
    // 折起来的是中段:首段与末两段还在,中间那两段不在。
    expect(within(crumbs).getByRole('button', { name: 'a' })).toBeTruthy()
    expect(within(crumbs).queryByRole('button', { name: 'c' })).toBeNull()
    expect(crumbs.textContent).toContain('f')
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
    // 走上去之后那条告知条不该冒出来 —— 这里既不是会话的根也不是主目录。
    expect(screen.queryByTestId('files-no-workdir')).toBeNull()
  })
})

describe('行:二形标识(字标 | 图标)', () => {
  it('目录走图标那一形(展开换 FolderOpen),语言走字标那一形', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())

    const dir = row(`${ROOT}/packages`)
    const md = row(`${ROOT}/README.md`)
    expect(dir.getAttribute('data-file-form')).toBe('icon')
    expect(dir.getAttribute('data-file-icon')).toBe('Folder')
    expect(dir.getAttribute('data-file-tone')).toBe('dir')
    // 定稿改判:.md 不再是「一张带尖括号的纸」,而是一枚品牌字标。
    expect(md.getAttribute('data-file-form')).toBe('brand')
    expect(md.getAttribute('data-file-brand')).toBe('md')
    expect(md.getAttribute('data-file-icon')).toBeNull()
    expect(md.textContent).toContain('MD')

    fireEvent.click(screen.getByText('packages'))
    await waitFor(() =>
      expect(row(`${ROOT}/packages`).getAttribute('data-file-icon')).toBe('FolderOpen'),
    )
    fireEvent.click(screen.getByText('core'))
    await waitFor(() => expect(screen.getByText('engine.ts')).toBeTruthy())
    expect(row(`${ROOT}/packages/core/engine.ts`).getAttribute('data-file-brand')).toBe('ts')
  })

  it('字标的底色与字色**一个字面值都没有** —— 只有两条 var() 引用', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const badge = row(`${ROOT}/README.md`).querySelector('span[style]')
    expect(badge?.getAttribute('style')).toContain('var(--fb-md-bg)')
    expect(badge?.getAttribute('style')).toContain('var(--fb-md-fg)')
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
    expect(row(`${ROOT}/.gitignore`).getAttribute('data-file-hidden')).toBe('true')
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-hidden')).toBeNull()
  })

  it('行上没有大小 / 时间 —— 那两个数只活在详情浮层上', async () => {
    installPort({
      listDirectory: vi.fn(async () => ({
        success: true,
        entries: [
          {
            name: 'README.md',
            path: `${ROOT}/README.md`,
            type: 'file' as const,
            size: 4096,
            mtimeMs: 1_700_000_000_000,
          },
        ],
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    // 行上只有字标那两个字母 + 名字,一个数都没有。
    expect(row(`${ROOT}/README.md`).textContent).toBe('MDREADME.md')
  })

  it('行尾那枚常驻 reveal 钮已退役(它的活儿在详情浮层与行菜单里)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    expect(screen.queryAllByLabelText('在文件管理器中显示')).toEqual([])
  })
})

describe('打开 ≠ 选中', () => {
  it('点一行 = 选中它;点开一个文件 = 那一行**另外**挂一颗打开点', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())

    // 点目录:选中了,但没有任何一行是「打开」的(目录没有内容可打开)。
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(row(`${ROOT}/packages`).getAttribute('data-file-selected')).toBe('true'))
    expect(document.querySelector('[data-testid="files-open-dot"]')).toBeNull()

    // 点文件:它既被选中,也被打开 —— 两格各说各的。
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBe('true'))
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-selected')).toBe('true')
    // 选中挪到别处,「打开」不跟着走 —— 这正是两件事的分水岭。
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(row(`${ROOT}/packages`).getAttribute('data-file-selected')).toBe('true'))
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBe('true')
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-selected')).toBeNull()
  })
})

/**
 * 树不卸载铁律:tree state ⟂ viewer state。开一个文件、展开一层、卷动一屏 ——
 * 这三件事都**不许**让还在场的那些行重新挂载(重挂 = 丢焦点、丢动画、丢一切
 * 挂在 DOM 上的东西)。判据是**元素同一性**:同一个 path 前后是同一个节点。
 */
describe('树不卸载:零重挂', () => {
  it('开一个文件不重挂树(打开态是 viewer state,key 不跟着它变)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const before = row(`${ROOT}/packages`)

    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('markdown')).toBeTruthy())
    expect(row(`${ROOT}/packages`)).toBe(before)

    fireEvent.click(screen.getByLabelText('关闭预览'))
    await waitFor(() => expect(screen.queryByText('markdown')).toBeNull())
    expect(row(`${ROOT}/packages`)).toBe(before)
  })

  it('展开一层改的是扁平化行数组,**不是**重建一棵组件树', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const readme = row(`${ROOT}/README.md`)

    // 展开 packages 会在 README.md **前面**插一行,行序变了 —— 但 key 是路径。
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    expect(row(`${ROOT}/README.md`)).toBe(readme)
  })
})

describe('树:懒展开与全部收起', () => {
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

  it('「全部收起」一层不留,**但不清缓存**(再展开不重新问后端)', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    // 一层都没展开时那颗钮是禁用的:没有可收的东西。
    expect(screen.getByLabelText('全部收起')).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('全部收起'))
    await waitFor(() => expect(screen.queryByText('core')).toBeNull())

    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    expect(port.listDirectory).toHaveBeenCalledTimes(2)
  })
})

describe('三种「还没有内容」各说各的', () => {
  it('空目录一行斜体灰,占一格正常行高', async () => {
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('这个目录是空的')).toBeTruthy())
  })

  it('懒展开画的是骨架短横,不是「正在读取…」四个字', async () => {
    let release: (() => void) | undefined
    installPort({
      listDirectory: vi.fn(
        () =>
          new Promise<{ success: true; entries: FilesDirectoryEntry[] }>((resolve) => {
            release = () => resolve({ success: true, entries: [entry('a.ts', 'file')] })
          }),
      ),
    })
    render(<>{renderContent('files')}</>)
    // 报给读屏的仍然是那句话(骨架是画法,不是把事实藏起来)。
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('正在读取…')
    expect(screen.queryByText('正在读取…')).toBeNull()
    await act(async () => {
      release?.()
    })
  })

  it('没权限说没权限,带后端原话,并且**就地给一颗「重试」**(只重拉这一层)', async () => {
    const listDirectory = vi.fn(async () => ({
      success: false as const,
      error: 'EACCES: permission denied, scandir',
    }))
    installPort({ listDirectory })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('没有权限读这个目录')).toBeTruthy())
    expect(screen.getByText('EACCES: permission denied, scandir')).toBeTruthy()

    listDirectory.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith(ROOT))
  })

  it('别的失败说读不到 —— 与「空」「没权限」三句不同的话', async () => {
    installPort({ listDirectory: vi.fn(async () => ({ success: false, error: 'boom' })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('读不到这个目录')).toBeTruthy())
  })
})

describe('无工作目录:告知条 + 绑定', () => {
  it('「绑定…」是一行输入(壳里没有 dialog 桥),打的是 updateWorkingDirectory', async () => {
    useExposeStore.setState({ currentSessionId: SESSION_WITHOUT_DIR })
    const setWorkingDirectory = vi.fn(async () => ({ ok: true as const }))
    useSessionsSource.setState({ setWorkingDirectory })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByTestId('files-no-workdir')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '绑定…' }))
    const input = screen.getByLabelText('输入工作目录的绝对路径')
    fireEvent.change(input, { target: { value: '/work/here' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(setWorkingDirectory).toHaveBeenCalledWith(SESSION_WITHOUT_DIR, '/work/here'),
    )
  })

  it('绑不上就**留在原地说**:输入行不收,后端原话跟在后面', async () => {
    useExposeStore.setState({ currentSessionId: SESSION_WITHOUT_DIR })
    useSessionsSource.setState({
      setWorkingDirectory: vi.fn(async () => ({ ok: false as const, error: 'sandbox root' })),
    })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByTestId('files-no-workdir')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '绑定…' }))
    fireEvent.change(screen.getByLabelText('输入工作目录的绝对路径'), {
      target: { value: '/nope' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => expect(screen.getByText('没能绑定工作目录')).toBeTruthy())
    expect(screen.getByText('sandbox root')).toBeTruthy()
    // 刚打的那条路径还在,改一个字就能重试。
    expect(screen.getByLabelText('输入工作目录的绝对路径')).toHaveProperty('value', '/nope')
  })
})

describe('行菜单:行尾 ⋯ 与右键是同一张表', () => {
  async function openMenu(path: string) {
    fireEvent.contextMenu(row(path))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  }

  it('右键出菜单,行尾 ⋯ 出的是同一张 —— 两个手势一张表', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())

    await openMenu(`${ROOT}/README.md`)
    const byContext = screen.getAllByRole('menuitem').map((el) => el.textContent)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.click(document.querySelector(`[data-file-more="${ROOT}/README.md"]`)!)
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(byContext)
  })

  it('「打开方式」七档全在,勾在当下那一档,选了就记住', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)

    const options = screen.getAllByRole('menuitemradio')
    expect(options).toHaveLength(7)
    expect(options.map((el) => el.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
      'false',
    ])

    fireEvent.click(screen.getByText('浮窗'))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('float'))
  })

  it('只有「面板内」真接上了 —— 其余六档各带一句「还没接上」+ 一句注脚', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)

    expect(screen.getAllByText('还没接上')).toHaveLength(6)
    expect(
      screen.getByText('目前只有「面板内」真能打开;其余几档先把你的选择记下来。'),
    ).toBeTruthy()
  })

  it('目录那一行菜单说「展开 / 收起」,文件说「打开查看」', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())

    await openMenu(`${ROOT}/packages`)
    expect(screen.getByText('展开')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await openMenu(`${ROOT}/README.md`)
    expect(screen.getByText('打开查看')).toBeTruthy()
  })

  it('复制路径:**菜单不关**,那一条就地变「已复制路径」,零通知', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)

    fireEvent.click(screen.getByText('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ROOT}/README.md`))
    // 反馈落在被按的那一条上,所以菜单必须还开着。
    await waitFor(() => expect(screen.getByText('已复制路径')).toBeTruthy())
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('菜单里的「在文件管理器中显示」把整条路径交下去', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)
    fireEvent.click(screen.getByText('在文件管理器中显示'))
    await waitFor(() => expect(port.reveal).toHaveBeenCalledWith(`${ROOT}/README.md`))
  })
})

describe('详情:附属浮层(不是打断式对话框)', () => {
  /** 双击一行(先一次 click 走单击那条路,再一次带 detail:2 的 click,最后 dblClick)。 */
  async function openDetail(name: string) {
    const target = screen.getByText(name)
    fireEvent.click(target, { detail: 1 })
    fireEvent.click(target, { detail: 2 })
    fireEvent.doubleClick(target)
    await waitFor(() => expect(screen.getByTestId('files-detail')).toBeTruthy())
  }

  it('它是 role=dialog 但**没有 aria-modal**,而且不压遮罩 —— 树还在', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')

    const pop = screen.getByRole('dialog')
    expect(pop.getAttribute('aria-modal')).toBeNull()
    // 树没有被盖掉:那一行仍然在文档里,读屏与鼠标都够得着。
    expect(row(`${ROOT}/packages`)).toBeTruthy()
  })

  it('⌘I 是它的第二个入口(全局 keymap 里没人占 `i`,所以这一下落在行上)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.keyDown(row(`${ROOT}/README.md`), { key: 'i', metaKey: true })
    await waitFor(() => expect(screen.getByTestId('files-detail')).toBeTruthy())
  })

  it('三格元信息 + 一条完整路径;数走 stat 那一口', async () => {
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
    /*
     * 在详情面**里面**找那条路径:双击文件时第一下已经把预览打开了(单击语义
     * 本批一个字没改),预览头上也写着同一条路径 —— 屏幕上有两份是**预期**。
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

  it('复制路径:就地反馈(⧉ 换 ✓ 并转 accent),**不产生一条通知**', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')

    fireEvent.click(within(screen.getByTestId('files-detail')).getByRole('button', { name: /复制路径/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ROOT}/README.md`))
    await waitFor(() =>
      expect(within(screen.getByTestId('files-detail')).getByText('已复制')).toBeTruthy(),
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

  it('点浮层外面就散(它是附属,不是打断)', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('files-detail')).toBeNull())
  })
})

describe('窗口化:大目录只画看得见的那一段', () => {
  const BIG = 600

  it('六百行的目录只渲染窗口内的那几十行,而卷轴仍然是整表那么长', async () => {
    installPort({
      listDirectory: vi.fn(async () => ({
        success: true,
        entries: Array.from({ length: BIG }, (_, i) => entry(`file-${i}.ts`, 'file')),
      })),
    })
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('file-0.ts')).toBeTruthy())

    // jsdom 不排版,所以视口高度得手动给一个 —— 量的是**窗口算术**,不是浏览器排版。
    const body = screen.getByTestId('files-tree')
    Object.defineProperty(body, 'clientHeight', { value: 10 * FILES_ROW_H, configurable: true })
    await act(async () => {
      fireEvent.scroll(body, { target: { scrollTop: 0 } })
    })

    const rendered = () => document.querySelectorAll('[data-file-path]').length
    // 可视 10 行 +1 + 下缓冲 8 = 19 行,远少于 600。
    expect(rendered()).toBe(19)
    expect(rendered()).toBeLessThan(BIG)

    // 卷到中间:画出来的行换了一批,数目仍然是「窗口 + 上下缓冲」。
    await act(async () => {
      fireEvent.scroll(body, { target: { scrollTop: 300 * FILES_ROW_H } })
    })
    expect(rendered()).toBe(27)
    expect(document.querySelector('[data-file-path$="file-0.ts"]')).toBeNull()
    expect(document.querySelector(`[data-file-path="${ROOT}/file-300.ts"]`)).toBeTruthy()
  })
})

describe('预览', () => {
  it('点文件出只读预览:正文走的是聊天区那条代码块渲染路径', async () => {
    const port = installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('export const engine = 1')).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText('这是二进制文件,没法按文本预览')).toBeTruthy())
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

  it('关掉预览回到树,那颗打开点也跟着灭', async () => {
    installPort()
    render(<>{renderContent('files')}</>)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByText('markdown')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('关闭预览'))
    await waitFor(() => expect(screen.queryByText('markdown')).toBeNull())
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBeNull()
  })
})
