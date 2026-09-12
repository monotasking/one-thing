/**
 * Unified Default Settings
 * Single source of truth for all default settings across main and renderer processes
 */

import { AIProvider } from '../ipc/providers.js'
import { DEFAULT_AGENT_ID } from '../ipc/agents.js'
import type {
  AppSettings,
  BrowserProfile,
  ChannelSettings,
  GeneralSettings,
  ChatSettings,
  EditorSettings,
  NetworkSettings,
  PluginPreferences,
} from '../ipc/settings.js'
import {
  DEFAULT_BROWSER_CDP_PORT,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_SEMANTIC_MODEL_ID,
} from '../ipc/settings.js'
import type { VoiceSettings } from '../ipc/voice.js'
import type { MusicRadioSource, MusicSettings } from '../ipc/music.js'
import type { ProviderConfig, EffectiveAISettings } from '../ipc/providers.js'
import type { ToolSettings } from '../ipc/tools.js'
import type { ACPSettings } from '../ipc/acp.js'

type ProviderConfigWithLocalAddress = ProviderConfig & { localAddress?: string }

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_TEMPERATURE = 0.7
// `DEFAULT_MAX_TOKENS = 4096` 于 2026-09-09 删除:它是「输出上限未知」时最后
// 一个还能编出数来的地方。同日 `ChatSettings.maxTokens` 整格退役 —— 请求侧的
// max_tokens 只认按模型覆盖与目录上限的一半,两个都缺席就不带。老设置文件里
// 残留的 `chat.maxTokens` 值没人读,留在那里即可。
export const DEFAULT_CONTEXT_LENGTH = 128000

export const DEFAULT_EDITOR_SETTINGS: Required<EditorSettings> = {
  tabSize: 2,
  lineWrapping: true,
  softWrapColumn: 88,
  syntaxHighlighting: true,
  completionEnabled: true,
  composerMaxHeight: 200,
  markdownNoteAttachmentDirectory: '',
  markdownProjectAttachmentDirectory: '',
}

// ============================================================================
// Provider Configurations
// ============================================================================

export const DEFAULT_PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  [AIProvider.OpenAI]: {
    apiKey: '',
    model: 'gpt-4o',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.Claude]: {
    apiKey: '',
    model: 'claude-sonnet-4-5-20250929',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.DeepSeek]: {
    apiKey: '',
    model: 'deepseek-chat',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.Kimi]: {
    apiKey: '',
    kimiApiMode: 'standard',
    kimiRegion: 'cn',
    model: 'moonshot-v1-8k',
    selectedModels: [],
    enabled: false,
  },
  // 订阅档:没有 apiKey 这一格 —— 凭证是 OAuth token,存在 token store 里。
  [AIProvider.KimiCode]: {
    authType: 'oauth',
    // 套餐目录(models.dev `kimi-for-coding`)里的 id,与按量那本不重名。
    model: 'k3',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.Zhipu]: {
    apiKey: '',
    zhipuApiMode: 'standard',
    model: 'glm-5.2',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.Qwen]: {
    apiKey: '',
    qwenApiMode: 'standard',
    qwenRegion: 'cn',
    model: 'qwen3.7-plus',
    // The three models both docs sites put front and center. Seeded because
    // models.dev lags the vendor: qwen3.8-max shipped 2026-08-03 and is still
    // absent from the pay-as-you-go catalogs (alibaba / alibaba-cn), so a
    // registry refresh alone would hide the flagship. Entries the catalog does
    // carry get their real metadata from the refresh; the rest are synthesized
    // until models.dev catches up.
    selectedModels: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3.7-flash'],
    enabled: false,
  },
  [AIProvider.OpenRouter]: {
    apiKey: '',
    model: 'openai/gpt-4o',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.Gemini]: {
    apiKey: '',
    model: 'gemini-2.0-flash-exp',
    selectedModels: [],
    enabled: false,
  },
  [AIProvider.ClaudeCode]: {
    model: 'claude-sonnet-4-20250514',
    selectedModels: [],
    authType: 'oauth',
    enabled: false,
  },
  [AIProvider.GitHubCopilot]: {
    model: 'gpt-4o',
    selectedModels: [],
    authType: 'oauth',
    enabled: false,
  },
  [AIProvider.Codex]: {
    model: 'gpt-5.3-codex',
    selectedModels: [],
    authType: 'oauth',
    enabled: false,
  },
  [AIProvider.ACP]: {
    model: 'claude-code',
    selectedModels: ['claude-code', 'codex-cli', 'pi'],
    enabled: false,
  },
  [AIProvider.ClaudeCodeAgent]: {
    model: 'claude-code-agent',
    // 'claude-code-agent' = whatever the local CLI is configured to use.
    selectedModels: ['claude-code-agent', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5'],
    enabled: false,
  },
  [AIProvider.Custom]: {
    apiKey: '',
    baseUrl: '',
    model: '',
    selectedModels: [],
    enabled: false,
  },
}

// ============================================================================
// AI Settings
// ============================================================================

/**
 * 首装种子(生效形状)。
 *
 * C2 之后 `provider` / `providers` / `customProviders` 这三格**不再落盘在
 * settings.json** —— 它们住在每个空间的 `providers.json`。这份种子仍然是生效
 * 形状(`EffectiveAISettings`),因为它同时充当:
 *
 * - 全新安装第一次合成时的兜底(`createDefaultSettings()` 的 `ai`);
 * - `DEFAULT_PROVIDER_CONFIGS` 的宿主 —— 空白空间加第一把 key 时的模型种子表
 *   (`seedSpaceSelectedModels`)从这里取。
 */
