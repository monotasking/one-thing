import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserSettings } from '../BrowserSettings'
import {
  configureBrowserSettingsPort,
  type BrowserSettingsPort,
} from '../../../data/browser-settings-port'
import {
  browserCdpQuery,
  chromeDevtoolsMcpConfig,
  chromeDevtoolsMcpSnippet,
  installChromeDevtoolsMcpMutation,
  setBrowserCdpEnabledMutation,
  toBrowserCdpView,
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
  browser: { cdp: { enabled: false, port: 9333 } },
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
  browserCdpQuery.reset()
  setBrowserCdpEnabledMutation.reset()
  installChromeDevtoolsMcpMutation.reset()
}

beforeEach(reset)
afterEach(() => {
  configureBrowserSettingsPort(undefined)
  reset()
})

describe('投影与配置(纯函数)', () => {
  it('三格:开着没有、开在哪个口、那条 MCP 装过没有', () => {
    expect(toBrowserCdpView({ browser: { cdp: { enabled: true, port: 9444 } } })).toEqual({
      enabled: true, port: 9444, mcpInstalled: false,
    })
    // 这一段压根不在(老 store)= 关着 + 缺省口。
    expect(toBrowserCdpView({})).toEqual({ enabled: false, port: 9333, mcpInstalled: false })
  })

  it('装过没有**按 id 判**,不按名字 —— 名字是人写的,id 是身份', () => {
    const servers = [{ ...chromeDevtoolsMcpConfig(9333), name: '我改过的名字' }]
    expect(toBrowserCdpView({ mcp: { enabled: true, servers } }).mcpInstalled).toBe(true)
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
      browser: { cdp: { enabled: true, port: 9333 } },
    }))
    await act(async () => { render(<BrowserSettings />) })
    await waitFor(() => expect(screen.getByRole('button', { name: t('browser.mcpInstall') })).toBeTruthy())
    expect(screen.getByRole('button', { name: t('browser.copyConfig') })).toBeTruthy()
    expect(screen.getByText(t('browser.newPageNote'))).toBeTruthy()
    // 端口露脸但不给编辑(「设置极简」:技术参数走默认值)。
    expect(screen.getByText(t('browser.cdpPortNote', { port: 9333 }))).toBeTruthy()
    expect(document.querySelector('input')).toBeNull()
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
      browser: { cdp: { enabled: true, port: 9444 } },
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
      browser: { cdp: { enabled: true, port: 9333 } },
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
      browser: { cdp: { enabled: true, port: 9444 } },
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
