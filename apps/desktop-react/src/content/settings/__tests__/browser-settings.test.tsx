import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserSettings } from '../BrowserSettings'
import {
  configureBrowserSettingsPort,
  type BrowserSettingsPort,
} from '../../../data/browser-settings-port'
import {
  addBrowserProfile,
  browserSettingsQuery,
  chromeDevtoolsMcpConfig,
  chromeDevtoolsMcpSnippet,
  installChromeDevtoolsMcpMutation,
  removeBrowserProfile,
  renameBrowserProfile,
  saveBrowserProfilesMutation,
  setDefaultBrowserProfile,
  setBrowserCdpEnabledMutation,
  setBrowserSearchEngineMutation,
  toBrowserSettingsView,
} from '../../../data/browser-settings-source'
import type { AppSettings } from '@shared/ipc/settings'
import { t } from '../../../i18n'

/**
 * 设置页「内置浏览器」那一节(B2′)。
 *
 * 钉住四件事:
 *  ① 关着时**只有那一行开关**(两颗钮与两句说明都不在场);
 *  ② 开着时三件都在(装 MCP / 复制配置 / `new_page` 那句);
 *  ③ 已经装过就**不给点、也不重复写**(重复写会把用户改过的那一条原样盖掉);
 *  ④ 复制是**就地反馈**(钮上换字),零 Toast。
 */

const BASE: AppSettings = {
  ai: {} as AppSettings['ai'],
  theme: 'dark',
  general: {} as AppSettings['general'],
  tools: {} as AppSettings['tools'],
  browser: {
    cdp: { enabled: false, port: 9333 },
    profiles: [{ id: 'default', name: '' }],
    defaultProfile: 'default',
    searchEngine: 'google',
  },
}

interface Fake extends BrowserSettingsPort {
  settings: AppSettings
  saves: AppSettings[]
}

function fakePort(settings: AppSettings): Fake {
  const fake: Fake = {
    settings,
    saves: [],
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings: fake.settings }),
    saveSettings: async (next) => {
      fake.saves.push(next)
      fake.settings = next
      return { success: true, settings: next }
    },
  }
  return fake
}

/** 剪贴板在 jsdom 里不存在 —— 装一个记下来的替身。 */
function stubClipboard(): { text: string | undefined } {
  const box: { text: string | undefined } = { text: undefined }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { box.text = text } },
  })
  return box
}

const reset = (): void => {
  browserSettingsQuery.reset()
  setBrowserCdpEnabledMutation.reset()
  installChromeDevtoolsMcpMutation.reset()
  // B3-b 的两只(名册 / 搜索引擎)—— 一处归零,不许漏格。
  saveBrowserProfilesMutation.reset()
  setBrowserSearchEngineMutation.reset()
}

beforeEach(reset)
afterEach(() => {
  configureBrowserSettingsPort(undefined)
  reset()
})

