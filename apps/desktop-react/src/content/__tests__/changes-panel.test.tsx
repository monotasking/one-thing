import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ResourceReadView } from '@shared/ipc/resources'
import { ChangesPanel } from '../changes/ChangesPanel'
import { ChangeFileView } from '../changes/ChangeFileView'
import { configureGitPort } from '../../data/git-port'
import type { GitPort } from '../../data/git-port'
import { resetChangesSource, statusQuery } from '../../data/changes-source'
import type { GitChangedFile } from '../../data/changes-source'
import { useFileOpenMode } from '../../data/file-open-mode'
import { openStateOf, useWorkbenchStore } from '../../workbench/store'
import { refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import { focusTree } from '../../focus/registry'
import { changeRef } from '../kinds/change-ref'
import { fileRef } from '../viewer/open-target'
import { t } from '../../i18n'
import { FocusDispatchHarness } from '../../test/focus-harness'
import '../kinds'

/**
 * **「改动」面**(正本 `apps/desktop-react/docs/changes-panel-2026-09.md` §3.4;
 * 批⑤「列与正文拆开」= `docs/changes-file-view-2026-09.md` §6.3 第一条)。
 *
 * 批⑤ 之后这只文件分成**两半**,与产品的那一刀同一处:
 *  · `ChangesPanel` = 一列文件 + 开一格的那条路 + 行菜单(下面前两组);
 *  · `ChangeFileView` = 那一格正文,**直接渲染它**(它自足了,不必先摆一块面出来
 *    —— 那正是这一单要证的事:它离开那块面也活得下去)。
 *
 * 取数走假端口(`configureGitPort`)—— 这一组问的是**这块面按读数画成什么**,
 * 后端那半边由它自己那组守。
 *
 * **反证**(逐条真跑过):
 *  · `openChange` 不按档走(写死 `openRef(ref)`)→「`panel` 档不开新标签」当场红;
 *  · ↵ 那一句 `focusIntoRefAfterCommit` 拿掉 →「↵ 多一发点名」红;
 *  · 把 `onDoubleClick` 加回行上 →「双击零处理器」红;
 *  · `{repo:false}` 折成 error → 「not-a-repo」那一条红(屏幕上是一条报错行)。
 */

const ROOT = '/repo/a'
const A_PATH = 'src/a.ts'

const ok = (value: unknown): ResourceReadView => ({ kind: 'ok', value }) as ResourceReadView

const file = (path: string, over: Partial<GitChangedFile> = {}): GitChangedFile => ({
  path,
  status: 'modified',
  staged: false,
  unstaged: true,
  add: 3,
  del: 1,
  ...over,
})

/**
 * 整文件视图吃的是**两个版本的原文**(批 ③-b:`git:` 的 `file` 读法),
 * 行级 diff 在壳里算(`content/code/line-diff.ts`)。
 * 这一对造出**两处**改动(第 2 行、第 6 行),中间隔着未改的行 —— ↑↓ 与
 * 改动地图都要有两块可走。
 */
const HEAD_TEXT = 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\nconst e = 5\nconst f = 6\n'
const WORK_TEXT = 'const a = 1\nconst b = 3\nconst c = 3\nconst d = 4\nconst e = 5\nconst f = 7\n'

const version = (text: string, over: Record<string, unknown> = {}) => ({
  text,
  binary: false,
  truncated: false,
  bytes: text.length,
  ...over,
})

/** 这一发 status 答什么(每个用例自己改)。 */
let status: () => ResourceReadView
/** 这一发 `file` 答什么。 */
let fileText: () => ResourceReadView
/** 每条读法各被问了几次(「刷新真的发了一发」靠它钉)。 */
let calls: Record<string, number>
/** 把 `status` 那一发挂住(refetching 那一档要一份在飞的读数)。 */
let holdStatus: (() => void) | null

function installPort(): void {
  calls = { status: 0, file: 0 }
  const port: GitPort = {
    ready: async () => undefined,
    read: vi.fn(async (_ref, name) => {
      calls[name] = (calls[name] ?? 0) + 1
      if (name === 'file') return fileText()
      if (holdStatus) await new Promise<void>((resolve) => (holdStatus = resolve))
      return status()
    }),
  }
  configureGitPort(port)
}

/** 一格内容此刻开着没有(`openStateOf` 是那三格事实的唯一判官)。 */
const openedState = (ref: { kind: string; key: string }) => {
  const st = useWorkbenchStore.getState()
  return openStateOf({ regions: st.regions, hidden: st.hidden, panelPath: st.panelPath }, ref)
}

/** 整棵树上装着这一格的 tab 有几份(「同一行点两下不开出两格」靠它钉)。 */
const tabsOf = (ref: { kind: string; key: string }): number => {
  const id = refId(ref)
  return Object.values(useWorkbenchStore.getState().regions)
    .flatMap((tree) => leavesOf(tree))
    .reduce((n, leaf) => n + leaf.tabs.filter((tab) => refId(tab) === id).length, 0)
}

/** 屏幕上此刻画出来的那几行(取件口是行自己那格 `data-change-path`)。 */
const rowsOnScreen = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-change-path]'))