export const DEFAULT_AI_SETTINGS: EffectiveAISettings = {
  provider: AIProvider.OpenAI,
  temperature: DEFAULT_TEMPERATURE,
  providers: DEFAULT_PROVIDER_CONFIGS as EffectiveAISettings['providers'],
  customProviders: [],
  modelCatalog: {},
}

// ============================================================================
// General Settings
// ============================================================================

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  animationSpeed: 0.25,
  sendShortcut: 'enter',
  colorTheme: 'blue',
  baseTheme: 'obsidian',
  themeId: 'flexoki',
  darkThemeId: 'flexoki',
  lightThemeId: 'flexoki',
  typographyDensity: 'compact',
  // 缺省 = 现状:standard 档的量尺就是内容列量尺(ChatPanel 不为它写第二份数字)。
  composerWidth: 'standard',
  messageListDensity: 'comfortable',
  shortcuts: {
    sendMessage: { key: 'Enter' },
    newChat: { key: 'n', metaKey: true },
    closeChat: { key: 'w', metaKey: true },
    toggleSidebar: { key: 'b', metaKey: true },
    focusInput: { key: '/' },
    searchEverywhere: { key: 'k', metaKey: true },
    toggleTodoPlanWindow: { key: 't', metaKey: true, shiftKey: true },
    toggleTodoPlan: { key: 't', metaKey: true, altKey: true },
  },
  quickCommands: [
    { commandId: 'cd', enabled: true },
    { commandId: 'git', enabled: true },
    { commandId: 'files', enabled: true },
  ],
  dailyNotes: {
    enabled: true,
    directoryMode: 'personal',
    customDirectory: '',
    useObsidianConfig: true,
    format: 'YYYY-MM-DD',
  },
  todoPlan: {
    enabled: true,
    directory: '',
    cardHeight: 360,
    pinned: false,
    docked: false,
    autonomy: 'active',
  },
  editor: DEFAULT_EDITOR_SETTINGS,
}

// ============================================================================
// Chat Settings
// ============================================================================

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  temperature: DEFAULT_TEMPERATURE,
  topP: 1,
  presencePenalty: 0,
  frequencyPenalty: 0,
  branchOpenInSplitScreen: true,
  chatFontSize: 15,
  contextCompactEnabled: true,
  contextCompactThreshold: 85,
  contextCompactKeepRecentTurns: 6,
  contextCompactChunkTimeoutSeconds: 300,
  agentLoopStream: true,
}

// ============================================================================
// Tool Settings
// ============================================================================

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  enableToolCalls: true,
  permissionMode: 'normal',
  toolCallModel: {
    providerId: '',
    model: '',
    thinking: false,
    thinkingEffort: 'medium',
  },
  // Per-tool settings are user overrides keyed by the dynamic tool registry.
  // Tool defaults come from each ToolDefinition, so new tools do not require
  // editing this settings file.
  tools: {},
  // 接入目录默认空 —— 空列表下五个接线点的行为与没有这个功能时完全一致。
  connectedDirectories: [],
  bash: {
    enableSandbox: true,
    defaultWorkingDirectory: '',
    allowedDirectories: [],
    confirmDangerousCommands: true,
    dangerousCommandWhitelist: [],
    // null = inherit process.env wholesale (historical behaviour). Opting into
    // an allowlist is safe but not free — see BashToolSettings.envAllowlist.
    envAllowlist: null,
  },
}

