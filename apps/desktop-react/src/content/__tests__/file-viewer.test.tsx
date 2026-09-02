import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileViewer } from '../viewer/FileViewer'
import {
  keymapById,
  listKeymaps,
  listNavigators,
  navigatorFor,
  registeredViewerIds,
  resolveViewer,
} from '../viewer/registry'
import '../viewer/kinds'
import '../viewer/navigators'
import '../viewer/keymaps'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { useViewerSource, viewerSaveKey, viewerSaveMutation } from '../../data/viewer-source'
import type { ViewerFile } from '../../data/viewer-source'
import { useFileOpenMode } from '../../data/file-open-mode'
import { useStageStore } from '../../stage/store'
import { FOCUS_SCOPES } from '../../focus/scopes'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'

/**
 * 文件查看器(F1)。这一组验的是**查看器这一块内容自己**:三张注册表、
 * 三层形状(头 / 体 / 脚)、四律的落点、轻编辑与关闭确认、⌘L 跳转。
 *
 * 面板那一侧(分栏开合、打开点、Esc)由 `files-panel.test.tsx` 验 —— 两块面
 * 各测各的,正是「查看器不认识自己被摆在哪儿」这条分界的测试面。
 */

const CODE = "export const gate = 'F1'\nconst second = 2\nconst third = 3\n"

function installPort(overrides: Partial<FilesPort> = {}): FilesPort {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    stat: vi.fn(async () => ({ success: true, type: 'file' as const, path: '/repo/a.ts' })),
    readContent: vi.fn(async () => ({ success: true, content: CODE, size: CODE.length })),
    saveContent: vi.fn(async () => ({ success: true, mtimeMs: 42 })),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
    ...overrides,
  }
  configureFilesPort(port)
  return port
}

/**
 * 进 / 出编辑。**铅笔 09-01 随檐减负一起退役**,进出编辑只剩右键菜单那一条路
 * (动作单产地),所以每一条编辑相关的用例都从这里走 —— 走的正是用户走的那条。
 */
async function toggleEditViaMenu(): Promise<void> {
  fireEvent.contextMenu(screen.getByTestId('viewer-body'))
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  const item = screen.queryByText('完成编辑') ?? screen.getByText('编辑')
  fireEvent.click(item)
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

async function open(path: string): Promise<void> {
  await act(async () => {
    await useViewerSource.getState().openFile(path)
  })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useViewerSource.getState().reset()
  useFileOpenMode.setState({ mode: 'panel' })
})

// 响应链是模块级单例(同 store):一份用例留下的作用域不该被下一份看见。
afterEach(() => {
  focusTree.reset()
})

/**
 * **查看器 + 那一格派发器**(09-03 R2)。
 *
 * ⌘S / ⌘L / ⌘F 从前挂在查看器根元素上,单独渲染这块面按键就会响;R2 之后
 * 它们是**作用域声明**(`FOCUS_SCOPES.viewer.keys` + `<FocusScope keyHandlers>`),
 * 真正听键盘的只有 `focus/dispatch.ts` 那一个,而它挂在外壳上。所以这一族用例
 * 要补两样才是「一台真机器」:①那个派发器(`FocusDispatchHarness`);
 * ②**焦点在这块面里** —— 路由问的是「查看器在不在活动路径上」,而不是
 * 「这一下按键经不经过它的根」(用户报的 ⌘F 死的正是后一条判据)。
 * 第②样走 `activateScope('viewer')`,与真机上「点开一个文件」落的是同一口。
 */
function renderViewer(node: React.ReactElement = <FileViewer />) {
  const view = render(
    <>
      <FocusDispatchHarness />
      {node}
    </>,
  )
  act(() => {
    focusTree.activateScope('viewer')
  })
  return view
}

/* ── 三张注册表 ────────────────────────────────────────────────────────── */

