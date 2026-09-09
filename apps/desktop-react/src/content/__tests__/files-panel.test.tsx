import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemo } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FilesDirectoryEntry } from '@shared/ipc/files'
import { FilesPanel, retargetFilesRoot } from '../FilesPanel'
import { dirRef, DIR_KIND } from '../kinds/dir-ref'
import { openSessionDirectory } from '../files-launcher'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { FILES_ROW_H, useFilesSource } from '../../data/files-source'
import { useViewerSource } from '../../data/viewer-source'
import { ViewerCloseHost } from '../viewer/close-hub'
import { FILE_OPEN_MODES, FILE_OPEN_MODE_LABELS, useFileOpenMode } from '../../data/file-open-mode'
import { t } from '../../i18n'
import { sessionMutation, useSessionsSource } from '../../data/sessions-source'
import { configureSessionsPort } from '../../data/sessions-port'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'
import { useNotifyStore } from '../../services/notify-store'
import { ONETHING_DIR, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { FOCUS_SCOPES } from '../../focus/scopes'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { useWorkbenchStore } from '../../workbench/store'
import { focusIntoScopeOf } from '../../workbench/kinds'
import { leavesOf, refIdsOf } from '../../workbench/tree'
import '../kinds'

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
    saveContent: vi.fn(async () => ({ success: true })),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
    ...overrides,
  }
  configureFilesPort(port)
  return port
}

/**
 * 会话源那两口**真的动作**。有几条用例会 `setState` 换掉它们(那是 zustand 里
 * 覆盖一格的写法,不是「这一条用例内」的作用域),所以每条用例开头装回去 ——
 * 不装的话,后面那条要走**真路**的用例会静默跑在上一条留下的假动作上。
 */
const REAL_SESSION_ACTIONS = {
  setWorkingDirectory: useSessionsSource.getState().setWorkingDirectory,
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useSessionsSource.setState(REAL_SESSION_ACTIONS)
  seedSessionsSource()
  /*
   * W5-b 裁定 3:文件树的根跟的是**环境会话**那一格(粘性 —— 焦点落到文件叶
   * 不换根),不是「当前会话」。判词在 `data/files-source.useSessionCwd` 上。
   */
  useExposeStore.setState({ envSessionId: SESSION_WITH_DIR })
  useFilesSource.getState().reset()
  useViewerSource.getState().reset()
  // 拼贴台也是模块级单例:一份用例开着的那一格不该被下一份看见(分栏那一格
  // `panelPath` 尤其 —— 它是「此刻在看谁」,泄漏过去下一条用例的第一帧就是脏的)。
  useWorkbenchStore.getState().reset()
  useNotifyStore.setState({ items: [] })
  useFileOpenMode.setState({ mode: 'panel' })
})

// 响应链是模块级单例:一份用例留下的作用域不该被下一份看见。
afterEach(() => {
  focusTree.reset()
})

/**
 * 这块面 **+ 外壳上那一个派发器**(09-02 R1)。
 *
 * 面里的浮层(行菜单 / 详情浮层)不再自己挂 Esc 监听 —— 它们各是响应链上的一格,
 * 认领这一下的是唯一那个 window keydown。单独渲染一块面去按 Esc,等于在一台
 * 没有外壳的机器上按键;`FocusDispatchHarness` 补的就是那一格,它零 DOM。
 */
/**
 * **这块面的根由树说**(W6-a):文件面板不再是一块面(`panel:files` 退役),
 * 而是**一族**面 —— 一个目录一份 `dir:<绝对路径>`。所以夹具先在中央区
 * 摆一格那样的 tab,再照真机那样**从树上读根**渲染它:面包屑回跳换的是那一格
 * tab 的 ref,而屏幕跟着换 —— 那条链在夹具里也得是真的,不然回跳那两条用例
 * 量的是一台不存在的机器。
 */
function FilesHarness() {
  const regions = useWorkbenchStore((st) => st.regions)
  const root = useMemo(() => {
    // 哪个区域都认(启动瓦出厂落**左架子**,而 `renderFiles` 落中央区)。
    for (const tree of Object.values(regions)) {
      for (const leaf of leavesOf(tree)) {
        for (const tab of leaf.tabs) if (tab.kind === DIR_KIND) return tab.key
      }
    }
    return null
  }, [regions])
  return root === null ? null : <FilesPanel root={root} />
}

function renderFiles(root: string = ROOT) {
  act(() => {
    useWorkbenchStore.getState().openRef(dirRef(root))
  })
  return render(
    <>
      <FocusDispatchHarness />
      <FilesHarness />
    </>,
  )
}

/**
 * 走**那块启动瓦**那条路开出来的一份(W6-a):它先问「这条会话的工作目录是哪儿」
 * (会话没绑就展 `~`),再开一格 `dir:<那个目录>`。告知条(没绑工作目录)
 * 的在场判据要它 —— 那句话只在**会话自己那一棵**上说。
 */
async function renderSessionFiles() {
  const view = render(
    <>
      <FocusDispatchHarness />
      <FilesHarness />
    </>,
  )
  await act(async () => {
    await openSessionDirectory()
  })
  return view
}

/**
 * 头上那条路径此刻说的是什么。
 *
 * **取件口是 `data-root` 而不是 textContent**:面包屑的中段现在会折成 `…`,
 * 折过之后屏幕上那串字就不再逐字等于路径了。屏幕说「我在哪儿」,属性说
 * 「那条路径本身」—— 这里问的是后者。
 *
 * **`files-root` 这个 testid 不跟着种类改名走**(K2b-1):种类叫 `dir` 了,但这一格
 * 是 DOM 把手 —— 三条真机门也按它取件。把手与种类名是两件事,改它只会白白动脚本。
 */
function shownRoot(): string {
  return screen.getByTestId('files-root').getAttribute('data-root') ?? ''
}