export const DEFAULT_ACP_SETTINGS: ACPSettings = {
  enabled: true,
  agents: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Claude Code ACP-compatible local agent.',
      enabled: true,
      command: 'claude-agent-acp',
      args: [],
      permissionMode: 'allow',
      allowFileSystemAccess: false,
      allowTerminalAccess: false,
      idleTimeoutMs: 10 * 60 * 1000,
      connectTimeoutMs: 30000,
      promptTimeoutMs: 30 * 60 * 1000,
      maxBufferedUpdates: 1000,
      maxSessionRecords: 100,
      maxTerminals: 32,
      maxTerminalOutputBytes: 1024 * 1024,
    },
    {
      id: 'codex-cli',
      name: 'Codex CLI',
      description: 'Codex ACP-compatible local agent.',
      enabled: true,
      command: 'codex-acp',
      args: [],
      permissionMode: 'allow',
      allowFileSystemAccess: false,
      allowTerminalAccess: false,
      idleTimeoutMs: 10 * 60 * 1000,
      connectTimeoutMs: 30000,
      promptTimeoutMs: 30 * 60 * 1000,
      maxBufferedUpdates: 1000,
      maxSessionRecords: 100,
      maxTerminals: 32,
      maxTerminalOutputBytes: 1024 * 1024,
    },
    {
      // Kimi Code 订阅的**登录**只对官方客户端开放(OAuth 走 CLI 的 `/login`),
      // 第三方直连一律手动 API Key。所以订阅用户要"点一下就登录",路径是驱动
      // 官方 CLI 而不是直连 —— `kimi acp` 是它的 ACP 模式,建会话时复用 CLI
      // 已有的登录态,我们这边一把 Key 都不碰。
      // 直连那一档仍然在(Providers → Kimi → 计费方式 → 编程套餐),两条并存:
      // 一条要装 CLI 换来免管 Key,一条不装 CLI 但要自己贴 Key。
      id: 'kimi-code',
      name: 'Kimi Code',
      description: 'Kimi Code CLI ACP-compatible local agent (login via `kimi` /login).',
      enabled: true,
      command: 'kimi',
      args: ['acp'],
      permissionMode: 'allow',
      allowFileSystemAccess: false,
      allowTerminalAccess: false,
      idleTimeoutMs: 10 * 60 * 1000,
      connectTimeoutMs: 30000,
      promptTimeoutMs: 30 * 60 * 1000,
      maxBufferedUpdates: 1000,
      maxSessionRecords: 100,
      maxTerminals: 32,
      maxTerminalOutputBytes: 1024 * 1024,
    },
    {
      id: 'pi',
      name: 'Pi',
      description: 'Custom Pi ACP-compatible local agent.',
      enabled: true,
      command: 'pi-acp',
      args: [],
      permissionMode: 'allow',
      allowFileSystemAccess: false,
      allowTerminalAccess: false,
      idleTimeoutMs: 10 * 60 * 1000,
      connectTimeoutMs: 30000,
      promptTimeoutMs: 30 * 60 * 1000,
      maxBufferedUpdates: 1000,
      maxSessionRecords: 100,
      maxTerminals: 32,
      maxTerminalOutputBytes: 1024 * 1024,
    },
  ],
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxy: {
    enabled: false,
    url: '',
    bypassRules: 'localhost;127.0.0.1;::1;*.local',
  },
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  alwaysOn: false,
  bargeIn: true,
  conversation: {
    defaultAgentId: DEFAULT_AGENT_ID,
    endpointing: 'fast',
    speakProtocol: 'speak-blocks',
  },
  wake: {
    enabled: false,
    phrase: '你好小一',
    provider: 'sherpa-kws',
    sensitivity: 'medium',
    accessKey: '',
    keywordPath: '',
    modelPath: '',
  },
  vad: {
    provider: 'silero-web',
    silenceMs: 650,
    maxRecordingMs: 20000,
    energyThreshold: 0.012,
  },
  asr: {
    provider: 'funasr-stream',
    openai: {
      apiKey: '',
      model: 'gpt-4o-transcribe',
      language: '',
    },
    openrouter: {
      apiKey: '',
      model: 'openai/whisper-1',
      language: '',
    },
    funasr: {
      url: '',
      language: 'auto',
      hotwords: '',
      mode: '2pass',
      chunkSize: [5, 10, 5],
      chunkInterval: 10,
    },
  },
  tts: {
    provider: 'system-tts',
    autoSpeak: true,
    system: {
      voice: '',
      language: '',
      rate: 1,
      pitch: 1,
    },
    openrouter: {
      apiKey: '',
      model: 'openai/gpt-4o-mini-tts-2025-12-15',
      voice: 'alloy',
    },
    openai: {
      apiKey: '',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
    },
    qwen: {
      apiKey: '',
      baseUrl: '',
      model: 'cosyvoice-v1',
      voice: 'longxiaochun',
    },
  },
  doubao: {
    apiKey: '',
    appId: '',
    accessToken: '',
    asrResourceId: 'volc.seedasr.sauc.duration',
    // 大模型语音合成 (matches the built-in mars/moon voice list; seed-tts-2.0
    // requires 2.0-generation voices instead).
    ttsResourceId: 'volc.service_type.10029',
    endpoint: 'wss://openspeech.bytedance.com',
    endWindowMs: 800,
    twoPass: true,
    speaker: 'zh_female_cancan_mars_bigtts',
    format: 'mp3',
  },
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  wechat: {
    enabled: false,
  },
}

/**
 * 插件提示音缺省**开着**(M1)。
 *
 * 缺省开不等于吵:插件必须显式点名 sound 才会出声,而绝大多数 notify 不点名;
 * 再叠每插件 3 秒限频。缺省关会让这个能力从来没被听见过 —— 那不如不做。
 */
export const DEFAULT_PLUGIN_PREFERENCES: PluginPreferences = {
  notifySoundsEnabled: true,
  notifySoundMutedPluginIds: [],
  ambientEnabled: true,
  ambientMutedPluginIds: [],
}

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  enabled: false,
  provider: 'ncm-cli',
  source: 'fm',
  configured: false,
  radioDj: {
    providerId: '',
    model: '',
    thinking: false,
    thinkingEffort: 'medium',
  },
}

// ============================================================================
// Complete Default Settings Factory
// ============================================================================

/**
 * Create a fresh copy of default settings
 * Use this function to ensure you get a clean copy without reference issues
 */

/**
 * `ai` 段的归一 —— **两种形状,由迁移标记分家**。
 *
 * - **C2 迁移已跑过**(`storage.spaceProviderSettingsMigratedAt` 在)且盘上没有
 *   `providers` 这一格:那就是干净的全局段 —— 只留温度缺省 + models.dev 目录
 *   缓存。不能再把 `DEFAULT_PROVIDER_CONFIGS` 并回去,否则每次保存都会往
 *   `settings.json` 里写回一整张永远不被读的默认 provider 表。
 * - **其余情况**:仍然并进默认表。两个理由,缺一不可 ——
 *   ① 迁移**之前**盘上还躺着 `provider` / `providers` / `customProviders`,
 *      一次性迁移正要读它们(展开 `settings.ai` 放在最前面是故意的);
 *   ② apps/server 的多租户树(`owners/<uid>/<wid>`)**不在本次改造内**,它直接
 *      拿这个函数的结果当生效设置用,少了默认 provider 表就会让新用户第一次
 *      打开设置页时拿到一个空的 provider 列表。
 */
