import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../json.js'
import type { AppSettings } from '../../ipc/settings.js'
import { createDefaultSettings, mergeWithDefaults } from '../settings.js'

type ProviderConfigWithLocalAddress = {
  localAddress?: string
}

function mergeSettings(settings: JsonObject): AppSettings {
  return mergeWithDefaults(settings as Partial<AppSettings>)
}

describe('compact settings defaults', () => {
  it('enables compacting by default', () => {
    const settings = createDefaultSettings()

    expect(settings.chat?.contextCompactEnabled).toBe(true)
    expect(settings.chat?.contextCompactThreshold).toBe(85)
    expect(settings.chat?.contextCompactKeepRecentTurns).toBe(6)
    expect(settings.chat?.agentLoopStream).toBe(true)
  })

  it('clamps compact numeric settings when merging', () => {
    const settings = mergeSettings({
      chat: {
        contextCompactThreshold: 120,
        contextCompactKeepRecentTurns: 0,
      },
    })

    expect(settings.chat?.contextCompactThreshold).toBe(100)
    expect(settings.chat?.contextCompactKeepRecentTurns).toBe(1)
  })

  it('normalizes legacy agent loop stream opt-out when merging', () => {
    const settings = mergeSettings({
      chat: {
        agentLoopStream: false,
      },
    })

    expect(settings.chat?.agentLoopStream).toBe(true)
  })
})

describe('typography density defaults', () => {
  it('uses compact interface typography by default while preserving comfortable chat density', () => {
    const settings = createDefaultSettings()

    expect(settings.general.typographyDensity).toBe('compact')
    expect(settings.general.messageListDensity).toBe('comfortable')
  })

  it('backfills typography density for older settings files', () => {
    const settings = mergeSettings({
      general: {},
    })

    expect(settings.general.typographyDensity).toBe('compact')
  })

  it('preserves explicit comfortable typography density', () => {
    const settings = mergeSettings({
      general: {
        typographyDensity: 'comfortable',
      },
    })

    expect(settings.general.typographyDensity).toBe('comfortable')
  })

  it('normalizes invalid typography density values', () => {
    const settings = mergeSettings({
      general: {
        typographyDensity: 'roomy',
      },
    })

    expect(settings.general.typographyDensity).toBe('compact')
  })
})

describe('tool call model settings defaults', () => {
  it('uses chat defaults until a provider/model is selected', () => {
    const settings = createDefaultSettings()

    expect(settings.tools.toolCallModel).toEqual({
      providerId: '',
      model: '',
      thinking: false,
      thinkingEffort: 'medium',
    })
  })

  it('backfills tool call model settings for older settings files', () => {
    const settings = mergeSettings({
      tools: {
        enableToolCalls: true,
        tools: {},
      },
    })

    expect(settings.tools.toolCallModel).toEqual({
      providerId: '',
      model: '',
      thinking: false,
      thinkingEffort: 'medium',
    })
  })
})

describe('radio dj model settings defaults', () => {
  it('defaults to following the session (empty provider), toolCallModel shape', () => {
    const settings = createDefaultSettings()

    expect(settings.music?.radioDj).toEqual({
      providerId: '',
      model: '',
      thinking: false,
      thinkingEffort: 'medium',
    })
  })

  it('backfills the radio dj model for older settings files and keeps user values', () => {
    const settings = mergeSettings({
      music: { enabled: true, source: 'fm', configured: true },
    })
    expect(settings.music?.radioDj).toEqual({
      providerId: '',
      model: '',
      thinking: false,
      thinkingEffort: 'medium',
    })

    const configured = mergeSettings({
      music: {
        enabled: true,
        source: 'fm',
        configured: true,
        radioDj: { providerId: 'deepseek', model: 'deepseek-v4', thinking: true },
      },
    })
    expect(configured.music?.radioDj).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4',
      thinking: true,
      thinkingEffort: 'medium',
    })
  })
})

