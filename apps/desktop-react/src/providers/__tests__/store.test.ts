import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'
import type { ProviderInfo } from '@shared/ipc/providers'
import { configureProviderSettingsPort } from '../../data/provider-settings-port'
import type { ProviderSettingsPort } from '../../data/provider-settings-port'
import { useNotifyStore } from '../../services/notify-store'
import { DEFAULT_SPACE_ID, useProviderSettings } from '../store'
import { buildFamilies, findFamily } from '../families'

/**
 * 写口三条。这一组守的是**写打在哪条口上**,以及失败之后屏幕不许留说谎的牌:
 *  ① 启用开关 → saveSettings,一次写完一家的所有 provider id;
 *  ② 模型勾选 → saveSettings,只动 selectedModels 那一格,别的格原样;
 *  ③ API 密钥 → spaces.setCredential,**绝不**经 saveSettings
 *     (那条路会把 apiKey 静默剥掉 —— 看起来存上了、其实没有)。
 */

function info(id: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    name: id,
    description: '',
    defaultBaseUrl: '',
    defaultModel: 'm',
    icon: id,
    supportsCustomBaseUrl: true,
    requiresApiKey: true,
    ...extra,
  }
}

const ROSTER: ProviderInfo[] = [
  info('claude', { name: 'Claude' }),
  info('claude-code', {
    name: 'Claude Code',
    requiresApiKey: false,
    requiresOAuth: true,
    oauthFlow: 'authorization-code',
  }),
]

function settings(): AppSettings {
  return {
    ai: {
      temperature: 0.7,
      modelCatalog: {},
      provider: 'claude',
      providers: {
        claude: { model: 'claude-opus-5', selectedModels: ['claude-opus-5'], apiKey: '••••' },
      },
      customProviders: [],
    },
  } as unknown as AppSettings
}

function installPort(overrides: Partial<ProviderSettingsPort> = {}) {
  const port: ProviderSettingsPort = {
    ready: async () => undefined,
    listProviders: vi.fn(async () => ({ success: true, providers: ROSTER })),
    listModels: vi.fn(async () => ({ success: true, models: [] })),
    readSettings: vi.fn(async () => ({ success: true, settings: settings() })),
    saveSettings: vi.fn(async (next: AppSettings) => ({ success: true, settings: next })),
    readCredentials: vi.fn(async () => ({
      success: true,
      credentials: { providers: { claude: { policy: 'single', entries: [] } } },
    })),
    setCredential: vi.fn(async () => ({
      success: true,
      credentials: {
        providers: {
          claude: {
            policy: 'single',
            entries: [
              {
                id: 'e0',
                label: '',
                authType: 'apiKey' as const,
                hasApiKey: true,
                apiKeyPreview: '…8c1d',
                source: 'manual',
              },
            ],
          },
        },
      },
    })),
    ...overrides,
  }
  configureProviderSettingsPort(port)
  return port
}

const CLAUDE = findFamily(buildFamilies(ROSTER), 'claude')!

beforeEach(() => {
  useProviderSettings.getState().reset()
  useNotifyStore.getState().clear()
})

describe('start', () => {
  it('三发并行,各自失败各自认 —— 名册拉不到不该把设置也拖没', async () => {
    installPort({ listProviders: vi.fn(async () => ({ success: false, error: 'boom' })) })
    await useProviderSettings.getState().start()
    const st = useProviderSettings.getState()
    expect(st.status).toBe('ready')
    expect(st.providers).toEqual([])
    expect(st.settings?.ai.provider).toBe('claude')
  })

  it('凭证口读不到 = credentialsKnown 为假(不是「没有凭证」)', async () => {
    installPort({ readCredentials: vi.fn(async () => ({ success: false, error: 'nope' })) })
    await useProviderSettings.getState().start()
    expect(useProviderSettings.getState().credentialsKnown).toBe(false)
  })

  it('名册与设置都没有 = 如实说读不到', async () => {
    installPort({
      listProviders: vi.fn(async () => ({ success: false, error: 'boom' })),
      readSettings: vi.fn(async () => ({ success: false, error: 'nope' })),
    })
    await useProviderSettings.getState().start()
    expect(useProviderSettings.getState().status).toBe('error')
  })
})