describe('注册表:查看器是壳,型从表里来', () => {
  const file = (kind: ViewerFile['kind']): ViewerFile => {
    switch (kind) {
      case 'code':
        return { kind, path: '/a.ts', name: 'a.ts', lang: 'typescript', content: 'x', size: 1, loaded: 1, truncated: false }
      case 'markdown':
        return { kind, path: '/a.md', name: 'a.md', content: '# x', size: 3, loaded: 3, truncated: false }
      case 'image':
        return { kind, path: '/a.png', name: 'a.png', src: 'file:///a.png' }
      case 'media':
        return { kind, path: '/a.mp4', name: 'a.mp4', src: 'file:///a.mp4', audio: false }
      case 'binary':
        return { kind, path: '/a.bin', name: 'a.bin', size: 9 }
      case 'oversize':
        return { kind, path: '/a.log', name: 'a.log', size: 99, limit: 9 }
      case 'error':
        return { kind, path: '/a.ts', name: 'a.ts', failure: 'denied' }
    }
  }

  it('五个处理器 + 一个兜底,各认各的', () => {
    expect(registeredViewerIds()).toEqual(['code', 'markdown', 'image', 'media', 'unsupported'])
    expect(resolveViewer(file('code')).id).toBe('code')
    expect(resolveViewer(file('markdown')).id).toBe('markdown')
    expect(resolveViewer(file('image')).id).toBe('image')
    expect(resolveViewer(file('media')).id).toBe('media')
  })

  it('打不开的三种都落兜底 —— 未知不是崩溃,是一种展示', () => {
    for (const kind of ['binary', 'oversize', 'error'] as const) {
      expect(resolveViewer(file(kind)).id).toBe('unsupported')
    }
  })

  it('只有文本那两型可编辑(铅笔的判据在表上,不在界面里)', () => {
    expect(resolveViewer(file('code')).editable).toBe(true)
    expect(resolveViewer(file('markdown')).editable).toBe(true)
    expect(resolveViewer(file('image')).editable).toBeUndefined()
  })
})

describe('注册表:跳转提供者(⌘L 唯一入口)', () => {
  it('四档在表里,F2 起行号与检索真接上(符号 / diff 画成灰的,不藏起来)', () => {
    const navigators = listNavigators()
    // 次序 = 注册次序。检索档在 F2 从留表位接了真,所以它挪到了 symbol 前面
    // (注册的地方从「留表位」那一段搬到了实现那一段)。
    expect(navigators.map((n) => n.id)).toEqual(['line', 'search', 'symbol', 'diff'])
    expect(navigators.filter((n) => n.list).map((n) => n.id)).toEqual(['line', 'search'])
    // 检索是「走一遍」的那一档:落点之后条不关,↵ 再按走下一个。
    expect(navigators.find((n) => n.id === 'search')?.cycle).toBe(true)
    expect(navigators.find((n) => n.id === 'line')?.cycle).toBeUndefined()
  })

  it('前缀分岔:# / @ 各归各的,纯数字落行号档', () => {
    expect(navigatorFor('42')?.id).toBe('line')
    expect(navigatorFor('#foo')?.id).toBe('symbol')
    expect(navigatorFor('/bar')?.id).toBe('search')
    expect(navigatorFor('@1')?.id).toBe('diff')
  })

  it('行号档吃掉 Vim 的那个冒号 —— `:42` 与 `42` 是同一个落点', () => {
    const line = listNavigators()[0]
    const ctx = { file: { kind: 'code' } as ViewerFile, lineCount: 100 }
    expect(line.list?.('42', ctx)[0].line).toBe(42)
    expect(line.list?.(':42', ctx)[0].line).toBe(42)
  })

  it('超出行数就夹到最后一行,并**说出来**(hint),不静默改数', () => {
    const line = listNavigators()[0]
    const hit = line.list?.('999', { file: { kind: 'code' } as ViewerFile, lineCount: 12 })[0]
    expect(hit?.line).toBe(12)
    expect(hit?.hint).toBe('12')
  })
})

describe('注册表:键位档', () => {
  it('默认档两条,Vim 档立了表形但**没接上绑定**(如实标出来)', () => {
    expect(listKeymaps().map((k) => k.id)).toEqual(['default', 'vim'])
    expect(keymapById('default')?.implemented).toBe(true)
    expect(keymapById('vim')?.implemented).toBe(false)
    expect(keymapById('vim')?.modes).toEqual(['normal', 'insert'])
  })

  /**
   * **键位路由不在这张表里**(09-03 R2)。从前这里有一格 `bindings`
   * (`mod+s` 那种写法)与一只 `commandFor`,查看器把它挂在自己根元素上;
   * R2 之后声明的正本是 `FOCUS_SCOPES.viewer.keys`,落点是 `<FocusScope keyHandlers>`。
   * 留着 bindings 就是同一份声明的第二个产地。这一条钉的正是「只剩一个产地」。
   */
  /**
   * **声明与落点不许分叉**(设计 §8)。声明只有 `FOCUS_SCOPES` 一份,落点是
   * 作用域实例注入的那张表 —— 所以对表在**真的挂起来的实例**上做,读树的排障口。
   * 反证:把 FileViewer 的 `viewerKeys` 里任何一格改名 → 这一条当场红。
   */
  it('作用域实例注入的 keyHandlers 名单 = FOCUS_SCOPES.viewer.keys 的 action 集合', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer()
    const node = focusTree.dump().nodes.find((n) => n.scope === 'viewer')
    expect(node?.keys.slice().sort()).toEqual([
      ...new Set(FOCUS_SCOPES.viewer.keys?.map((k) => k.action) ?? []),
    ].sort())
  })

  it('档里**没有** bindings 那一格:键位路由归响应链的作用域声明', () => {
    const map = keymapById('default') as unknown as Record<string, unknown>
    expect('bindings' in map).toBe(false)
    expect(FOCUS_SCOPES.viewer.keys?.map((k) => k.action)).toEqual(['save', 'jump', 'find'])
  })
})

