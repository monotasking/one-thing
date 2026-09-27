import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { configureBrowserPort } from '../../../data/browser-port'
import type { BrowserPort } from '../../../data/browser-port'
import { browserTabsQuery, onBrowserFact, resetBrowserSource } from '../../../data/browser-source'
import {
  browserSettingsQuery,
  saveBrowserProfilesMutation,
  setBrowserSearchEngineMutation,
  setBrowserCdpEnabledMutation,
} from '../../../data/browser-settings-source'
import {
  configureBrowserSettingsPort,
  type BrowserSettingsPort,
} from '../../../data/browser-settings-port'
import {
  configureComposerReferenceSink,
  resetComposerReferenceSink,
  type ComposerReference,
} from '../../../composer/references'
import { materializePageReferences } from '../../../data/page-references'
import '../../../references'
import { referenceKindOf } from '../../../references/registry'
import { focusTree } from '../../../focus/registry'
import { resetNativeViewKeymapDownlink } from '../../native-view/keymap-downlink'
import { resetBrowserFind } from '../../../data/browser-find'
import { resetBrowserSettled } from '../../../data/browser-settled'
import { resetBrowserNotices } from '../../../data/browser-notices'
import { BrowserLeaf } from '../BrowserLeaf'
import { BrowserActionsMenu } from '../BrowserActionsMenu'
import type { AppSettings } from '@shared/ipc/settings'
import { t } from '../../../i18n'

/**
 * **B3-b 壳半边的守卫**:起始页两态、身份丸、动作表落引用、发送时才取正文。
 *
 * 与 B3-a 那份逐条同一条分工:这里不量真机上视图怎么样(那是 `gate:browser`),
 * 也不量主进程那一侧怎么折(那是 `electron/browser/__tests__/browser-b3b.test.ts`)
 * —— 这一份量的是**壳这一侧的形**:屏幕上画了什么、按下去交出了什么。
 */

const TAB = {
  id: 't1',
  url: 'https://example.test/a',
  title: 'Example',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoomLevel: 0,
  active: true,
  profile: 'default',
}

class SilentResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function settingsWith(
  profiles: { id: string; name: string }[],
  searchEngine = 'google',
): AppSettings {
  return {
    ai: {} as AppSettings['ai'],
    theme: 'dark',
    general: {} as AppSettings['general'],
    tools: {} as AppSettings['tools'],
    browser: {
      cdp: { enabled: false, port: 9333 },
      profiles,
      defaultProfile: profiles[0]?.id ?? 'default',
      searchEngine,
    },
  } as AppSettings
}

/**
 * 设置端口替身。**读回的是最后一次存的**(真后端就是这样):写路 `settle` 之后会
 * `invalidate` 重拉一次,一只永远答出厂值的替身会把刚存的又冲回去 —— 那是替身在
 * 说谎,不是产品在说谎。
 */
function settingsPort(initial: AppSettings): BrowserSettingsPort & { saves: AppSettings[] } {
  let settings = initial
  const port = {
    saves: [] as AppSettings[],
    ready: () => Promise.resolve(undefined),
    readSettings: () => Promise.resolve({ success: true, settings }),
    saveSettings: (next: AppSettings) => {
      port.saves.push(next)
      settings = next
      return Promise.resolve({ success: true, settings: next })
    },
  }
  configureBrowserSettingsPort(port)
  return port
}

interface Harness {
  reads: { ref: string; name: string }[]
  did: { ref: string; op: string; params?: Record<string, unknown> }[]
  /**
   * 这一格 tab 此刻那一行。**可改** —— 改完 `browserTabsQuery.refetch()` 就是
   * 「后端推来一条新事实、壳重拉了一次表」的最小夹具(起始页留作底那两条用它
   * 走一条真的时间线,而不是靠换 props 装出来)。
   */
  row: typeof TAB
}