describe('setFamilyEnabled —— 写口 ①', () => {
  it('一次写完一家的所有 provider id(家族一开全开)', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().setFamilyEnabled(CLAUDE, false)

    expect(port.saveSettings).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    expect(sent.ai.providers.claude.enabled).toBe(false)
    expect(sent.ai.providers['claude-code'].enabled).toBe(false)
    // 别的格原样带回去 —— 漏传一格 = 清空那一格。
    expect(sent.ai.providers.claude.selectedModels).toEqual(['claude-opus-5'])
    expect(sent.ai.provider).toBe('claude')
  })

  it('写失败:回滚到底本 + 一条通知,屏幕上不留说谎的牌', async () => {
    const port = installPort({ saveSettings: vi.fn(async () => ({ success: false, error: '写不进去' })) })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().setFamilyEnabled(CLAUDE, false)

    expect(port.saveSettings).toHaveBeenCalledTimes(1)
    expect(useProviderSettings.getState().settings?.ai.providers.claude.enabled).toBeUndefined()
    expect(useProviderSettings.getState().saving).toBe(false)
    expect(useNotifyStore.getState().items[0]).toMatchObject({ source: 'providers.save' })
  })
})

describe('toggleModel —— 写口 ②', () => {
  it('勾上 = 追加一条,别的格原样', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().toggleModel('claude', 'claude-sonnet-5', true)

    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    expect(sent.ai.providers.claude.selectedModels).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(sent.ai.providers.claude.model).toBe('claude-opus-5')
  })

  it('取消 = 减一条', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().toggleModel('claude', 'claude-opus-5', false)
    expect(vi.mocked(port.saveSettings).mock.calls[0][0].ai.providers.claude.selectedModels).toEqual(
      [],
    )
  })

  it('勾一条已经勾着的 = 一次请求都不发', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().toggleModel('claude', 'claude-opus-5', true)
    expect(port.saveSettings).not.toHaveBeenCalled()
  })

  it('这一家在设置里还没有记录时,新建的那条带齐必填格', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().toggleModel('claude-code', 'claude-sonnet-5', true)
    expect(vi.mocked(port.saveSettings).mock.calls[0][0].ai.providers['claude-code']).toEqual({
      model: '',
      selectedModels: ['claude-sonnet-5'],
    })
  })
})

describe('saveApiKey —— 写口 ③', () => {
  it('走凭证域,**不**经 saveSettings;成功后尾号当场就对', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().saveApiKey('claude', '  sk-real-key  ')

    expect(port.saveSettings).not.toHaveBeenCalled()
    expect(port.setCredential).toHaveBeenCalledWith({
      id: DEFAULT_SPACE_ID,
      providerId: 'claude',
      // 前后空白剃掉 —— 粘贴出来的 key 常带一个换行,原样送过去就是一把错的 key。
      apiKey: 'sk-real-key',
    })
    const st = useProviderSettings.getState()
    expect(st.keyStatus.claude).toBe('saved')
    expect(st.credentials.claude.entries[0].apiKeyPreview).toBe('…8c1d')
    expect(st.credentialsKnown).toBe(true)
  })

  it('空串什么都不做 —— 不拿一次空写把已有的那把冲掉', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().saveApiKey('claude', '   ')
    expect(port.setCredential).not.toHaveBeenCalled()
  })

  it('写失败:状态退回 idle + 一条通知', async () => {
    installPort({ setCredential: vi.fn(async () => ({ success: false, error: '存不进去' })) })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().saveApiKey('claude', 'sk-x')
    expect(useProviderSettings.getState().keyStatus.claude).toBe('idle')
    expect(useNotifyStore.getState().items[0]).toMatchObject({ source: 'providers.credential' })
  })
})

describe('ensureCatalog', () => {
  it('拉过就不再拉;forceRefresh 才是「刷新目录」那颗钮', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().ensureCatalog('claude')
    await useProviderSettings.getState().ensureCatalog('claude')
    expect(port.listModels).toHaveBeenCalledTimes(1)
    expect(port.listModels).toHaveBeenLastCalledWith('claude', false)

    await useProviderSettings.getState().ensureCatalog('claude', true)
    expect(port.listModels).toHaveBeenCalledTimes(2)
    expect(port.listModels).toHaveBeenLastCalledWith('claude', true)
    expect(useProviderSettings.getState().catalogFetchedAt.claude).toBeGreaterThan(0)
  })

  it('目录拉不到:记后端那句原话,**不**弹通知(人正在看这块面)', async () => {
    installPort({ listModels: vi.fn(async () => ({ success: false, error: '402 Insufficient Balance' })) })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().ensureCatalog('claude')
    expect(useProviderSettings.getState().catalogStatus.claude).toBe('error')
    expect(useProviderSettings.getState().catalogError.claude).toBe('402 Insufficient Balance')
    expect(useNotifyStore.getState().items).toHaveLength(0)
  })
})
