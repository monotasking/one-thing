/**
 * plugin-contract —— 插件与宿主约定的词汇(D202 新立,层次 L2):作用域 / 表面 / 严重度策略、超时与熔断阈值、
 * 运行期守卫与健康账、面板与界面锚点的描述树、文件导入 / 请求通道 / 背景层 / 网页面板的声明,
 * 以及凭证策略与检索供给方两张登记契约。
 *
 * 为什么单立一个功能:凭证、检索、深链三张登记表是「插件在别的功能里的落脚点」—— 插件写表、功能读表,
 * 登记表住在读表的功能里是对的;它们要的是这套**词汇**,而词汇从前住在插件功能里、经一只 740 行的桶
 * (`plugin/plugin-contract.ts`,已拆)交出,那只桶还顺手再导出了插件系统的实现,三张表一引就成环。
 * 词汇下沉成本功能之后方向是单向的:插件引它,三张登记表引它,它不引插件。
 *
 * 健康账(`plugin-contract-health.ts`)带进程态与宿主端口,所以本功能是 L2 而不是 L1。
 * 依赖:logging 的入口(健康账打日志);别的功能一个不引。
 */

// 作用域与表面、严重度策略表、熔断阈值与探测间隔。
export {
  classifyPluginScope,
  describePluginSurface,
  PLUGIN_INPUT_INTERCEPT_SURFACE,
  PLUGIN_REGISTRY_POLICY,
  PLUGIN_TOOL_CALL_INTERCEPT_SURFACE,
  PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE,
  pluginResourceSurface,
  pluginScope,
  resolvePluginScopeSeverity,
} from './plugin-contract-policy.js'
export type { PluginFailureScope } from './plugin-contract-policy.js'

// 运行期守卫的常量。
export { CORE_PLUGIN_FAILURE_THRESHOLD } from './plugin-contract-runtime-guard-constants.js'

// 运行期守卫:超时预算、结果规范化、健康账的内核。
export {
  CORE_PLUGIN_ENTRY_TIMEOUT_MS,
  CORE_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS,
  CORE_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS,
  CORE_PLUGIN_REQUEST_TIMEOUT_MS,
  CORE_PLUGIN_SETTINGS_HOOK_TIMEOUT_MS,
  CorePluginHealthTracker,
  CorePluginTimeoutError,
  isCorePluginTimeoutError,
  runWithPluginTimeout,
} from './plugin-contract-runtime-guard.js'
export type { CorePluginRuntimeHealth } from './plugin-contract-runtime-guard.js'

// 健康账的进程落点(失败计数熔断、降级探测、宿主端口)。
export {
  clearPluginRuntimeHealth,
  configurePluginHealthHost,
  describePluginSurfaceDegradation,
  getPluginRuntimeHealth,
  isPluginSurfaceDegraded,
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
  resetPluginRuntimeHealthForTests,
  restorePluginRuntimeHealth,
} from './plugin-contract-health.js'
export type { PersistedPluginHealth } from './plugin-contract-health.js'

// 插件的规范顺序(冲突时谁赢)。
export { comparePluginCanonicalOrder, sortByPluginCanonicalOrder } from './plugin-contract-canonical-order.js'

// 工作区面板的描述树。
export {
  describePluginPanelResultProblem,
  isReservedPluginPanelAction,
  MAX_PANEL_DEPTH,
  PANEL_MIN_REFRESH_INTERVAL_MS,
  PLUGIN_PANEL_INIT_ACTION,
  PLUGIN_PANEL_INVOKE_ACTION,
  PLUGIN_PANEL_PROTOCOL_VERSION,
  PLUGIN_PANEL_RENDER_ACTION,
  validatePluginPanelTree,
} from './plugin-contract-panel.js'
export type {
  CorePluginPanelContext,
  CorePluginPanelRegistration,
  PluginPanelNode,
  PluginPanelTree,
} from './plugin-contract-panel.js'