/* ── 三层形状 ──────────────────────────────────────────────────────────── */

describe('头:身份与去向(大小与时间不在这里)', () => {
  /*
   * ── 09-01 裁定:檐上只剩身份 ─────────────────────────────────────────
   * 修前这条 40 高的檐上有七件,真机上文件名被挤成 `kimi-sli…`。裁定之后
   * 只剩三件(类型徽 + 名 + 未保存丸)加行尾一颗关闭;复制路径 / 编辑 /
   * Finder / 打开方式全部撤进**右键那张动作菜单**(动作单产地)。
   * 下面这一条正是那条裁定的机器化:**它们不在头上**,而且不是「藏起来了」——
   * 它们在菜单里(由 files-panel / 本文件的菜单那一组验)。
   */
  it('只剩类型徽 + 名 + 关闭;复制 / 编辑 / Finder / 打开方式都不在头上', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    expect(screen.getByTestId('viewer-name').textContent).toBe('a.ts')
    expect(screen.getByTestId('viewer-name').getAttribute('data-viewer-path')).toBe('/repo/a.ts')
    expect(screen.getByTestId('viewer-close')).toBeTruthy()
    // 撤下去的那四件,一件都不在。
    expect(screen.queryByTestId('viewer-copy-path')).toBeNull()
    expect(screen.queryByTestId('viewer-open-mode')).toBeNull()
    expect(screen.queryByTestId('viewer-edit-toggle')).toBeNull()
    expect(screen.queryByRole('button', { name: '在文件管理器中显示' })).toBeNull()
    // 大小与时间是详情面的事:这块头上一个数都没有。
    expect(screen.queryByText(/KB|MB|B$/)).toBeNull()
  })

  it('名字截断配 Tooltip 全名 —— 悬停说得出整条路径(禁令区那条)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.focus(screen.getByTestId('viewer-name'))
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('/repo/a.ts'), {
      timeout: 2000,
    })
  })

  it('身上右键 = 那张动作菜单(与树行同一件);编辑 / 复制 / Finder / 七档都在里面', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.contextMenu(screen.getByTestId('viewer-body'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('编辑')).toBeTruthy()
    expect(within(menu).getByText('复制路径')).toBeTruthy()
    expect(within(menu).getByText('在文件管理器中显示')).toBeTruthy()
    // 七档打开方式在同一张表里(勾在当下那一档)。
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(7)
  })

  it('菜单里选一档打开方式 = 当场生效(记忆 + 落点一起走)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.contextMenu(screen.getByTestId('viewer-body'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.click(screen.getByText('浮窗'))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('float'))
    // 「当场生效」的机器化:那块瓦真的被摆到了浮窗上(修前只记档不搬)。
    expect(useStageStore.getState().placements['viewer']).toEqual({ kind: 'float' })
  })

  it('菜单里的 Finder 走 files 端口那条唯一的写口', async () => {
    const port = installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.contextMenu(screen.getByTestId('viewer-body'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.click(screen.getByText('在文件管理器中显示'))
    await waitFor(() => expect(port.reveal).toHaveBeenCalledWith('/repo/a.ts'))
  })
})

/* ── 落点生命周期:檐归属 / 滚动归属 ─────────────────────────────────────── */

/**
 * 09-01 回炉判例(用户报障:「浮窗形态下双檐叠加、内容展示不全、没有滚动条」)。
 *
 * 立法「状态先行」之后补的表,这一组是那张表里**檐归属**那一列的机器化:
 *   panel / edge-*  → 查看器自己那条檐(架子那条是 Tabs,塞不进文件名)
 *   float / stage / cover → **宿主自带 header,查看器整条檐不画**
 * 「整条不画」而不是「把里面几件藏掉」:后者会剩一条 40px 空带子,而那正是
 * 报障里「空间利用度很低」的那 40px。
 */