describe('editor settings defaults', () => {
  it('provides stable editor defaults', () => {
    const settings = createDefaultSettings()

    expect(settings.general.editor).toEqual({
      tabSize: 2,
      lineWrapping: true,
      softWrapColumn: 88,
      syntaxHighlighting: true,
      completionEnabled: true,
      composerMaxHeight: 200,
      markdownNoteAttachmentDirectory: '',
      markdownProjectAttachmentDirectory: '',
    })
  })

  it('merges and clamps editor settings', () => {
    const settings = mergeSettings({
      general: {
        editor: {
          tabSize: 99,
          lineWrapping: false,
          softWrapColumn: 999,
          composerMaxHeight: 10,
          markdownNoteAttachmentDirectory: 'attachments',
          markdownProjectAttachmentDirectory: 'assets',
        },
      },
    })

    expect(settings.general.editor?.tabSize).toBe(8)
    expect(settings.general.editor?.lineWrapping).toBe(false)
    expect(settings.general.editor?.softWrapColumn).toBe(200)
    expect(settings.general.editor?.syntaxHighlighting).toBe(true)
    expect(settings.general.editor?.composerMaxHeight).toBe(80)
    expect(settings.general.editor?.markdownNoteAttachmentDirectory).toBe('attachments')
    expect(settings.general.editor?.markdownProjectAttachmentDirectory).toBe('assets')
  })
})

describe('shortcut settings defaults', () => {
  it('provides shortcut defaults', () => {
    const settings = createDefaultSettings()

    expect(settings.general.shortcuts?.searchEverywhere).toEqual({ key: 'k', metaKey: true })
    expect(settings.general.shortcuts?.toggleTodoPlanWindow).toEqual({ key: 't', metaKey: true, shiftKey: true })
    expect(settings.general.shortcuts?.toggleTodoPlan).toEqual({ key: 't', metaKey: true, altKey: true })
  })

  it('merges new shortcut defaults for older settings files', () => {
    const settings = mergeSettings({
      general: {
        shortcuts: {
          sendMessage: { key: 'Enter' },
          newChat: { key: 'n', metaKey: true },
          closeChat: { key: 'w', metaKey: true },
          toggleSidebar: { key: 'b', metaKey: true },
          focusInput: { key: '/' },
        },
      },
    })

    expect(settings.general.shortcuts?.searchEverywhere).toEqual({ key: 'k', metaKey: true })
    expect(settings.general.shortcuts?.toggleTodoPlanWindow).toEqual({ key: 't', metaKey: true, shiftKey: true })
  })

  it('preserves double shift shortcut sequences', () => {
    const settings = mergeSettings({
      general: {
        shortcuts: {
          searchEverywhere: { key: 'Shift', sequence: 'double-shift' },
        },
      },
    })

    expect(settings.general.shortcuts?.searchEverywhere).toEqual({ key: 'Shift', sequence: 'double-shift' })
  })
})

describe('todo plan settings defaults', () => {
  it('uses active todo autonomy by default', () => {
    const settings = createDefaultSettings()

    expect(settings.general.todoPlan?.enabled).toBe(true)
    expect(settings.general.todoPlan?.autonomy).toBe('active')
  })

  it('merges active todo autonomy for older settings files', () => {
    const settings = mergeSettings({
      general: {
        todoPlan: {
          enabled: true,
        },
      },
    })

    expect(settings.general.todoPlan?.autonomy).toBe('active')
  })
})

describe('settings.ui (im-workbench-layout C0 回滚闸)已退役', () => {
  /**
   * `ui.shellMode`(workbench ↔ classic 逐像素回滚闸)于 2026-08-05 整段删除 ——
   * docs/design/product-two-forms-chatgpt-shell.md D2。这条测试留下来是当墓碑用:
   * 谁要是再往 settings 里加一个「外壳形态」开关,得先回去读那一节为什么删的。
   */
  it('不再有 ui 段,settings.json 里写 shellMode 也不再有任何效果', () => {
    expect('ui' in createDefaultSettings()).toBe(false)
    expect('ui' in mergeWithDefaults({})).toBe(false)
    expect('ui' in mergeSettings({ ui: { shellMode: 'classic' } } as never)).toBe(false)
  })
})