// 界面锚点表与槽位描述。
export {
  assertUiAnchorRegistryConsistency,
  forgetUiActionGestures,
  hasFreshUiActionGesture,
  isEffectiveUiDrawerSlot,
  isIgnoredUiDrawerDeclaration,
  isIgnoredUiSlotSideDeclaration,
  isReservedPluginUiAction,
  isTriggerUiAnchor,
  isUiAnchor,
  isUiDrawerRenderState,
  isUiSlotSide,
  noteUiActionGesture,
  PLUGIN_LAYOUT_GESTURE_WINDOW_MS,
  PLUGIN_UI_INVOKE_ACTION,
  PLUGIN_UI_RENDER_ACTION,
  resolveUiSlotSide,
  supportsUiDrawer,
  supportsUiSlotSide,
  UI_ANCHOR_CAPACITY,
  UI_ANCHORS,
  UI_SLOT_DEFAULT_SIDE,
  uiAnchorKind,
  uiDrawerExpandedMaxHeight,
  uiSlotAddress,
  uiSlotMaxWidth,
  uiSlotSurfaceId,
} from './plugin-contract-ui-anchor.js'
export type {
  CorePluginUiSlotContext,
  CorePluginUiSlotRegistration,
  PluginLayoutResult,
  PluginLayoutVerb,
  UiAnchor,
} from './plugin-contract-ui-anchor.js'

// 文件导入的声明与校验。
export {
  clampPluginFilePickMaxBytes,
  describePluginDirectoryPickDeclarationProblem,
  describePluginFileImportDeclarationProblem,
  describePluginFileImportProblem,
  nextAvailablePluginImportFileName,
  PLUGIN_FILE_PICK_EXTENSIONS,
  PLUGIN_FILE_PICK_MAX_BYTES,
  PLUGIN_IMPORTS_DIR_NAME,
  PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT,
  PLUGIN_SETTINGS_FILE_IMPORT_FORMAT,
  resolvePluginFilePickAccept,
  sanitizePluginImportFileName,
} from './plugin-contract-file-pick.js'
export type { PluginFilePickResult } from './plugin-contract-file-pick.js'

// 统一请求通道。
export {
  assertPluginPayloadSerializable,
  CorePluginRequestRegistry,
  describeNonSerializable,
  normalizePluginRequestAction,
  PLUGIN_REQUEST_ABORTED_ERROR,
  pluginRequestErrorMessage,
} from './plugin-contract-request-channel.js'
export type {
  CorePluginRequestContext,
  CorePluginRequestHandler,
  CorePluginRequestInput,
  CorePluginRequestResult,
} from './plugin-contract-request-channel.js'

// 背景层的声明。
export {
  clampPluginBackgroundParamsPatch,
  describePluginBackgroundProblem,
  describePluginRuntimeBackgroundImageProblem,
  parsePluginStorageImageRef,
  PLUGIN_STORAGE_IMAGE_PREFIX,
  resolvePluginBackgrounds,
} from './plugin-contract-background.js'
export type {
  PluginBackgroundDescriptor,
  PluginBackgroundEntry,
  PluginBackgroundInput,
  PluginBackgroundParamsPatch,
} from './plugin-contract-background.js'

// 网页面板的资源路径判据。
export {
  describePluginRelativeAssetPathProblem,
  describePluginWebviewPanelProblem,
  isPluginWebviewPanel,
  pluginWebviewEntryUrl,
  resolvePluginWebviewRoot,
} from './plugin-contract-webview.js'

// 凭证策略的登记契约。
export {
  isPluginCredentialChoiceValid,
  PLUGIN_CREDENTIAL_ENTRY_FIELDS,
  PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN,
  PLUGIN_CREDENTIAL_STRATEGY_PERMISSION_NOTE,
  PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS,
  PLUGIN_PERMISSION_CREDENTIAL_STRATEGY,
  pluginCredentialStrategyPolicy,
  pluginCredentialStrategySurface,
  toPluginCredentialEntryView,
} from './plugin-contract-credential-strategy.js'
export type {
  CorePluginCredentialStrategyContext,
  CorePluginCredentialStrategyRegistration,
  PluginCredentialEntryView,
  PluginCredentialFailureKind,
  PluginCredentialUsage,
} from './plugin-contract-credential-strategy.js'

// 检索供给方的登记契约。
export {
  PLUGIN_PERMISSION_SEARCH_PROVIDE,
  PLUGIN_SEARCH_PROVIDER_RESULT_CAP,
  PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS,
  pluginSearchProviderSurface,
  sanitizePluginSearchResults,
} from './plugin-contract-search-provider.js'
export type { CorePluginSearchActionContext, CorePluginSearchProviderRegistration } from './plugin-contract-search-provider.js'