describe('落点:宿主自带檐时合一', () => {
  const HOST_OWNS = ['float', 'stage', 'cover']
  const SELF_OWNS = ['panel', 'edge-left', 'edge-right', 'edge-top', 'edge-bottom']

  for (const placement of HOST_OWNS) {
    it(`${placement}:查看器那条檐整条不画(宿主檐替它说身份)`, async () => {
      installPort()
      await open('/repo/a.ts')
      renderViewer(<FileViewer placement={placement} />)
      expect(screen.queryByTestId('viewer-name')).toBeNull()
      expect(screen.queryByTestId('viewer-close')).toBeNull()
      expect(document.querySelector('[data-viewer-chrome]')).toBeNull()
      // 体与脚照画 —— 合的是檐,不是把查看器变成半个。
      expect(screen.getByTestId('viewer-body')).toBeTruthy()
      expect(screen.getByTestId('viewer-status')).toBeTruthy()
    })
  }

  for (const placement of SELF_OWNS) {
    it(`${placement}:查看器自己那条檐照画(宿主没有能说文件名的檐)`, async () => {
      installPort()
      await open('/repo/a.ts')
      renderViewer(<FileViewer placement={placement} />)
      expect(screen.getByTestId('viewer-name').textContent).toBe('a.ts')
      expect(screen.getByTestId('viewer-close')).toBeTruthy()
    })
  }

  /*
   * ── 型工具条的归属(09-01 自查走查:panel 一屏五条横带)──────────────────
   * 走查读数(面板高 478):面包屑 45 + 名条 40 + **型工具条 51** + 正文 291
   * + 状态条 26 + 提示行 25。工具条那 51px 是能省的 —— 40 高的名条右边空着
   * 一大片,一排放得下就不该占两排。
   * 合檐的落点里名条整条不画,那时它才自己成一条(宿主那条 header 是通用的,
   * 塞不进一个这一型专用的分段器)。
   */
  it('有名条的落点:型工具条并进名条右端,不再自成一条', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: true, content: '# md\n', size: 5 })),
    })
    await open('/repo/a.md')
    renderViewer(<FileViewer placement="panel" />)
    // 那一格还在(渲染 ⇄ 源码切得动),但它长在名条里,不再是一条独立的带子。
    expect(screen.getByRole('radio', { name: '渲染' })).toBeTruthy()
    expect(screen.queryByTestId('viewer-toolbar')).toBeNull()
    const chrome = document.querySelector('[data-viewer-chrome]')
    expect(chrome?.contains(screen.getByRole('radio', { name: '渲染' }))).toBe(true)
  })

  it('合檐的落点:名条不画,型工具条自己成一条(宿主檐塞不进它)', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: true, content: '# md\n', size: 5 })),
    })
    await open('/repo/a.md')
    renderViewer(<FileViewer placement="float" />)
    expect(document.querySelector('[data-viewer-chrome]')).toBeNull()
    expect(screen.getByTestId('viewer-toolbar')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '渲染' })).toBeTruthy()
  })

  it('没有工具条的型:两种落点都不留一条空带子', async () => {
    installPort()
    await open('/repo/a.ts')
    const view = renderViewer(<FileViewer placement="panel" />)
    expect(screen.queryByTestId('viewer-toolbar')).toBeNull()
    view.rerender(<FileViewer placement="float" />)
    expect(screen.queryByTestId('viewer-toolbar')).toBeNull()
  })

  /*
   * 滚动归属:**永远是查看器 .body**,不随落点变。这一条守的是那个前提 ——
   * `.body` 拿得到确定高度。判据按源文本:`.viewer` 那条 `height: 100%` 是
   * 修好这条病的**唯一**一行(修前它没有 height,在宿主那个块级内容盒里高度
   * 被内容撑成 52016px,于是 clientHeight == scrollHeight、浏览器不给滚动条)。
   * 拆掉它 → 真机探针四种落点全部 scrollable: false(09-01 已真跑过一轮)。
   */
  it('滚动的前提写在样式里:.viewer 有确定高度,.body 自己 overflow:auto', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // 先剥注释:病历文本(那段讲修前 52016px 的注)会让断言自红。
    const css = readFileSync(path.join(here, '../viewer/FileViewer.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).toMatch(/\.viewer\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/\.body\s*\{[^}]*overflow:\s*auto/)
  })
})

