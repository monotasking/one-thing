import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileViewer } from '../viewer/FileViewer'
import {
  commandFor,
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
import { useViewerSource } from '../../data/viewer-source'
import type { ViewerFile } from '../../data/viewer-source'
import { useFileOpenMode } from '../../data/file-open-mode'
import { useStageStore } from '../../stage/store'

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
  it('四档在表里,今天只有行号真接上(其余画成灰的,不藏起来)', () => {
    const navigators = listNavigators()
    expect(navigators.map((n) => n.id)).toEqual(['line', 'symbol', 'search', 'diff'])
    expect(navigators.filter((n) => n.list).map((n) => n.id)).toEqual(['line'])
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

  it('组合键 → 能力是纯函数(mod = ⌘ 或 Ctrl)', () => {
    const map = keymapById('default')
    const press = (key: string, meta = true) => ({
      key,
      metaKey: meta,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    })
    expect(commandFor(map, press('s'))).toBe('save')
    expect(commandFor(map, press('l'))).toBe('jump')
    expect(commandFor(map, press('s', false))).toBeUndefined()
    expect(commandFor(map, press('k'))).toBeUndefined()
  })
})

/* ── 三层形状 ──────────────────────────────────────────────────────────── */

describe('头:身份与去向(大小与时间不在这里)', () => {
  it('类型徽 + 名 + 路径钮 + 打开方式 + 关闭;没有大小也没有时间', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    expect(screen.getByTestId('viewer-name').textContent).toBe('a.ts')
    expect(screen.getByTestId('viewer-name').getAttribute('data-viewer-path')).toBe('/repo/a.ts')
    expect(screen.getByTestId('viewer-copy-path')).toBeTruthy()
    expect(screen.getByTestId('viewer-open-mode')).toBeTruthy()
    expect(screen.getByLabelText('关闭查看器')).toBeTruthy()
    // 大小与时间是详情面的事:这块头上一个数都没有。
    expect(screen.queryByText(/KB|MB|B$/)).toBeNull()
  })

  it('路径点即复制,就地变「已复制」,**零通知**', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-copy-path'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/repo/a.ts'))
    await waitFor(() => expect(screen.getByTestId('viewer-copy-path').textContent).toBe('已复制'))
  })

  it('「打开方式」与树行菜单**同一张表、同一份记忆**(七档,只有面板内接上)', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-open-mode'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(7)
    expect(screen.getAllByText('还没接上')).toHaveLength(6)
    fireEvent.click(screen.getByText('浮窗'))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('float'))
  })

  it('Finder 那颗把整条路径交给宿主(查看器自己不认识那条端口)', async () => {
    installPort()
    await open('/repo/a.ts')
    const onReveal = vi.fn()
    render(<FileViewer onReveal={onReveal} />)
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示' }))
    expect(onReveal).toHaveBeenCalledWith('/repo/a.ts')
  })
})

