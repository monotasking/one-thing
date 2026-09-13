import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppSettings } from '@shared/ipc/settings'
import type { OpenRouterModel, ProviderInfo, SpaceProviderSettings } from '@shared/ipc/providers'
import { configureProviderSettingsPort } from '../../../data/provider-settings-port'
import type { ProviderSettingsPort } from '../../../data/provider-settings-port'
import { useProviderSettings } from '../../store'
import { fakeProviderPort } from '../../__tests__/fake-port'
import { useNotifyStore } from '../../../services/notify-store'
import { useStageStore } from '../../../stage/store'
import { ProviderSettingsPanel } from '../ProviderSettingsPanel'

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
  // 两型:一型是设置里的「当前模型」,另一型不是 —— 「设为当前」那颗钮只长在
  // 非当前的行上,所以目录里必须有一行不是当前的,否则那颗钮无从断言。
  claude: [model('claude-sonnet-4', 'Claude Sonnet 4'), model('claude-haiku-4-5', 'Claude Haiku 4.5')],
  'claude-code': [model('claude-opus-5', 'Claude Opus 5')],
  acp: [],
}

/** 全局设置只剩全空间共享的两格 —— provider 那一半在空间的 providers.json 里。 */
function settings(): AppSettings {
  // 带**迁移标记**:这些用例演的是今天绝大多数机器(跑过 C2 搬迁),
  // provider 那一半的真相在空间文件里。未迁移那条路由专门的用例点名测。
  return {
    ai: { temperature: 0.7, modelCatalog: {} },
    storage: { spaceProviderSettingsMigratedAt: 1 },
  } as unknown as AppSettings
}

/** 当前空间那一份 provider 设置。 */
function spaceSettings(): SpaceProviderSettings {
  return {
    provider: 'claude',
    providers: { claude: { model: 'claude-sonnet-4', selectedModels: ['claude-sonnet-4'] } },
    customProviders: [],
  } as unknown as SpaceProviderSettings
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
  const port: ProviderSettingsPort = fakeProviderPort({
    listProviders: vi.fn(async () => ({ success: true, providers: ROSTER })),
    listModels: vi.fn(async (providerId: string) => ({
      success: true,
      models: CATALOGS[providerId] ?? [],
    })),
    readSettings: vi.fn(async () => ({ success: true, settings: settings() })),
    saveSettings: vi.fn(async (next: AppSettings) => ({ success: true, settings: next })),
    readProviderSettings: vi.fn(async () => ({ success: true, ai: spaceSettings() })),
    writeProviderSettings: vi.fn(async (request) => ({ success: true, ai: request.ai })),
    readCredentials: vi.fn(async () => credentials(false)),
    setCredential: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
    ...overrides,
  })
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
    render(<ProviderSettingsPanel />)

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
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('provider-row-claude')
    expect(screen.getByText('API 密钥 · 已配置 · 订阅 · 未登录 · 已选 1 型')).toBeTruthy()
  })

  it('开面落在第一家上,头部画名字与启用开关', async () => {
    installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('provider-row-claude')
    expect(screen.getByRole('switch', { name: '启用 Claude' })).toBeTruthy()
    expect(screen.getByText('Anthropic 的模型')).toBeTruthy()
  })

  it('名册与设置都读不到时如实说,并给一颗重试钮', async () => {
    installPort({
      listProviders: vi.fn(async () => ({ success: false, error: 'boom' })),
      readSettings: vi.fn(async () => ({ success: false, error: 'nope' })),
    })
    render(<ProviderSettingsPanel />)
    await waitFor(() => expect(screen.getByText(/读不到模型服务名册/)).toBeTruthy())
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy()
  })
})

