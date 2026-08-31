import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppSettings } from '@shared/ipc/settings'
import type { OpenRouterModel, ProviderInfo } from '@shared/ipc/providers'
import { renderContent } from '../../../content'
import { configureProviderSettingsPort } from '../../../data/provider-settings-port'
import type { ProviderSettingsPort } from '../../../data/provider-settings-port'
import { useProviderSettings } from '../../store'
import { useNotifyStore } from '../../../services/notify-store'
import { useStageStore } from '../../../stage/store'
import { PROVIDERS_ITEM_ID } from '../../../stage/items'

/**
 * 模型服务面(批一)。这一批验的是**面长在真数据上**:
 * 左栏三组按家名册、右面按模式分坑、换一坑就换一份目录、勾选与启用真的写出去、
 * 以及五处缺席态一处都不假装。
 *
 * 取数一律走假端口(单元测试不碰网)。
 */

function info(id: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    name: id,
    description: '',
    defaultBaseUrl: 'https://api.test/v1',
    defaultModel: 'm',
    icon: id,
    supportsCustomBaseUrl: true,
    requiresApiKey: true,
    ...extra,
  }
}

const ROSTER: ProviderInfo[] = [
  info('claude', { name: 'Claude', description: 'Anthropic 的模型' }),
  info('claude-code', {
    name: 'Claude Code',
    requiresApiKey: false,
    requiresOAuth: true,
    oauthFlow: 'authorization-code',
  }),
  info('acp', { name: 'ACP Agents', requiresApiKey: false }),
]

function model(id: string, name: string): OpenRouterModel {
  return {
    id,
    name,
    context_length: 200_000,
    architecture: {
      modality: 'text',
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      tokenizer: 'x',
    },
    pricing: { prompt: '0.000003', completion: '0.000015', request: '0', image: '0' },
    top_provider: { context_length: 200_000, max_completion_tokens: 32_768, is_moderated: false },
    supported_parameters: ['tools'],
  }
}

const CATALOGS: Record<string, OpenRouterModel[]> = {
  claude: [model('claude-sonnet-4', 'Claude Sonnet 4')],
  'claude-code': [model('claude-opus-5', 'Claude Opus 5')],
  acp: [],
}

function settings(): AppSettings {
  return {
    ai: {
      temperature: 0.7,
      modelCatalog: {},
      provider: 'claude',
      providers: { claude: { model: 'claude-sonnet-4', selectedModels: ['claude-sonnet-4'] } },
      customProviders: [],
    },
  } as unknown as AppSettings
}

/** 默认这台机器:claude 有一把 key,订阅那一坑没登录。 */
function credentials(signedIn: boolean) {
  return {
    success: true as const,
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
        ...(signedIn
          ? {
              'claude-code': {
                policy: 'single',
                entries: [
                  {
                    id: 'e1',
                    label: '',
                    authType: 'oauth' as const,
                    hasApiKey: false,
                    hasOAuthToken: true,
                    oauthAccount: 'me@example.com',
                    source: 'oauth',
                  },
                ],
              },
            }
          : {}),
      },
    },
  }
}

function installPort(overrides: Partial<ProviderSettingsPort> = {}) {
  const port: ProviderSettingsPort = {
    ready: async () => undefined,
    listProviders: vi.fn(async () => ({ success: true, providers: ROSTER })),
    listModels: vi.fn(async (providerId: string) => ({
      success: true,
      models: CATALOGS[providerId] ?? [],
    })),
    readSettings: vi.fn(async () => ({ success: true, settings: settings() })),
    saveSettings: vi.fn(async (next: AppSettings) => ({ success: true, settings: next })),
    readCredentials: vi.fn(async () => credentials(false)),
    setCredential: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
    ...overrides,
  }
  configureProviderSettingsPort(port)
  return port
}

beforeEach(() => {
  // 断言写的是中文那一份文案,所以语言得钉死 —— jsdom 的 navigator.language 是
  // en-US,'system' 档会解析成英文(与 files-panel 用例同一手)。
  useStageStore.setState({ locale: 'zh' })
  useProviderSettings.getState().reset()
  useNotifyStore.getState().clear()
})