describe('体:code 型', () => {
  it('行由我们自己切(不等高亮器),每一行一个块级盒 —— 行号靠 counter,不进选区', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
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
    render(<FileViewer />)
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
    render(<FileViewer />)
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
    render(<FileViewer />)
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
    render(<FileViewer onReveal={vi.fn()} />)
    expect(screen.getByTestId('viewer-honest')).toBeTruthy()
    expect(screen.getByText('这是二进制文件,没法按文本查看')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
  })

  it('读不到:三档失败各一句话 + 后端原话原样', async () => {
    installPort({
      readContent: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied' })),
    })
    await open('/repo/secret.ts')
    render(<FileViewer />)
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
    const { rerender } = render(<FileViewer />)
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

  it('② 骨架**只首载**:手上什么都没有的那一帧才画转圈', async () => {
    installPort()
    render(<FileViewer />)
    expect(screen.getByTestId('viewer-first-load')).toBeTruthy()
    await open('/repo/a.ts')
    await waitFor(() => expect(screen.queryByTestId('viewer-first-load')).toBeNull())
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
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-edit-toggle'))
    fireEvent.change(screen.getByTestId('viewer-editor'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByTestId('viewer-save'))
    await waitFor(() => expect(screen.getByTestId('viewer-save').textContent).toBe('正在保存…'))
    expect(screen.getByTestId('viewer-save')).toHaveProperty('disabled', true)
    await act(async () => {
      release?.({ success: true })
    })
  })
})

/* ── 轻编辑 ────────────────────────────────────────────────────────────── */

describe('轻编辑:铅笔 → 等宽文本 → ⌘S', () => {
  it('铅笔进编辑:一块等宽可写文本(无高亮),改了就挂「未保存」丸', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    expect(screen.queryByTestId('viewer-dirty')).toBeNull()

    fireEvent.click(screen.getByTestId('viewer-edit-toggle'))
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
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-edit-toggle'))
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
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-edit-toggle'))
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
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-edit-toggle'))
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
    render(<FileViewer />)
    fireEvent.click(screen.getByLabelText('关闭查看器'))
    await waitFor(() => expect(useViewerSource.getState().file).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('铅笔是可开关的一枚:关掉它整枚不渲染,别的一格都不变', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer allowEdit={false} />)
    expect(screen.queryByTestId('viewer-edit-toggle')).toBeNull()
    // 别的照旧:路径、打开方式、关闭、状态栏都在。
    expect(screen.getByTestId('viewer-copy-path')).toBeTruthy()
    expect(screen.getByTestId('viewer-status')).toBeTruthy()
  })
})

/* ── ⌘L 跳转 ──────────────────────────────────────────────────────────── */

describe('⌘L 跳转条:跳转的唯一入口', () => {
  it('⌘L 开条;输入行号回车 → 落当前行', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
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
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-jump'))
    expect(await screen.findByTestId('viewer-jump-bar')).toBeTruthy()
  })

  it('没接上的那几档**画出来**,写着「还没接上」,不藏起来', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    fireEvent.click(screen.getByTestId('viewer-jump'))
    const bar = await screen.findByTestId('viewer-jump-bar')
    // 空输入时把四档全列出来当提示。
    expect(within(bar).getByText('符号')).toBeTruthy()
    expect(within(bar).getAllByText('还没接上')).toHaveLength(3)
  })

  it('不按行寻址的体没有那一格(markdown 的渲染面)', async () => {
    installPort({ readContent: vi.fn(async () => ({ success: true, content: '# x', size: 3 })) })
    await open('/repo/README.md')
    render(<FileViewer />)
    expect(screen.queryByTestId('viewer-jump')).toBeNull()
  })
})

/* ── 状态栏 ────────────────────────────────────────────────────────────── */

describe('脚:26 的状态栏', () => {
  it('左段是这一型报的事实(语言 · 编码 · 换行符)', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    expect(within(screen.getByTestId('viewer-status')).getByText('typescript · UTF-8 · LF')).toBeTruthy()
  })

  it('只载了一段时中段报「已载入 x%」并给一颗「继续加载」', async () => {
    const port = installPort({
      // 5MB 一段之外、20MB 上限之内 —— 正好是「首段 + 继续加载」那一档
      // (再大一档就是 oversize:那是另一句话)。
      readContent: vi.fn(async () => ({ success: true, content: CODE, size: 10 * 1024 * 1024 })),
    })
    await open('/repo/big.log')
    render(<FileViewer />)
    expect(screen.getByText(/已载入/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续加载' }))
    await waitFor(() => expect(port.readContent).toHaveBeenCalledTimes(2))
  })

  it('Vim 开关就地换档:模式标出现,而且**不重挂**查看器(体还是同一个节点)', async () => {
    installPort()
    await open('/repo/a.ts')
    render(<FileViewer />)
    const before = screen.getByTestId('viewer-code')
    fireEvent.click(screen.getByTestId('viewer-vim-toggle'))
    await waitFor(() => expect(screen.getByTestId('viewer-vim-mode').textContent).toBe('NORMAL'))
    expect(screen.getByTestId('viewer-code')).toBe(before)
    expect(useViewerSource.getState().view.keymap).toBe('vim')
  })
})