function harness(tab: Partial<typeof TAB> = {}, over: Partial<BrowserPort> = {}): Harness {
  const reads: { ref: string; name: string }[] = []
  const did: { ref: string; op: string; params?: Record<string, unknown> }[] = []
  const row = { ...TAB, ...tab }
  const port: BrowserPort = {
    ready: () => Promise.resolve(undefined),
    read: (ref, name) => {
      reads.push({ ref, name })
      if (name === 'tabs') {
        // 每一发交一份**新的**行(真后端每次答的也是新对象)—— 不然改了 `row`
        // 再重拉,拿到的是同一个引用,读数那一格看不出变过。
        return Promise.resolve({ kind: 'ok', value: { tabs: [{ ...row }], activeId: row.id } })
      }
      return Promise.resolve({
        kind: 'ok',
        value: {
          title: row.title,
          url: row.url,
          text: `<untrusted-content source="${row.url}">正文</untrusted-content>`,
        },
      })
    },
    do: (ref, op, params) => {
      did.push({ ref, op, ...(params ? { params } : {}) })
      return Promise.resolve({ kind: 'ok', text: '' })
    },
    onResourceEvent: () => () => undefined,
    nativeView: {
      send: () => {},
      on: () => () => undefined,
    },
    ...over,
  }
  configureBrowserPort(port)
  return { reads, did, row }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = SilentResizeObserver
  resetBrowserSource()
  resetNativeViewKeymapDownlink()
  browserSettingsQuery.reset()
})

