// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChannelsSettingsTab from '../ChannelsSettingsTab.vue'
import type { AppSettings, GatewayStatus } from '@/types'

const mocks = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,qr'),
}))

vi.mock('qrcode', () => ({
  toDataURL: mocks.toDataURL,
}))

// P4c 第八批:八条 gateway 数据面从 `electronAPI.gateway*` 换成
// `@/platform/gateway-client` 的 `gatewayApi`(通用 RPC 通道)。
const gatewayApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  wechatLogout: vi.fn(),
  wechatAddAccount: vi.fn(),
  wechatStopAccount: vi.fn(),
  wechatRemoveAccount: vi.fn(),
  wechatRenameAccount: vi.fn(),
}))
vi.mock('@/platform/gateway-client', () => ({ gatewayApi }))

function appSettings(enabled = false): AppSettings {
  return {
    theme: 'dark',
    general: {
      shortcuts: {},
      editor: {},
      dailyNotes: { enabled: true },
      todoPlan: { enabled: true },
    },
    chat: {},
    ai: {
      provider: 'openai',
      providers: {},
      customProviders: [],
    },
    tools: {
      enableToolCalls: true,
      tools: {},
    },
    network: {
      proxy: {
        enabled: false,
        url: '',
        bypassRules: '',
      },
    },
    channels: {
      wechat: { enabled },
    },
    mcp: { enabled: true, servers: [] },
    skills: { enableSkills: true, skills: {} },
  } as unknown as AppSettings
}

function gatewayStatus(
  patch: Partial<GatewayStatus['wechat']> = {},
  accounts?: NonNullable<GatewayStatus['wechatAccounts']>,
): GatewayStatus {
  const wechat = {
    id: 'default',
    enabled: false,
    running: false,
    loginStatus: 'idle' as const,
    loggedIn: false,
    ...patch,
  }
  return {
    running: false,
    starting: false,
    stopping: false,
    enabled: false,
    wechat,
    wechatAccounts: accounts || [wechat],
  }
}

async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

const CHANNEL_IDENTITY_RPC_RESULTS: Record<string, unknown> = {
  listProfiles: {
    success: true,
    profiles: [
      {
        id: 'local-owner',
        name: 'Local user',
        isMain: true,
        createdAt: 1,
        updatedAt: 1,
        lastSentAt: 2,
      },
      {
        id: 'channel-wechat-default-wechat-user-1',
        name: 'WeChat user',
        connector: 'wechat',
        workspaceId: 'default',
        externalUserId: 'wechat-user-1',
        source: 'channel',
        createdAt: 2,
        updatedAt: 2,
        lastSentAt: 3,
      },
    ],
  },
  listLinks: { success: true, links: [] },
  createProfile: { success: true },
  updateProfile: { success: true },
  createLink: { success: true },
  deleteLink: { success: true },
}

const rpcInvokeMock = vi.fn(async (request: { domain: string; method: string }) => {
  if (request.domain !== 'channelIdentity') {
    return { ok: false, error: { message: `Unknown RPC domain "${request.domain}"` } }
  }
  const data = CHANNEL_IDENTITY_RPC_RESULTS[request.method]
  if (data === undefined) {
    return { ok: false, error: { message: `Unknown RPC method "${request.method}"` } }
  }
  return { ok: true, data }
})

