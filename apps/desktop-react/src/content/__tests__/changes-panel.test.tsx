import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ResourceReadView } from '@shared/ipc/resources'
import { ChangesPanel } from '../changes/ChangesPanel'
import { configureGitPort } from '../../data/git-port'
import type { GitPort } from '../../data/git-port'
import { resetChangesSource, statusQuery } from '../../data/changes-source'
import type { GitChangedFile } from '../../data/changes-source'
import { openStateOf, useWorkbenchStore } from '../../workbench/store'
import { fileRef } from '../viewer/open-target'
import { t } from '../../i18n'
import { FocusDispatchHarness } from '../../test/focus-harness'
import '../kinds'

/**
 * **「改动」面**(正本 `apps/desktop-react/docs/changes-panel-2026-09.md` §3.4;
 * 壳侧 §4 第四组)。
 *
 * 六态各一例 + 选行开文件 + **超量零重挂**:
 *  initial / not-a-repo / clean / ready / error / refetching。
 *
 * 取数走假端口(`configureGitPort`)—— 这一组问的是**这块面按读数画成什么**,
 * 后端那半边由它自己那组守。
 *
 * **反证**:`{repo:false}` 折成 error(在 `changes-source.readGit` 里对它 throw)
 * → 「not-a-repo」那一条当场红(屏幕上是一条报错行,不是那句话)。
 */

const ROOT = '/repo/a'

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

