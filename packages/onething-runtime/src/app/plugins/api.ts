/**
 * Plugin API — main-process host adapter for the headless core API builder.
 */

import { Tool } from '../tools/core/tool.js'
import type { ToolMetadata } from '../tools/core/tool.js'
import {
  registerTool as registerToolInRegistry,
  unregisterTool as unregisterToolInRegistry,
} from '../tools/index.js'
// R3b:插件工具进目录(见 host.registerTool / disposePlugin 两处的注释)。
import { isToolkitEnabled } from '@onething/runtime/toolkit/flag'
import {
  registerPluginToolInCatalog,
  unregisterPluginToolFromCatalog,
} from '../toolkit/plugin-tools.js'
import type { EventBus } from '../events/event-bus.js'
import type { StreamEngine } from '../engine/stream-engine.js'
import { z } from 'zod'
import { PluginStore, createPluginFiles, createPluginMessageState, createPluginStorage } from './store.js'
import {
  getDeclaredBackground,
  getDeclaredPanelIds,
  getDeclaredPermissions,
  getDeclaredUiSlots,
  getDeclaredWebviewPanelIds,
  isLocalPlugin,
} from './loader.js'
import { createPluginSessionHostPorts } from './sessions.js'
import { pluginLlmComplete } from './llm.js'
import { forgetPluginNotifySoundThrottle, resolvePluginNotifySound } from './notify-sound.js'
import { clearPluginBackgroundParams, setPluginBackgroundParams } from './background.js'
import { pluginStorageImageExists } from './file-import.js'
import { registerIMConnector } from '../channel/connector-registry.js'
import { registerPluginDeepLinkAction } from '../deeplink/registry.js'
import { registerPluginSearchProvider } from '../search/plugin-search-registry.js'
import { registerPluginCredentialStrategy } from '../providers/credential-strategy.js'
import {
  forgetUiActionGestures,
  PLUGIN_FILES_QUOTA_WARNING_EVENT,
  PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT,
} from '@onething/core/plugins'
import type { PluginContributionUiSlot, PluginFailureScope } from '@onething/core/plugins'
import type { IMConnector } from '@shared/ipc.js'
import {
  emitPluginStatusPart,
  getPluginStatusRegistry,
  notePluginStatusPending,
  sweepPluginStatusForPlugin,
} from './status.js'
import {
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './health.js'
import {
  getEffectivePluginConfig,
  getPluginExternalRoot,
  subscribePluginConfigChange,
} from './config.js'
import {
  registerPluginSkillRootProvider,
  type PluginSkillRootProvider,
} from '../skills/plugin-roots.js'
import { registerPromptContextProvider } from '../engine/prompt/plugin-context.js'
import {
  registerAfterAssistantResponseHook,
  registerBeforeContextCompactHook,
} from './lifecycle.js'
import { registerPluginInputInterceptHook } from './input-intercept.js'
import { registerPluginToolCallInterceptHook } from './tool-call-intercept.js'
import { registerPluginToolResultInterceptHook } from './tool-result-intercept.js'
import { getScheduler } from '../scheduler/index.js'
import type {
  AfterAssistantResponseHook,
  BeforeContextCompactHook,
  PluginAPI,
  PluginCommandDefinition,
  PluginEventHandler,
  PluginPromptContextProvider,
  PluginSchedulerAPI,
  PluginToolDefinition,
} from './types.js'
import { LOCAL_PLUGIN_API_KEYS } from './types.js'
import {
  createCorePluginAPI,
  createScopedPluginScheduler,
  disposeCorePluginState,
  executeCorePluginTool,
  type CorePluginAPIState,
} from '@onething/core/plugins'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

export interface PluginState extends CorePluginAPIState<PluginAPI, PluginCommandDefinition> {}

/**
 * 走全局总线(EventBus.emitGlobal / onGlobal)的事件名单。
 *
 * 与 `packages/shared/events/global-events.ts` 的 GlobalEvent 联合一一对应 ——
 * 那边加一个成员,这里就要加一个,否则插件订阅它会被静默挂到会话面上。
 * 插件自定义事件(`plugin:<id>:<name>`)按前缀归入同一面。
 */
export const GLOBAL_PLUGIN_EVENT_TYPES = new Set([
  'app:initialized',
  'app:quitting',
  'settings:changed',
  'session:created',
  'session:switched',
  'session:deleted',
  'mcp:server-connected',
  'mcp:server-disconnected',
  'mcp:server-error',
  'plugin:loaded',
  'plugin:error',
  'plugin:notification',
])

/** 插件自定义事件:`plugin:<pluginId>:<name>`,三段以上。 */
const CUSTOM_PLUGIN_EVENT = /^plugin:[^:]+:.+$/

export function isGlobalPluginEventType(eventType: string): boolean {
  return GLOBAL_PLUGIN_EVENT_TYPES.has(eventType) || CUSTOM_PLUGIN_EVENT.test(eventType)
}

/** 会话事件都带冒号命名空间;不符合的多半是拼错了,值得吼一声。 */
const KNOWN_SESSION_EVENT_HINT = /^[a-z][\w-]*:[\w:-]+$/i

/**
 * 面板刷新的合流窗口(毫秒)。
 *
 * 取值只需要盖住"一次批量操作里的连续 refresh",不需要盖住用户的两次点击 ——
 * 200ms 之外的两次刷新,用户会觉得那是两件事。
 */
const PANEL_REFRESH_DEDUPE_MS = 200

interface PanelRefreshWindow {
  timer: ReturnType<typeof setTimeout>
  /** 窗口期内是否又来过 —— 决定窗口关闭时要不要补发。 */
  pending: boolean
}
const panelRefreshWindows = new Map<string, PanelRefreshWindow>()

/**
 * 合并式去重(leading + trailing),不是单纯的 leading-edge 丢弃。
 *
 * 只丢弃的话,"连发 N 条,最后一条落在窗口内"会把**最后一条**丢掉 —— 而最后
 * 一条恰恰对应最终状态。之前这个洞被 renderer 的 trailing debounce 掩盖着,
 * 但那是另一层的巧合:换一个消费者(或 renderer 改了策略)就会漏刷新。
 * 现在窗口关闭时若期间有过调用,补发一条。
 */
/**
 * 拆除一个插件时取消它还没到点的补发。
 *
 * 不取消的话,已经被停用的插件仍会在 200ms 后广播一次 panel-refresh ——
 * 一个已经不存在的面板要求重画自己。
 */
function cancelPanelRefreshWindows(pluginId: string): void {
  const prefix = `${pluginId}::`
  for (const [key, window] of [...panelRefreshWindows]) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(window.timer)
    panelRefreshWindows.delete(key)
  }
}