describe('模式切换换目录', () => {
  it('默认落在配好的那一坑,目录是那一坑的', async () => {
    const port = installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')
    expect(port.listModels).toHaveBeenCalledWith('claude', false)
    expect(screen.queryByTestId('model-row-claude-opus-5')).toBeNull()
  })

  it('换到已登录的订阅坑,拉的是**另一份**目录', async () => {
    const port = installPort({ readCredentials: vi.fn(async () => credentials(true)) })
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('radio', { name: '订阅 · 已登录' }))
    expect(await screen.findByTestId('model-row-claude-opus-5')).toBeTruthy()
    expect(port.listModels).toHaveBeenCalledWith('claude-code', false)
    // 两坑各一份,不合并。
    expect(screen.queryByTestId('model-row-claude-sonnet-4')).toBeNull()
  })

  it('未登录的订阅坑**连请求都不发** —— 目录不可得就说不可得', async () => {
    const port = installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('radio', { name: '订阅 · 未登录' }))
    await waitFor(() => expect(screen.getByText(/登录后才有模型目录/)).toBeTruthy())
    expect(vi.mocked(port.listModels).mock.calls.map((c) => c[0])).not.toContain('claude-code')
  })

  it('一坑的家不画分段器 —— 只有一格的分段器是噪音', async () => {
    installPort()
    render(<ProviderSettingsPanel />)
    fireEvent.click(await screen.findByTestId('provider-row-acp'))
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: '接入模式' })).toBeNull())
  })
})

describe('写与缺席态', () => {
  it('勾一个模型 = 一次整份写回,只动 selectedModels', async () => {
    const port = installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('checkbox', { name: '勾选 claude-sonnet-4' }))
    await waitFor(() => expect(port.writeProviderSettings).toHaveBeenCalledTimes(1))
    expect(vi.mocked(port.writeProviderSettings).mock.calls[0][0].ai.providers.claude.selectedModels).toEqual(
      [],
    )
  })

  it('关一家 = 家族一开全开的反面:两个 id 一次写完', async () => {
    const port = installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('switch', { name: '启用 Claude' }))
    await waitFor(() => expect(port.writeProviderSettings).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(port.writeProviderSettings).mock.calls[0][0]
    expect(sent.ai.providers.claude.enabled).toBe(false)
    expect(sent.ai.providers['claude-code'].enabled).toBe(false)
  })

  it('密钥:添加走凭证域,原文绝不经 saveSettings', async () => {
    const port = installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加密钥' }))
    const field = (await screen.findByLabelText('新密钥')) as HTMLInputElement
    // 输入框初值永远是空的 —— 已存的原文永不回读。
    expect(field.value).toBe('')

    fireEvent.change(field, { target: { value: 'sk-new' } })
    // 09-02 批 12:添加那一条的主钮叫「添加」(它加的是一条新条目,不是保存改动)。
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(port.setCredential).toHaveBeenCalledTimes(1))
    // 密钥**绝不**经 saveSettings —— 那条路会把它静默剥掉。
    expect(port.writeProviderSettings).not.toHaveBeenCalled()
    // 不带 entryId = 追加一条(带了才是「换 key 不换条目」)。
    expect(vi.mocked(port.setCredential).mock.calls[0][0].entryId).toBeUndefined()
  })

  it('批一那五处缺席态全部兑现,一句「在下一批」都不剩', async () => {
    installPort()
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    // ① 新建自定义家:钮活了。
    // 按 testid 取件,不按名字:09-11 起名册有两种形(268 的名册 / 44 的图标条),
    // 这一句在两种形里是同一句文案的两颗钮,真机上永不同屏(另一颗 display:none),
    // 而 jsdom 没有 CSS,两颗都在树上。
    const addCustom = screen.getByTestId('provider-add-custom') as HTMLButtonElement
    expect(addCustom.disabled).toBe(false)
    // ② 多钥与轮换:池子长出来了。
    expect(screen.getByRole('button', { name: '＋ 添加密钥' })).toBeTruthy()
    expect(screen.getByLabelText('轮换策略')).toBeTruthy()
    // ③ 设为当前 / ④ 手填 ID:两颗真钮。
    expect(screen.getByTestId('set-current-claude-haiku-4-5')).toBeTruthy()
    // 当前的那一行画的是读数不是钮 —— 「设为当前」点了不会变的钮是噪音。
    expect(screen.queryByTestId('set-current-claude-sonnet-4')).toBeNull()
    expect(screen.getByRole('button', { name: '＋ 手填 ID' })).toBeTruthy()

    // ⑤ 订阅登录:钮不再是禁用的。
    fireEvent.click(screen.getByRole('radio', { name: '订阅 · 未登录' }))
    const signIn = (await screen.findByRole('button', { name: '登录' })) as HTMLButtonElement
    expect(signIn.disabled).toBe(false)

    expect(screen.queryByText(/在下一批/)).toBeNull()
  })
})