describe('投影与配置(纯函数)', () => {
  it('六格:开着没有、开在哪个口、MCP 装过没有、名册 / 缺省身份 / 搜索引擎', () => {
    expect(toBrowserSettingsView({
      browser: {
        cdp: { enabled: true, port: 9444 },
        profiles: [{ id: 'default', name: '' }, { id: 'work', name: '工作' }],
        defaultProfile: 'work',
        searchEngine: 'bing',
      },
    })).toEqual({
      enabled: true, port: 9444, mcpInstalled: false,
      profiles: [{ id: 'default', name: '' }, { id: 'work', name: '工作' }],
      defaultProfile: 'work',
      searchEngine: 'bing',
    })
    // 这一段压根不在(老 store)= 关着 + 缺省口 + **一格身份的名册**。
    // 空名册画到屏幕上是一张连删都删不掉的表(判词在 `toBrowserSettingsView` 上)。
    expect(toBrowserSettingsView({})).toEqual({
      enabled: false, port: 9333, mcpInstalled: false,
      profiles: [{ id: 'default', name: '' }],
      defaultProfile: 'default',
      searchEngine: 'google',
    })
  })

  it('缺省身份指着一个已删的身份 → 落回第一行(否则每开一格新 tab 都落进一个现建的空分区)', () => {
    const view = toBrowserSettingsView({
      browser: {
        cdp: { enabled: false, port: 9333 },
        profiles: [{ id: 'work', name: '工作' }],
        defaultProfile: 'gone',
        searchEngine: 'google',
      },
    })
    expect(view.defaultProfile).toBe('work')
  })

  it('装过没有**按 id 判**,不按名字 —— 名字是人写的,id 是身份', () => {
    const servers = [{ ...chromeDevtoolsMcpConfig(9333), name: '我改过的名字' }]
    expect(toBrowserSettingsView({ mcp: { enabled: true, servers } }).mcpInstalled).toBe(true)
  })

  it('那一条 stdio:`npx -y`(没有 -y 会停下来问 yes/no,而没人回答它)+ 指着本机那个口', () => {
    const config = chromeDevtoolsMcpConfig(9444)
    expect(config.transport).toBe('stdio')
    expect(config.command).toBe('npx')
    expect(config.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--browserUrl', 'http://127.0.0.1:9444'])
  })

  it('复制片段是 Claude Code / Cursor 认的那个形,端口跟着设置走', () => {
    const parsed = JSON.parse(chromeDevtoolsMcpSnippet(9444)) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(parsed.mcpServers['chrome-devtools'].command).toBe('npx')
    expect(parsed.mcpServers['chrome-devtools'].args).toContain('http://127.0.0.1:9444')
  })
})

describe('设置页那一节', () => {
  it('关着:只有那一行开关,两颗钮都不在场', async () => {
    configureBrowserSettingsPort(fakePort(structuredClone(BASE)))
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: t('browser.cdpLabel') }).getAttribute('aria-checked'))
        .toBe('false'),
    )
    expect(document.querySelector('[data-testid="browser-cdp-actions"]')).toBeNull()
    expect(screen.queryByRole('button', { name: t('browser.mcpInstall') })).toBeNull()
    expect(screen.queryByText(t('browser.newPageNote'))).toBeNull()
  })

  it('开着:装 MCP / 复制配置 / `new_page` 那句,三件都在', async () => {
    configureBrowserSettingsPort(fakePort({
      ...structuredClone(BASE),
      browser: { cdp: { enabled: true, port: 9333 }, profiles: [{ id: 'default', name: '' }], defaultProfile: 'default', searchEngine: 'google' },
    }))
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByRole('button', { name: t('browser.mcpInstall') })).toBeTruthy())
    expect(screen.getByRole('button', { name: t('browser.copyConfig') })).toBeTruthy()
    expect(screen.getByText(t('browser.newPageNote'))).toBeTruthy()
    // 端口露脸但不给编辑(「设置极简」:技术参数走默认值)。
    expect(screen.getByText(t('browser.cdpPortNote', { port: 9333 }))).toBeTruthy()
    /*
     * 端口露脸但不给编辑(「设置极简」:技术参数走默认值)。
     * **判据从「这一节一个 input 都没有」收窄成「没有端口输入框」**(B3-b):
     * 身份那一块有一格可改的名字,而它不是技术参数,是人自己起的名。
     * 按值判 —— 屏上任何一格输入框都不许装着那个端口。
     */
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(input.value).not.toBe('9333')
    }
  })

  it('翻开关:**就地更新**(当场翻过去),写回只动 browser.cdp 那一格', async () => {
    const port = fakePort(structuredClone(BASE))
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    const toggle = await screen.findByRole('switch', { name: t('browser.cdpLabel') })
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))

    await act(async () => { fireEvent.click(toggle) })
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0].browser?.cdp).toEqual({ enabled: true, port: 9333 })
    // 主题那一格原样带着 —— 整份写回的底本是**当场读的那一份**,不是缓存。
    expect(port.saves[0].theme).toBe('dark')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('给 AI 装上:名册里多一条,开着,指着本机那个口', async () => {
    const port = fakePort({
      ...structuredClone(BASE),
      browser: { cdp: { enabled: true, port: 9444 }, profiles: [{ id: 'default', name: '' }], defaultProfile: 'default', searchEngine: 'google' },
    })
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    const install = await screen.findByRole('button', { name: t('browser.mcpInstall') })

    await act(async () => { fireEvent.click(install) })
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0].mcp?.servers).toEqual([chromeDevtoolsMcpConfig(9444)])
    // 装完那一节自己改口,并说清「重启之后才用得上」。
    await waitFor(() => expect(screen.getByText(t('browser.mcpInstalledNote'))).toBeTruthy())
  })

  it('**已装上就不给点、也不重复写** —— 重复写会把用户改过的那一条原样盖掉', async () => {
    const mine = { ...chromeDevtoolsMcpConfig(9333), name: '我改过的名字' }
    const port = fakePort({
      ...structuredClone(BASE),
      browser: { cdp: { enabled: true, port: 9333 }, profiles: [{ id: 'default', name: '' }], defaultProfile: 'default', searchEngine: 'google' },
      mcp: { enabled: true, servers: [mine] },
    })
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    const installed = await screen.findByRole('button', { name: t('browser.mcpInstalled') })
    expect(installed.hasAttribute('disabled')).toBe(true)

    // 钮禁着点不动,所以直接从写路那一头再证一次:它自己也不写。
    await act(async () => { await installChromeDevtoolsMcpMutation.run() })
    expect(port.saves).toHaveLength(0)
    expect(port.settings.mcp?.servers).toEqual([mine])
  })

  it('复制:**就地反馈**(钮上换字),零 Toast', async () => {
    const clipboard = stubClipboard()
    configureBrowserSettingsPort(fakePort({
      ...structuredClone(BASE),
      browser: { cdp: { enabled: true, port: 9444 }, profiles: [{ id: 'default', name: '' }], defaultProfile: 'default', searchEngine: 'google' },
    }))
    await act(async () => { render(<BrowserSettings />) })
    const copy = await screen.findByRole('button', { name: t('browser.copyConfig') })

    await act(async () => { fireEvent.click(copy) })
    await waitFor(() => expect(screen.getByRole('button', { name: t('common.copied') })).toBeTruthy())
    expect(clipboard.text).toBe(chromeDevtoolsMcpSnippet(9444))
  })

  it('拉不到:错误与那一行**并陈**,开关自禁(拿一个猜测当底本去写设置是错的)', async () => {
    configureBrowserSettingsPort({
      ready: async () => undefined,
      readSettings: async () => ({ success: false, error: 'boom' }),
      saveSettings: async () => ({ success: false, error: 'boom' }),
    })
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByText(`${t('browser.loadFailed')} · boom`)).toBeTruthy())
    expect(screen.getByRole('switch', { name: t('browser.cdpLabel') }).hasAttribute('disabled')).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * 身份名册(B3-b)
 * ══════════════════════════════════════════════════════════════════════════ */