function normalizeAISection(
  settings: Partial<AppSettings>,
  // **必须是 `createDefaultSettings()` 深拷出来的那一份**,不能直接用模块常量:
  // 展开只复制一层,`providers[*]` 仍然是同一批对象 —— 一个 owner 改了 openai
  // 的 key,所有 owner(以及下一次 merge)都跟着变。apps/server 的多租户树上
  // 这就是一次跨用户的密钥泄漏。
  defaults: EffectiveAISettings,
): EffectiveAISettings {
  const ai = settings.ai as (EffectiveAISettings & { providers?: unknown }) | undefined
  const migrated = typeof (settings.storage as { spaceProviderSettingsMigratedAt?: number } | undefined)
    ?.spaceProviderSettingsMigratedAt === 'number'
  const modelCatalog = { ...(ai?.modelCatalog ?? {}) }
  if (migrated && ai?.providers === undefined) {
    return { temperature: ai?.temperature ?? defaults.temperature, modelCatalog } as EffectiveAISettings
  }
  return {
    ...defaults,
    ...ai,
    providers: { ...defaults.providers, ...(ai?.providers as EffectiveAISettings['providers']) },
    modelCatalog,
  }
}

export function createDefaultSettings(): AppSettings {
  return {
    ai: JSON.parse(JSON.stringify(DEFAULT_AI_SETTINGS)),
    theme: 'dark',
    general: JSON.parse(JSON.stringify(DEFAULT_GENERAL_SETTINGS)),
    chat: JSON.parse(JSON.stringify(DEFAULT_CHAT_SETTINGS)),
    tools: JSON.parse(JSON.stringify(DEFAULT_TOOL_SETTINGS)),
    voice: JSON.parse(JSON.stringify(DEFAULT_VOICE_SETTINGS)),
    music: JSON.parse(JSON.stringify(DEFAULT_MUSIC_SETTINGS)),
    network: JSON.parse(JSON.stringify(DEFAULT_NETWORK_SETTINGS)),
    channels: JSON.parse(JSON.stringify(DEFAULT_CHANNEL_SETTINGS)),
    acp: JSON.parse(JSON.stringify(DEFAULT_ACP_SETTINGS)),
    plugins: JSON.parse(JSON.stringify(DEFAULT_PLUGIN_PREFERENCES)),
    diagnostics: { enabled: false },
    // 语义召回:默认关(拍点壬 a)。打开才下载模型。
    search: { semantic: { enabled: false, modelId: DEFAULT_SEMANTIC_MODEL_ID } },
    // 内置浏览器的 CDP 口:默认关(拍点 ②)。开着 = 本机任何程序都能驱动它。
    browser: {
      cdp: { enabled: false, port: DEFAULT_BROWSER_CDP_PORT },
      // 身份名册出厂一行。`name` 是**空串**而不是「默认」三个字:名册是数据,
      // 没起过名的那一行由 UI 用字典画(B3-b)。
      profiles: [{ id: DEFAULT_BROWSER_PROFILE_ID, name: '' }],
      defaultProfile: DEFAULT_BROWSER_PROFILE_ID,
      searchEngine: DEFAULT_BROWSER_SEARCH_ENGINE,
    },
  }
}

/**
 * Deep merge settings with defaults
 * Ensures all required fields exist while preserving user values
 */