function requestPanelRefresh(pluginId: string, panelId: string, emit: () => void): void {
  const key = `${pluginId}::${panelId}`
  const window = panelRefreshWindows.get(key)
  if (window) {
    window.pending = true
    return
  }
  emit()
  const timer = setTimeout(() => {
    const current = panelRefreshWindows.get(key)
    panelRefreshWindows.delete(key)
    if (current?.pending) requestPanelRefresh(pluginId, panelId, emit)
  }, PANEL_REFRESH_DEDUPE_MS)
  // 这个定时器不该拖住进程退出。
  ;(timer as unknown as { unref?: () => void }).unref?.()
  panelRefreshWindows.set(key, { timer, pending: false })
}

export interface CreatePluginAPIOptions {
  /**
   * manifest contributes.panels 里声明过的面板 id(R5)。
   * 不传就现查清单 —— 清单本来就是唯一权威,这个参数只为注入/测试留着。
   */
  declaredPanelIds?: string[]
  /** 其中的 webview 面板(C 期);同上,参数只为注入/测试留着。 */
  declaredWebviewPanelIds?: string[]
  /** manifest contributes.uiSlots 里声明过的锚点块(R5.x);同上,参数只为注入/测试留着。 */
  declaredUiSlots?: PluginContributionUiSlot[]
  /** manifest 声明了合法背景(G 期,L2.5);同上,参数只为注入/测试留着。 */
  declaredBackground?: boolean
  /** manifest contributes.permissions 原文(N1);同上,参数只为注入/测试留着。 */
  declaredPermissions?: string[]
}