describe('mergeWithDefaults 白名单漏键审计', () => {
  /**
   * `merged` 是白名单式重建,末尾的 `as AppSettings` 断言让漏列的键静默消失
   * ——用户在 settings.json 里改了也不生效。这条测试拿一个「每个键都有值」的
   * 探针过一遍 merge,把幸存集合钉死。
   *
   * `storage` / `evals` 曾是 C0 之前就存在的两个漏项,C1 一起补上了 ——
   * 迁移标记 `storage.providerConfigMigratedAt` 就住在 `storage` 里,被吞掉的
   * 后果是每次启动重跑一遍 provider 配置迁移。名单因此清空:**任何一个键被
   * merge 吞掉都是红**。
   */
  const KNOWN_DROPPED_KEYS: readonly string[] = []

  it('AppSettings 的每个键都活过 merge(不再有既有漏项)', () => {
    const probe: Record<string, unknown> = {
      ...createDefaultSettings(),
      storage: { sessionFormat: 'jsonl' },
      evals: { repoDir: '/tmp/evals' },
      mcp: { servers: [] },
      skills: {},
    }

    const merged = mergeWithDefaults(probe as Partial<AppSettings>) as unknown as Record<string, unknown>
    const dropped = Object.keys(probe).filter(key => merged[key] === undefined)

    expect(dropped.sort()).toEqual([...KNOWN_DROPPED_KEYS].sort())
  })

  /**
   * 接入目录清单。它挂在 `tools` 下,靠 `{...defaults.tools, ...settings.tools}`
   * 那次展开活下来 —— 但上面那条探针只数**顶层**键,看不见它。而这条清单是
   * **可写沙箱根**的唯一来源:一旦被 merge 静默吞掉,用户加的目录保存即消失,
   * 界面上只表现为"加了没反应"。所以单独钉住往返。
   */
  it('tools.connectedDirectories 活过 merge(保存即丢的老坑不再重演)', () => {
    const merged = mergeWithDefaults({
      tools: {
        ...createDefaultSettings().tools,
        connectedDirectories: ['/Users/me/vault', '/Users/me/work'],
      },
    } as Partial<AppSettings>)

    expect(merged.tools.connectedDirectories).toEqual(['/Users/me/vault', '/Users/me/work'])

    // 往返一次(保存路径上 normalize 会再跑一遍)仍然一字不差。
    expect(mergeWithDefaults(merged).tools.connectedDirectories)
      .toEqual(['/Users/me/vault', '/Users/me/work'])
  })

  it('接入目录默认空,且脏值被挡在入口外', () => {
    expect(mergeWithDefaults({}).tools.connectedDirectories).toEqual([])

    const dirty = mergeWithDefaults({
      tools: {
        ...createDefaultSettings().tools,
        // 非字符串、空白、重复、以及**相对路径**(进了沙箱根只会变成一条
        // 永远不生效的授权,必须在入口挡掉)。
        connectedDirectories: [
          '/Users/me/vault',
          '/Users/me/vault',
          '  ',
          'relative/path',
          42 as unknown as string,
          '/Users/me/other',
        ],
      },
    } as Partial<AppSettings>)

    expect(dirty.tools.connectedDirectories).toEqual(['/Users/me/vault', '/Users/me/other'])

    // 非数组也不炸,退回空列表。
    expect(mergeWithDefaults({
      tools: {
        ...createDefaultSettings().tools,
        connectedDirectories: 'nope' as unknown as string[],
      },
    } as Partial<AppSettings>).tools.connectedDirectories).toEqual([])
  })

  /**
   * `general` 走的是 `{...defaults.general, ...settings.general}` 展开,所以它的
   * 子键天然幸存 —— 但上面那条探针只数**顶层**键,`userProfile` 这种"零默认值、
   * 只有用户写了才存在"的子键在它眼里是不可见的。身份是 dm/署名/@ 三条链的入口,
   * 静默丢一次就是全链路回退到「用户」,所以单独钉住。
   */
  it('general.userProfile 与私聊通知开关活过 merge', () => {
    const merged = mergeWithDefaults({
      general: {
        userProfile: { name: '一天', handle: 'yitian', avatar: '🙂', avatarImage: 'me.png' },
        dmNotifications: false,
      },
    } as Partial<AppSettings>)

    expect(merged.general.userProfile).toEqual({
      name: '一天',
      handle: 'yitian',
      avatar: '🙂',
      avatarImage: 'me.png',
    })
    expect(merged.general.dmNotifications).toBe(false)
  })

  /**
   * 输入区宽度档位(I 期)。`general` 是白名单式重建里**显式列出**的枚举归一
   * 之一,不是靠展开幸存的 —— 于是这条钉三件事:缺省不变、合法值活过 merge、
   * 脏值回落缺省(而不是原样流进 CSS 选择器,让界面无声地停在缺省档)。
   */
  it('general.composerWidth:缺省 standard、合法值幸存、非法值回落', () => {
    expect(createDefaultSettings().general.composerWidth).toBe('standard')
    expect(mergeWithDefaults({}).general.composerWidth).toBe('standard')

    for (const gear of ['narrow', 'standard', 'wide', 'full'] as const) {
      expect(mergeWithDefaults({ general: { composerWidth: gear } } as Partial<AppSettings>)
        .general.composerWidth).toBe(gear)
    }

    for (const dirty of ['NARROW', 'huge', '', null, 42, undefined]) {
      expect(mergeWithDefaults({ general: { composerWidth: dirty } } as unknown as Partial<AppSettings>)
        .general.composerWidth).toBe('standard')
    }
  })
})