export function mergeWithDefaults(settings: Partial<AppSettings>): AppSettings {
  const defaults = createDefaultSettings()

  // Use type assertion because we know defaults provides all required fields
  // and spread operations preserve those values
  const merged = {
    // **`ai` 归一产出的是「生效形状」**(`EffectiveAISettings`),不是落盘形状。
    //
    // C2 之后桌面/CLI 的 `settings.ai` 只落两格(温度缺省 + models.dev 目录
    // 缓存),per-space 那一半住在 `workspaces/<id>/providers.json`;剥离发生在
    // **仓库的写路**(`app/stores/settings.ts` 的 `prepareSave`),不在这里。
    //
    // 这里仍然把 `DEFAULT_PROVIDER_CONFIGS` 并进来,有两个理由:
    //  1. 迁移**之前**的 settings.json 里还躺着 `provider` / `providers` /
    //     `customProviders`,一次性迁移正要读它们(展开放在最前面是故意的);
    //  2. apps/server 的多租户树(`owners/<uid>/<wid>`)**不在本次改造内** ——
    //     它直接拿这个函数的结果当生效设置用,少了默认 provider 表就会在
    //     「新用户第一次打开设置页」时拿到一个空的 provider 列表。
    ai: normalizeAISection(settings, defaults.ai),
    theme: settings.theme ?? defaults.theme,
    general: {
      ...defaults.general,
      ...settings.general,
      shortcuts: {
        ...defaults.general.shortcuts,
        ...settings.general?.shortcuts,
      },
      typographyDensity: normalizeTypographyDensity(settings.general?.typographyDensity),
      // 白名单式重建:枚举键必须**显式**归一,否则 settings.json 里的脏值
      // (拼错的档位、旧版本留下的值)会原样流进 CSS 选择器,变成一个谁也
      // 匹配不上的 data 属性 —— 界面无声地停在缺省档而没人知道为什么。
      composerWidth: normalizeComposerWidth(settings.general?.composerWidth),
      quickCommands: settings.general?.quickCommands ?? defaults.general.quickCommands,
      dailyNotes: {
        ...defaults.general.dailyNotes,
        ...settings.general?.dailyNotes,
      },
      todoPlan: {
        ...defaults.general.todoPlan,
        ...settings.general?.todoPlan,
      },
      editor: normalizeEditorSettings(settings.general?.editor),
    },
    chat: {
      ...defaults.chat,
      ...settings.chat,
      contextCompactEnabled: settings.chat?.contextCompactEnabled ?? DEFAULT_CHAT_SETTINGS.contextCompactEnabled,
      contextCompactThreshold: clampNumber(
        settings.chat?.contextCompactThreshold,
        50,
        100,
        DEFAULT_CHAT_SETTINGS.contextCompactThreshold ?? 85,
      ),
      contextCompactKeepRecentTurns: clampNumber(
        settings.chat?.contextCompactKeepRecentTurns,
        1,
        20,
        DEFAULT_CHAT_SETTINGS.contextCompactKeepRecentTurns ?? 6,
      ),
      contextCompactChunkTimeoutSeconds: clampNumber(
        settings.chat?.contextCompactChunkTimeoutSeconds,
        30,
        1800,
        DEFAULT_CHAT_SETTINGS.contextCompactChunkTimeoutSeconds ?? 300,
      ),
      agentLoopStream: true,
    },
    tools: {
      ...defaults.tools,
      ...settings.tools,
      toolCallModel: {
        ...defaults.tools.toolCallModel,
        ...settings.tools?.toolCallModel,
      },
      bash: {
        ...defaults.tools.bash,
        ...settings.tools?.bash,
      },
      // 显式归一而不是靠上面那次展开兜住:这份清单是**可写沙箱根**的来源,
      // 脏值的代价不是界面难看,而是权限面 —— 一个相对路径进了根列表,
      // `isCorePathContained` 会拿它当前缀去比对绝对路径,判定结果无从预期。
      connectedDirectories: normalizeConnectedDirectories(settings.tools?.connectedDirectories),
    },
    network: {
      ...defaults.network!,
      proxy: {
        ...defaults.network!.proxy,
        ...settings.network?.proxy,
      },
    },
    voice: normalizeVoiceSettings(settings.voice),
    music: normalizeMusicSettings(settings.music),
    channels: normalizeChannelSettings(settings.channels),
    mcp: settings.mcp,
    acp: normalizeACPSettings(settings.acp),
    skills: settings.skills,
    plugins: normalizePluginPreferences(settings.plugins),
    // 必须显式列出:`merged` 是白名单式重建,漏掉的键会被静默丢弃
    // (settings.json 里改了也不生效),而结尾的 `as AppSettings` 断言把这件事
    // 藏了起来。C0 审计当时记下 `storage` / `evals` 两个既有漏项;C1 补上
    // `storage` —— 迁移标记 `storage.providerConfigMigratedAt` 就住在那里,
    // 被吞掉的后果是**每次启动重跑一遍迁移**。顺带把 `storage.sessionFormat`
    // 这个一直是死的开关一起救活(见 settings.test.ts 的「白名单漏键审计」)。
    storage: settings.storage,
    evals: settings.evals,
    // 诊断模式:默认关。显式归一而不是直接透传 —— 白名单式重建漏掉的键会被
    // 静默丢弃,而这一格的"丢弃"意味着用户打开的诊断模式下次启动就没了。
    diagnostics: { enabled: settings.diagnostics?.enabled === true },
    // 与 diagnostics 同一条理由:白名单式重建漏掉的键会被静默丢弃,而这一格的
    // 「丢弃」意味着用户打开的语义召回下次启动就没了。
    search: {
      semantic: {
        enabled: settings.search?.semantic?.enabled === true,
        modelId: settings.search?.semantic?.modelId || DEFAULT_SEMANTIC_MODEL_ID,
      },
    },
    // 与 diagnostics / search 同一条理由(白名单式重建漏掉的键会被静默丢弃)。
    // 这一格被吞掉的后果更实在:用户开着的调试口下次启动会自己关回去,而他以为
    // 它还开着 —— chrome-mcp 连不上,报的却是一句「连接被拒绝」。
    // 端口夹进 1..65535:`0` 是随机口,开了等于没开(没人发现得了)。
    browser: {
      cdp: {
        enabled: settings.browser?.cdp?.enabled === true,
        port: normalizeCdpPort(settings.browser?.cdp?.port),
      },
      // 身份名册与缺省身份**一起归一**:两格互相约束(缺省必须指着名册里
      // 真有的那一行),分开归一必然出现「指着一个已删身份」的组合。
      ...normalizeBrowserProfiles(settings.browser?.profiles, settings.browser?.defaultProfile),
      searchEngine:
        typeof settings.browser?.searchEngine === 'string' && settings.browser.searchEngine
          ? settings.browser.searchEngine
          : DEFAULT_BROWSER_SEARCH_ENGINE,
    },
  }

  // 历史脏键 `localAddress`(剥在这里 + 剥在 `providers.json` 的写入归一里,
  // 两处都剥不算重复)。
  const ai = merged.ai as unknown as {
    providers?: Record<string, ProviderConfigWithLocalAddress | undefined>
    customProviders?: ProviderConfigWithLocalAddress[]
  }
  if (ai.providers) stripProviderLocalAddress(ai.providers as Record<string, ProviderConfig>)
  if (Array.isArray(ai.customProviders)) {
    for (const provider of ai.customProviders) {
      delete provider.localAddress
    }
  }

  return merged as unknown as AppSettings
}