describe('ChannelsSettingsTab', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    gatewayApi.getStatus.mockReset().mockResolvedValue({
      success: true,
      status: gatewayStatus(),
    })
    gatewayApi.start.mockReset().mockResolvedValue({
      success: true,
      status: gatewayStatus({
        enabled: true,
        running: true,
        loginStatus: 'waiting-for-scan',
        qrUrl: 'https://liteapp.weixin.qq.com/q/mock',
      })
    })
    gatewayApi.stop.mockReset().mockResolvedValue({ success: true, status: gatewayStatus() }),
    gatewayApi.wechatLogout.mockReset().mockResolvedValue({ success: true, status: gatewayStatus() }),
    gatewayApi.wechatAddAccount.mockReset().mockResolvedValue({
      success: true,
      account: {
        id: 'wechat-2',
        enabled: true,
        running: true,
        loginStatus: 'waiting-for-scan',
        loggedIn: false,
        qrUrl: 'https://liteapp.weixin.qq.com/q/work',
      },
      status: gatewayStatus({}, [
        {
          id: 'default',
          enabled: true,
          running: false,
          loginStatus: 'idle',
          loggedIn: false,
        },
        {
          id: 'wechat-2',
          enabled: true,
          running: true,
          loginStatus: 'waiting-for-scan',
          loggedIn: false,
          qrUrl: 'https://liteapp.weixin.qq.com/q/work',
        },
      ]),
    })
    gatewayApi.wechatStopAccount.mockReset().mockResolvedValue({
      success: true,
      status: gatewayStatus({
        id: 'default',
        enabled: false,
        running: false,
        loginStatus: 'idle',
        loggedIn: false,
      })
    })
    gatewayApi.wechatRemoveAccount.mockReset().mockResolvedValue({ success: true, status: gatewayStatus() }),
    gatewayApi.wechatRenameAccount.mockReset().mockResolvedValue({ success: true, status: gatewayStatus() }),
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        // 渠道身份域已迁到通用 RPC 通道(主线 T1 第二批):这里不再逐方法打桩,
        // 而是打**那一条**通道,再按 method 分发 —— 和生产链路同形。
        rpcInvoke: rpcInvokeMock,
        writeClipboardText: vi.fn().mockReturnValue({ success: true }),
        openExternal: vi.fn().mockResolvedValue({ success: true }),
      },
    })
  })

  it('enables WeChat when starting the channel runtime', async () => {
    const wrapper = mount(ChannelsSettingsTab, {
      props: { settings: appSettings(false) },
    })
    await settle()

    const startButton = wrapper.findAll('button').find(button => button.text() === 'Start')
    expect(startButton).toBeTruthy()
    await startButton!.trigger('click')
    await settle()

    expect(wrapper.emitted('update:settings')?.[0]?.[0]).toMatchObject({
      channels: { wechat: { enabled: true } },
    })
    expect(gatewayApi.start).toHaveBeenCalledWith({ channel: 'wechat', accountId: 'default' })

    wrapper.unmount()
  })

  it('adds a second WeChat account and renders its own QR code', async () => {
    const wrapper = mount(ChannelsSettingsTab, {
      props: { settings: appSettings(true) },
    })
    await settle()

    const addButton = wrapper.findAll('button').find(button => button.text() === 'Add WeChat')
    expect(addButton).toBeTruthy()
    await addButton!.trigger('click')
    await settle()

    expect(gatewayApi.wechatAddAccount).toHaveBeenCalledWith({})
    expect(wrapper.text()).toContain('wechat-2')
    expect(mocks.toDataURL).toHaveBeenCalledWith(
      'https://liteapp.weixin.qq.com/q/work',
      expect.any(Object),
    )
    expect(wrapper.emitted('update:settings')?.at(-1)?.[0]).toMatchObject({
      channels: {
        wechat: {
          enabled: true,
          accounts: expect.arrayContaining([
            expect.objectContaining({ id: 'wechat-2', enabled: true }),
          ]),
        },
      },
    })

    wrapper.unmount()
  })

  it('stops a single WeChat account without removing the account setting', async () => {
    vi.mocked(gatewayApi.getStatus).mockResolvedValue({
      success: true,
      status: gatewayStatus({
        id: 'default',
        enabled: true,
        running: true,
        loginStatus: 'logged-in',
        loggedIn: true,
      }),
    })

    const wrapper = mount(ChannelsSettingsTab, {
      props: {
        settings: {
          ...appSettings(true),
          channels: {
            wechat: {
              enabled: true,
              accounts: [{ id: 'default', enabled: true }],
            },
          },
        } as AppSettings,
      },
    })
    await settle()

    const accountStopButton = wrapper.findAll('.wechat-account-row button')
      .find(button => button.text() === 'Stop')
    expect(accountStopButton).toBeTruthy()
    await accountStopButton!.trigger('click')
    await settle()

    expect(gatewayApi.wechatStopAccount).toHaveBeenCalledWith({ accountId: 'default' })
    expect(wrapper.emitted('update:settings')?.at(-1)?.[0]).toMatchObject({
      channels: {
        wechat: {
          enabled: true,
          accounts: [expect.objectContaining({ id: 'default', enabled: false })],
        },
      },
    })

    wrapper.unmount()
  })

  it('renders the scan URL as a QR code and uses Electron APIs for QR actions', async () => {
    vi.mocked(gatewayApi.getStatus).mockResolvedValue({
      success: true,
      status: gatewayStatus({
        enabled: true,
        running: true,
        loginStatus: 'waiting-for-scan',
        qrUrl: 'https://liteapp.weixin.qq.com/q/mock',
      }),
    })

    const wrapper = mount(ChannelsSettingsTab, {
      props: { settings: appSettings(true) },
    })
    await settle()

    expect(mocks.toDataURL).toHaveBeenCalledWith(
      'https://liteapp.weixin.qq.com/q/mock',
      expect.objectContaining({
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      }),
    )

    await wrapper.find('button[aria-label="Copy login URL"]').trigger('click')
    await wrapper.find('button[aria-label="Open login URL"]').trigger('click')

    expect(window.electronAPI.writeClipboardText).toHaveBeenCalledWith('https://liteapp.weixin.qq.com/q/mock')
    expect(window.electronAPI.openExternal).toHaveBeenCalledWith('https://liteapp.weixin.qq.com/q/mock')

    wrapper.unmount()
  })

  it('retries QR rendering when refreshing the same scan URL after a render failure', async () => {
    const scanStatus = gatewayStatus({
      enabled: true,
      running: true,
      loginStatus: 'waiting-for-scan',
      qrUrl: 'https://liteapp.weixin.qq.com/q/mock',
    })
    vi.mocked(gatewayApi.getStatus).mockResolvedValue({
      success: true,
      status: scanStatus,
    })
    mocks.toDataURL.mockRejectedValueOnce(new Error('render failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mount(ChannelsSettingsTab, {
      props: { settings: appSettings(true) },
    })
    await settle()

    expect(wrapper.text()).toContain('Could not render the login QR code')
    expect(wrapper.find('img.qr-code-image').exists()).toBe(false)

    await wrapper.find('button[aria-label="Refresh status"]').trigger('click')
    await settle()

    expect(mocks.toDataURL).toHaveBeenCalledTimes(2)
    expect(mocks.toDataURL).toHaveBeenLastCalledWith(
      'https://liteapp.weixin.qq.com/q/mock',
      expect.any(Object),
    )
    expect(wrapper.find('img.qr-code-image').exists()).toBe(true)

    wrapper.unmount()
    consoleError.mockRestore()
  })

  it('renders profiles and creates channel bindings', async () => {
    const wrapper = mount(ChannelsSettingsTab, {
      props: { settings: appSettings(true) },
    })
    await settle()

    expect(wrapper.text()).toContain('Local user')
    expect(wrapper.text()).toContain('local-owner')
    expect(wrapper.text()).toContain('Default')
    expect(wrapper.text()).toContain('wechat-user-1')

    await wrapper.find('.binding-form .channel-action').trigger('click')
    await settle()

    expect(rpcInvokeMock).toHaveBeenCalledWith({
      domain: 'channelIdentity',
      method: 'createLink',
      payload: {
        connector: 'wechat',
        workspaceId: 'default',
        externalUserId: 'wechat-user-1',
        clientUserId: 'local-owner',
      },
    })

    wrapper.unmount()
  })
})