describe('骨架', () => {
  it('左栏按三组画家名册,一家两模式只占一行', async () => {
    installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)

    expect(await screen.findByTestId('provider-row-claude')).toBeTruthy()
    expect(screen.getByTestId('provider-row-acp')).toBeTruthy()
    // claude-code 折进了 Claude 那一行,不另占一行。
    expect(screen.queryByTestId('provider-row-claude-code')).toBeNull()
    expect(screen.getByText('云服务')).toBeTruthy()
    expect(screen.getByText('本地')).toBeTruthy()
    // 「N 家已接入」数的是配好了的:claude 有 key、acp 是本地坑 = 2。
    expect(screen.getByText('2 家已接入')).toBeTruthy()
  })

  it('副行是算出来的事实句,不是写死的字', async () => {
    installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('provider-row-claude')
    expect(screen.getByText('API 密钥 · 已配置 · 订阅 · 未登录 · 已选 1 型')).toBeTruthy()
  })

  it('开面落在第一家上,头部画名字与启用开关', async () => {
    installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('provider-row-claude')
    expect(screen.getByRole('switch', { name: '启用 Claude' })).toBeTruthy()
    expect(screen.getByText('Anthropic 的模型')).toBeTruthy()
  })

  it('名册与设置都读不到时如实说,并给一颗重试钮', async () => {
    installPort({
      listProviders: vi.fn(async () => ({ success: false, error: 'boom' })),
      readSettings: vi.fn(async () => ({ success: false, error: 'nope' })),
    })
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await waitFor(() => expect(screen.getByText(/读不到模型服务名册/)).toBeTruthy())
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy()
  })
})

describe('模式切换换目录', () => {
  it('默认落在配好的那一坑,目录是那一坑的', async () => {
    const port = installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('model-row-claude-sonnet-4')
    expect(port.listModels).toHaveBeenCalledWith('claude', false)
    expect(screen.queryByTestId('model-row-claude-opus-5')).toBeNull()
  })

  it('换到已登录的订阅坑,拉的是**另一份**目录', async () => {
    const port = installPort({ readCredentials: vi.fn(async () => credentials(true)) })
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('radio', { name: '订阅 · 已登录' }))
    expect(await screen.findByTestId('model-row-claude-opus-5')).toBeTruthy()
    expect(port.listModels).toHaveBeenCalledWith('claude-code', false)
    // 两坑各一份,不合并。
    expect(screen.queryByTestId('model-row-claude-sonnet-4')).toBeNull()
  })

  it('未登录的订阅坑**连请求都不发** —— 目录不可得就说不可得', async () => {
    const port = installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('radio', { name: '订阅 · 未登录' }))
    await waitFor(() => expect(screen.getByText(/登录后才有模型目录/)).toBeTruthy())
    expect(vi.mocked(port.listModels).mock.calls.map((c) => c[0])).not.toContain('claude-code')
  })

  it('一坑的家不画分段器 —— 只有一格的分段器是噪音', async () => {
    installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    fireEvent.click(await screen.findByTestId('provider-row-acp'))
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: '接入模式' })).toBeNull())
  })
})

describe('写与缺席态', () => {
  it('勾一个模型 = 一次整份写回,只动 selectedModels', async () => {
    const port = installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('checkbox', { name: '勾选 claude-sonnet-4' }))
    await waitFor(() => expect(port.saveSettings).toHaveBeenCalledTimes(1))
    expect(vi.mocked(port.saveSettings).mock.calls[0][0].ai.providers.claude.selectedModels).toEqual(
      [],
    )
  })

  it('关一家 = 家族一开全开的反面:两个 id 一次写完', async () => {
    const port = installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('switch', { name: '启用 Claude' }))
    await waitFor(() => expect(port.saveSettings).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    expect(sent.ai.providers.claude.enabled).toBe(false)
    expect(sent.ai.providers['claude-code'].enabled).toBe(false)
  })

  it('密钥:占位符说尾号,输入框初值永远是空的,保存走凭证域', async () => {
    const port = installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    const field = (await screen.findByLabelText('Claude 的 API 密钥')) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('已存 …8c1d,输入新的可替换')

    fireEvent.change(field, { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(port.setCredential).toHaveBeenCalledTimes(1))
    // 密钥**绝不**经 saveSettings —— 那条路会把它静默剥掉。
    expect(port.saveSettings).not.toHaveBeenCalled()
  })

  it('五处缺席态画的是禁用钮 + 一句「在下一批」,一个假流程都没有', async () => {
    installPort()
    render(<>{renderContent(PROVIDERS_ITEM_ID)}</>)
    await screen.findByTestId('model-row-claude-sonnet-4')

    const addCustom = screen.getByRole('button', { name: '＋ 自定义服务商' }) as HTMLButtonElement
    expect(addCustom.disabled).toBe(true)
    expect(screen.getByText('新建自定义服务商在下一批')).toBeTruthy()
    expect(screen.getByText('多把密钥、顺序与轮换策略在下一批')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: '订阅 · 未登录' }))
    const signIn = (await screen.findByRole('button', { name: '登录' })) as HTMLButtonElement
    expect(signIn.disabled).toBe(true)
    expect(screen.getByText('登录入口在下一批')).toBeTruthy()
  })
})