/** 一份文件此刻开着没有(`openStateOf` 是那三格事实的唯一判官)。 */
const openedState = (path: string) => {
  const st = useWorkbenchStore.getState()
  return openStateOf({ regions: st.regions, hidden: st.hidden, panelPath: st.panelPath }, fileRef(path))
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

beforeEach(() => {
  resetChangesSource()
  installPort()
  status = () =>
    ok({
      repo: true,
      root: ROOT,
      branch: 'main',
      head: 'abc1234',
      files: [file('src/a.ts'), file('docs/b.md', { status: 'added', add: 9, del: 0 })],
      stat: { add: 12, del: 1, files: 2 },
    })
  fileText = () =>
    ok({ path: 'src/a.ts', head: version(HEAD_TEXT), work: version(WORK_TEXT) })
  holdStatus = null
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
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
    // 骨架**只在首载**:列与体这时一个都没有。
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

  it('ready:两行 + **首次自动选第一行** + 那一行的 diff', async () => {
    mount()
    await screen.findByTestId('changes-list')
    const rows = rowsOnScreen()
    expect(rows.map((r) => r.getAttribute('data-change-path'))).toEqual(['src/a.ts', 'docs/b.md'])
    expect(rows[0].getAttribute('data-change-selected')).toBe('true')
    await waitFor(() => expect(screen.getByTestId('changes-body')).toBeTruthy())
    expect(screen.getByTestId('changes-body').getAttribute('data-change-body-path')).toBe('src/a.ts')
    // diff 体画的是块本体解析出来的行(`+const b = 3` 那一行真在屏上)。
    expect(screen.getByTestId('changes-body').textContent).toContain('const b = 3')
  })

  it('diff 体逐**行**跳渲 —— 这块面把 `skip` 递下去(两万行那一格的前提)', async () => {
    mount()
    await screen.findByTestId('changes-list')
    await waitFor(() => expect(screen.getByTestId('changes-body')).toBeTruthy())
    /*
     * 2026-09-13 批 ②:containment 的粒度从 hunk 盒回到**行**(行高取整之后逐行
     * 才不留缝,判词在 `CodeLines.module.css` 规矩③ 与 `ChangesPanel.module.css`
     * 那段病历上)。谁要跳渲由宿主说 —— 聊天正文里那块不传,这块面传 `true`。
     */
    const rows = Array.from(
      screen.getByTestId('changes-body').querySelectorAll('[class*="line"]'),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.className.includes('lineSkip'))).toBe(true)
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

describe('整文件视图的四态(批 ③-b)', () => {
  /** 屏幕上那几行(取件口是基础件落的 `data-line-index`)。 */
  const linesOnScreen = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="changes-body"] [data-line-index]'))

  const marksOf = () =>
    linesOnScreen().map((el) =>
      el.className.includes('lineAdd') ? 'add' : el.className.includes('lineDel') ? 'del' : 'ctx',
    )

  it('两版都在 → 整文件:行数 = 文件行数 + 改动行,未改的行两个号都有', async () => {
    mount()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBeGreaterThan(0))
    // 六行里两行改了 = 4 未改 + 2 删 + 2 增。
    expect(marksOf()).toEqual(['ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'del', 'add'])
    const first = linesOnScreen()[0]
    expect(first.getAttribute('data-old-no')).toBe('1')
    expect(first.getAttribute('data-new-no')).toBe('1')
  })

  it('只有 head(文件删掉了)→ 整篇 del,一行都没有新行号', async () => {
    fileText = () => ok({ path: 'src/a.ts', head: version(HEAD_TEXT), work: null })
    mount()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBe(6))
    expect(marksOf().every((m) => m === 'del')).toBe(true)
    expect(linesOnScreen().every((el) => !el.hasAttribute('data-new-no'))).toBe(true)
    // **整篇删除的文件里 ↑↓ 照样有落点** —— 当前行按下标定位,不按新行号。
    expect(linesOnScreen()[0].getAttribute('data-current')).toBe('true')
  })

  it('只有 work(新文件)→ 整篇 add,一行都没有旧行号', async () => {
    fileText = () => ok({ path: 'src/a.ts', head: null, work: version(WORK_TEXT) })
    mount()
    await screen.findByTestId('changes-body')
    await waitFor(() => expect(linesOnScreen().length).toBe(6))
    expect(marksOf().every((m) => m === 'add')).toBe(true)
    expect(linesOnScreen().every((el) => !el.hasAttribute('data-old-no'))).toBe(true)
  })

  it('任一版 binary:一句「不展示」,一行都不画', async () => {
    fileText = () =>
      ok({ path: 'src/a.ts', head: version('', { binary: true }), work: version(WORK_TEXT) })
    mount()
    expect(await screen.findByTestId('changes-body-binary')).toBeTruthy()
    expect(linesOnScreen()).toHaveLength(0)
  })

  it('truncated:块尾一行', async () => {
    fileText = () =>
      ok({ path: 'src/a.ts', head: version(HEAD_TEXT), work: version(WORK_TEXT, { truncated: true }) })
    mount()
    expect(await screen.findByTestId('changes-body-truncated')).toBeTruthy()
  })

  it('两版一模一样:一句「此刻没有改动」,导航整组不画', async () => {
    fileText = () => ok({ path: 'src/a.ts', head: version(HEAD_TEXT), work: version(HEAD_TEXT) })
    mount()
    expect(await screen.findByTestId('changes-body-empty')).toBeTruthy()
    expect(screen.queryByTestId('changes-nav')).toBeNull()
  })
})

describe('改动导航:↑ k / N ↓ 与右缘那张地图', () => {
  const countText = () => screen.getByTestId('changes-nav-count').textContent
  const currentIndex = () =>
    document
      .querySelector('[data-testid="changes-body"] [data-current="true"]')
      ?.getAttribute('data-line-index')

  it('首次 ready 落在第一块,读数是 `1 / N`', async () => {
    mount()
    await screen.findByTestId('changes-nav')
    expect(countText()).toBe('1 / 2')
    expect(currentIndex()).toBe('1')
  })

  it('↓ 走到下一块,↑ 回来,而且**到头循环**', async () => {
    mount()
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
    mount()
    await screen.findByTestId('changes-nav')
    expect(screen.getByTestId('changes-nav-count').getAttribute('aria-label')).toBe(
      t('diff.changeAt', { k: 1, n: 2 }),
    )
  })

  it('地图每块一格,点一格跳过去', async () => {
    mount()
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
    mount()
    const map = await screen.findByTestId('changes-map')
    expect(map.getAttribute('tabindex')).toBe('-1')
    expect(map.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('↵ / 双击开那个文件', () => {
  it('开的是 `<仓库根>/<相对路径>` 那个绝对路径', async () => {
    mount()
    await screen.findByTestId('changes-list')
    const rows = rowsOnScreen()
    act(() => rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    // 落点由「打开方式」那一档说了算(分栏 / 舞台 / 浮窗 …),所以断言问的是
    // **那份文件此刻开着没有**(`openStateOf` 是那三格事实的唯一判官),
    // 不是某一档的落点 —— 后者会让这一条跟着一个与它无关的偏好走。
    await waitFor(() => expect(openedState(`${ROOT}/src/a.ts`)).not.toBeNull())
  })

  it('`deleted` 那一行开不出来(盘上没有那个文件了)', async () => {
    status = () =>
      ok({
        repo: true,
        root: ROOT,
        files: [file('gone.ts', { status: 'deleted', add: 0, del: 4 })],
        stat: { add: 0, del: 4, files: 1 },
      })
    mount()
    await screen.findByTestId('changes-list')
    const rows = rowsOnScreen()
    act(() => rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    await Promise.resolve()
    expect(openedState(`${ROOT}/gone.ts`)).toBeNull()
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