/* ══ 忙态逐格(09-01 批 1 的两条反证)════════════════════════════════════════
 *
 * 病历:写路从前挂在 store 一颗 `saving: boolean` 上,于是勾一个模型的那 200ms
 * 里整张表连同「设为当前」一起禁灰 —— 用户报的「勾选闪烁」(病型 B,粒度病)。
 * 修法是把写路整只迁到 `data/kernel` 的 `settingsMutation`,按 `settingsKey`
 * 分格记账。下面两条钉的正是这次迁移的两半:粒度对不对,语义有没有漂。
 * ════════════════════════════════════════════════════════════════════════ */
describe('忙态逐格', () => {
  /** 一发**卡住的写**:`release()` 之前它永远不回来,于是「在飞」是可观测的。 */
  function heldWrite() {
    let release: (() => void) | undefined
    const write = vi.fn(async (request: { ai: SpaceProviderSettings }) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { success: true as const, ai: request.ai }
    })
    return { write, release: () => release?.() }
  }

  it('勾选 A 在飞时,B 那一行既不禁用、也还是同一个 DOM 节点', async () => {
    const held = heldWrite()
    const port = installPort({ writeProviderSettings: held.write })
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    const pick = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
    // 操作**之前**先扣住 B 那个节点 —— 零重挂断言比的是引用,不是长得像。
    const before = pick('勾选 claude-haiku-4-5')

    fireEvent.click(pick('勾选 claude-sonnet-4'))
    await waitFor(() => expect(port.writeProviderSettings).toHaveBeenCalledTimes(1))

    // 在写的那一行禁了 —— 律③:反馈长在发起它的那个控件上。
    await waitFor(() => expect(pick('勾选 claude-sonnet-4').disabled).toBe(true))
    // 别的行**一个都不许动**。把 disabled 改回一颗全局忙布尔,这两句当场红。
    const after = pick('勾选 claude-haiku-4-5')
    expect(after.disabled).toBe(false)
    expect(after).toBe(before)
    // 家头开关、手填钮同理:它们各在自己的格上,不在模型那一格上。
    expect((screen.getByRole('switch', { name: '启用 Claude' }) as HTMLInputElement).disabled).toBe(
      false,
    )
    expect((screen.getByRole('button', { name: '＋ 手填 ID' }) as HTMLButtonElement).disabled).toBe(
      false,
    )

    held.release()
    await waitFor(() => expect(pick('勾选 claude-sonnet-4').disabled).toBe(false))
  })

  it('写失败:settings 与 spaceAi **两格一起**回底本,外加一条通知', async () => {
    installPort({
      writeProviderSettings: vi.fn(async () => ({ success: false, error: '写不进去' })),
    })
    render(<ProviderSettingsPanel />)
    await screen.findByTestId('model-row-claude-sonnet-4')

    // 底本 = 出手之前屏幕上那两格的**引用**。回滚回的必须是它们本身。
    const baseSettings = useProviderSettings.getState().settings
    const baseSpaceAi = useProviderSettings.getState().spaceAi
    expect(baseSettings).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: '勾选 claude-sonnet-4' }))

    await waitFor(() => expect(useNotifyStore.getState().items).toHaveLength(1))
    expect(useNotifyStore.getState().items[0]).toMatchObject({
      source: 'providers.save',
      // 后端那句原话原样带出来 —— 它是数据,不是文案。
      body: '写不进去',
    })
    expect(useProviderSettings.getState().settings).toBe(baseSettings)
    expect(useProviderSettings.getState().spaceAi).toBe(baseSpaceAi)
    // 屏幕上不留说谎的牌:那一行还勾着。
    expect((screen.getByRole('checkbox', { name: '勾选 claude-sonnet-4' }) as HTMLInputElement).checked).toBe(
      true,
    )
  })
})