describe('名册那四只纯函数', () => {
  const one = { profiles: [{ id: 'default', name: '' }], defaultProfile: 'default' }
  const two = {
    profiles: [{ id: 'default', name: '' }, { id: 'work', name: '工作' }],
    defaultProfile: 'default',
  }

  it('新建:加一行,**缺省不动**(建一个身份不等于要用它);id 随机不按名字派生', () => {
    const next = addBrowserProfile(two, '第三个')
    expect(next.profiles).toHaveLength(3)
    expect(next.defaultProfile).toBe('default')
    expect(next.profiles[2]!.name).toBe('第三个')
    // id 不是名字的派生 —— 派生的话「改个名」= 「换一个分区」= 登录态没了。
    expect(next.profiles[2]!.id).not.toBe('第三个')
    expect(next.profiles[2]!.id).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('新建:id 不与已有的撞', () => {
    const taken = new Set<string>()
    let table = one
    for (let i = 0; i < 30; i += 1) {
      table = addBrowserProfile(table, `n${i}`)
      const id = table.profiles.at(-1)!.id
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
  })

  it('改名:认不出的 id 是**恒等**(而不是悄悄新增一行)', () => {
    expect(renameBrowserProfile(two, 'work', '办公').profiles[1]!.name).toBe('办公')
    expect(renameBrowserProfile(two, 'ghost', 'x').profiles).toEqual(two.profiles)
  })

  /**
   * **反证**:把 `removeBrowserProfile` 里 `table.profiles.length <= 1` 那一句
   * 拆掉 → 第一条当场红。名册删到空之后每一格 tab 都指着一个名册上没有的身份,
   * 设置页画不出、删不掉。
   */
  it('删:只剩一格时是恒等;删掉的正好是缺省那一格时缺省落到剩下的第一行', () => {
    expect(removeBrowserProfile(one, 'default')).toBe(one)
    const next = removeBrowserProfile({ ...two, defaultProfile: 'work' }, 'work')
    expect(next.profiles.map((row) => row.id)).toEqual(['default'])
    expect(next.defaultProfile).toBe('default')
    // 认不出的 id 也是恒等。
    expect(removeBrowserProfile(two, 'ghost')).toBe(two)
  })

  it('换缺省:不在名册里的 id 是恒等', () => {
    expect(setDefaultBrowserProfile(two, 'work').defaultProfile).toBe('work')
    expect(setDefaultBrowserProfile(two, 'ghost')).toBe(two)
  })
})

describe('身份那一块四态', () => {
  function withProfiles(profiles: { id: string; name: string }[], defaultProfile = profiles[0]!.id) {
    return fakePort({
      ...structuredClone(BASE),
      browser: { cdp: { enabled: false, port: 9333 }, profiles, defaultProfile, searchEngine: 'google' },
    })
  }

  it('还没问到 → 这一块**整个不画**(一张空名册说的是「你一个身份都没有」,那是假话)', async () => {
    configureBrowserSettingsPort({
      ready: async () => undefined,
      readSettings: () => new Promise(() => {}),
      saveSettings: async () => ({ success: true }),
    })
    await act(async () => { render(<BrowserSettings />) })
    expect(screen.queryByTestId('browser-profiles')).toBeNull()
  })

  it('只有一格 → 一行名字,**不画删钮**,也不画「新标签页用哪个身份」那一行', async () => {
    configureBrowserSettingsPort(withProfiles([{ id: 'default', name: '' }]))
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByTestId('browser-profiles')).toBeTruthy())
    expect(screen.getAllByTestId('browser-profile-row')).toHaveLength(1)
    expect(screen.queryByTestId('browser-profile-delete')).toBeNull()
    expect(screen.queryByTestId('browser-default-profile-row')).toBeNull()
    // 没起过名的那一行由**字典**画(名册里它的 name 是空串)。
    const input = screen.getAllByTestId('browser-profile-row')[0]!.querySelector('input')!
    expect(input.getAttribute('placeholder')).toBe(t('browser.profileDefaultName'))
  })

  it('多格 → 每格一行 + 删钮 + 那一行选择器', async () => {
    configureBrowserSettingsPort(withProfiles([
      { id: 'default', name: '' },
      { id: 'work', name: '工作' },
    ]))
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getAllByTestId('browser-profile-row')).toHaveLength(2))
    expect(screen.getAllByTestId('browser-profile-delete')).toHaveLength(2)
    expect(screen.getByTestId('browser-default-profile-row')).toBeTruthy()
  })

  it('删 → **先弹确认**(数据会没),确认之后才写;取消什么都不写', async () => {
    const port = withProfiles([{ id: 'default', name: '' }, { id: 'work', name: '工作' }])
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getAllByTestId('browser-profile-delete')).toHaveLength(2))

    await act(async () => { fireEvent.click(screen.getAllByTestId('browser-profile-delete')[1]!) })
    // 确认框在,而且**一个字都还没写**。
    expect(screen.getByText(t('browser.profileDeleteBody'))).toBeTruthy()
    expect(port.saves).toHaveLength(0)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })) })
    expect(port.saves).toHaveLength(0)

    await act(async () => { fireEvent.click(screen.getAllByTestId('browser-profile-delete')[1]!) })
    await act(async () => { fireEvent.click(screen.getByTestId('browser-profile-delete-confirm')) })
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0]!.browser?.profiles.map((row) => row.id)).toEqual(['default'])
  })

  it('新建 → 名册多一行,**只动 browser.profiles 那一格**', async () => {
    const port = withProfiles([{ id: 'default', name: '' }])
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByTestId('browser-profile-add')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('browser-profile-add')) })
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0]!.browser?.profiles).toHaveLength(2)
    // CDP 那一格与主题一个字没动(整份写回,但只改自己那一格)。
    expect(port.saves[0]!.browser?.cdp).toEqual({ enabled: false, port: 9333 })
    expect(port.saves[0]!.theme).toBe(BASE.theme)
  })

  it('改名是**失焦才存**,而且没改就一发都不打', async () => {
    const port = withProfiles([{ id: 'default', name: '' }])
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByTestId('browser-profiles')).toBeTruthy())
    const input = screen.getAllByTestId('browser-profile-row')[0]!.querySelector('input')!

    // 打字期间一个字都不写。
    await act(async () => { fireEvent.change(input, { target: { value: '工' } }) })
    await act(async () => { fireEvent.change(input, { target: { value: '工作' } }) })
    expect(port.saves).toHaveLength(0)

    await act(async () => { fireEvent.blur(input) })
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0]!.browser?.profiles[0]!.name).toBe('工作')

    // 再失焦一次(没改)→ 不打第二发。
    await act(async () => { fireEvent.blur(input) })
    expect(port.saves).toHaveLength(1)
  })

  it('搜索引擎那一行在,而且换一家只动 browser.searchEngine', async () => {
    const port = withProfiles([{ id: 'default', name: '' }])
    configureBrowserSettingsPort(port)
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByTestId('browser-search-engine-row')).toBeTruthy())
    await act(async () => { await setBrowserSearchEngineMutation.run('baidu') })
    expect(port.saves.at(-1)!.browser?.searchEngine).toBe('baidu')
    expect(port.saves.at(-1)!.browser?.profiles).toEqual([{ id: 'default', name: '' }])
  })
})