function row(path: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-file-path="${path}"]`)
  if (!el) throw new Error(`树上没有这一行:${path}`)
  return el
}

/**
 * 分栏里那台查看器在看哪个文件。
 *
 * W1:身份从檐上那格 `viewer-name` 搬去了 `stage/live-title`(檐没有了),
 * 但查看器身上仍然有一格**稳定的取件口** `data-viewer-path` —— 门与用例要的
 * 一直是「它此刻在看谁」,那一格就是答案。
 */
function viewerPath(): string | null {
  return (
    document.querySelector('[data-testid="file-viewer"]')?.getAttribute('data-viewer-path') ?? null
  )
}

/**
 * 关掉一个文件。**走右键菜单里那一行**(W1;动作单产地)——
 * 查看器身上那颗 ✕ 随「一格一檐」退役了,分栏那一档也走这条路。
 */
/** 开一行的右键菜单(顶层那份;describe 里那只 `openMenu` 只在它自己那一组里)。 */
async function rowMenu(path: string): Promise<void> {
  fireEvent.contextMenu(row(path))
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
}

async function closeViaMenu(path: string): Promise<void> {
  fireEvent.contextMenu(row(path))
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  fireEvent.click(screen.getByText('关闭'))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

/** 内容表那一格换人了没有 —— 这条在 FilesMock 还挂着时必红。 */
describe('内容表:files 这一格是真面板', () => {
  it('`dir` 那一种画的是真树,不是写死的三行', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    // FilesMock 那三行里唯一不可能来自本用例假端口的字面量:它在场就说明旧面板还在。
    expect(screen.queryByText('model-capability.ts')).toBeNull()
    // 真面板才有的那件:头上那条真路径。
    expect(shownRoot()).toBe(ROOT)
  })

  /* 08-31「IDE 紧凑树」:面板内那个与 tab 重名的大标题退役。 */
  it('面板里不再有第二个「文件」大标题(tab 已经叫这个名字)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    expect(screen.queryByRole('heading', { name: '文件' })).toBeNull()
  })
})

/**
 * **根不再跟着会话走 —— 它是这一格内容的身份**(W6-a,设计 §3)。
 *
 * 「会话的工作目录是哪儿」这件事只问一次,而且是**那块启动瓦**问的
 * (`content/files-launcher.openSessionDirectory`):问完开一格
 * `dir:<那个目录>`。这一组因此从「面板会不会跟着会话换根」改成
 * 「那块瓦开出来的是不是那个目录」。
 */
describe('根:目录那块启动瓦开出来的那一格', () => {
  it('点瓦 = 开一格 `dir:<活跃会话的工作目录>`,面板头上如实显示', async () => {
    const port = installPort()
    await renderSessionFiles()
    await waitFor(() => expect(shownRoot()).toBe(ROOT))
    // 出厂摆法是**左架子**(W6-a §8),所以那一格落在 `edge:left` 那棵树上。
    const allRefs = Object.values(useWorkbenchStore.getState().regions)
      .flatMap((tree) => refIdsOf(tree))
    expect(allRefs).toContain(`${DIR_KIND}:${ROOT}`)
    expect(port.listDirectory).toHaveBeenCalledWith(ROOT)
    // 会话带着工作目录 = 不必问后端展 `~`。
    expect(port.stat).not.toHaveBeenCalled()
  })

  it('会话没有工作目录时退主目录,并**说出来**(那句话现在长在告知条上)', async () => {
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    installPort({
      listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    })
    await renderSessionFiles()
    await waitFor(() =>
      expect(screen.getByText('这条会话没有工作目录,显示的是主目录')).toBeTruthy(),
    )
    expect(screen.getByTestId('files-no-workdir')).toBeTruthy()
    expect(shownRoot()).toBe('/home/me')
  })

  it('用户自己打开的**别的**目录不说那句话(它与这条会话无关)', async () => {
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    installPort()
    // 先把会话那一棵解析出来(告知条的在场判据要它),再另开一个目录。
    await act(async () => {
      await openSessionDirectory()
    })
    renderFiles(`${ROOT}/packages`)
    await waitFor(() => expect(shownRoot()).toBe(`${ROOT}/packages`))
    expect(screen.queryByTestId('files-no-workdir')).toBeNull()
  })
})

describe('面包屑:各段可点回跳', () => {
  it('路径逐段画出来,尾段是当前所在(不是钮)', async () => {
    installPort()
    renderFiles()
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
    useExposeStore.setState({ envSessionId: SESSION_WITH_DIR })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    renderFiles()
    await waitFor(() => expect(shownRoot()).toBe(ROOT))
    // W6-a:回跳 = 把这一格 tab 换成那个目录(`navigateRoot` 那条老路退役)。
    await act(async () => {
      retargetFilesRoot(ROOT, deep)
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
    renderFiles()
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
    renderFiles()
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
    renderFiles()
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
    renderFiles()
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
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    // 行上只有字标那两个字母 + 名字,一个数都没有。
    expect(row(`${ROOT}/README.md`).textContent).toBe('MDREADME.md')
  })

  it('行尾那枚常驻 reveal 钮已退役(它的活儿在详情浮层与行菜单里)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    expect(screen.queryAllByLabelText('在文件管理器中显示')).toEqual([])
  })
})

describe('打开 ≠ 选中', () => {
  it('点一行 = 选中它;点开一个文件 = 那一行**另外**挂一颗打开点', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())

    // 点目录:选中了,但没有任何一行是「打开」的(目录没有内容可打开)。
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(row(`${ROOT}/packages`).getAttribute('data-file-selected')).toBe('true'))
    expect(document.querySelector('[data-testid="files-open-dot"]')).toBeNull()

    // 点文件:它既被选中,也被打开 —— 两格各说各的。
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBe('shown'))
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-selected')).toBe('true')
    // 选中挪到别处,「打开」不跟着走 —— 这正是两件事的分水岭。
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(row(`${ROOT}/packages`).getAttribute('data-file-selected')).toBe('true'))
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBe('shown')
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-selected')).toBeNull()
  })
})

/**
 * 树不卸载铁律:tree state ⟂ viewer state。开一个文件、**换一个文件**、关掉查看器、
 * 展开一层、卷动一屏 —— 这些都**不许**让还在场的那些行重新挂载(重挂 = 丢焦点、
 * 丢动画、丢一切挂在 DOM 上的东西)。判据是**元素同一性**:同一个 path 前后是
 * 同一个节点。F1 把它从「开 / 关」两下扩到「开 / 换 / 关」三连 —— 分栏是新形状,
 * 而这条铁律正是那个形状要保住的东西。
 */
describe('树不卸载:零重挂', () => {
  /*
   * ── 病型 A 的 DOM 侧反证(7d)────────────────────────────────────────────
   * 真机探针修前采到:点一下「重新读取」,5 行掉到 3 行、出现骨架、节点身份全换。
   * 这一条把那三件事在 jsdom 里各钉一句 —— 刻意让重拉**停在半路**,断言那一刻
   * 屏幕上的行还在、还是同一批 DOM 节点、一条骨架都没有。
   * 把 `refresh()` 里那句 `set({ dirs: {} })` 换回去必红。
   */
  it('点「重新读取」:重拉在飞时旧行还在屏上,同一批 DOM 节点,零骨架', async () => {
    /** 重拉时每一层各扣一发在手上,逐层放行 —— 扣的是**那一层自己**的答案。 */
    const held = new Map<string, () => void>()
    let live = false
    installPort({
      listDirectory: vi.fn((path: string) => {
        const answer = TREE[path]
          ? { success: true as const, entries: TREE[path] }
          : { success: false as const, error: 'Failed to list directory' }
        if (!live) return Promise.resolve(answer)
        return new Promise<typeof answer>((resolve) => {
          held.set(path, () => resolve(answer))
        })
      }),
    })
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    const kept = [row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]

    live = true
    await act(async () => {
      fireEvent.click(screen.getByLabelText('重新读取'))
      await Promise.resolve()
    })

    // 重拉还没回来的这一刻:三行都在、都是同一个节点、树里没有 role=status 的骨架。
    expect([row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]).toEqual(
      kept,
    )
    expect(within(screen.getByTestId('files-tree')).queryByRole('status')).toBeNull()

    await act(async () => {
      for (const release of held.values()) release()
      await Promise.resolve()
    })
    // 答案没变 → `sameEntries` 让 kernel 留住上一个数组 → 连行都没重渲一遍。
    expect([row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]).toEqual(
      kept,
    )
  })

  it('开一个文件不重挂树(打开态是 viewer state,key 不跟着它变)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const before = row(`${ROOT}/packages`)

    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())
    expect(row(`${ROOT}/packages`)).toBe(before)

    /*
     * W1:查看器身上那颗 ✕ 没有了(一格一檐)。**关一个文件的路是右键菜单里
     * 那一行**(动作单产地),分栏那一档也走它 —— 于是这一条走的仍然是用户
     * 真会走的那条路,而不是一个只有测试知道的后门。
     */
    await closeViaMenu(`${ROOT}/README.md`)
    await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
    expect(row(`${ROOT}/packages`)).toBe(before)
  })

  it('开 → 换 → 关三连,树上那些行**一个都没有重挂**(分栏的硬约束)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    // 先展一层,好让「还在场的行」不止根那一层。
    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    const kept = [row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]

    // ① 开
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() =>
      expect(viewerPath()).toBe(`${ROOT}/README.md`),
    )
    expect([row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]).toEqual(
      kept,
    )

    // ② 换(就地换内容,不是重开一块面)
    fireEvent.click(screen.getByText('core'))
    await waitFor(() => expect(screen.getByText('engine.ts')).toBeTruthy())
    fireEvent.click(screen.getByText('engine.ts'))
    await waitFor(() =>
      expect(viewerPath()).toBe(`${ROOT}/packages/core/engine.ts`),
    )
    expect([row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]).toEqual(
      kept,
    )

    // ③ 关
    await closeViaMenu(`${ROOT}/packages/core/engine.ts`)
    await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
    expect([row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]).toEqual(
      kept,
    )
  })

  it('展开一层改的是扁平化行数组,**不是**重建一棵组件树', async () => {
    installPort()
    renderFiles()
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
    renderFiles()
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
    renderFiles()
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
    renderFiles()
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
    renderFiles()
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
    renderFiles()
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
    await renderSessionFiles()
    await waitFor(() => expect(screen.getByText('没有权限读这个目录')).toBeTruthy())
    expect(screen.getByText('EACCES: permission denied, scandir')).toBeTruthy()

    listDirectory.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith(ROOT))
  })

  it('别的失败说读不到 —— 与「空」「没权限」三句不同的话', async () => {
    installPort({ listDirectory: vi.fn(async () => ({ success: false, error: 'boom' })) })
    await renderSessionFiles()
    await waitFor(() => expect(screen.getByText('读不到这个目录')).toBeTruthy())
  })
})

describe('无工作目录:告知条 + 绑定', () => {
  it('「绑定…」是一行输入(壳里没有 dialog 桥),打的是 updateWorkingDirectory', async () => {
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    const setWorkingDirectory = vi.fn(async () => ({ ok: true as const }))
    useSessionsSource.setState({ setWorkingDirectory })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    await renderSessionFiles()
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
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    useSessionsSource.setState({
      setWorkingDirectory: vi.fn(async () => ({ ok: false as const, error: 'sandbox root' })),
    })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    await renderSessionFiles()
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

  /*
   * ── 7d:那颗确认钮的忙态**读自 `sessionMutation`**,不再自己记一格 ────────
   * 这条用例刻意**不 stub** `setWorkingDirectory` —— 它要走的正是产品那条真路:
   * 组件 → store action → `sessionMutation.run({kind:'workdir'})` → 端口。
   * 把 `useAsyncPending(...)` 换回 `useState(busy)` 必红(那一格与真相无关,
   * 而这里断言的是**发起它的那一格**在飞)。
   */
  it('绑定在飞时:确认钮 aria-busy,而且连点不发第二发(律③逐格)', async () => {
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    let release: ((value: { success: true }) => void) | undefined
    const updateWorkingDirectory = vi.fn(
      () => new Promise<{ success: true }>((resolve) => { release = resolve }),
    )
    configureSessionsPort({
      ready: async () => undefined,
      listMeta: async () => ({ success: true, sessions: [] }),
      getSegments: async () => ({ success: true, segments: [] }),
      getMessagesPage: async () => ({ success: true, messages: [] }),
      getUserMarkers: async () => ({ success: true, markers: [] }),
      create: async () => ({ success: false, error: 'not stubbed' }),
      updateWorkingDirectory,
      updatePin: async () => ({ success: true }),
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    await renderSessionFiles()
    await waitFor(() => expect(screen.getByTestId('files-no-workdir')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '绑定…' }))
    fireEvent.change(screen.getByLabelText('输入工作目录的绝对路径'), {
      target: { value: '/work/here' },
    })
    const confirm = screen.getByRole('button', { name: '确定' })
    fireEvent.click(confirm)
    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBe('true'))

    // 连点:第二下打不进去。**挡它的是钮自己的 disabled**(`ui/AsyncButton` 忙起来
    // 立刻禁用 + `aria-busy`),不是 submit 里那道二次闸 —— 这条断言分不出是哪一道
    // (09-02 批 10 记档:此处原注写「钮没有被禁掉」,与代码不符)。二次闸挡的是
    // **↵**:输入框上的回车不经过那颗钮,那条路上没有 disabled 可依。
    fireEvent.click(confirm)
    expect(updateWorkingDirectory).toHaveBeenCalledTimes(1)

    await act(async () => {
      release?.({ success: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByTestId('files-bind-row')).toBeNull())
  })

  /*
   * ── 上一条判不出「谁记的账」,这一条判得出 ────────────────────────────
   * `useState(busy)` 与 `useAsyncPending(...)` 在「自己点自己」那条路上长得一样,
   * 所以上一条对两种写法都绿(诚实记档)。**真正的区别是那一格账在谁手上**:
   *  · 那一发写**不经过这颗钮**发起(别处也能改同一条会话的工作目录)时,
   *    钮照样得说「在飞」—— 自己记一格的写法看不见它;
   *  · 而**别的会话**在飞时它必须不动 —— 律③要的是逐格,不是整面一颗。
   * 把 `useAsyncPending` 换回 `useState` 必红。
   */
  it('忙态是**那一条会话**那一格的账:别处发起也照说,别的会话在飞则不动', async () => {
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    let release: ((value: { success: true }) => void) | undefined
    configureSessionsPort({
      ready: async () => undefined,
      listMeta: async () => ({ success: true, sessions: [] }),
      getSegments: async () => ({ success: true, segments: [] }),
      getMessagesPage: async () => ({ success: true, messages: [] }),
      getUserMarkers: async () => ({ success: true, markers: [] }),
      create: async () => ({ success: false, error: 'not stubbed' }),
      updateWorkingDirectory: () =>
        new Promise<{ success: true }>((resolve) => { release = resolve }),
      updatePin: async () => ({ success: true }),
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })
    installPort({ listDirectory: vi.fn(async () => ({ success: true, entries: [] })) })
    await renderSessionFiles()
    await waitFor(() => expect(screen.getByTestId('files-no-workdir')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '绑定…' }))
    const confirm = screen.getByRole('button', { name: '确定' })
    expect(confirm.getAttribute('aria-busy')).toBeNull()

    // ① **别的会话**在飞:这颗钮一动不动(逐格,不是整面一颗)。
    await act(async () => {
      void sessionMutation.run({ kind: 'workdir', sessionId: '别人', workingDirectory: '/x' })
      await Promise.resolve()
    })
    expect(confirm.getAttribute('aria-busy')).toBeNull()
    const releaseOther = release
    release = undefined

    // ② **这一条会话**在飞、而且不是这颗钮发起的:它照样说「在飞」。
    await act(async () => {
      void sessionMutation.run({
        kind: 'workdir',
        sessionId: SESSION_WITHOUT_DIR,
        workingDirectory: '/y',
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBe('true'))

    await act(async () => {
      releaseOther?.({ success: true })
      release?.({ success: true })
      await Promise.resolve()
    })
  })
})

describe('行菜单:行尾 ⋯ 与右键是同一张表', () => {
  async function openMenu(path: string) {
    fireEvent.contextMenu(row(path))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  }

  it('右键出菜单,行尾 ⋯ 出的是同一张 —— 两个手势一张表', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())

    await openMenu(`${ROOT}/README.md`)
    const byContext = screen.getAllByRole('menuitem').map((el) => el.textContent)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.click(screen.getByTestId(`files-more:${ROOT}/README.md`))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(byContext)
  })

  /**
   * **「打开方式」那七格单选**(W7-c 起它前面还站着「视图」那两格)。
   * markdown 那一型自述了两档看法,而两组在无障碍树上是同一个角色 ——
   * 这一口按 `FILE_OPEN_MODE_LABELS` 的文案认人,所以将来再多一节也不受影响。
   */
  function openModeOptions() {
    const labels = new Set(FILE_OPEN_MODES.map((m) => t(FILE_OPEN_MODE_LABELS[m])))
    return screen.getAllByRole('menuitemradio').filter((el) => labels.has(el.textContent ?? ''))
  }

  it('「打开方式」七档全在,勾在当下那一档,选了就记住', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)

    /*
     * **前两格是「视图」那一节**(W7-c 裁定 2:markdown 的「渲染 / 源码」从叶檐的
     * 工具条搬进了这张表)。它们与「打开方式」同样是**一组值里选一个**,所以同样
     * 报 `menuitemradio` —— 这一条问的是打开方式那七档,所以先把视图那两格切掉。
     * `openModeOptions` 是这个切法的唯一产地,免得两条用例各数一次。
     */
    const options = openModeOptions()
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

    // W4 起七档全通;这一条仍旧选「主区域」,它验的是「选档即生效」那条链。
    fireEvent.click(screen.getByText('主区域'))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('stage'))
  })

  /*
   * ── W4:七档全接上了 ────────────────────────────────────────────────
   * F1 的诚实降级(六档「记住但不假装」)在 F2 结清过一次;W1-a 因为架子与浮窗
   * 还没有树,又退回过两档(五档禁灰 + 一句「下一批」)。W4 把两处都换成了树,
   * 于是这一条把**终态**钉死:七档全能选,一格禁灰、一句注脚都不该再有。
   */
  it('W4:七档全通,禁灰与「下一批」那句注脚一并退役', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)

    const options = openModeOptions()
    expect(options).toHaveLength(7)
    expect(options.filter((el) => el.hasAttribute('disabled'))).toHaveLength(0)
    expect(screen.queryAllByText('架子与浮窗的标签下一批')).toHaveLength(0)
    // 旧那句注脚(F1 时代的诚实降级)同样不该出现 —— 它说的是另一件事。
    expect(screen.queryAllByText('还没接上')).toHaveLength(0)
  })

  it('选一档非面板落点 = 那块瓦当场被摆过去(选档即生效)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    // 先打开一个文件,再换档 —— 「调整后没有生效」报的正是这一步。
    fireEvent.click(row(`${ROOT}/README.md`))
    await waitFor(() => expect(useViewerSource.getState().instances[`${ROOT}/README.md`]).toBeTruthy())
    await rowMenu(`${ROOT}/README.md`)
    fireEvent.click(screen.getByText('主区域'))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('stage'))
    /*
     * W1:「主区域」不再是把一块瓦摆上舞台,而是**把这个 ref 插进中央区那棵树**
     * (`stage` 那一档翻出来的就是 `center`)。落点的证据因此从形态机那张
     * `placements` 换成拼贴台那棵树。
     */
    await waitFor(() =>
      expect(
        refIdsOf(useWorkbenchStore.getState().regions.center).includes(`file:${ROOT}/README.md`),
      ).toBe(true),
    )
    // 面板内那条分栏跟着收起来 —— 一份内容只该有一个落点(两处同时画就是重影)。
    await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
  })

  it('目录那一行菜单说「展开 / 收起」,文件说「打开查看」', async () => {
    installPort()
    renderFiles()
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
    renderFiles()
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
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openMenu(`${ROOT}/README.md`)
    fireEvent.click(screen.getByText('在文件管理器中显示'))
    await waitFor(() => expect(port.reveal).toHaveBeenCalledWith(`${ROOT}/README.md`))
  })
})

/*
 * ── 底部提示行的归属(09-01 自查走查:panel 一屏五条横带)──────────────────
 * 它是一句**用法**(怎么打开一个文件、菜单在哪儿)。分栏开着的时候它还占着
 * 25px,而那 25px 是从正文里扣的 —— 何况此刻这句话已经没用了:文件都开着了。
 * 判据只有一条(分栏开没开),不记「用户见过没有」那种状态 —— 那会让同一块面
 * 在两台机器上长得不一样。
 */
describe('底部提示行:分栏开着时让位给正文', () => {
  it('没开查看器时它在(它是这块面唯一说得出「右键有菜单」的地方)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    expect(document.querySelector('[data-panel-hint]')).toBeTruthy()
  })

  it('分栏一开就收起来,关掉查看器又回来', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(row(`${ROOT}/README.md`))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())
    expect(document.querySelector('[data-panel-hint]')).toBeNull()

    await closeViaMenu(`${ROOT}/README.md`)
    await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
    expect(document.querySelector('[data-panel-hint]')).toBeTruthy()
  })

  it('查看器摆去别的落点时它照旧在 —— 那时这块面里没有分栏', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    act(() => useFileOpenMode.setState({ mode: 'float' }))
    fireEvent.click(row(`${ROOT}/README.md`))
    await waitFor(() =>
      expect(useViewerSource.getState().instances[`${ROOT}/README.md`]).toBeTruthy(),
    )
    expect(document.querySelector('[data-panel-hint]')).toBeTruthy()
  })
})

describe('详情:附属浮层(不是打断式对话框)', () => {
  /**
   * 开一行的详情。
   *
   * ── 09-01 裁定:**双击那条路整条删了** ──────────────────────────────
   * 报障原话是「双击间隔多久了还能出现」;查下去发现两件事:这台壳对间隔
   * 一个判据都没有(挂的是 `onDoubleClick`,Blink 只看平台递来的 clickCount),
   * 而 macOS 触控板的**双指点按到达时就是双击形态**,与右键语义正面打架 ——
   * 用户想开右键菜单,得到的是详情浮层。
   *
   * 裁定不是「收紧窗口」而是**整条删掉**:打开 = 单击 / ↵,动作 = 右键菜单,
   * 详情的入口是 ⌘I 与菜单里那一行。所以这个助手走的正是菜单那条路。
   */
  async function openDetail(name: string) {
    const target = screen.getByText(name)
    const path = target.closest('[data-file-path]')?.getAttribute('data-file-path') ?? ''
    fireEvent.contextMenu(target)
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.click(screen.getByText('详情'))
    await waitFor(() => expect(screen.getByTestId('files-detail')).toBeTruthy())
    return path
  }

  it('双击**不再**开详情(09-01 裁定:触控板双指点按与右键打架)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const target = screen.getByText('README.md')
    fireEvent.click(target)
    fireEvent.doubleClick(target)
    // 给它一次真正的机会:等一轮微任务,详情仍然不该出现。
    await Promise.resolve()
    expect(screen.queryByTestId('files-detail')).toBeNull()
  })

  it('它是 role=dialog 但**没有 aria-modal**,而且不压遮罩 —— 树还在', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')

    const pop = screen.getByRole('dialog')
    expect(pop.getAttribute('aria-modal')).toBeNull()
    // 树没有被盖掉:那一行仍然在文档里,读屏与鼠标都够得着。
    expect(row(`${ROOT}/packages`)).toBeTruthy()
  })

  /*
   * ── R2:⌘I 的落点在**面板那一格作用域**上,不在行上 ─────────────────────
   * 所以按下去之前要先让焦点真的落在那一行:①它把自己报成「当前行」
   * (面板据此交出 `keyHandlers.detail`);②它把这块面送上活动路径(路由问的是
   * 「files 在不在路径上」,不是「这一下按键经不经过谁」)。
   * 用真的 `.focus()` 而不是 `fireEvent.focus`:树听的是 `focusin`,而
   * `fireEvent.focus` 只派一个不冒泡的 `focus`,两者不是一回事。
   */
  it('⌘I 是它的第二个入口(全局 keymap 里没人占 `i`,所以这一下归当前那一行)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    act(() => row(`${ROOT}/README.md`).focus())
    fireEvent.keyDown(row(`${ROOT}/README.md`), { key: 'i', metaKey: true })
    await waitFor(() => expect(screen.getByTestId('files-detail')).toBeTruthy())
  })

  /**
   * **声明与落点不许分叉**(设计 §8):表里写着的 action,这块面真的交出了同名的
   * 处理器。R2 之前这条对的是「查看器键位表 vs SCOPED_KEYS」;R2 之后声明只有
   * `FOCUS_SCOPES` 一份,而落点是作用域实例注入的那张表 —— 所以对表要在
   * **真的挂起来的实例**上做,读的是树自己的排障口。
   * 反证:把 `filesKeys` 那一格改名(比如 `detail` → `info`)→ 这一条当场红。
   */
  it('作用域实例注入的 keyHandlers 名单 = FOCUS_SCOPES.files.keys 的 action 集合', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const node = focusTree.dump().nodes.find((n) => n.scope === 'files')
    expect(node?.keys.slice().sort()).toEqual([
      ...new Set(FOCUS_SCOPES.files.keys?.map((k) => k.action) ?? []),
    ].sort())
  })

  /**
   * **被召唤时焦点落在一行上,不是落在根上**(W7-c 裁定 6,结清 W7-p 的留账
   * 「目录面板召唤后焦点不进去」)。
   *
   * 病历:这块面从前不声明 `restingTarget`,落点就是作用域的根 —— 根确实接得住
   * 焦点(`tabIndex={-1}`),但**进去之后一个键都不响**:树的方向键长在行上
   * (那些行是真 `<button>`),⌘I / ⌘↵ 那两条局部键要一格选中的行。用户看到的
   * 就是「面开出来了,键盘还在别处」。
   *
   * 反证:把 `FilesPanel` 那句 `restingTarget` 拆掉 → 焦点落在 `files-panel` 上,
   * 这一条当场红。
   */
  it('W7-c:`activateScope("files")` 把焦点送到**一行**上,不是送到面板根上', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    act(() => {
      focusTree.activateScope('files', { reason: 'open' })
    })
    const active = document.activeElement as HTMLElement | null
    expect(active?.getAttribute('data-file-path'), '落在一行上').toBeTruthy()
    expect(active?.closest('[data-testid="files-panel"]'), '而且那一行在这块面里').toBeTruthy()
  })

  /**
   * **「进这一格 = 进哪块面」由种类自述**(与会话那一种同一条:`ContentKind.focusInto`)。
   * 不声明的话 `focusIntoRef` 只能退回 `leaf` 那一层,能不能穿到这块面里要看那一刻
   * 它登记好了没有。反证:把 `dir` 那格 `focusInto` 删掉 → 这一条当场红。
   */
  it('W7-c:`dir` 自述 focusInto = files', () => {
    expect(focusIntoScopeOf(dirRef('/x'))).toBe('files')
  })

  it('一行都没拿焦点时 ⌘I **不接** —— 交不出处理器,这一下原样落给全局命令表', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    act(() => screen.getByTestId('files-panel').focus())
    const handled = fireEvent.keyDown(screen.getByTestId('files-panel'), { key: 'i', metaKey: true })
    // fireEvent 回 true = 没人 preventDefault。反证:把 `current ? … : undefined`
    // 那一格改成恒给处理器 → 这一下会被吞掉(表现为「按了没反应」)。
    expect(handled).toBe(true)
    expect(screen.queryByTestId('files-detail')).toBeNull()
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
    renderFiles()
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

  /*
   * ── 7d 规范修正:再问一次砸了时,那四格与那句错**同屏** ──────────────
   * 判据从 `status === 'error'` 换成了「`error` 在不在」。手上一格都没有时两个
   * 判据逐字等价(所以常态零像素变化);而这一条走的正是它们不等价的那一档 ——
   * 从前:值被抹掉、屏幕上只剩一句错;现在:值留着(律②),错在它上面并陈。
   */
  it('详情再问一次砸了:上一次那四格留在屏上,错误并陈', async () => {
    let ok = true
    installPort({
      stat: vi.fn(async () =>
        ok
          ? {
              success: true as const,
              type: 'file' as const,
              path: `${ROOT}/README.md`,
              size: 4096,
            }
          : { success: false as const, error: 'EACCES: permission denied, stat' },
      ),
    })
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    await waitFor(() => expect(screen.getByTestId('files-detail-size').textContent).toBe('4.0 KB'))

    ok = false
    fireEvent.keyDown(document, { key: 'Escape' })
    await openDetail('README.md')

    await waitFor(() => expect(screen.getByText('EACCES: permission denied, stat')).toBeTruthy())
    // **那一格没有退回破折号** —— 上一次问到的大小还在屏上。
    expect(screen.getByTestId('files-detail-size').textContent).toBe('4.0 KB')
  })

  it('目录:一样出详情,类型说「目录」,而且没有「预览打开」那颗钮', async () => {
    installPort({
      stat: vi.fn(async () => ({
        success: true,
        type: 'directory' as const,
        path: `${ROOT}/packages`,
      })),
    })
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    await openDetail('packages')

    expect(screen.getByText('目录')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '预览打开' })).toBeNull()
    // 后端没给大小 / 时间就画缺席格,**不拿 0 B 和 1970 顶**。
    expect(screen.getByTestId('files-detail-size').textContent).toBe('—')
    expect(screen.getByTestId('files-detail-mtime').textContent).toBe('—')
  })

  /*
   * 从前这里验的是「双击目录只翻一次展开」(靠 `e.detail > 1` 挡掉第二下)。
   * 双击整条删掉之后那个问题不存在了 —— 一次单击就是一次展开,没有第二下。
   * 换成验菜单那条路:菜单里的「展开」与单击是同一个动作。
   */
  it('菜单里的「展开」与单击是同一个动作', async () => {
    const port = installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    fireEvent.contextMenu(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.click(screen.getByText('展开'))
    await waitFor(() => expect(port.listDirectory).toHaveBeenCalledWith(`${ROOT}/packages`))
  })

  it('「在文件管理器中显示」把整条路径交下去;做不到弹一条 error', async () => {
    const port = installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    /*
     * **在详情面**里面找那颗钮:双击的第一下已经把查看器打开了(单击语义一个字
     * 没改),而查看器头上也有一颗同名的 —— 屏幕上有两颗是**预期**,不是重复。
     */
    fireEvent.click(
      within(screen.getByTestId('files-detail')).getByRole('button', { name: '在文件管理器中显示' }),
    )
    await waitFor(() => expect(port.reveal).toHaveBeenCalledWith(`${ROOT}/README.md`))
    expect(useNotifyStore.getState().items).toEqual([])
  })

  /*
   * ── 7d 律③:reveal 在飞时那颗钮 aria-busy,而且挡住第二发 ────────────
   * **不禁用**(`aria-busy` 说的是「在飞」不是「不可用」,与 7e 总览 `+` 钮同一条):
   * 禁了会让键盘用户在往返中途掉出焦点序。零新像素。
   */
  it('reveal 在飞:那颗钮 aria-busy 但不禁用,连点不发第二发', async () => {
    let release: ((value: { success: true }) => void) | undefined
    const port = installPort({
      reveal: vi.fn(() => new Promise<{ success: true }>((resolve) => { release = resolve })),
    })
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    const btn = within(screen.getByTestId('files-detail')).getByRole('button', {
      name: '在文件管理器中显示',
    })

    await act(async () => {
      fireEvent.click(btn)
      await Promise.resolve()
    })
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(btn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(btn)
    expect(port.reveal).toHaveBeenCalledTimes(1)

    await act(async () => {
      release?.({ success: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(btn.getAttribute('aria-busy')).toBeNull())
  })

  it('reveal 做不到就弹一条 error —— 点了没反应是最坏的那一种', async () => {
    installPort({
      reveal: vi.fn(async () => ({
        success: false,
        error: 'Revealing local files is not available in the web server runtime.',
      })),
    })
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    fireEvent.click(
      within(screen.getByTestId('files-detail')).getByRole('button', { name: '在文件管理器中显示' }),
    )
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
    renderFiles()
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
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    await openDetail('packages')
    await waitFor(() => expect(screen.getByText('没有权限读这一项的信息')).toBeTruthy())
    expect(screen.getByText('EACCES: permission denied, stat')).toBeTruthy()
  })

  it('Esc 关掉详情(逃生口)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    await openDetail('README.md')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('files-detail')).toBeNull())
  })

  it('点浮层外面就散(它是附属,不是打断)', async () => {
    installPort()
    renderFiles()
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
    renderFiles()
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

/**
 * 面板内分栏(F1 唯一的打开位)。这一组只验**面板这一侧**的事:分栏开合、
 * 打开点、Esc、以及查看器确实拿到了那条路径。查看器**里面**画什么由
 * `file-viewer.test.tsx` 验 —— 那是另一块内容的事。
 */
describe('面板内分栏:单击文件 = 在此打开', () => {
  it('单击一个文件 = 右列长出来,树还在(不是盖住)', async () => {
    const port = installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    expect(document.querySelector('[data-viewer="open"]')).toBeNull()

    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())
    expect(port.readContent).toHaveBeenCalledWith(`${ROOT}/README.md`, expect.any(Number))
    expect(document.querySelector('[data-viewer="open"]')).toBeTruthy()
    // 树没有被盖掉:那两行还在,点得到、读屏也够得着。
    expect(row(`${ROOT}/packages`)).toBeTruthy()
    expect(screen.getByTestId('files-tree')).toBeTruthy()
  })

  it('再单击别的文件 = **就地换内容**(不是开第二块)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('packages')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())

    fireEvent.click(screen.getByText('packages'))
    await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
    fireEvent.click(screen.getByText('core'))
    await waitFor(() => expect(screen.getByText('engine.ts')).toBeTruthy())
    fireEvent.click(screen.getByText('engine.ts'))

    await waitFor(() => expect(viewerPath()).toBe(`${ROOT}/packages/core/engine.ts`))
    expect(screen.getAllByTestId('file-viewer')).toHaveLength(1)
    // 打开点跟着走:一次只有一个文件开着。
    expect(row(`${ROOT}/packages/core/engine.ts`).getAttribute('data-file-open')).toBe('shown')
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBeNull()
  })

  it('把一份**藏着的**文件关掉 = 它从隐藏表里也一起走(树行那颗空心点当场灭)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    // 开进中央区(分栏那一档不进树,谈不上「隐藏」)。
    await rowMenu(`${ROOT}/README.md`)
    fireEvent.click(screen.getByText('主区域'))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('stage'))
    fireEvent.click(row(`${ROOT}/README.md`))
    await waitFor(() =>
      expect(refIdsOf(useWorkbenchStore.getState().regions.center)).toContain(
        `file:${ROOT}/README.md`,
      ),
    )
    // 藏起来:树行那颗点翻成空心。
    await rowMenu(`${ROOT}/README.md`)
    fireEvent.click(screen.getByText('隐藏'))
    await waitFor(() =>
      expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBe('hidden'),
    )
    /*
     * 关掉它。**判据是「这份内容还在不在」** —— 藏着的那一份也是「打开着」,
     * 所以关闭要把隐藏表那一条一起收掉。不收的话空心点会继续亮着,
     * 而点它请回来的是一份已经被 dispose 的实例。
     */
    await rowMenu(`${ROOT}/README.md`)
    fireEvent.click(screen.getByText('关闭'))
    await waitFor(() => expect(useWorkbenchStore.getState().hidden).toEqual([]))
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBeNull()
    expect(useViewerSource.getState().instances[`${ROOT}/README.md`]).toBeUndefined()
  })

  it('Esc 收起查看区回全树', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())

    // R2:Esc 是这块面那一格作用域的 `onEscape`,前提是它在活动路径上 ——
    // 焦点摆进这块面里(真机上点开一个文件本来就落在这儿)。
    act(() => screen.getByTestId('files-panel').focus())
    fireEvent.keyDown(screen.getByTestId('files-panel'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
    expect(document.querySelector('[data-viewer="open"]')).toBeNull()
    // 关掉之后那颗打开点也跟着灭。
    expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBeNull()
  })

  /*
   * ── W1-a 修批:面板内那一档也有一条身份带 ────────────────────────────────
   *
   * 病历:W1-a 交卷时这一档的查看器**一条檐都没有**(「一格一檐」那条规则只在树
   * 里落地了),于是关一个文件只剩右键菜单与 Esc —— 而「面板内」是 `file-open-mode`
   * 的**出厂缺省档**,多数用户第一眼看到的正是它。
   *
   * 裁定:面板内这一格也是一「格」,它该有**同一条**身份带,不是没有 ——
   * 与中央叶单 tab 时同一件(`workbench/LeafStrip`),所以两处逐像素相同。
   *
   * 「那条带子上的每一格 UI 状态」由 `workbench/__tests__/pane-leaf.test.tsx` 与
   * `ui/__tests__` 验(件本身);这一组验的是**这个宿主接上了没有**:
   * 檐在盒子里、说得出文件名、✕ 关得掉、关闭语义与中央叶一致、树不重挂。
   */
  describe('身份带:面板内那一格也有檐', () => {
    /** 檐里那颗 ✕。取件口与 `gate:files` 逐字相同(一处判据,不是两处)。 */
    function stripClose(): HTMLElement {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="file-viewer"] [role="tab"] [class*="close"]',
      )
      if (!el) throw new Error('身份带上没有那颗 ✕')
      return el
    }

    async function openReadme(): Promise<void> {
      await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
      fireEvent.click(screen.getByText('README.md'))
      await waitFor(() => expect(viewerPath()).toBe(`${ROOT}/README.md`))
    }

    it('查看器盒子里**恰有一条** tablist,它说得出文件名,✕ 在场', async () => {
      installPort()
      renderFiles()
      await openReadme()

      const box = screen.getByTestId('file-viewer')
      // 「一格一檐」在这一档的机器化:一条,不是零条(修前)也不是两条。
      expect(box.querySelectorAll('[role="tablist"]')).toHaveLength(1)
      // 檐是盒子里的**第一个孩子**(身份带在顶,与中央叶同形)。
      expect(box.firstElementChild).toBe(screen.getByTestId('viewer-strip'))

      const tab = box.querySelector('[role="tab"]')!
      expect(tab.getAttribute('aria-selected')).toBe('true')
      expect(tab.textContent).toContain('README.md')
      expect(stripClose()).toBeTruthy()
      /*
       * **不画「隐藏」「分屏」**:那两件是树的动作,面板内这一档不在树里。
       * (中央叶那两颗的 testId 是 `pane-hidden:` / `pane-split:`。)
       */
      expect(box.querySelector('[data-testid^="pane-split"]')).toBeNull()
      expect(box.querySelector('[data-testid^="pane-hidden"]')).toBeNull()
    })

    it('单击 ✕ = 关掉这一格;树上那些行**一个都没有重挂**', async () => {
      installPort()
      renderFiles()
      await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
      fireEvent.click(screen.getByText('packages'))
      await waitFor(() => expect(screen.getByText('core')).toBeTruthy())
      const kept = [row(`${ROOT}/packages`), row(`${ROOT}/packages/core`), row(`${ROOT}/README.md`)]

      await openReadme()
      fireEvent.click(stripClose())

      await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
      // 分栏收起来了,而那棵树的 DOM 节点逐个还是原来那几个(树常驻铁律)。
      expect(document.querySelector('[data-viewer="open"]')).toBeNull()
      expect([
        row(`${ROOT}/packages`),
        row(`${ROOT}/packages/core`),
        row(`${ROOT}/README.md`),
      ]).toEqual(kept)
      // 关闭 = 丢实例(不是隐藏),树行那颗打开点当场灭。
      expect(useViewerSource.getState().instances[`${ROOT}/README.md`]).toBeUndefined()
      expect(row(`${ROOT}/README.md`).getAttribute('data-file-open')).toBeNull()
    })

    /**
     * **关闭语义与中央叶逐字相同**:先问种类(`ContentKind.beforeClose` → 脏文件
     * 那一问),答「关」才真关。判据整件在 `workbench/kinds.mayCloseContent`,
     * 两条檐共用 —— 所以这一条同时是「面板内没有走第二套关闭」的证据。
     */
    it('脏文件先问一句:「取消」不关,「不保存」才关', async () => {
      installPort()
      act(() => {
        useWorkbenchStore.getState().openRef(dirRef(ROOT))
      })
      render(
        <>
          <FocusDispatchHarness />
          <FilesHarness />
          <ViewerCloseHost />
        </>,
      )
      await openReadme()

      // 弄脏它:进编辑 + 改一个字(走 store 那两口,与真机同一条路)。
      act(() => {
        useViewerSource.getState().setEditing(`${ROOT}/README.md`, true)
        useViewerSource.getState().setDraft(`${ROOT}/README.md`, 'changed')
      })

      fireEvent.click(stripClose())
      await waitFor(() => expect(screen.getByText('还有没保存的改动')).toBeTruthy())
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() => expect(screen.queryByText('还有没保存的改动')).toBeNull())
      // 取消 = 这一次关闭作废,面还在。
      expect(viewerPath()).toBe(`${ROOT}/README.md`)

      fireEvent.click(stripClose())
      await waitFor(() => expect(screen.getByText('还有没保存的改动')).toBeTruthy())
      fireEvent.click(screen.getByText('不保存'))
      await waitFor(() => expect(screen.queryByTestId('file-viewer')).toBeNull())
    })
  })

  it('查看区没开时 Esc **不接** —— 让它原样往上冒(外壳还有自己的 Esc 分层)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    let bubbled = false
    const panel = screen.getByTestId('files-panel')
    panel.parentElement?.addEventListener('keydown', () => {
      bubbled = true
    })
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(bubbled).toBe(true)
  })

  it('详情面上那颗钮说「打开查看」,按下去开的是查看器', async () => {
    // 那颗钮只在**文件**上出现(目录没有内容可看),所以这里让 stat 说实话。
    installPort({
      stat: vi.fn(async () => ({
        success: true,
        type: 'file' as const,
        path: `${ROOT}/README.md`,
      })),
    })
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    // 详情从右键菜单出(双击那条路 09-01 整条删了)。菜单不打开查看器,
    // 所以这里屏幕上此刻**没有**查看器 —— 那颗钮按下去才是第一次开。
    fireEvent.contextMenu(screen.getByText('README.md'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.click(screen.getByText('详情'))
    await waitFor(() => expect(screen.getByTestId('files-detail')).toBeTruthy())
    expect(screen.queryByTestId('file-viewer')).toBeNull()

    fireEvent.click(within(screen.getByTestId('files-detail')).getByRole('button', { name: '打开查看' }))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())
  })
})

/* ── ↵ 开文件把焦点送进查看器(§11 拍点 1 的另一半)──────────────────────── */

describe('↵ 开文件:焦点进查看器', () => {
  /**
   * 真机门场景 10 逮到的那一形:**↵ 开的正是此刻已经开着的那个文件**。
   * 那一下 `openPath` 与 `viewerOpen` 都没变,所以「等查看器到位再送焦点」那条
   * effect 的依赖表一格不动 —— 少了那格自增的触发器,effect 根本不跑,焦点留在树上。
   * 反证:把 `openTick` 从依赖表里摘掉 → 第二段当场红。
   */
  it('同一个文件再按一次 ↵,焦点照样进查看器', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())

    const target = row(`${ROOT}/README.md`)
    act(() => target.focus())
    fireEvent.keyDown(target, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-focus-scope="viewer"]')).toBeTruthy(),
    )

    // 回到树上,对**同一个文件**再按一次 ↵。
    act(() => row(`${ROOT}/README.md`).focus())
    expect(document.activeElement?.closest('[data-focus-scope="files"]')).toBeTruthy()
    fireEvent.keyDown(row(`${ROOT}/README.md`), { key: 'Enter' })
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-focus-scope="viewer"]')).toBeTruthy(),
    )
  })

  it('单击不送:焦点留在树这块面里(拍点 1 的 (a) 档)', async () => {
    installPort()
    renderFiles()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    const target = row(`${ROOT}/README.md`)
    act(() => target.focus())
    fireEvent.click(target)
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toBeTruthy())
    expect(document.activeElement).toBe(target)
  })
})