/**
 * 接入目录清单的归一。挡住四种脏值:非数组、数组里的非字符串、空白串、重复项。
 *
 * **只收绝对路径**,判据与 `packages/backend/rpc/domains/skills.ts` 的
 * `validateSkillDirectoryPath` 同款。理由不是洁癖:这份清单会进
 * `getCoreSandboxRoots`,而 `isCorePathContained` 是纯前缀比对 —— 相对路径
 * 在那里既不会报错也不会匹配,只会变成一条永远不生效的授权,用户以为加上了。
 * 宁可在入口挡掉,也不要一条静默失效的权限。
 *
 * 目录**存在与否不在这里判**:盘可以后挂、目录可以后建,写settings的那一刻
 * 不存在不代表这条配置是错的。存在性是运行期的事(各接线点温和跳过)。
 */
export function normalizeConnectedDirectories(dirs?: string[]): string[] {
  if (!Array.isArray(dirs)) return []
  const cleaned = dirs
    .filter((dir): dir is string => typeof dir === 'string')
    .map(dir => dir.trim())
    .filter(dir => dir.length > 0 && (dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir)))
  return Array.from(new Set(cleaned))
}

/**
 * 静音名单要挡住三种脏值:非数组、数组里的非字符串、以及重复 id。
 * 名单是"谁被静音"的唯一账本,脏进去的代价是有人永远听不到某个插件的声音而
 * 界面上看不出原因。
 */
export function normalizePluginPreferences(settings?: Partial<PluginPreferences>): PluginPreferences {
  const muted = Array.isArray(settings?.notifySoundMutedPluginIds)
    ? settings.notifySoundMutedPluginIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : DEFAULT_PLUGIN_PREFERENCES.notifySoundMutedPluginIds
  // 氛围静音名单同规(G2):挡住非数组、数组里的非字符串、重复 id —— 名单是
  // "谁的氛围被关"的唯一账本,脏进去的代价是有人永远看不到某插件的氛围而
  // 界面上看不出原因(与提示音静音名单同一个道理,别再吃漏列白名单的坑)。
  const ambientMuted = Array.isArray(settings?.ambientMutedPluginIds)
    ? settings.ambientMutedPluginIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : DEFAULT_PLUGIN_PREFERENCES.ambientMutedPluginIds
  return {
    notifySoundsEnabled: settings?.notifySoundsEnabled !== false,
    notifySoundMutedPluginIds: Array.from(new Set(muted)),
    ambientEnabled: settings?.ambientEnabled !== false,
    ambientMutedPluginIds: Array.from(new Set(ambientMuted)),
  }
}

function normalizeChannelSettings(settings?: Partial<ChannelSettings>): ChannelSettings {
  return {
    wechat: {
      ...DEFAULT_CHANNEL_SETTINGS.wechat,
      ...settings?.wechat,
      enabled: settings?.wechat?.enabled ?? DEFAULT_CHANNEL_SETTINGS.wechat.enabled,
    },
  }
}

export function normalizeACPSettings(settings?: ACPSettings): ACPSettings {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_ACP_SETTINGS)) as ACPSettings
  const byId = new Map(defaults.agents.map(agent => [agent.id, agent]))

  for (const agent of settings?.agents ?? []) {
    if (!agent?.id) continue
    const defaultAgent = byId.get(agent.id)
    const normalizedAgent = migrateLegacyDefaultACPAgent({
      ...(defaultAgent ?? {}),
      ...agent,
      args: Array.isArray(agent.args) ? agent.args : defaultAgent?.args ?? [],
      env: agent.env && typeof agent.env === 'object' ? agent.env : defaultAgent?.env,
      enabled: agent.enabled !== false,
      permissionMode: agent.permissionMode === 'reject' ? 'reject' : 'allow',
    })
    byId.set(agent.id, normalizedAgent)
  }

  return {
    enabled: settings?.enabled !== false,
    agents: Array.from(byId.values()).filter(agent => Boolean(agent.id && agent.command)),
  }
}

function migrateLegacyDefaultACPAgent(agent: ACPSettings['agents'][number]): ACPSettings['agents'][number] {
  if (agent.id === 'claude-code' && agent.command === 'claude-code-acp') {
    return { ...agent, command: 'claude-agent-acp', args: [] }
  }

  if (agent.id === 'codex-cli' && agent.command === 'codex' && (agent.args ?? []).join(' ') === '--experimental-acp') {
    return { ...agent, command: 'codex-acp', args: [] }
  }

  if (agent.id === 'pi' && agent.command === 'pi' && (agent.args ?? []).join(' ') === '--acp') {
    return { ...agent, command: 'pi-acp', args: [] }
  }

  return agent
}

export function normalizeMusicSettings(settings?: MusicSettings): MusicSettings {
  const source: MusicRadioSource = settings?.source === 'daily' ? 'daily' : DEFAULT_MUSIC_SETTINGS.source
  return {
    ...DEFAULT_MUSIC_SETTINGS,
    ...settings,
    enabled: settings?.enabled === true,
    // Unknown ids are kept as-is; the runtime registry falls back to ncm at
    // resolution time, so a downgraded app never rewrites the user's choice.
    provider:
      typeof settings?.provider === 'string' && settings.provider
        ? settings.provider
        : DEFAULT_MUSIC_SETTINGS.provider,
    configured: settings?.configured === true,
    source,
    radioDj: {
      ...DEFAULT_MUSIC_SETTINGS.radioDj,
      ...settings?.radioDj,
    },
  }
}