describe('体:code 型', () => {
  it('行由我们自己切(不等高亮器),每一行一个块级盒 —— 行号靠 counter,不进选区', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    const pre = screen.getByTestId('viewer-code')
    // 尾随换行切出来那个空段被丢掉:三行内容就是三行。
    expect(pre.getAttribute('data-viewer-lines')).toBe('3')
    expect(pre.querySelectorAll('[data-line]')).toHaveLength(3)
    /*
     * 行号**不在 DOM 文本里**(它是 ::before 的生成内容)—— 所以逐行取出来的字
     * 就是磁盘上那几行,一个数字都没多。
     * (行之间的换行是**块级盒**给的,不是文本节点:jsdom 的 textContent 把块
     *  拼起来时不补换行,所以这里逐行比,而不是比整块字符串。)
     */
    expect(Array.from(pre.querySelectorAll('[data-line]')).map((el) => el.textContent)).toEqual(
      CODE.trimEnd().split('\n'),
    )
  })

  it('当前行由 ⌘L 落点(**行本身不挂交互** —— 一行代码不是控件)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    // 点一行什么都不发生:落到某一行只有跳转条这一条路(定稿的唯一入口)。
    fireEvent.click(document.querySelector('[data-line="2"]')!)
    expect(useViewerSource.getState().view.currentLine).toBe(0)

    act(() => {
      useViewerSource.getState().setView({ currentLine: 2 })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-line="2"]')?.getAttribute('data-current')).toBe('true'),
    )
    expect(document.querySelector('[data-line="1"]')?.getAttribute('data-current')).toBeNull()
  })

  it('折行开关长在状态栏(它是这一型自己声明的那一格)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    const wrap = within(screen.getByTestId('viewer-status')).getByRole('button', { name: '折行' })
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(wrap)
    await waitFor(() => expect(useViewerSource.getState().view.wrap).toBe(true))
  })
})

describe('体:markdown 型', () => {
  it('渲染面走块系统(与聊天同一条路),源码面走 code 本体', async () => {
    installPort({ readContent: vi.fn(async () => ({ success: true, content: '# 标题\n\n一段话', size: 12 })) })
    await open('/repo/README.md')
    renderViewer(<FileViewer />)
    expect(screen.getByTestId('viewer-markdown')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: '源码' }))
    await waitFor(() => expect(screen.getByTestId('viewer-code')).toBeTruthy())
    expect(screen.queryByTestId('viewer-markdown')).toBeNull()
  })
})

describe('体:诚实态', () => {
  it('二进制不画乱码,给类型徽 + 大小 + 一颗 Finder', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: true, content: '', isBinary: true, size: 2048 })),
    })
    await open('/repo/blob.dat')
    renderViewer(<FileViewer onReveal={vi.fn()} />)
    expect(screen.getByTestId('viewer-honest')).toBeTruthy()
    expect(screen.getByText('这是二进制文件,没法按文本查看')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
  })

  it('读不到:三档失败各一句话 + 后端原话原样', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied' })),
    })
    await open('/repo/secret.ts')
    renderViewer(<FileViewer />)
    expect(screen.getByText('没有权限读这个文件')).toBeTruthy()
    expect(screen.getByText('EACCES: permission denied')).toBeTruthy()
  })
})

/* ── UI 状态四律 ───────────────────────────────────────────────────────── */