describe('network settings defaults', () => {
  it('disables global proxy by default', () => {
    const settings = createDefaultSettings()

    expect(settings.network?.proxy.enabled).toBe(false)
    expect(settings.network?.proxy.url).toBe('')
    expect(settings.network?.proxy.bypassRules).toContain('localhost')
  })

  it('merges proxy settings for older settings files', () => {
    const settings = mergeWithDefaults({})

    expect(settings.network?.proxy.enabled).toBe(false)
  })

  it('drops legacy selected network interface settings when merging', () => {
    const settings = mergeSettings({
      network: {
        networkInterface: {
          enabled: true,
          id: 'en0:IPv4:192.168.1.23',
          name: 'en0',
          address: '192.168.1.23',
          family: 'IPv4',
        },
        proxy: {
          enabled: false,
          url: '',
        },
      },
    })

    expect('networkInterface' in settings.network!).toBe(false)
  })
})

describe('legacy network interface settings', () => {
  it('strips provider localAddress values when merging settings', () => {
    const settings = mergeSettings({
      ai: {
        providers: {
          openai: {
            apiKey: '',
            model: 'gpt-4o',
            selectedModels: [],
            localAddress: '10.0.0.1',
          },
        },
        customProviders: [{
          id: 'custom-old',
          name: 'Old',
          apiType: 'openai',
          apiKey: '',
          baseUrl: 'https://example.com/v1',
          model: 'model',
          selectedModels: ['model'],
          localAddress: '10.0.0.2',
        }],
      },
    })

    expect((settings.ai.providers.openai as ProviderConfigWithLocalAddress).localAddress).toBeUndefined()
    expect((settings.ai.customProviders?.[0] as ProviderConfigWithLocalAddress | undefined)?.localAddress).toBeUndefined()
  })
})

describe('插件提示音偏好(M1)', () => {
  it('缺省开着,静音名单为空', () => {
    const settings = createDefaultSettings()

    expect(settings.plugins?.notifySoundsEnabled).toBe(true)
    expect(settings.plugins?.notifySoundMutedPluginIds).toEqual([])
  })

  it('活过 merge —— 这是「白名单漏键」那个坑的第三次点名', () => {
    const settings = mergeSettings({
      plugins: { notifySoundsEnabled: false, notifySoundMutedPluginIds: ['tps-meter'] },
    })

    expect(settings.plugins).toEqual({
      notifySoundsEnabled: false,
      notifySoundMutedPluginIds: ['tps-meter'],
      ambientEnabled: true,
      ambientMutedPluginIds: [],
    })
  })

  it('用户没写过 plugins 段时补出缺省(而不是 undefined)', () => {
    expect(mergeSettings({}).plugins).toEqual({
      notifySoundsEnabled: true,
      notifySoundMutedPluginIds: [],
      ambientEnabled: true,
      ambientMutedPluginIds: [],
    })
  })

  it('静音名单挡住脏值:非数组、非字符串项、重复 id', () => {
    expect(mergeSettings({ plugins: { notifySoundMutedPluginIds: 'tps-meter' } }).plugins)
      .toEqual({
        notifySoundsEnabled: true,
        notifySoundMutedPluginIds: [],
        ambientEnabled: true,
        ambientMutedPluginIds: [],
      })

    expect(mergeSettings({
      plugins: { notifySoundMutedPluginIds: ['a', 1, null, '', 'a', 'b'] },
    }).plugins?.notifySoundMutedPluginIds).toEqual(['a', 'b'])
  })

  it('总开关只有显式 false 才算关 —— 缺失/脏值都按开', () => {
    expect(mergeSettings({ plugins: {} }).plugins?.notifySoundsEnabled).toBe(true)
    expect(mergeSettings({ plugins: { notifySoundsEnabled: false } }).plugins?.notifySoundsEnabled).toBe(false)
  })
})