export function normalizeVoiceSettings(settings?: VoiceSettings): VoiceSettings {
  return {
    ...DEFAULT_VOICE_SETTINGS,
    ...settings,
    wake: {
      ...DEFAULT_VOICE_SETTINGS.wake,
      ...settings?.wake,
      phrase: (settings?.wake?.phrase || DEFAULT_VOICE_SETTINGS.wake.phrase).trim(),
      sensitivity: ['low', 'medium', 'high'].includes(settings?.wake?.sensitivity as string)
        ? settings!.wake!.sensitivity
        : DEFAULT_VOICE_SETTINGS.wake.sensitivity,
    },
    conversation: {
      ...DEFAULT_VOICE_SETTINGS.conversation,
      ...settings?.conversation,
      defaultAgentId: (settings?.conversation?.defaultAgentId || DEFAULT_VOICE_SETTINGS.conversation.defaultAgentId).trim(),
      endpointing: ['fast', 'balanced', 'patient', 'custom'].includes(settings?.conversation?.endpointing as string)
        ? settings!.conversation!.endpointing
        : DEFAULT_VOICE_SETTINGS.conversation.endpointing,
      speakProtocol: 'speak-blocks',
    },
    vad: {
      ...DEFAULT_VOICE_SETTINGS.vad,
      ...settings?.vad,
      silenceMs: clampNumber(settings?.vad?.silenceMs, 300, 10000, DEFAULT_VOICE_SETTINGS.vad.silenceMs),
      maxRecordingMs: clampNumber(settings?.vad?.maxRecordingMs, 3000, 120000, DEFAULT_VOICE_SETTINGS.vad.maxRecordingMs),
      energyThreshold: clampNumber(settings?.vad?.energyThreshold, 0.001, 0.25, DEFAULT_VOICE_SETTINGS.vad.energyThreshold),
    },
    asr: {
      ...DEFAULT_VOICE_SETTINGS.asr,
      ...settings?.asr,
      openai: {
        ...DEFAULT_VOICE_SETTINGS.asr.openai,
        ...settings?.asr?.openai,
      },
      openrouter: {
        ...DEFAULT_VOICE_SETTINGS.asr.openrouter,
        ...settings?.asr?.openrouter,
      },
      funasr: {
        ...DEFAULT_VOICE_SETTINGS.asr.funasr,
        ...settings?.asr?.funasr,
      },
    },
    tts: {
      ...DEFAULT_VOICE_SETTINGS.tts,
      ...settings?.tts,
      system: {
        ...DEFAULT_VOICE_SETTINGS.tts.system,
        ...settings?.tts?.system,
        rate: clampNumber(settings?.tts?.system?.rate, 0.5, 2, DEFAULT_VOICE_SETTINGS.tts.system.rate),
        pitch: clampNumber(settings?.tts?.system?.pitch, 0, 2, DEFAULT_VOICE_SETTINGS.tts.system.pitch),
      },
      openrouter: {
        ...DEFAULT_VOICE_SETTINGS.tts.openrouter,
        ...settings?.tts?.openrouter,
      },
      openai: {
        ...DEFAULT_VOICE_SETTINGS.tts.openai,
        ...settings?.tts?.openai,
      },
      qwen: {
        ...DEFAULT_VOICE_SETTINGS.tts.qwen,
        ...settings?.tts?.qwen,
      },
    },
    doubao: {
      ...DEFAULT_VOICE_SETTINGS.doubao,
      ...settings?.doubao,
      asrResourceId: (settings?.doubao?.asrResourceId || DEFAULT_VOICE_SETTINGS.doubao.asrResourceId || '').trim(),
      // seed-tts-2.0 was an earlier default that mismatches the built-in
      // mars/moon voices; migrate it to the 大模型语音合成 resource.
      ttsResourceId: ((settings?.doubao?.ttsResourceId === 'seed-tts-2.0' ? '' : settings?.doubao?.ttsResourceId)
        || DEFAULT_VOICE_SETTINGS.doubao.ttsResourceId || '').trim(),
      endpoint: (settings?.doubao?.endpoint || DEFAULT_VOICE_SETTINGS.doubao.endpoint || '').trim().replace(/\/$/, ''),
      endWindowMs: clampNumber(settings?.doubao?.endWindowMs, 200, 5000, DEFAULT_VOICE_SETTINGS.doubao.endWindowMs!),
      twoPass: settings?.doubao?.twoPass !== false,
      speaker: (settings?.doubao?.speaker || DEFAULT_VOICE_SETTINGS.doubao.speaker || '').trim(),
      format: ['mp3', 'ogg_opus', 'pcm'].includes(settings?.doubao?.format as string)
        ? settings!.doubao!.format
        : DEFAULT_VOICE_SETTINGS.doubao.format,
    },
  }
}