describe('四律:切文件不闪 / 骨架只首载 / 异步钮有 pending', () => {
  it('① 读新文件期间旧内容留在屏上,头上那格读数说「正在读取…」', async () => {
    let release: ((v: { success: true; content: string; size: number }) => void) | undefined
    const slow = new Promise<{ success: true; content: string; size: number }>((resolve) => {
      release = resolve
    })
    installPort({
      readContent: vi.fn((path: string) =>
        path === '/repo/a.ts'
          ? Promise.resolve({ success: true as const, content: CODE, size: CODE.length })
          : slow,
      ),
    })
    await open('/repo/a.ts')
    const { rerender } = renderViewer(<FileViewer />)
    expect(screen.getByTestId('viewer-code')).toBeTruthy()

    let opening: Promise<void> | undefined
    await act(async () => {
      opening = useViewerSource.getState().openFile('/repo/b.ts')
    })
    rerender(<FileViewer />)
    // 旧内容还在,读数在飞 —— 屏幕上没有任何一帧是空的。
    expect(screen.getByTestId('viewer-code')).toBeTruthy()
    expect(screen.getByTestId('viewer-inflight')).toBeTruthy()

    await act(async () => {
      release?.({ success: true, content: 'later', size: 5 })
      await opening
    })
  })

  it('② 骨架**只首载**:手上什么都没有、而且正在读的那一帧才画转圈', async () => {
    installPort()
    let release: ((v: { success: true; content: string; size: number }) => void) | undefined
    installPort({
      readContent: vi.fn(
        () =>
          new Promise<{ success: true; content: string; size: number }>((resolve) => {
            release = resolve
          }),
      ),
    })
    let opening: Promise<void> | undefined
    await act(async () => {
      opening = useViewerSource.getState().openFile('/repo/a.ts')
    })
    renderViewer(<FileViewer />)
    expect(screen.getByTestId('viewer-first-load')).toBeTruthy()
    await act(async () => {
      release?.({ success: true, content: CODE, size: CODE.length })
      await opening
    })
    await waitFor(() => expect(screen.queryByTestId('viewer-first-load')).toBeNull())
  })

  /*
   * F2 起查看器是一块**普通的瓦**,所以它可以在「一个文件都没打开」的情况下
   * 被点开(Dock 上点那块瓦)。那一帧既不是首载(没有东西在读)也不是错误,
   * 所以它有自己的一格空态 —— 不转圈,说实话。
   */
  it('空态:一个文件都没打开时说实话,不转圈', () => {
    installPort()
    renderViewer(<FileViewer />)
    expect(screen.getByTestId('viewer-empty')).toBeTruthy()
    expect(screen.queryByTestId('viewer-first-load')).toBeNull()
  })

  it('③ 存盘在飞时那颗钮禁用并换字', async () => {
    let release: ((v: { success: true }) => void) | undefined
    installPort({
      saveContent: vi.fn(
        () =>
          new Promise<{ success: true }>((resolve) => {
            release = resolve
          }),
      ),
    })
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    fireEvent.change(screen.getByTestId('viewer-editor'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByTestId('viewer-save'))
    await waitFor(() => expect(screen.getByTestId('viewer-save').textContent).toBe('正在保存…'))
    expect(screen.getByTestId('viewer-save')).toHaveProperty('disabled', true)
    await act(async () => {
      release?.({ success: true })
    })
  })

  /**
   * 09-02 批 6:存盘的忙态从 store 上一颗 `edit.saving` 布尔搬进了写路
   * (`viewerSaveMutation`),按 `save:<path>` **逐格**记账。这一条钉的是
   * 那笔迁移真正买到的东西 —— 律③要的「反馈长在被点的那一个上」:
   * 在飞的是这个文件那一格,别的路径那一格是静的。
   * 拆掉逐格(把 key 摘了)当场红:那时任何一个 key 都会读回 true。
   */
  it('存盘的忙态由写路**逐格**给:飞的是这个文件那一格,别的路径不受连累', async () => {
    let release: ((v: { success: true }) => void) | undefined
    installPort({
      saveContent: vi.fn(
        () =>
          new Promise<{ success: true }>((resolve) => {
            release = resolve
          }),
      ),
    })
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    fireEvent.change(screen.getByTestId('viewer-editor'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByTestId('viewer-save'))

    await waitFor(() =>
      expect(viewerSaveMutation.isPending(viewerSaveKey('/repo/a.ts'))).toBe(true),
    )
    expect(viewerSaveMutation.isPending(viewerSaveKey('/repo/other.ts'))).toBe(false)
    // 钮上那一格是按 key 算的读数,状态栏说得出它是哪一格。
    expect(screen.getByTestId('viewer-save').getAttribute('data-save-key')).toBe('save:/repo/a.ts')

    await act(async () => {
      release?.({ success: true })
    })
    expect(viewerSaveMutation.isPending(viewerSaveKey('/repo/a.ts'))).toBe(false)
  })
})

/* ── 轻编辑 ────────────────────────────────────────────────────────────── */

describe('轻编辑:右键「编辑」→ 等宽文本 → ⌘S', () => {
  it('进编辑:一块等宽可写文本(无高亮),改了就挂「未保存」丸', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    expect(screen.queryByTestId('viewer-dirty')).toBeNull()

    await toggleEditViaMenu()
    const editor = screen.getByTestId('viewer-editor')
    expect((editor as HTMLTextAreaElement).value).toBe(CODE)
    // 没改之前不算脏 —— 判据是「草稿与内容不逐字相同」,不是「进过编辑」。
    expect(screen.queryByTestId('viewer-dirty')).toBeNull()

    fireEvent.change(editor, { target: { value: `${CODE}// more\n` } })
    await waitFor(() => expect(screen.getByTestId('viewer-dirty')).toBeTruthy())
  })

  it('⌘S 走端口那条唯一的写口,并把手上这份内容就地换成草稿', async () => {
    const port = installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    fireEvent.change(screen.getByTestId('viewer-editor'), { target: { value: 'next' } })
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 's', metaKey: true })

    await waitFor(() => expect(port.saveContent).toHaveBeenCalledWith('/repo/a.ts', 'next', undefined))
    await waitFor(() => expect(screen.queryByTestId('viewer-dirty')).toBeNull())
    expect(screen.getByTestId('viewer-saved')).toBeTruthy()
    expect(useViewerSource.getState().file).toMatchObject({ content: 'next', mtimeMs: 42 })
  })

  it('盘上被别人改过:如实说,**不覆盖**(乐观锁的回执自成一句话)', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: true, content: CODE, size: 9, mtimeMs: 7 })),
      saveContent: vi.fn(async () => ({ success: false, conflict: true, error: 'stale' })),
    })
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    fireEvent.change(screen.getByTestId('viewer-editor'), { target: { value: 'mine' } })
    fireEvent.click(screen.getByTestId('viewer-save'))
    await waitFor(() =>
      expect(screen.getByText('这个文件在你打开之后被改过 —— 没有覆盖')).toBeTruthy(),
    )
    // 改动还在手上,一个字都没丢。
    expect(useViewerSource.getState().edit.draft).toBe('mine')
  })

  it('未保存时关闭 = 三按钮确认(取消 / 不保存 / 保存并关闭)', async () => {
    const port = installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    fireEvent.change(screen.getByTestId('viewer-editor'), { target: { value: 'dirty' } })
    fireEvent.click(screen.getByLabelText('关闭查看器'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '不保存' })).toBeTruthy()
    // 还没关掉 —— 确认之前它一定还在。
    expect(useViewerSource.getState().file).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '保存并关闭' }))
    await waitFor(() => expect(port.saveContent).toHaveBeenCalled())
    await waitFor(() => expect(useViewerSource.getState().file).toBeNull())
  })

  it('没有未保存的改动就直接关,不问', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.click(screen.getByLabelText('关闭查看器'))
    await waitFor(() => expect(useViewerSource.getState().file).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /*
   * 「铅笔是可开关的一枚(纯只读配置下整枚不渲染)」这条 F1 定稿**随铅笔一起
   * 退役**(09-01 檐减负):进出编辑只剩右键菜单那一条路,而那张菜单是与树行
   * 共用的一件,它不认识「这一份查看器是不是只读的」。
   *
   * 于是 `allowEdit` 那个 prop 也删了 —— 它**从来没有过消费者**(FilesPanel 与
   * ViewerPanel 都没传过),留着一个没人传的布尔只会让人以为有一条只读路径。
   * 记档:真需要一处只读宿主时,判据应当长在**那个宿主**上(它可以不给菜单),
   * 而不是查看器身上一个没人传的开关。
   */
  it('进编辑走右键菜单,出编辑走状态栏那颗「完成编辑」', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    expect(screen.getByTestId('viewer-editor')).toBeTruthy()
    fireEvent.click(screen.getByTestId('viewer-edit-done'))
    expect(screen.queryByTestId('viewer-editor')).toBeNull()
  })

  /*
   * 编辑框里的右键**让给文本域**(粘贴 / 撤销 / 拼写)。判据是「点在哪儿」而不是
   * 「在不在编辑态」—— 后者会连编辑态下点在别处的右键也一起吞掉,那时用户
   * 除了状态栏那颗钮再没有第二条出口。
   */
  it('编辑框里的右键让给文本域,不弹我们这张菜单', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    await toggleEditViaMenu()
    fireEvent.contextMenu(screen.getByTestId('viewer-editor'))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

/* ── ⌘L 跳转 ──────────────────────────────────────────────────────────── */

describe('⌘L 跳转条:跳转的唯一入口', () => {
  it('⌘L 开条;输入行号回车 → 落当前行', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 'l', metaKey: true })
    const bar = await screen.findByTestId('viewer-jump-bar')

    fireEvent.change(within(bar).getByLabelText('跳转到'), { target: { value: '3' } })
    fireEvent.keyDown(within(bar).getByLabelText('跳转到'), { key: 'Enter' })
    await waitFor(() => expect(useViewerSource.getState().view.currentLine).toBe(3))
    expect(screen.queryByTestId('viewer-jump-bar')).toBeNull()
  })

  it('状态栏那格「行 n:1 ⌘L」是它的第二个入口', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-jump'))
    expect(await screen.findByTestId('viewer-jump-bar')).toBeTruthy()
  })

  it('没接上的那两档**画出来**,写着「还没接上」,不藏起来(F2:检索已接真)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-jump'))
    const bar = await screen.findByTestId('viewer-jump-bar')
    // 空输入时把四档全列出来当提示;F2 起「检索命中」也真接上了,
    // 所以画成灰的只剩符号与改动两档。
    expect(within(bar).getByText('符号')).toBeTruthy()
    expect(within(bar).getByText('检索命中')).toBeTruthy()
    expect(within(bar).getAllByText('还没接上')).toHaveLength(2)
  })

  /*
   * ── ⌘F:同一条跳转条,前缀先打上(F2)────────────────────────────────
   * 「检索」在这台上不是第二块 UI —— 命中列表、跳行、当前行高亮、Esc 关掉
   * 四件事全是跳转条那套公共骨架的既有能力,检索只回答「这串字对应哪几行」。
   */
  it('⌘F 开的是同一条跳转条,而且把 `/` 前缀先打上', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 'f', metaKey: true })
    const bar = await screen.findByTestId('viewer-jump-bar')
    expect((within(bar).getByRole('textbox') as HTMLInputElement).value).toBe('/')
  })

  it('检索:一行一条命中,↵ 走一个、到底绕回第一个,当前行跟着走', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 'f', metaKey: true })
    const bar = await screen.findByTestId('viewer-jump-bar')
    const input = within(bar).getByRole('textbox')
    fireEvent.change(input, { target: { value: '/const' } })
    // CODE 三行都有 const —— 一行一条,不按出现次数发候选。
    await waitFor(() =>
      expect(screen.getByTestId('viewer-jump-count').textContent).toBe('第 1 个 · 共 3 个'),
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useViewerSource.getState().view.currentLine).toBe(1)
    // 落点之后**条不关**(cycle 档),↵ 再按走下一个。
    expect(screen.getByTestId('viewer-jump-bar')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useViewerSource.getState().view.currentLine).toBe(2)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useViewerSource.getState().view.currentLine).toBe(3)
    // 到底绕回第一个。
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useViewerSource.getState().view.currentLine).toBe(1)
  })

  it('检索没有命中时如实说一句,不给一张空表', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 'f', metaKey: true })
    const bar = await screen.findByTestId('viewer-jump-bar')
    fireEvent.change(within(bar).getByRole('textbox'), { target: { value: '/zzz' } })
    await waitFor(() => expect(screen.getByTestId('viewer-jump-empty')).toBeTruthy())
  })

  it('不按行寻址的体没有那一格(markdown 的渲染面)', async () => {
    installPort({ readContent: vi.fn(async () => ({ success: true, content: '# x', size: 3 })) })
    await open('/repo/README.md')
    renderViewer(<FileViewer />)
    expect(screen.queryByTestId('viewer-jump')).toBeNull()
  })

  /**
   * 散场行为的两条,拆掉哪一条都当场红:
   *  · Esc 关掉,而且**认领这一下**(preventDefault)—— 退层链读的正是它,
   *    不认领的话同一下 Esc 会继续往外把查看器所在的那块面一起收掉;
   *  · **不点外关**:点到正文上不该把条收掉,那一下多半正是用户在看清楚要跳哪儿。
   *
   * 09-02 批 6 它从手写监听迁进 `ui/float` 的 `useFloatDismiss`(浮层栈);
   * R1 再迁一次,这回迁到响应链:跳转条是一格 `float` 作用域,`onEscape` 一句
   * 声明,认领由那唯一的派发器代劳 —— 所以夹具里要有那个派发器
   * (`FocusDispatchHarness`),它就是外壳上那一格。
   */
  it('Esc 关掉跳转条,并认领这一下(退层链据 defaultPrevented 让位)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer()
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 'l', metaKey: true })
    await screen.findByTestId('viewer-jump-bar')

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(esc)
    })
    await waitFor(() => expect(screen.queryByTestId('viewer-jump-bar')).toBeNull())
    expect(esc.defaultPrevented).toBe(true)
  })

  it('点条外面**不**关它(原语默认是关的,这一档是显式关掉的)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    fireEvent.keyDown(screen.getByTestId('file-viewer'), { key: 'l', metaKey: true })
    await screen.findByTestId('viewer-jump-bar')

    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('viewer-jump-bar')).toBeTruthy()
  })
})