/**
 * 轻通道:把完整 api 物理收窄成 `LocalPluginAPI`。
 *
 * 只保留 `LOCAL_PLUGIN_API_KEYS` 里的键,其余(sessions / llm / 面板 / 拦截钩子 …)
 * **物理不挂** —— 本地脚本调它们得到的是 `undefined`,而不是一个会抛错的桩。函数
 * 绑回原 api(保住闭包/this),子对象(ui/events/storage/store/scheduler)按引用透传。
 *
 * 注意:只收窄**交给插件 entry 的那个 api**;`state.api` 仍是完整对象,宿主侧的
 * dispose / 状态清扫照常读它(它是被信任的一侧)。
 */
export function narrowApiForLocalPlugin(api: PluginAPI): PluginAPI {
  const narrowed: Record<string, unknown> = {}
  const source = api as unknown as Record<string, unknown>
  for (const key of LOCAL_PLUGIN_API_KEYS) {
    const value = source[key]
    narrowed[key] = typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(api)
      : value
  }
  return narrowed as unknown as PluginAPI
}

export function createPluginAPI(
  pluginId: string,
  eventBus: EventBus,
  streamEngine: StreamEngine,
  options?: CreatePluginAPIOptions,
): { api: PluginAPI; state: PluginState } {
  // stateRef 后填(createCorePluginAPI 的返回值才有 state),而 store 只在调用时
  // 读它 —— 所以先建 store、后接 state 是安全的。
  const stateRef: { current: PluginState | null } = { current: null }
  const store = new PluginStore(pluginId, {
    isDisposing: () => Boolean(stateRef.current?.disposing),
  })
  const schedulerDisposeCallbacks: Array<() => void> = []
  // KV 的拆除闩:晚到的 store.set 会 ensureDir 把刚归档的目录复活成鬼目录。
  //
  //
  // **它不进回调队列。** 那个数组同时是 onDispose 的队列,而插件的 onDispose 是
  // 在 entry(api) 里注册的 —— 比这里晚得多,所以无论把 closeStore push 在哪儿,
  // FIFO 下它都排在插件回调**前面**。上一轮"挪到函数末尾"没有改变这一点。
  // 正确的做法是让它根本不参与排队:拆除流程 drain 完回调之后再显式关。
  const closeStore = () => store.dispose()
  // §7.4 拆除闩(storage 侧):与 KV 同一个时机哲学 —— onDispose 里的
  // api.storage.writeJson 是自然的收尾写法,不能提前闩;闩在拆除流程
  // drain 完回调之后才落下(见 storeClosers 的注册)。
  const storageGate = { demolished: false }
  const closeStorage = () => { storageGate.demolished = true }
  // 消息态(plugin-message-state-2026-08):lifetime 闸门 —— manifest 的
  // contributes.uiSlots 任一项声明 'persistent' 才落盘;否则纯内存。
  const messageState = createPluginMessageState(pluginId, {
    persistent: (options?.declaredUiSlots ?? getDeclaredUiSlots(pluginId))
      .some(slot => slot.lifetime === 'persistent'),
    isDisposed: () => storageGate.demolished,
  })
  // F1 受管文件树。三条宿主线:
  //  - 声明门:`storage:external-root` 在不在 manifest 里(不在 = 外部根一律拒);
  //  - 外部根:每次调用现取(用户随时可能在设置里改那个目录);
  //  - 预警:越过 9 成配额发一条**插件自己命名空间**的事件,插件用
  //    `api.on('plugin:<id>:storage:quota-warning')` 订阅。发在自己的命名空间里,
  //    是因为配额是每插件的事实 —— 全局事件会让每个插件都收到别人的水位。
  const declaredPermissionList = options?.declaredPermissions ?? getDeclaredPermissions(pluginId)
  const files = createPluginFiles(pluginId, {
    externalRootDeclared: declaredPermissionList.includes(PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT),
    resolveExternalRoot: () => getPluginExternalRoot(pluginId),
    isDisposed: () => storageGate.demolished,
    onQuotaWarning(usage) {
      eventBus.emitGlobal({
        type: `plugin:${pluginId}:${PLUGIN_FILES_QUOTA_WARNING_EVENT}`,
        pluginId,
        name: PLUGIN_FILES_QUOTA_WARNING_EVENT,
        payload: usage,
      } as any)
    },
  })
  // 拆除闸要能被 scheduler 看到,而 state 是 createCorePluginAPI 的返回值 ——
  // 用一个后填的引用把两者接上(register 只在调用时读它)。
  const pluginScheduler = createScopedPluginScheduler({
    pluginId,
    scheduler: getScheduler(),
    disposeCallbacks: schedulerDisposeCallbacks,
    isDisposed: () => Boolean(stateRef.current?.disposed),
  }) as PluginSchedulerAPI

  const result = createCorePluginAPI<
    PluginAPI,
    PluginToolDefinition<z.ZodType, ToolMetadata>,
    PluginEventHandler,
    PluginCommandDefinition,
    Omit<PluginCommandDefinition, 'name'>,
    PluginPromptContextProvider,
    BeforeContextCompactHook,
    AfterAssistantResponseHook,
    PluginSkillRootProvider,
    PluginStore,
    PluginSchedulerAPI
  >({
    pluginId,
    store,
    // §7.4 拆除闩:卸载后晚到的 storage 写(合流定时器/在飞回调)不重建
    // 刚归档的家目录。闩的时机与 KV 相同 —— 拆除 drain 完之后才落下。
    storage: createPluginStorage(pluginId, {
      isDisposed: () => storageGate.demolished,
    }),
    // 消息态见上方 messageState 工厂(lifetime 闸门)。
    messageState,
    // F1 受管文件树(见上方 files 工厂)。
    files,
    // 声明先于代码:面板注册要跟 manifest 对得上,清单是权威。
    declaredPanelIds: options?.declaredPanelIds ?? getDeclaredPanelIds(pluginId),
    // C 期:webview 面板的 render 挂 `panel:init:<id>`(返回初始化数据而不是树)。
    declaredWebviewPanelIds: options?.declaredWebviewPanelIds ?? getDeclaredWebviewPanelIds(pluginId),
    declaredUiSlots: options?.declaredUiSlots ?? getDeclaredUiSlots(pluginId),
    // G 期:api.theme.updateBackground 的门控 —— 没在 manifest 里声明背景就调不动。
    declaredBackground: options?.declaredBackground ?? getDeclaredBackground(pluginId),
    // N1:api.sendMessage / api.sessions.* / api.isIdle 的门控 —— 同一条
    // "声明先于代码",装前确认页把这几条权限逐条念给用户听。
    declaredPermissions: declaredPermissionList,
    // 全进程一本账(R6):清扫按会话进行,每插件一本就扫不干净。
    statusRegistry: getPluginStatusRegistry(),
    scheduler: pluginScheduler,
    disposeCallbacks: schedulerDisposeCallbacks,
    onPluginFailure({ pluginId: id, scope, error }: { pluginId: string; scope: PluginFailureScope; error: unknown }) {
      reportPluginRuntimeFailure(id, scope, error)
    },
    onPluginSuccess({ pluginId: id, scope }: { pluginId: string; scope: PluginFailureScope }) {
      reportPluginRuntimeSuccess(id, scope)
    },
    host: {
      registerTool(_, toolId, tool) {
        /*
         * **插件不能给自己发免检通行证。**
         *
         * `permissionGuard: 'safe'` 落在 CORE_AUTO_EXECUTE 集里 —— 声明它的工具
         * 不弹权限提示、直接执行。上一版把它交给插件自己填(`?? 'permission-gated'`
         * 只是缺省),于是任何插件写一行就绕过了整套权限系统,而 manifest 的
         * `contributes.permissions` 纯装饰、不参与任何判定。示例插件正在教这个写法。
         *
         * 现在插件注册的工具**一律 permission-gated**:要不要执行由用户在提示里
         * 决定。等 manifest 的 permissions 真正参与判定(H 线一起做)之后,
         * 再考虑按声明降级。
         */
        if (tool.permissionGuard && tool.permissionGuard !== 'permission-gated') {
          console.warn(
            `[Plugin] Tool "${tool.name}" asked for permissionGuard "${tool.permissionGuard}"; `
            + 'plugin tools are always permission-gated. Declare capabilities in '
            + 'contributes.permissions instead.',
          )
        }
        registerToolInRegistry(
          Tool.define(toolId, {
            name: tool.name,
            description: tool.description,
            category: 'custom',
            parameters: tool.parameters,
            permissionGuard: 'permission-gated',
            /*
             * N3:并发声明原样透传。core 的注册闸已经保证它只可能是
             * 'parallel' / 'sequential' / undefined,所以这里不再兜一层 ——
             * 归一化有两处就迟早不一致。缺省(undefined)= 屏障 = 插件工具
             * 今天的行为,一字不改。真正读它的只有一处:agent-loop runner
             * 的 `executionMode !== 'parallel'` 判据。
             */
            executionMode: tool.executionMode,
            // 工具自带的提示词原样透传:core 注册闸已经校验过形状。它随工具面
            // 进出 —— 插件禁用/卸载时工具注销,段落随之消失,不另记账。
            prompt: tool.prompt,
            async execute(args: unknown, ctx: any) {
              return executeCorePluginTool(tool, args as any, {
                sessionId: ctx.sessionId,
                messageId: ctx.messageId,
                toolCallId: ctx.toolCallId,
                // F4:身份透传。ctx.agentId 由回合入口一次解析后一路带下来
                // (stream-runtime → direct-tool-execution → 这里),插件不必
                // 也不该自己反查 session.agentId。
                agentId: ctx.agentId,
                workingDirectory: ctx.workingDirectory,
                abortSignal: ctx.abortSignal,
                metadata(input: { title?: string; metadata?: Partial<ToolMetadata> }) {
                  ctx.metadata?.(input)
                },
              })
            },
          }),
        )
        /*
         * R3b:同一个定义**同时**进新树目录(设计文档 §14.5 第 1 条)。
         *
         * 旧路那一段一个字不改 —— 开关关时这一句不执行,开关开时两边都注册:
         * 目录答"谁来跑它"(`runToolkitToolDirectly`),旧 registry 仍然答着那些
         * 还没改口的读点。R4 删旧树时删的是上面那一段,不是这一句。
         *
         * `permissionGuard: 'permission-gated'` 那句话在新树里由 `plugin_exec`
         * 这条效果说出来(§13.3),所以这里不必再传一次。
         */
        if (isToolkitEnabled()) {
          registerPluginToolInCatalog({
            toolId,
            definition: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
              ...(tool.prompt ? { prompt: tool.prompt } : {}),
            },
            execute: (args, hostContext) => executeCorePluginTool(tool, args as any, hostContext as any),
          })
        }
      },
      subscribeEvent(id, eventType, handler) {
        // 会话事件走 per-session 环形缓冲,全局事件走 globalHandlers —— 两条投递面
        // 不同,订阅口必须分流,否则订阅了却永远收不到东西,而且零告警。
        //
        // 判据是**显式的全局事件名单**,不是 startsWith('plugin:'):按前缀分的话,
        // 插件订阅 settings:changed / session:created / mcp:server-* 这些真·全局
        // 事件会被误挂到会话面上,同样永远收不到。
        if (isGlobalPluginEventType(eventType)) {
          return eventBus.onGlobal(eventType as any, handler as any)
        }
        if (!KNOWN_SESSION_EVENT_HINT.test(eventType)) {
          console.warn(
            `[Plugin:${id}] Subscribing to unrecognized event "${eventType}"; `
            + 'treating it as a session event. Global events must be listed in GLOBAL_PLUGIN_EVENT_TYPES.',
          )
        }
        return eventBus.onAnySession(
          eventType as any,
          handler as any,
          `Plugin:${id}`,
        )
      },
      emitPanelRefresh(id, panelId) {
        // 短窗合流:插件在一次文件扫描里对每个变化的文件调一次 refresh 是完全
        // 合理的写法,但那是 N 条一模一样的信号。同一 pluginId+panelId 在窗口内
        // 只发一条,窗口结束时若期间还来过则补发一条(见 requestPanelRefresh)。
        requestPanelRefresh(id, panelId, () => {
          eventBus.emitGlobal({
            type: 'plugin:notification',
            pluginId: id,
            message: `plugin-panel-refresh:${id}:${panelId}`,
            level: 'info',
            kind: 'panel-refresh',
            panelId,
          })
        })
      },
      emitPluginStatus(_id, sessionId, part) {
        emitPluginStatusPart(sessionId, part)
      },
      notePluginStatusPending() {
        notePluginStatusPending()
      },
      /**
       * R7 试点注册表:IM 连接器。
       *
       * 开放下一个注册表要动五处,清单在 core 的 `PLUGIN_OPEN_REGISTRIES`
       * 注释里(策略表 / API+Host 类型 / api-builder 实现 / 这里的转发 /
       * 拆除快照测试)。这里是其中的第四处。
       */
      registerIMConnector(id, connector) {
        // 带上归属:运行期投递失败要记到**这个插件**的熔断账上,
        // 而 registry 本身不认识 pluginId。
        return registerIMConnector(connector as IMConnector, { ownerPluginId: id })
      },
      /**
       * 搜索供给方(M2)—— 又一个既有宿主动词面。转发到装配层的注册表 +
       * 聚合器;onAction 的 ctx.notify 走既有 plugin:notification 轨(与 ui.notify
       * 同一条广播),让插件在点击时能对用户说一句话。
       */
      registerSearchProvider(id, registration) {
        return registerPluginSearchProvider(id, registration, {
          notify: (message, level) => eventBus.emitGlobal({
            type: 'plugin:notification',
            pluginId: id,
            message,
            level,
            sound: resolvePluginNotifySound(id, undefined),
          }),
        })
      },
      /**
       * 深链动作(H4)—— 第三个既有宿主动词面。转发到装配层的注册表;
       * 确认门与派发在 Electron 宿主(它才认识窗口与 URL scheme)。
       *
       * 这里**只登记**:一个动作被注册不代表它会被调用,调用永远要经过一次
       * 用户看着全文按下的确认。
       */
      registerDeepLinkAction(id, registration) {
        return registerPluginDeepLinkAction(id, registration)
      },
      /**
       * 凭证轮换策略(批 E)—— 第四个既有宿主动词面。转发到装配层的注册表;
       * 脱敏投影、超时、熔断、用量聚合都在那里(它才认识凭证池与账本)。
       *
       * 这里**只登记**:一个策略被注册不代表它会被调用 —— 只有用户在某个空间的
       * 某个 provider 上把 policy 选成 `plugin:<id>:<name>` 之后,它才会被问到。
       */
      registerCredentialStrategy(id, registration) {
        return registerPluginCredentialStrategy(id, registration)
      },
      emitPluginEvent(id, eventName, payload) {
        // 自定义事件名是运行期拼出来的,不在 GlobalEvent 联合里 —— 这处 cast
        // 是有意的(与 panel-refresh 不同,后者已经收进联合)。
        eventBus.emitGlobal({
          type: `plugin:${id}:${eventName}`,
          pluginId: id,
          name: eventName,
          payload,
        } as any)
      },
      steer(_, sessionId, content) {
        streamEngine.steerMessage(sessionId, content, pluginId)
      },
      followUp(_, sessionId, content) {
        streamEngine.followUpMessage(sessionId, content, pluginId)
      },
      /**
       * N1 的三个动词(投递 + 两个快照)。实现在 `./sessions.ts` —— 这里只是
       * 把 eventBus / streamEngine 这两个装配期才有的东西喂进去。
       */
      ...createPluginSessionHostPorts({ eventBus, streamEngine }),
      /**
       * N7-b:受管 LLM 调用。实现在 `./llm.ts` —— provider 解析 / 计费 /
       * 超时 / 配额三要素全在那里,core 只做声明门与输入校验。
       */
      llmComplete: (id, options) => pluginLlmComplete(id, options),
      /**
       * 横幅 + 可选一声(M1)。
       *
       * `sound` 在**这里**就裁决完:静音开关、每插件静音、限频三道闸全在
       * `resolvePluginNotifySound` 里。renderer 拿到的是结论不是请求 ——
       * 这条通知走 `sendToAllWindows` 广播,让每个窗口自己判就会响两声。
       *
       * 被静音/被限频时只是 sound 变 'none',`message` 原样发出:横幅照常显示。
       */
      notify(id, message, level, sound) {
        eventBus.emitGlobal({
          type: 'plugin:notification',
          pluginId: id,
          message,
          level,
          sound: resolvePluginNotifySound(id, sound),
        })
      },
      /**
       * 布局动词的投递(I 期)。
       *
       * **零新通道**:搭的是 panel-refresh / catalog-changed 那班既有的
       * `plugin:notification` 车 —— 带 `kind` 的通知是**机械信号**,renderer
       * 一律不弹 toast(判据是"有没有 kind",不是白名单),于是新增一个 kind
       * 不需要动 toast 那一侧的任何代码。
       *
       * 手势闸与 unsupported 都在 core 判完了:这里只负责把结论发出去。
       * 广播到所有窗口 —— "开合侧栏"是每个窗口自己的布局,谁在前台谁响应。
       */
      applyLayoutVerb(id, verb, panelId) {
        eventBus.emitGlobal({
          type: 'plugin:notification',
          pluginId: id,
          // message 是机器串(与 panel-refresh 同款):有 kind 就不给人看,
          // 但日志与调试里要认得出是哪一条。
          message: `plugin-layout:${verb}${panelId ? `:${panelId}` : ''}`,
          level: 'info',
          kind: 'layout',
          layout: { verb, ...(panelId ? { panelId } : {}) },
        })
      },
      getPluginConfig: getEffectivePluginConfig,
      onPluginConfigChange: subscribePluginConfigChange,
      /**
       * 背景层运行期调参的落点(G 期,L2.5)。
       *
       * 记进内存态,然后**复用 catalog-changed** 这一条既有信号 —— renderer 已经
       * 在监听它重拉插件清单(面板入口、锚点块、主题覆盖都走这条路),背景描述符
       * 就挂在同一份清单响应里,于是这里零新通道、零新事件。
       */
      updatePluginBackground(id, patch) {
        // 图源的最后一道闸(B 期):core 判得了 `storage:` 寻址的形状,判不了
        // 文件存不存在(它不吃 fs)。指向空气的一次换图**整条被拒**、背景保持
        // 原样 —— 记进内存态的话,设置页会说"生效中"而屏幕上什么也没有。
        //
        // 撤回(`image: null`)不进这道闸:没有图,就没有"存不存在"可问。
        // 用 `typeof === 'string'` 而不是 `!== undefined`,是因为这里要分的是
        // "有图 / 无图",不是"提没提这个字段"。
        if (typeof patch.image === 'string' && !pluginStorageImageExists(id, patch.image)) {
          console.error(
            `[Plugin:${id}] theme.updateBackground rejected: "${patch.image}" is not in this plugin's storage`,
          )
          return
        }
        setPluginBackgroundParams(id, patch)
        eventBus.emitGlobal({
          type: 'plugin:notification',
          pluginId: id,
          message: `plugin-catalog-changed:${id}`,
          level: 'info',
          kind: 'catalog-changed',
        })
      },
      registerPromptContextProvider: registerPromptContextProvider,
      registerBeforeContextCompactHook,
      registerAfterAssistantResponseHook,
      // N2:发送前拦截(第一个干预型钩子)。声明门在 api-builder(`input:intercept`),
      // 链的次序 / 预算 / fail-open / 熔断闸在 input-intercept.ts,挂点在引擎。
      registerInputInterceptHook: registerPluginInputInterceptHook,
      // N4:工具调用拦截(第二个干预型钩子,第一个 fail-closed 的)。声明门在
      // api-builder(`toolcall:intercept`),链的次序 / 预算 / fail-closed / 熔断闸
      // 在 tool-call-intercept.ts,挂点在 executeCoreDirectTool 那一处必经点。
      registerToolCallInterceptHook: registerPluginToolCallInterceptHook,
      // N5:工具结果改写(第三个干预型钩子,interceptToolCall 的 fail-open 镜像)。
      // 声明门在 api-builder(`toolresult:intercept`),链在 tool-result-intercept.ts,
      // 挂点在 executeCoreDirectTool 工具执行**之后**、结果回模型之前的对称位置。
      registerToolResultInterceptHook: registerPluginToolResultInterceptHook,
      registerSkillRoot: registerPluginSkillRootProvider,
      invalidateSkillsCache() {
        return import('../skills/session-skills.js')
          .then(({ invalidateSessionSkillsCache }) => invalidateSessionSkillsCache())
          .catch(() => undefined)
      },
    },
  })

  stateRef.current = result.state
  // 级联(§3.3):消息/会话删除事件携带坐标,存在即清。订阅的生命周期与
  // 插件 state 对齐 —— 排进 storeClosers,拆除时最先退订。
  const cascadeUnsubs = [
    eventBus.onAnySession(
      SESSION_EVENT_TYPES.MESSAGE_DELETED,
      (env) => messageState.handleMessageDeleted(env.sessionId, env.event.messageId),
      `PluginMessageState:${pluginId}`,
    ),
    eventBus.onGlobal(
      'session:deleted',
      (env) => messageState.handleSessionDeleted(env.event.sessionId),
    ),
  ]
  // 拆除流程收尾时关 storage 闩 + 关 KV(见 disposePlugin)—— 不排进回调队列。
  storeClosers.set(result.state, () => {
    for (const unsub of cascadeUnsubs) unsub()
    closeStorage()
    closeStore()
    // G 期:背景层的运行期参数是内存态,拆除即撤 —— 留着的话重新启用会带回
    // 一份用户早就忘了的旧透明度,而 manifest 上写的明明是另一个值。
    // 层本身的撤除不需要动作:清单里没有这条 active 声明,下一次投影就没有赢家。
    clearPluginBackgroundParams(pluginId)
    // 同理:限频账是内存态,拆除即清。留着的话"停用→立刻启用"的第一声会被
    // 上一条生命周期里的时间戳吃掉,看起来像声音坏了。
    forgetPluginNotifySoundThrottle(pluginId)
    // 同理:手势账也是内存态,拆除即清。留着的话"停用 → 立刻启用"会带回
    // 上一条生命周期里的手势,一个刚装回来的插件能在用户什么都没点的情况下
    // 先弹一次工作台 —— 那正是手势锚定要挡住的那件事。
    forgetUiActionGestures(pluginId)
  })
  // 轻通道(本地单文件脚本):把交给 entry 的 api 物理收窄。state 不动 —— 宿主侧
  // 拆除/清扫读的是 state.api(完整),插件侧拿到的是窄化面。
  if (isLocalPlugin(pluginId)) {
    return { api: narrowApiForLocalPlugin(result.api), state: result.state }
  }
  return result
}