/** 这块面挂在一台**有派发器**的壳上(响应链上线之后单渲一件浮层按不出键)。 */
function mount(root = ROOT) {
  return render(
    <>
      <FocusDispatchHarness />
      <ChangesPanel root={root} />
    </>,
  )
}

/**
 * **直接渲染那一格正文**(批⑤:它自足了)。`owner` 给了就是标准档(自己一格
 * 作用域),不给就是改动面 `panel` 档那条内联分栏。
 */
function mountView(path = A_PATH, owner?: string) {
  return render(
    <>
      <FocusDispatchHarness />
      <ChangeFileView root={ROOT} path={path} owner={owner} />
    </>,
  )
}

beforeEach(() => {
  resetChangesSource()
  installPort()
  status = () =>
    ok({
      repo: true,
      root: ROOT,
      branch: 'main',
      head: 'abc1234',
      files: [file(A_PATH), file('docs/b.md', { status: 'added', add: 9, del: 0 })],
      stat: { add: 12, del: 1, files: 2 },
    })
  fileText = () => ok({ path: A_PATH, head: version(HEAD_TEXT), work: version(WORK_TEXT) })
  holdStatus = null
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
  // 打开方式是一格**跨用例会漏**的偏好(它 persist 在 localStorage 里):
  // 每一条从出厂那一档起算,免得上一条挑的 `panel` 把下一条判成「不开标签」。
  useFileOpenMode.setState({ mode: 'stage' })
})

afterEach(() => {
  configureGitPort(undefined)
  resetChangesSource()
})