export function normalizeEditorSettings(settings?: EditorSettings): Required<EditorSettings> {
  return {
    tabSize: clampNumber(settings?.tabSize, 1, 8, DEFAULT_EDITOR_SETTINGS.tabSize),
    lineWrapping: settings?.lineWrapping ?? DEFAULT_EDITOR_SETTINGS.lineWrapping,
    softWrapColumn: clampNumber(
      settings?.softWrapColumn,
      40,
      200,
      DEFAULT_EDITOR_SETTINGS.softWrapColumn,
    ),
    syntaxHighlighting: settings?.syntaxHighlighting ?? DEFAULT_EDITOR_SETTINGS.syntaxHighlighting,
    completionEnabled: settings?.completionEnabled ?? DEFAULT_EDITOR_SETTINGS.completionEnabled,
    composerMaxHeight: clampNumber(
      settings?.composerMaxHeight,
      80,
      640,
      DEFAULT_EDITOR_SETTINGS.composerMaxHeight,
    ),
    markdownNoteAttachmentDirectory: settings?.markdownNoteAttachmentDirectory ?? DEFAULT_EDITOR_SETTINGS.markdownNoteAttachmentDirectory,
    markdownProjectAttachmentDirectory: settings?.markdownProjectAttachmentDirectory ?? DEFAULT_EDITOR_SETTINGS.markdownProjectAttachmentDirectory,
  }
}

function clampNumber(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * CDP 端口的归一。**不合法就回缺省,不夹** —— 与别处那些 `clampNumber` 有意不同:
 * 夹一个端口是没有意义的(`0` 夹成 `1` 会开在一个特权口上,`70000` 夹成 `65535`
 * 开在一个谁也没打算用的口上)。端口不是一根滑杆上的量,它是一个地址:说不出
 * 合法地址的时候,唯一诚实的答案是「用缺省那个」。
 *
 * `0`(Chromium 的随机口)明确不收:随机口没人发现得了,等于开了个谁都用不上的洞
 * —— 与 `electron/browser/cdp-flag.ts` 读侧那条判据逐字同一把尺子。
 */
/**
 * 出厂搜索引擎的 id。**字符串而不是联合类型**:可选那几家住在壳里
 * (`apps/desktop-react/src/browser/omnibox.ts` 的 `BROWSER_SEARCH_ENGINES`),
 * 而 `@shared` 不该认识壳。壳那一侧 `resolveBrowserSearchEngine` 对认不出的 id
 * 自己回落,所以这里只负责「有一个非空串」。
 */
const DEFAULT_BROWSER_SEARCH_ENGINE = 'google'

/**
 * 身份名册的归一(B3-b)。**三条硬保证**,每一条都对着一种真会发生的坏账本:
 *
 *  ① **至少一行** —— 删到空(或整格缺席 / 不是数组)就回出厂那一行。空名册的
 *     后果是每一格 tab 指着一个名册上没有的身份,设置页画不出、删不掉。
 *  ② **id 去重、去空、去非法字符** —— id 直接拼进分区名 `persist:browser-<id>`,
 *     一个斜杠或一个引号就是一个奇怪的分区(Chromium 不会报错,它会老老实实
 *     给你一个新分区,而用户以为自己还登着)。只收 `[A-Za-z0-9_-]`。
 *  ③ **缺省身份必须在名册里** —— 指着一个已删的身份 = 每开一格 tab 都落进一个
 *     现建的空分区。不在就回第一行。
 *
 * 名字不归一(除了截断):那是人写的字,壳不替他改。
 */
function normalizeBrowserProfiles(
  rawProfiles: unknown,
  rawDefault: unknown
): { profiles: BrowserProfile[]; defaultProfile: string } {
  const seen = new Set<string>()
  const profiles: BrowserProfile[] = []
  for (const entry of Array.isArray(rawProfiles) ? rawProfiles : []) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { id?: unknown; name?: unknown }
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id)) continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    profiles.push({
      id: row.id,
      name: typeof row.name === 'string' ? row.name.slice(0, 64) : '',
    })
  }
  if (profiles.length === 0) {
    profiles.push({ id: DEFAULT_BROWSER_PROFILE_ID, name: '' })
  }
  const wanted = typeof rawDefault === 'string' ? rawDefault : ''
  const defaultProfile = profiles.some(profile => profile.id === wanted)
    ? wanted
    : profiles[0]!.id
  return { profiles, defaultProfile }
}

function normalizeCdpPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_BROWSER_CDP_PORT
  if (value < 1 || value > 65535) return DEFAULT_BROWSER_CDP_PORT
  return value
}

function clampFraction(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function normalizeTypographyDensity(
  value: GeneralSettings['typographyDensity'] | string | null | undefined
): GeneralSettings['typographyDensity'] {
  return value === 'comfortable' ? 'comfortable' : DEFAULT_GENERAL_SETTINGS.typographyDensity
}

/** 输入区宽度档位:非法/缺失一律回落缺省档(= 现状),不抛错。 */
const COMPOSER_WIDTHS: ReadonlyArray<NonNullable<GeneralSettings['composerWidth']>> = [
  'narrow', 'standard', 'wide', 'full',
]

export function normalizeComposerWidth(
  value: GeneralSettings['composerWidth'] | string | null | undefined
): GeneralSettings['composerWidth'] {
  return COMPOSER_WIDTHS.includes(value as NonNullable<GeneralSettings['composerWidth']>)
    ? (value as GeneralSettings['composerWidth'])
    : DEFAULT_GENERAL_SETTINGS.composerWidth
}

function stripProviderLocalAddress(providers: Record<string, ProviderConfig>): void {
  for (const config of Object.values(providers)) {
    delete (config as ProviderConfigWithLocalAddress).localAddress
  }
}