/**
 * state → 关 KV 的收尾动作。
 *
 * 用 WeakMap 而不是 per-pluginId 的表:同一个 pluginId 在竞态窗口里可能同时存在
 * 两份 state(refresh 与 enable 各一份),按 id 索引会关错那一份。
 */
const storeClosers = new WeakMap<PluginState, () => void>()

export function disposePlugin(state: PluginState): void {
  disposeCorePluginState(state, {
    /*
     * R3b:**两侧拆除**。core 按注册过的工具 id 逐个调这个口,所以把"两边都摘"
     * 收在这一处,注册表足迹与目录足迹不可能漂开(`builtin-teardown.test.ts` 钉的
     * 就是"停用之后一个字都不剩")。目录没建起来时后一句返回 false,无害。
     */
    unregisterTool: (toolId: string) => {
      const removed = unregisterToolInRegistry(toolId)
      const removedFromCatalog = isToolkitEnabled() && unregisterPluginToolFromCatalog(toolId)
      return removed || removedFromCatalog
    },
  })
  // KV **在 onDispose 回调全部跑完之后**才关 —— 插件在 onDispose 里
  // `api.store.set` 存盘是最自然的收尾写法,提前关掉就是静默丢数据。
  try {
    storeClosers.get(state)?.()
  } catch (error) {
    console.error('[Plugin] Failed to close the plugin KV store:', error)
  }
  // R5 携带项:还没到点的面板刷新补发一并取消 —— 否则一个已停用的插件会在
  // 200ms 后要求重画一个已经不存在的面板。
  if (state.api?.id) cancelPanelRefreshWindows(state.api.id)
  // R6:拆除的插件在**所有**会话里挂着的状态一起撤下。
  // 只等流结束是不够的 —— 被熔断禁用的插件,它挂在别的会话上的状态没人再会来
  // 清,而那些会话可能几小时后才结束。api 的 disposed 闩只挡住新的 show,
  // 挡不住已经挂上去的。
  if (state.api?.id) sweepPluginStatusForPlugin(state.api.id)
}