afterEach(() => {
  resetBrowserSource()
  resetBrowserFind()
  resetBrowserSettled()
  resetBrowserNotices()
  resetNativeViewKeymapDownlink()
  resetComposerReferenceSink()
  browserSettingsQuery.reset()
  saveBrowserProfilesMutation.reset()
  setBrowserSearchEngineMutation.reset()
  setBrowserCdpEnabledMutation.reset()
  configureBrowserPort(undefined)
  configureBrowserSettingsPort(undefined)
  focusTree.reset()
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/* ── 起始页两态 ───────────────────────────────────────────────────────── */

describe('起始页', () => {
  it('空标签页画壳自己的起始页,**不画占位格**(不报帧 = 那片视图保持隐藏)', async () => {
    harness({ url: '', title: '' })
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()

    expect(screen.getByTestId('browser-start')).toBeTruthy()
    expect(document.querySelector('[data-native-view]')).toBeNull()
    // 四枚引擎丸,选中的是设置里那一格。
    const engines = screen.getAllByTestId('browser-start-engine')
    expect(engines.length).toBe(4)
    expect(engines.find((el) => el.dataset.on !== undefined)?.dataset.engineId).toBe('google')
  })

  it('去过地址的那一格画占位格,起始页不在', async () => {
    harness()
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.queryByTestId('browser-start')).toBeNull()
    expect(document.querySelector('[data-native-view="t1"]')).toBeTruthy()
  })

  it('点一枚引擎丸 = 存成缺省搜索引擎,**不跳转**', async () => {
    const h = harness({ url: '', title: '' })
    const port = settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()

    const bing = screen
      .getAllByTestId('browser-start-engine')
      .find((el) => el.dataset.engineId === 'bing')!
    await act(async () => { bing.click() })
    await settle()

    expect(port.saves.at(-1)?.browser?.searchEngine).toBe('bing')
    // 一发导航都没有 —— 挑引擎不是「现在带我去谷歌首页」。
    expect(h.did.filter((call) => call.op === 'navigate')).toEqual([])
  })

  /*
   * 回车用的是**设置里那一格**引擎(2026-09-26 用户报障「选了别的引擎最终还是谷歌」)。
   * 从前 `go()` 写的是 `resolveBrowserSearchEngine(undefined)`,于是起始页点亮哪一枚
   * 都没用。**反证**:把 `BrowserLeaf` 里 `searchEngineId` 换回 `undefined` → 这一条红。
   */
  it('起始页挑了百度再回车搜一句话 → navigate 去的是百度,不是谷歌', async () => {
    const h = harness({ url: '', title: '' })
    settingsPort(settingsWith([{ id: 'default', name: '' }], 'baidu'))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(
      screen.getAllByTestId('browser-start-engine').find((el) => el.dataset.on !== undefined)?.dataset
        .engineId,
    ).toBe('baidu')

    const input = screen.getByTestId('browser-address') as HTMLInputElement
    await act(async () => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'hello world' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await settle()
    const nav = h.did.filter((call) => call.op === 'navigate')
    expect(nav.length).toBe(1)
    expect(nav[0].params?.url).toBe('https://www.baidu.com/s?wd=hello%20world')
  })

  it('点一枚引擎丸之后**紧接着**回车,用的就是刚点的那一枚(乐观读数,不等设置落盘)', async () => {
    const h = harness({ url: '', title: '' })
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    const ddg = screen
      .getAllByTestId('browser-start-engine')
      .find((el) => el.dataset.engineId === 'duckduckgo')!
    await act(async () => { ddg.click() })
    const input = screen.getByTestId('browser-address') as HTMLInputElement
    await act(async () => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'onething' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await settle()
    const nav = h.did.filter((call) => call.op === 'navigate')
    expect(nav.map((call) => call.params?.url)).toEqual(['https://duckduckgo.com/?q=onething'])
  })

  /*
   * ── 起始页留作底(2026-09-17)──────────────────────────────────────────
   *
   * 提交到网页首帧之间原生视图是透明的(实测约 500ms),从前起始页那时已经摘掉
   * 了,于是那一段露的是壳 DOM 的一片空底。判词与三档整段在 `start-backdrop.ts`
   * 上;这两条量的是**屏幕上的形**:那一段里两件同在、起始页是装饰;首帧之后它
   * 永远撤掉。
   *
   * **反证**:把 `BrowserLeaf` 里 `phase === 'warming'` 那一行删掉 → 第一条红。
   */
  it('从起始页出发的第一次加载:占位格与当底的起始页同在,起始页 inert', async () => {
    harness({ url: 'http://x.test', title: '', loading: true })
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()

    expect(document.querySelector('[data-native-view="t1"]')).toBeTruthy()
    const start = screen.getByTestId('browser-start')
    expect(start.dataset.backdrop).toBe('true')
    // 装饰:不进 Tab 序、不进无障碍树。
    expect(start.hasAttribute('inert')).toBe(true)
    expect(start.getAttribute('aria-hidden')).toBe('true')
    // **底不画引擎丸**(2026-09-26):首帧之前留在屏上的那排丸,读起来就是「回到起点」。
    expect(screen.queryAllByTestId('browser-start-engine')).toEqual([])
  })

  /*
   * 闩按 tabId 住在 `data/browser-settled.ts`,不住在组件上(2026-09-26):换宿主是
   * 一次重挂,从前的 `useRef` 一重挂就归零,页面若正在加载,起始页就以底的身份又
   * 装回来 —— 用户报障「搜索、加载时感觉回到了空状态页」的另一半。
   * **反证**:把 `BrowserLeaf` 里 `hasBrowserTabSettled(id)` 换回一格 `useRef` → 红。
   */
  it('停过一次之后重挂(换宿主),页面正在加载也**不**再把起始页当底', async () => {
    const h = harness({ url: 'http://x.test', title: '', loading: false })
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    const first = render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.queryByTestId('browser-start')).toBeNull()

    // 换宿主:卸载、再挂载;此刻这一格正在加载下一页。
    h.row.loading = true
    h.row.url = 'http://y.test'
    await act(async () => { await browserTabsQuery.refetch() })
    act(() => first.unmount())
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.queryByTestId('browser-start')).toBeNull()
    expect(document.querySelector('[data-native-view="t1"]')).toBeTruthy()
  })

  it('tab 关掉之后同一个 id 再出现,闩是新的(`closed` 事实把它忘掉)', async () => {
    const h = harness({ url: 'http://x.test', title: '', loading: false })
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    const first = render(<BrowserLeaf id="t1" />)
    await settle()
    act(() => first.unmount())
    onBrowserFact({ event: 'closed', ref: 'browser:t1', payload: { id: 't1' } } as never)

    h.row.loading = true
    await act(async () => { await browserTabsQuery.refetch() })
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.getByTestId('browser-start').dataset.backdrop).toBe('true')
  })

  it('第一次加载完成 → 起始页撤掉;第二次导航不再回来', async () => {
    const h = harness({ url: 'http://x.test', title: '', loading: true })
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.getByTestId('browser-start').dataset.backdrop).toBe('true')

    // 首帧落地:这一格这辈子成功停下来过了。
    h.row.loading = false
    await act(async () => { await browserTabsQuery.refetch() })
    await settle()
    expect(screen.queryByTestId('browser-start')).toBeNull()

    // 第二次导航:换页由 Chromium 自己留着上一页的画面,壳不必再兜一次底。
    h.row.loading = true
    h.row.url = 'http://y.test'
    await act(async () => { await browserTabsQuery.refetch() })
    await settle()
    expect(screen.queryByTestId('browser-start')).toBeNull()
    expect(document.querySelector('[data-native-view="t1"]')).toBeTruthy()
  })
})