describe('六态', () => {
  it('initial:首载在飞时画骨架', async () => {
    holdStatus = () => {}
    mount()
    expect(await screen.findByTestId('changes-skeleton')).toBeTruthy()
    // 骨架**只在首载**:列这时还没有。
    expect(screen.queryByTestId('changes-list')).toBeNull()
  })

  it('not-a-repo:`{repo:false}` 画一句话 + 路径,**零按钮**', async () => {
    status = () => ok({ repo: false })
    mount()
    const box = await screen.findByTestId('changes-not-repo')
    expect(box.textContent).toContain(t('diff.notRepo'))
    expect(box.textContent).toContain(ROOT)
    // 「接入 git」不是这块面的事 —— 这一档里没有任何一颗钮。
    expect(box.querySelectorAll('button')).toHaveLength(0)
  })

  it('clean:一句话 + 分支名', async () => {
    status = () => ok({ repo: true, root: ROOT, branch: 'main', files: [], stat: { add: 0, del: 0, files: 0 } })
    mount()
    const box = await screen.findByTestId('changes-clean')
    expect(box.textContent).toContain(t('diff.clean'))
    expect(box.textContent).toContain('main')
  })

  it('ready:两行 + **首次把键盘位落到第一行**(而且什么都不打开)', async () => {
    mount()
    await screen.findByTestId('changes-list')
    const rows = rowsOnScreen()
    expect(rows.map((r) => r.getAttribute('data-change-path'))).toEqual([A_PATH, 'docs/b.md'])
    expect(rows[0].getAttribute('data-change-selected')).toBe('true')
    // **键盘位不是打开**(批⑤):一块面自己开出来的 tab 是没人要过的打开。
    expect(tabsOf(changeRef(ROOT, A_PATH))).toBe(0)
    expect(calls.file).toBe(0)
  })

  it('error:通知行 + **后端原话** + 重试钮,而且旧屏不清', async () => {
    mount()
    await screen.findByTestId('changes-list')
    status = () => ({ kind: 'denied', reason: 'outside the sandbox' }) as ResourceReadView
    await act(async () => {
      await statusQuery.get(ROOT).refetch()
    })
    const row = await screen.findByTestId('changes-error')
    expect(row.textContent).toContain('outside the sandbox')
    expect(row.querySelector('button')).toBeTruthy()
    // **旧屏不清**(律②):上一次读到的两行还在。
    expect(rowsOnScreen()).toHaveLength(2)
  })

  it('refetching:旧屏一格不动,骨架**不回来**', async () => {
    mount()
    await screen.findByTestId('changes-list')
    const before = rowsOnScreen()[0]

    holdStatus = () => {}
    act(() => void statusQuery.get(ROOT).refetch())
    await waitFor(() => expect(statusQuery.get(ROOT).get().inflight).toBe(true))

    expect(screen.queryByTestId('changes-skeleton')).toBeNull()
    // **同一个 DOM 节点**(律④:零重挂)。
    expect(rowsOnScreen()[0]).toBe(before)
  })
})