describe('插件氛围偏好(G2 —— 全窗动画覆盖)', () => {
  it('缺省开着,静音名单为空', () => {
    const settings = createDefaultSettings()
    expect(settings.plugins?.ambientEnabled).toBe(true)
    expect(settings.plugins?.ambientMutedPluginIds).toEqual([])
  })

  it('总闸落盘 + 每插件静音落盘,活过 merge', () => {
    const settings = mergeSettings({
      plugins: {
        notifySoundsEnabled: true,
        notifySoundMutedPluginIds: [],
        ambientEnabled: false,
        ambientMutedPluginIds: ['snow-scene'],
      },
    })
    expect(settings.plugins?.ambientEnabled).toBe(false)
    expect(settings.plugins?.ambientMutedPluginIds).toEqual(['snow-scene'])
  })

  it('氛围静音名单挡住脏值:非数组、非字符串项、重复 id', () => {
    expect(mergeSettings({ plugins: { ambientMutedPluginIds: 'snow-scene' } }).plugins?.ambientMutedPluginIds)
      .toEqual([])
    expect(mergeSettings({
      plugins: { ambientMutedPluginIds: ['x', 2, null, '', 'x', 'y'] },
    }).plugins?.ambientMutedPluginIds).toEqual(['x', 'y'])
  })

  it('氛围总闸只有显式 false 才算关 —— 缺失/脏值都按开', () => {
    expect(mergeSettings({ plugins: {} }).plugins?.ambientEnabled).toBe(true)
    expect(mergeSettings({ plugins: { ambientEnabled: false } }).plugins?.ambientEnabled).toBe(false)
  })

  it('只写氛围段时不吃掉提示音缺省(两半偏好互不覆盖)', () => {
    const plugins = mergeSettings({ plugins: { ambientEnabled: false } }).plugins
    expect(plugins?.notifySoundsEnabled).toBe(true)
    expect(plugins?.notifySoundMutedPluginIds).toEqual([])
  })
})

/**
 * 内置浏览器的 CDP 那一格(B2′,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.2-5 / 拍点 ②)。
 */
describe('browser.cdp settings', () => {
  it('缺省关 —— 开着 = 本机任何程序都能驱动一台登着账号的浏览器', () => {
    const settings = createDefaultSettings()
    expect(settings.browser?.cdp.enabled).toBe(false)
    expect(settings.browser?.cdp.port).toBe(9333)
  })

  it('显式归一,不靠白名单重建兜住 —— 被吞掉的后果是开着的口自己关回去', () => {
    expect(mergeSettings({ browser: { cdp: { enabled: true, port: 9444 } } }).browser?.cdp)
      .toEqual({ enabled: true, port: 9444 })
    // 这一段压根不在(老 store):按缺省,不是 undefined。
    expect(mergeSettings({}).browser?.cdp).toEqual({ enabled: false, port: 9333 })
  })

  it('只有显式 true 才算开', () => {
    expect(mergeSettings({ browser: { cdp: { enabled: 'yes', port: 9333 } } }).browser?.cdp.enabled)
      .toBe(false)
    expect(mergeSettings({ browser: { cdp: { enabled: 1, port: 9333 } } }).browser?.cdp.enabled)
      .toBe(false)
  })

  it('端口不合法**回缺省,不夹** —— 夹一个端口是没有意义的(它是地址不是滑杆上的量)', () => {
    // 参数写 `number | string` 而不是 `unknown`:下面五个调用点就是这两种,而
    // `unknown` 进不了 `JsonObjectProperty`(存量 tsc 红,T2 顺手结清)。
    const portOf = (port: number | string): number =>
      mergeSettings({ browser: { cdp: { enabled: true, port } } }).browser!.cdp.port
    // 0 = Chromium 的随机口:没人发现得了,等于开了个谁都用不上的洞。
    expect(portOf(0)).toBe(9333)
    expect(portOf(70000)).toBe(9333)
    expect(portOf(-1)).toBe(9333)
    expect(portOf(9333.5)).toBe(9333)
    expect(portOf('nope')).toBe(9333)
    // 合法的那些原样留着。
    expect(portOf(9444)).toBe(9444)
    expect(portOf(1)).toBe(1)
    expect(portOf(65535)).toBe(65535)
  })
})