/* ── 身份丸 ───────────────────────────────────────────────────────────── */

describe('身份丸', () => {
  it('名册只有一格时**不画**(一句废话不值得占檐上的地)', async () => {
    harness()
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.queryByTestId('browser-profile-badge')).toBeNull()
  })

  it('多于一格时画这一格 tab 的身份名;没起过名的走字典那句', async () => {
    harness({ profile: 'work' })
    settingsPort(settingsWith([{ id: 'default', name: '' }, { id: 'work', name: '工作' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.getByTestId('browser-profile-badge').textContent).toBe('工作')
  })

  it('这一格 tab 的身份在名册里认不出来 → **不编一个名字**,整枚不画', async () => {
    harness({ profile: 'ghost' })
    settingsPort(settingsWith([{ id: 'default', name: '' }, { id: 'work', name: '工作' }]))
    await act(async () => { render(<BrowserLeaf id="t1" />) })
    await settle()
    expect(screen.queryByTestId('browser-profile-badge')).toBeNull()
  })
})

/* ── 动作表:把这一页交给对话 ─────────────────────────────────────────── */

describe('把这一页交给对话', () => {
  it('落进输入框的是一枚**零字节的引用**,而且点击那一刻一个字的正文都不取', async () => {
    const h = harness()
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    const landed: ComposerReference[] = []
    /* W5-c-2:登记按 `sessionId` 分格(屏幕上可以有好几块输入面板),而投递目标
     * 仍旧是 `expose.currentSessionId` 那格投影 —— 这一族用例没碰过它,所以它是
     * 空串(「还没绑会话」那一态),登记与投递因此对得上。 */
    configureComposerReferenceSink('', (reference: ComposerReference) => { landed.push(reference) })

    await act(async () => {
      render(
        <BrowserActionsMenu
          tab={TAB}
          at={{ x: 10, y: 10 }}
          onClose={() => {}}
          onOpenInProfile={() => {}}
        />,
      )
    })
    await settle()
    await act(async () => { screen.getByText(t('browser.giveToChat')).click() })

    /*
     * 09-14(所见即所发):这条缝收的是**哪一种 + 哪一枚**,不再是调用方手拼的
     * `{label, token, tip}` —— chip 上写什么、记号是哪几个字、提示说什么,三样
     * 全归 `references/kinds/page.ts` 那一份自述。
     */
    expect(landed).toEqual([
      {
        kindId: 'page',
        ref: { kind: 'pageRef', tabId: 't1', title: 'Example', url: 'https://example.test/a' },
      },
    ])
    // 那一枚在句子里占的那截字仍旧是它(记号由自述算,不由这条缝说)。
    expect(referenceKindOf('page')!.draft!.token(landed[0].ref)).toBe('{{page:t1}}')
    /*
     * **反证**:把 `BrowserActionsMenu.giveToChat` 改成点击那一刻就
     * `readBrowserPage(tab.id)` → 这一条当场红。判词整段在
     * `data/page-references.ts` 的判据③上:草稿会被存进**每一条会话的稿**里,
     * 点击就取等于把两万字连同草稿一起存下来,而人也许根本没发出去。
     */
    expect(h.reads.filter((call) => call.name === 'page')).toEqual([])
  })

  it('名册多于一格时表里多一节「在「X」中打开此页」,只列**别的**身份', async () => {
    harness()
    settingsPort(settingsWith([{ id: 'default', name: '' }, { id: 'work', name: '工作' }]))
    const picked: string[] = []
    await act(async () => {
      render(
        <BrowserActionsMenu
          tab={TAB}
          at={{ x: 10, y: 10 }}
          onClose={() => {}}
          onOpenInProfile={(profile) => picked.push(profile)}
        />,
      )
    })
    await settle()
    // 自己那一格不在表里(「在「默认」中打开此页」= 一句废话)。
    expect(screen.queryByText(t('browser.openInProfile', { name: t('browser.profileDefaultName') }))).toBeNull()
    await act(async () => { screen.getByText(t('browser.openInProfile', { name: '工作' })).click() })
    expect(picked).toEqual(['work'])
  })

  it('名册只有一格 → 那一节整个不画', async () => {
    harness()
    settingsPort(settingsWith([{ id: 'default', name: '' }]))
    await act(async () => {
      render(
        <BrowserActionsMenu
          tab={TAB}
          at={{ x: 10, y: 10 }}
          onClose={() => {}}
          onOpenInProfile={() => {}}
        />,
      )
    })
    await settle()
    expect(screen.queryByText(t('browser.profileSection'))).toBeNull()
  })
})

/* ── 发送那一刻的物化 ─────────────────────────────────────────────────── */

describe('materializePageReferences', () => {
  it('正文里没有页面引用 = 恒等,而且**一发请求都不打**', async () => {
    const h = harness()
    const out = await materializePageReferences('看看 {{file:/a.ts}} 这个')
    expect(out).toEqual({ text: '看看 {{file:/a.ts}} 这个', attachments: [] })
    expect(h.reads).toEqual([])
  })

  it('有引用 → token 连同一个尾随空格离开正文,正文变成一件带出处的文本附件', async () => {
    harness()
    const out = await materializePageReferences('总结一下 {{page:t1}} 谢谢')

    expect(out.text).toBe('总结一下 谢谢')
    expect(out.attachments.length).toBe(1)
    const one = out.attachments[0]!
    expect(one.sourceUrl).toBe('https://example.test/a')
    expect(one.sourceTitle).toBe('Example')
    expect(one.mediaType).toBe('file')
    // 正文已经被 provider 那一侧 `<untrusted-content>` 定界过 —— 这里**不包第二层**。
    expect(one.excerpt).toContain('<untrusted-content')
    expect(one.excerpt).toContain('正文')
    // 一件**没有字节落在磁盘上**的附件:引擎那一支认的是 sourceUrl / excerpt。
    expect('filePath' in one).toBe(false)
    expect(one.base64Data).toBeUndefined()
  })

  it('tab 早关了(死 token)→ 那一枚连尾随空格一起消失,什么都不带', async () => {
    harness()
    const out = await materializePageReferences('看 {{page:gone}} 这个')
    expect(out.text).toBe('看 这个')
    expect(out.attachments).toEqual([])
  })

  it('读正文砸了 → 仍然带一件**只有出处没有正文**的附件(静默丢掉是骗)', async () => {
    harness({}, {
      read: (ref, name) => {
        if (name === 'tabs') {
          return Promise.resolve({ kind: 'ok', value: { tabs: [TAB], activeId: 't1' } })
        }
        return Promise.resolve({ kind: 'failed', error: { message: '页面导航走了' } } as never)
      },
    })
    const out = await materializePageReferences('{{page:t1}}')
    expect(out.attachments.length).toBe(1)
    expect(out.attachments[0]!.sourceUrl).toBe('https://example.test/a')
    expect(out.attachments[0]!.excerpt).toBe('')
  })
})

/*
 * ── 出站那道展开的**顺序**(文件先、页面后)不在这里 ─────────────────────
 * 那条闸的落点是 `data/chat-port.ts` 的 `sendMessage`,而验它要一条真的命令
 * 总线(内存传输 + 真端口)—— 那台夹具已经在 `src/data/chat-port.test.ts` 里
 * 站着了。两条用例因此写在那边(「页面正文里就算写着 `{{file:…}}` 也不会被
 * 当成草稿再扫一遍」与「人自己 @ 的那个文件照常展开」),这里不复刻一台。
 */