describe('批⑤:列与正文拆开', () => {
  it('缺省**只有列** —— 一块正文都不画,分隔杆也不在', async () => {
    mount()
    await screen.findByTestId('changes-list')
    expect(screen.queryByTestId('changes-body')).toBeNull()
    expect(screen.queryByTestId('changes-file-view')).toBeNull()
    expect(screen.queryByTestId('changes-splitter')).toBeNull()
  })

  it('单击一行 → 开一格 `change:`,落点按当下这一档(出厂 = 中央区)', async () => {
    mount()
    await screen.findByTestId('changes-list')
    act(() => rowsOnScreen()[0].click())
    const ref = changeRef(ROOT, A_PATH)
    expect(openedState(ref)).toBe('shown')
    expect(useWorkbenchStore.getState().regions.center).toBeDefined()
    // **同一行点两下不开出两格**(`insertTab` 在同一片叶里只激活)。
    act(() => rowsOnScreen()[0].click())
    expect(tabsOf(ref)).toBe(1)
  })

  it('单击开的是**改动**那一格,不是那个文件', async () => {
    mount()
    await screen.findByTestId('changes-list')
    act(() => rowsOnScreen()[0].click())
    expect(openedState(changeRef(ROOT, A_PATH))).toBe('shown')
    expect(openedState(fileRef(`${ROOT}/${A_PATH}`))).toBeNull()
  })

  it('↵ 走**同一条路**,只多一件:点名把焦点送进开出来的那一格', async () => {
    const spy = vi.spyOn(focusTree, 'activateScope')
    mount()
    await screen.findByTestId('changes-list')
    const ref = changeRef(ROOT, A_PATH)

    act(() => rowsOnScreen()[0].click())
    // 单击**不送焦点**(响应链规则 4:导航器里浏览不抢焦点)。
    expect(spy.mock.calls.some(([, opts]) => opts?.owner === refId(ref))).toBe(false)

    await act(async () => {
      fireEvent.keyDown(rowsOnScreen()[0], { key: 'Enter' })
      await Promise.resolve()
    })
    expect(
      spy.mock.calls.some(([scope, opts]) => scope === 'diff' && opts?.owner === refId(ref)),
    ).toBe(true)
    spy.mockRestore()
  })

  it('`panel` 那一档:面板里长出分栏 + 内联正文,**中央区一格不多**', async () => {
    useFileOpenMode.setState({ mode: 'panel' })
    mount()
    await screen.findByTestId('changes-list')
    act(() => rowsOnScreen()[0].click())

    expect(await screen.findByTestId('changes-splitter')).toBeTruthy()
    const view = await screen.findByTestId('changes-file-view')
    // 内联那一档**不登记作用域**(它是这块面的一部分)。
    expect(view.getAttribute('data-change-inline')).toBe('true')
    expect(view.getAttribute('data-focus-scope')).toBeNull()
    expect(screen.getByTestId('changes-body').getAttribute('data-change-body-path')).toBe(A_PATH)
    expect(tabsOf(changeRef(ROOT, A_PATH))).toBe(0)
  })

  it('行尾那颗开态点:开着才画,而且画的是**这一行**那一格', async () => {
    mount()
    await screen.findByTestId('changes-list')
    expect(rowsOnScreen()[0].getAttribute('data-change-open')).toBeNull()
    act(() => rowsOnScreen()[0].click())
    await waitFor(() => expect(rowsOnScreen()[0].getAttribute('data-change-open')).toBe('shown'))
    // 另一行没开 —— 那一格仍旧不在场。
    expect(rowsOnScreen()[1].getAttribute('data-change-open')).toBeNull()
  })

  it('**双击零处理器**(壳禁令:双击不作动作触发)', async () => {
    mount()
    await screen.findByTestId('changes-list')
    act(() => {
      rowsOnScreen()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(tabsOf(changeRef(ROOT, A_PATH))).toBe(0)
    expect(screen.queryByTestId('changes-body')).toBeNull()
  })

  it('右键 → 四项动作(打开改动 / 打开文件 / 打开方式 ▸ / 在文件管理器里显示)', async () => {
    mount()
    await screen.findByTestId('changes-list')
    act(() => {
      fireEvent.contextMenu(rowsOnScreen()[0], { clientX: 40, clientY: 60 })
    })
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((el) => el.textContent)).toEqual([
      t('diff.menuOpenChange'),
      t('diff.menuOpenFile'),
      t('files.openWith'),
      t('files.reveal'),
    ])
  })

  it('菜单里的「打开改动」与单击同一条路', async () => {
    mount()
    await screen.findByTestId('changes-list')
    act(() => {
      fireEvent.contextMenu(rowsOnScreen()[0], { clientX: 40, clientY: 60 })
    })
    const open = await screen.findByText(t('diff.menuOpenChange'))
    act(() => open.click())
    expect(openedState(changeRef(ROOT, A_PATH))).toBe('shown')
  })

  it('已删除的那一行:「在查看器里打开文件」与「在文件管理器里显示」**按不动**', async () => {
    status = () =>
      ok({
        repo: true,
        root: ROOT,
        files: [file('gone.ts', { status: 'deleted', add: 0, del: 4 })],
        stat: { add: 0, del: 4, files: 1 },
      })
    mount()
    await screen.findByTestId('changes-list')
    act(() => {
      fireEvent.contextMenu(rowsOnScreen()[0], { clientX: 40, clientY: 60 })
    })
    const items = await screen.findAllByRole('menuitem')
    const disabled = items.filter((el) => (el as HTMLButtonElement).disabled).map((el) => el.textContent)
    expect(disabled).toEqual([t('diff.menuOpenFile'), t('files.reveal')])
    // 「打开改动」照旧按得动 —— 删掉的文件**有**改动可看(整篇 del)。
    expect(openedState(changeRef(ROOT, 'gone.ts'))).toBeNull()
  })
})

describe('整文件视图的四态(批 ③-b;批⑤ 起直接渲染它)', () => {
  /** 屏幕上那几行(取件口是基础件落的 `data-line-index`)。 */
  const linesOnScreen = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="changes-body"] [data-line-index]'))

  const marksOf = () =>
    linesOnScreen().map((el) =>
      el.className.includes('lineAdd') ? 'add' : el.className.includes('lineDel') ? 'del' : 'ctx',
    )

  it('**自足**:只收 root + path,自己取两版原文、自己拿 ± 与状态', async () => {
    mountView()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBeGreaterThan(0))
    // ± 来自 `status` 那一份里自己那一行(夹具:+3 −1)。
    const head = screen.getByTestId('changes-body').querySelector('[class*="bodyHead"]')
    expect(head?.textContent).toContain('+3')
    expect(head?.textContent).toContain('−1')
  })

  it('标准档(带 owner)自己是一格 `diff` 作用域,落点是正文那块滚动容器', async () => {
    mountView(A_PATH, refId(changeRef(ROOT, A_PATH)))
    const view = await screen.findByTestId('changes-file-view')
    expect(view.getAttribute('data-focus-scope')).toBe('diff')
    expect(view.getAttribute('data-change-inline')).toBeNull()
    expect(screen.getByTestId('changes-body').getAttribute('tabindex')).toBe('-1')
  })

  it('两版都在 → 整文件:行数 = 文件行数 + 改动行,未改的行两个号都有', async () => {
    mountView()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBeGreaterThan(0))
    // 六行里两行改了 = 4 未改 + 2 删 + 2 增。
    expect(marksOf()).toEqual(['ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'del', 'add'])
    const first = linesOnScreen()[0]
    expect(first.getAttribute('data-old-no')).toBe('1')
    expect(first.getAttribute('data-new-no')).toBe('1')
  })

  it('只有 head(文件删掉了)→ 整篇 del,一行都没有新行号', async () => {
    fileText = () => ok({ path: A_PATH, head: version(HEAD_TEXT), work: null })
    mountView()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBe(6))
    expect(marksOf().every((m) => m === 'del')).toBe(true)
    expect(linesOnScreen().every((el) => !el.hasAttribute('data-new-no'))).toBe(true)
    // **整篇删除的文件里 ↑↓ 照样有落点** —— 当前行按下标定位,不按新行号。
    expect(linesOnScreen()[0].getAttribute('data-current')).toBe('true')
  })

  it('只有 work(新文件)→ 整篇 add,一行都没有旧行号', async () => {
    fileText = () => ok({ path: A_PATH, head: null, work: version(WORK_TEXT) })
    mountView()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBe(6))
    expect(marksOf().every((m) => m === 'add')).toBe(true)
    expect(linesOnScreen().every((el) => !el.hasAttribute('data-old-no'))).toBe(true)
  })

  it('任一版 binary:一句「不展示」,一行都不画', async () => {
    fileText = () =>
      ok({ path: A_PATH, head: version('', { binary: true }), work: version(WORK_TEXT) })
    mountView()
    expect(await screen.findByTestId('changes-body-binary')).toBeTruthy()
    expect(linesOnScreen()).toHaveLength(0)
  })

  it('truncated:块尾一行', async () => {
    fileText = () =>
      ok({ path: A_PATH, head: version(HEAD_TEXT), work: version(WORK_TEXT, { truncated: true }) })
    mountView()
    expect(await screen.findByTestId('changes-body-truncated')).toBeTruthy()
  })

  it('两版一模一样:一句「此刻没有改动」,导航整组不画', async () => {
    fileText = () => ok({ path: A_PATH, head: version(HEAD_TEXT), work: version(HEAD_TEXT) })
    mountView()
    expect(await screen.findByTestId('changes-body-empty')).toBeTruthy()
    expect(screen.queryByTestId('changes-nav')).toBeNull()
  })

  it('**这一行不在改动表里了** → 一句话,而且 tab 不自动关(§6.4 裁定)', async () => {
    mountView('src/never-changed.ts')
    expect(await screen.findByTestId('changes-body-gone')).toBeTruthy()
    // 说了话,但这一格还在屏上 —— 关掉别人的标签不是这块面的事。
    expect(screen.getByTestId('changes-file-view')).toBeTruthy()
    expect(linesOnScreen()).toHaveLength(0)
  })
})