/* ── 状态栏 ────────────────────────────────────────────────────────────── */

describe('脚:26 的状态栏', () => {
  it('左段是这一型报的事实(语言 · 编码 · 换行符)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    expect(within(screen.getByTestId('viewer-status')).getByText('typescript · UTF-8 · LF')).toBeTruthy()
  })

  it('只载了一段时中段报「已载入 x%」并给一颗「继续加载」', async () => {
    const port = installPort({
      // 5MB 一段之外、20MB 上限之内 —— 正好是「首段 + 继续加载」那一档
      // (再大一档就是 oversize:那是另一句话)。
      readContent: vi.fn(async () => ({ success: true, content: CODE, size: 10 * 1024 * 1024 })),
    })
    await open('/repo/big.log')
    renderViewer(<FileViewer />)
    expect(screen.getByText(/已载入/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续加载' }))
    await waitFor(() => expect(port.readContent).toHaveBeenCalledTimes(2))
  })

  it('Vim 开关就地换档:模式标出现,而且**不重挂**查看器(体还是同一个节点)', async () => {
    installPort()
    await open('/repo/a.ts')
    renderViewer(<FileViewer />)
    const before = screen.getByTestId('viewer-code')
    fireEvent.click(screen.getByTestId('viewer-vim-toggle'))
    await waitFor(() => expect(screen.getByTestId('viewer-vim-mode').textContent).toBe('NORMAL'))
    expect(screen.getByTestId('viewer-code')).toBe(before)
    expect(useViewerSource.getState().view.keymap).toBe('vim')
  })
})
