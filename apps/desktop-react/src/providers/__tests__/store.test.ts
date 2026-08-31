import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'
import type { ProviderInfo } from '@shared/ipc/providers'
import { configureProviderSettingsPort } from '../../data/provider-settings-port'
import type { ProviderSettingsPort } from '../../data/provider-settings-port'
import { useNotifyStore } from '../../services/notify-store'
import { DEFAULT_SPACE_ID, useProviderSettings } from '../store'
import { buildFamilies, findFamily } from '../families'
import { fakeProviderPort } from './fake-port'

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
  const port: ProviderSettingsPort = fakeProviderPort({
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
  })
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

/* ── 批二:模型级 ────────────────────────────────────────────────────────── */

describe('setCurrentModel / addManualModel / removeManualModel', () => {
  it('设为当前**顺带勾上** —— 当前模型不在选择器里,聊天那边就选不着它', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().setCurrentModel('claude', 'claude-sonnet-4')

    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    expect(sent.ai.providers.claude.model).toBe('claude-sonnet-4')
    expect(sent.ai.providers.claude.selectedModels).toContain('claude-sonnet-4')
    // 原来勾着的一个都没丢。
    expect(sent.ai.providers.claude.selectedModels).toContain('claude-opus-5')
  })

  it('已经是当前了就不写 —— 一次空写会让屏幕闪一下忙态却什么都没做', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().setCurrentModel('claude', 'claude-opus-5')
    expect(port.saveSettings).not.toHaveBeenCalled()
  })

  it('手填一个目录没有的 id:进 selectedModels', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    expect(useProviderSettings.getState().addManualModel('claude', ' qwen3-max ')).toBeUndefined()
    await vi.waitFor(() => expect(port.saveSettings).toHaveBeenCalledTimes(1))
    expect(vi.mocked(port.saveSettings).mock.calls[0][0].ai.providers.claude.selectedModels).toEqual([
      'claude-opus-5',
      'qwen3-max',
    ])
  })

  it('重复的 id **同步**返回一句话且不发请求 —— 输入框要当场知道该不该清空', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    const problem = useProviderSettings.getState().addManualModel('claude', 'claude-opus-5')
    expect(problem).toBeTruthy()
    expect(port.saveSettings).not.toHaveBeenCalled()
  })

  it('删手填模型:**最后一条不删**(与生产 toggleSpaceModelSelection 同一守则)', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    // 池里只有 claude-opus-5 一条,删它 = 把这一家清空。
    await useProviderSettings.getState().removeManualModel('claude', 'claude-opus-5')
    expect(port.saveSettings).not.toHaveBeenCalled()
  })

  it('删掉的正好是当前模型时,当前顺位落到剩下的第一个', async () => {
    const port = installPort({
      readSettings: vi.fn(async () => ({
        success: true,
        settings: {
          ai: {
            temperature: 0.7,
            modelCatalog: {},
            provider: 'claude',
            providers: { claude: { model: 'ghost', selectedModels: ['ghost', 'claude-opus-5'] } },
            customProviders: [],
          },
        } as unknown as AppSettings,
      })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().removeManualModel('claude', 'ghost')
    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    expect(sent.ai.providers.claude.selectedModels).toEqual(['claude-opus-5'])
    // 留一个指向已删 id 的 model = 让聊天那边挑到一个不存在的模型。
    expect(sent.ai.providers.claude.model).toBe('claude-opus-5')
  })
})

/* ── 批二:凭证池 ────────────────────────────────────────────────────────── */

const POOL = {
  success: true as const,
  credentials: {
    providers: {
      claude: {
        policy: 'priority-failover',
        entries: [
          { id: 'e0', label: '个人', authType: 'apiKey' as const, hasApiKey: true, source: 'user' },
          { id: 'e1', label: '公司', authType: 'apiKey' as const, hasApiKey: true, source: 'user' },
        ],
      },
    },
  },
}

function poolPort(overrides: Partial<ProviderSettingsPort> = {}) {
  return installPort({ readCredentials: vi.fn(async () => POOL), ...overrides })
}

describe('凭证池的写', () => {
  it('添加:**不带 entryId**(追加一条)', async () => {
    const port = poolPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().addCredential('claude', ' sk-new ', ' 备注 ')
    const sent = vi.mocked(port.setCredential).mock.calls[0][0]
    expect(sent).toMatchObject({ id: DEFAULT_SPACE_ID, providerId: 'claude', apiKey: 'sk-new', label: '备注' })
    expect(sent.entryId).toBeUndefined()
  })

  it('换密钥:**带 entryId** —— 换 key 不换条目,用量账才连得上', async () => {
    const port = poolPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().replaceCredential('claude', 'e1', 'sk-rotated')
    const sent = vi.mocked(port.setCredential).mock.calls[0][0]
    expect(sent.entryId).toBe('e1')
    expect(sent.apiKey).toBe('sk-rotated')
    // 池那一口没被碰 —— 换 key 不是一次重排。
    expect(port.setCredentialPool).not.toHaveBeenCalled()
  })

  it('删除:发的是**剩下的那串 id**(那一口吃的是期望的最终顺序)', async () => {
    const port = poolPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().removeCredential('claude', 'e0')
    expect(vi.mocked(port.setCredentialPool).mock.calls[0][0].entryIds).toEqual(['e1'])
  })

  it('只剩一条时删不动 —— 后端本来就拒空列表,这里先挡一道', async () => {
    const port = installPort({
      readCredentials: vi.fn(async () => ({
        success: true as const,
        credentials: {
          providers: {
            claude: {
              policy: 'single',
              entries: [{ id: 'e0', label: '', authType: 'apiKey' as const, hasApiKey: true, source: 'user' }],
            },
          },
        },
      })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().removeCredential('claude', 'e0')
    expect(port.setCredentialPool).not.toHaveBeenCalled()
  })

  it('调序 = 一次交换后的整串;越界不发请求', async () => {
    const port = poolPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().moveCredential('claude', 'e1', -1)
    expect(vi.mocked(port.setCredentialPool).mock.calls[0][0].entryIds).toEqual(['e1', 'e0'])

    await useProviderSettings.getState().moveCredential('claude', 'e0', -1)
    expect(port.setCredentialPool).toHaveBeenCalledTimes(1)
  })

  it('换策略要把整串 id 一起发回去', async () => {
    const port = poolPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().setRotation('claude', 'round-robin')
    expect(vi.mocked(port.setCredentialPool).mock.calls[0][0]).toMatchObject({
      entryIds: ['e0', 'e1'],
      policy: 'round-robin',
    })
  })

  it('池写失败:记原话 + 弹一条,并且**不做乐观更新**(摘要没有产地可回滚)', async () => {
    const port = poolPort({
      setCredentialPool: vi.fn(async () => ({ success: false, error: '写不进去' })),
    })
    await useProviderSettings.getState().start()
    const before = useProviderSettings.getState().credentials.claude
    await useProviderSettings.getState().setRotation('claude', 'round-robin')
    expect(useProviderSettings.getState().poolError.claude).toBe('写不进去')
    expect(useProviderSettings.getState().credentials.claude).toBe(before)
    expect(useNotifyStore.getState().items).toHaveLength(1)
    expect(port.setCredentialPool).toHaveBeenCalledTimes(1)
  })
})

/* ── 批二:订阅登录 ──────────────────────────────────────────────────────── */

describe('登录流', () => {
  it('设备码流:起步后把码摆出来,轮到 completed 就收尾并重问登录态', async () => {
    let polls = 0
    const port = installPort({
      oauthStart: vi.fn(async () => ({
        success: true,
        flowId: 'f1',
        userCode: 'XKCD-2048',
        verificationUri: 'https://x.ai/device',
        pollIntervalMs: 1,
      })),
      oauthDevicePoll: vi.fn(async () => {
        polls += 1
        return polls < 2
          ? { success: true, completed: false, pollStatus: 'authorization_pending' }
          : { success: true, completed: true }
      }),
      oauthStatus: vi.fn(async () => ({ success: true, isLoggedIn: polls >= 2 })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().startAuth('claude-code')

    expect(polls).toBe(2)
    expect(useProviderSettings.getState().authStatus['claude-code']?.isLoggedIn).toBe(true)
    // 收尾后流被收掉 —— 屏幕不该还停在设备码那一屏。
    expect(useProviderSettings.getState().authFlow['claude-code']?.kind).toBeNull()
    expect(port.oauthDevicePoll).toHaveBeenCalledWith({ providerId: 'claude-code', flowId: 'f1' })
  })

  it('设备码流失败:显示**服务商原话**,不换成一句「登录失败」', async () => {
    installPort({
      oauthStart: vi.fn(async () => ({
        success: true,
        userCode: 'A-1',
        verificationUri: 'https://a',
        pollIntervalMs: 1,
      })),
      oauthDevicePoll: vi.fn(async () => ({
        success: false,
        completed: false,
        error: 'expired_token',
      })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().startAuth('claude-code')
    expect(useProviderSettings.getState().authFlow['claude-code']?.error).toBe('expired_token')
  })

  it('贴码流:起步后不锁面,提交码走 callback', async () => {
    const port = installPort({
      oauthStart: vi.fn(async () => ({
        success: true,
        requiresCodeEntry: true,
        state: 'st-1',
        instructions: '去浏览器里拿码',
      })),
      oauthCallback: vi.fn(async () => ({ success: true })),
      oauthStatus: vi.fn(async () => ({ success: true, isLoggedIn: true })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().startAuth('claude-code')

    const flow = useProviderSettings.getState().authFlow['claude-code']
    expect(flow?.kind).toBe('paste')
    // 接下来要用户去浏览器里拿码,这边转个圈没有意义。
    expect(flow?.busy).toBe(false)
    expect(flow?.paste?.instructions).toBe('去浏览器里拿码')

    useProviderSettings.getState().setAuthCode('claude-code', ' code-9 ')
    await useProviderSettings.getState().submitAuthCode('claude-code')
    expect(port.oauthCallback).toHaveBeenCalledWith({
      providerId: 'claude-code',
      code: 'code-9',
      state: 'st-1',
    })
  })

  it('起步就失败 = 画错误,不画一个空流程', async () => {
    installPort({ oauthStart: vi.fn(async () => ({ success: false, error: '起不来' })) })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().startAuth('claude-code')
    const flow = useProviderSettings.getState().authFlow['claude-code']
    expect(flow?.kind).toBeNull()
    expect(flow?.error).toBe('起不来')
  })

  /**
   * 后端没有 cancel 这一口,取消 = 世代号 +1,让还在飞的轮询循环自己退出。
   * 这一条守的是**取消之后轮询真的停了** —— 停不下来就会在用户重开一条流时
   * 用上一条的答案把它顶掉。
   */
  it('取消:流收掉,并且还在飞的轮询不再问下去', async () => {
    let polls = 0
    installPort({
      oauthStart: vi.fn(async () => ({
        success: true,
        userCode: 'A-1',
        verificationUri: 'https://a',
        pollIntervalMs: 1,
      })),
      oauthDevicePoll: vi.fn(async () => {
        polls += 1
        useProviderSettings.getState().cancelAuth('claude-code')
        return { success: true, completed: false, pollStatus: 'authorization_pending' }
      }),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().startAuth('claude-code')
    expect(polls).toBe(1)
    expect(useProviderSettings.getState().authFlow['claude-code']?.kind).toBeNull()
  })
})

/* ── 批二:用量 ──────────────────────────────────────────────────────────── */

describe('订阅用量', () => {
  const USAGE = {
    success: true as const,
    providerId: 'codex',
    usage: { planType: 'Plus', limits: [{ id: 'codex', primary: { usedPercent: 34 } }] },
  }

  it('60s 内吃缓存,force 绕过它', async () => {
    const port = installPort({ getProviderUsage: vi.fn(async () => USAGE) })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().loadUsage('codex')
    await useProviderSettings.getState().loadUsage('codex')
    expect(port.getProviderUsage).toHaveBeenCalledTimes(1)

    await useProviderSettings.getState().loadUsage('codex', true)
    expect(port.getProviderUsage).toHaveBeenCalledTimes(2)
  })

  it('后端说 unsupported = 这家没有用量卡(存 null,组件据它整块不画)', async () => {
    installPort({
      getProviderUsage: vi.fn(async () => ({ success: true, providerId: 'claude', unsupported: true })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().loadUsage('claude')
    expect(useProviderSettings.getState().usage.claude).toBeNull()
    expect(useProviderSettings.getState().usageStatus.claude).toBe('ready')
  })

  it('拿不到:记原话,不缓存(下一次还要真去问)', async () => {
    const port = installPort({
      getProviderUsage: vi.fn(async () => ({ success: false, providerId: 'codex', error: '429' })),
    })
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().loadUsage('codex')
    expect(useProviderSettings.getState().usageError.codex).toBe('429')
    await useProviderSettings.getState().loadUsage('codex')
    expect(port.getProviderUsage).toHaveBeenCalledTimes(2)
  })
})

/* ── 批二:自定义家与计费档位 ────────────────────────────────────────────── */

describe('自定义家', () => {
  const FORM = {
    name: '我的 vLLM',
    description: '本机',
    apiType: 'openai' as const,
    baseUrl: 'http://192.168.1.8:8000/v1',
    apiKey: '',
    model: 'qwen3-32b-awq',
  }

  it('新建:写 customProviders **同时**镜像进 ai.providers', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().saveCustomProvider(FORM)

    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    const created = sent.ai.customProviders![0]
    expect(created).toMatchObject({ name: '我的 vLLM', apiType: 'openai', model: 'qwen3-32b-awq' })
    // 只写 customProviders 的话,这一家在聊天的模型选择器里是隐形的。
    expect(sent.ai.providers[created.id]).toMatchObject({
      baseUrl: 'http://192.168.1.8:8000/v1',
      selectedModels: ['qwen3-32b-awq'],
      enabled: true,
    })
  })

  it('删除:两处一起删', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().saveCustomProvider(FORM)
    const id = vi.mocked(port.saveSettings).mock.calls[0][0].ai.customProviders![0].id

    await useProviderSettings.getState().deleteCustomProvider(id)
    const sent = vi.mocked(port.saveSettings).mock.calls[1][0]
    expect(sent.ai.customProviders).toHaveLength(0)
    expect(sent.ai.providers[id]).toBeUndefined()
  })
})

describe('setDials', () => {
  it('档位与 baseUrl 一起写;没有旋钮的家一个字都不写', async () => {
    const port = installPort()
    await useProviderSettings.getState().start()

    await useProviderSettings.getState().setDials('claude', 'coding-plan', 'cn')
    expect(port.saveSettings).not.toHaveBeenCalled()

    await useProviderSettings.getState().setDials('kimi', 'coding-plan', 'cn')
    const sent = vi.mocked(port.saveSettings).mock.calls[0][0]
    expect(sent.ai.providers.kimi).toMatchObject({
      kimiApiMode: 'coding-plan',
      baseUrl: 'https://api.kimi.com/coding/v1',
    })
  })
})