describe('改动导航:↑ k / N ↓ 与右缘那张地图', () => {
  const countText = () => screen.getByTestId('changes-nav-count').textContent
  const currentIndex = () =>
    document
      .querySelector('[data-testid="changes-body"] [data-current="true"]')
      ?.getAttribute('data-line-index')

  it('首次 ready 落在第一块,读数是 `1 / N`', async () => {
    mountView()
    await screen.findByTestId('changes-nav')
    expect(countText()).toBe('1 / 2')
    expect(currentIndex()).toBe('1')
  })

  it('↓ 走到下一块,↑ 回来,而且**到头循环**', async () => {
    mountView()
    await screen.findByTestId('changes-nav')
    act(() => screen.getByTestId('changes-next').click())
    expect(countText()).toBe('2 / 2')
    expect(currentIndex()).toBe('6')
    // 最后一块再往下 → 回到第一块(循环,不是禁用)。
    act(() => screen.getByTestId('changes-next').click())
    expect(countText()).toBe('1 / 2')
    // 第一块再往上 → 到最后一块。
    act(() => screen.getByTestId('changes-prev').click())
    expect(countText()).toBe('2 / 2')
  })

  it('读数给读屏的是一整句(`第 k 处改动,共 n 处`)', async () => {
    mountView()
    await screen.findByTestId('changes-nav')
    expect(screen.getByTestId('changes-nav-count').getAttribute('aria-label')).toBe(
      t('diff.changeAt', { k: 1, n: 2 }),
    )
  })

  it('地图每块一格,点一格跳过去', async () => {
    mountView()
    const map = await screen.findByTestId('changes-map')
    expect(map.querySelectorAll('[data-change-block]')).toHaveLength(2)
    expect(map.querySelector('[data-change-block="0"]')?.getAttribute('data-active')).toBe('true')
    /*
     * 点的是**位置**不是格子(两千处改动时格子只有半个像素高)。jsdom 里
     * `getBoundingClientRect` 恒零,所以这里把它按下去再量那条判据本身
     * —— 真机那一半在 `gate:changes` ⑦ 上。
     */
    act(() => screen.getByTestId('changes-next').click())
    expect(map.querySelector('[data-change-block="1"]')?.getAttribute('data-active')).toBe('true')
    expect(map.querySelector('[data-change-block="0"]')?.getAttribute('data-active')).toBeNull()
  })

  it('地图那条带子不在 Tab 序里(键盘的路是檐上那两颗钮)', async () => {
    mountView()
    const map = await screen.findByTestId('changes-map')
    expect(map.getAttribute('tabindex')).toBe('-1')
    expect(map.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('超量:2 000 行', () => {
  it('画得出来,而且**刷新一次之后旧行是同一个 DOM 节点**(零重挂)', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => file(`src/mod-${i}/a.ts`))
    status = () => ok({ repo: true, root: ROOT, files: many, stat: { add: 6000, del: 2000, files: 2000 } })
    mount()
    await screen.findByTestId('changes-list')
    const before = rowsOnScreen()
    expect(before.length).toBeGreaterThan(0)
    const firstNode = before[0]

    await act(async () => {
      await statusQuery.get(ROOT).refetch()
    })

    const after = rowsOnScreen()
    expect(after[0]).toBe(firstNode)
    expect(after.length).toBe(before.length)
  })
})
