/**
 * 插件 API 的能力面:注册工具与命令、订阅事件、三个提示词 / 生命周期钩子、三条拦截链、技能根、请求通道、`onDispose` 与调度器。
 *
 * 从 `plugin-api-builder.ts` 按面拆出(大文件拆分批 2,2026-10-04):每一格的方法正文与拆分前一字不差,
 * 从前读闭包变量的地方,现在读开头从上下文(`plugin-api-context.ts`)解构出来的同名局部量。
 * 键的顺序不在这里定 —— `createCorePluginAPI` 按拆分前那只对象字面量的顺序拼。
 */
import { describeToolPromptContributionProblem } from '../agent-loop/agent-loop.js'
import {
  isReservedPluginPanelAction,
  isReservedPluginUiAction,
  pluginScope,
  normalizePluginRequestAction,
  type CorePluginRequestHandler,
} from '@onething/backend/plugin-contract'
import {
  PLUGIN_PERMISSION_INPUT_INTERCEPT,
  type PluginInputInterceptHandler,
} from './plugin-input-intercept.js'
import {
  PLUGIN_PERMISSION_TOOLCALL_INTERCEPT,
  type PluginToolCallInterceptHandler,
} from './plugin-tool-call-intercept.js'
import {
  PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT,
  type PluginToolResultInterceptHandler,
} from './plugin-tool-result-intercept.js'
import { assertCorePluginToolExecutionMode } from './plugin-tool-execution-mode.js'
import type { CorePluginAPITypeArgs, PluginApiBuildContext } from './plugin-api-context.js'

export function buildPluginApiCapabilities<T extends CorePluginAPITypeArgs>(ctx: PluginApiBuildContext<T>) {
  type TTool = T['tool']
  type TEventHandler = T['eventHandler']
  type TCommand = T['command']
  type TCommandOptions = T['commandOptions']
  type TPromptContextProvider = T['promptContextProvider']
  type TBeforeContextCompactHook = T['beforeContextCompactHook']
  type TAfterAssistantResponseHook = T['afterAssistantResponseHook']
  type TSkillRootProvider = T['skillRootProvider']
  const { pluginId, host, scheduler, logger, state, unsubs, commands, toolIds, skillRootUnsubs, promptContextUnsubs, lifecycleUnsubs, disposeCallbacks, requestHandlers, declaredPermissions, reportFailure, reportSuccess, rejectLateCall } = ctx

  return {
    registerTool(tool: TTool): void {
      if (rejectLateCall('registerTool')) return
      const toolId = `plugin:${pluginId}:${tool.name}`
      try {
        // N3:并发声明是**这一个工具**的注册前提。非法值拒注册它一个
        // (插件其余的面照常),而不是静默降级成屏障 —— 降级安全,但作者
        // 把 'parallel' 拼错之后永远看不到任何线索。
        assertCorePluginToolExecutionMode(
          (tool as { executionMode?: unknown }).executionMode,
          tool.name,
        )
        // Same rule for the prompt it brings: an illegal declaration rejects
        // this one tool, loudly, instead of a silently mangled system prompt.
        const promptProblem = describeToolPromptContributionProblem(
          (tool as { prompt?: unknown }).prompt,
        )
        if (promptProblem) {
          throw new Error(`Tool "${tool.name}": ${promptProblem}`)
        }
        host.registerTool(pluginId, toolId, tool)
        if (!toolIds.includes(toolId)) {
          toolIds.push(toolId)
        }
        logger.debug(`[Plugin:${pluginId}] Registered tool: ${tool.name}`)
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] Failed to register tool "${tool.name}":`, undefined, error)
      }
    },

    on(eventType: string, handler: TEventHandler): () => void {
      if (rejectLateCall('on')) return () => {}
      const scope = pluginScope.event(eventType)
      const onHandlerError = (error: unknown): void => {
        logger.error(`[Plugin:${pluginId}] Event handler error (${eventType}):`, undefined, error)
        reportFailure(scope, error)
      }
      const wrappedHandler = ((...args: unknown[]) => {
        // 事件面**不**在 dispose 窗口里放行:拆除中的插件不该再被喂新事件。
        // 放行的只有写面(storage / store),那是为了让 onDispose 能存盘。
        if (state.disposed) {
          // 拆除之后到达的事件不再进插件 —— 见 CorePluginAPIState.disposed。
          return
        }
        try {
          const result = handler(...args)
          if (result instanceof Promise) {
            result.then(() => reportSuccess(scope), onHandlerError)
          } else {
            reportSuccess(scope)
          }
        } catch (error) {
          onHandlerError(error)
        }
      }) as TEventHandler

      const unsub = host.subscribeEvent(pluginId, eventType, wrappedHandler)
      unsubs.push(unsub)
      return unsub
    },

    registerCommand(name: string, options: TCommandOptions): void {
      if (rejectLateCall('registerCommand')) return
      const fullName = name.startsWith('/') ? name : `/${name}`
      commands.set(fullName, { name: fullName, ...options } as unknown as TCommand)
      logger.debug(`[Plugin:${pluginId}] Registered command: ${fullName}`)
    },

    registerPromptContextProvider(id: string, provider: TPromptContextProvider): void {
      if (rejectLateCall('registerPromptContextProvider')) return
      const unsub = host.registerPromptContextProvider(pluginId, id, provider)
      promptContextUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered prompt context provider: ${id}`)
    },

    beforeContextCompact(id: string, hook: TBeforeContextCompactHook): void {
      if (rejectLateCall('beforeContextCompact')) return
      const unsub = host.registerBeforeContextCompactHook(pluginId, id, hook)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered beforeContextCompact hook: ${id}`)
    },

    afterAssistantResponse(id: string, hook: TAfterAssistantResponseHook): void {
      if (rejectLateCall('afterAssistantResponse')) return
      const unsub = host.registerAfterAssistantResponseHook(pluginId, id, hook)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered afterAssistantResponse hook: ${id}`)
    },

    /**
     * 发送前拦截(N2)——**拦截族**的第一个成员。
     *
     * 它刻意**不是** `api.on('input')`:观察族(`api.on`)的返回值今天被忽略,
     * 把一个"返回值被消费"的点混进同一个函数,作者永远搞不清自己 return 的东西
     * 到底算不算数;而裸 string 订阅名拼错就是 pi 那条静默死订阅。两个家族从
     * 类型上分开之后,这两个问题一起消失:拦截点是函数名,拼错编译不过。
     *
     * 声明门:`contributes.permissions` 要有 `input:intercept`。未声明 = 报错 +
     * 拒绝注册,**不计熔断**(与 sendMessage / theme.updateBackground 同规:
     * 那是作者写错了 manifest,不该为一次笔误连坐整个插件)。
     */
    interceptInput(id: string, handler: PluginInputInterceptHandler): void {
      if (rejectLateCall('interceptInput')) return
      if (!declaredPermissions.has(PLUGIN_PERMISSION_INPUT_INTERCEPT)) {
        logger.error(
          `[Plugin:${pluginId}] interceptInput requires "${PLUGIN_PERMISSION_INPUT_INTERCEPT}" in `
          + 'contributes.permissions (plugin.json). It is the most sensitive declaration there is — '
          + 'the install page tells the user this plugin can rewrite or handle their messages.',
          undefined,
        )
        return
      }
      if (!host.registerInputInterceptHook) {
        logger.error(
          `[Plugin:${pluginId}] interceptInput is not available on this host (no send pipeline).`,
          undefined,
        )
        return
      }
      const unsub = host.registerInputInterceptHook(pluginId, id, handler)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered input interceptor: ${id}`)
    },

    /**
     * 工具调用拦截(N4)——**拦截族**的第二个成员,也是第一个 fail-closed 的。
     *
     * handler 返回 `{action:'allow'|'block'|'rewrite'}`(或什么都不返回 = allow),
     * 多插件按全局规范顺序链式:rewrite 逐个累积参数,第一个 block 短路后续。
     * 改写后的参数**要过工具自己的校验**,过不了当作 block。
     *
     * 抛错 / 超时 / 返回值读不懂 = **阻断这一次调用**(与 interceptInput 相反),
     * 因为这里的默认动作是执行一个带副作用的工具。连败到阈值后这个插件的拦截面
     * 被降级掉,之后它的调用一律放行 —— 一个坏插件挡得住三次,瘫痪不了应用。
     *
     * 声明门:`contributes.permissions` 要有 `toolcall:intercept`。未声明 = 报错 +
     * 拒绝注册,**不计熔断**(manifest 笔误不该连坐整个插件,与 N1/N2 同规)。
     */
    interceptToolCall(id: string, handler: PluginToolCallInterceptHandler): void {
      if (rejectLateCall('interceptToolCall')) return
      if (!declaredPermissions.has(PLUGIN_PERMISSION_TOOLCALL_INTERCEPT)) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolCall requires "${PLUGIN_PERMISSION_TOOLCALL_INTERCEPT}" in `
          + 'contributes.permissions (plugin.json). The install page tells the user this plugin '
          + 'can inspect, block, or rewrite tool calls before they run.',
          undefined,
        )
        return
      }
      if (!host.registerToolCallInterceptHook) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolCall is not available on this host (no tool pipeline).`,
          undefined,
        )
        return
      }
      const unsub = host.registerToolCallInterceptHook(pluginId, id, handler)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered tool-call interceptor: ${id}`)
    },

    /**
     * 工具结果改写(N5)——**拦截族**的第三个成员,`interceptToolCall` 的 fail-open
     * 镜像。它挂在工具执行**之后**、结果回模型之前的对称位置。
     *
     * handler 返回 `{action:'keep'|'replace'}`(或什么都不返回 = keep),多插件按
     * 全局规范顺序链式:replace 逐个累积(后手看到前手改写后的结果)。没有 block、
     * 没有短路 —— 结果已经产生,只有改写。content 是纯文本(不过 schema,只有
     * 长度上限),isError 可翻转(脱敏场景)。
     *
     * 抛错 / 超时 / 返回值读不懂 = **保留原结果**(fail-open,与 interceptToolCall
     * 相反),因为结果早已产生、改写失败无害。连败到阈值后这个插件的改写面被降级掉。
     *
     * 声明门:`contributes.permissions` 要有 `toolresult:intercept`。未声明 = 报错 +
     * 拒绝注册,**不计熔断**(manifest 笔误不该连坐整个插件,与 N1/N2/N4 同规)。
     * 它是最敏感的声明之一 —— 装前确认页会念成人话:该插件能读到并改写所有工具的
     * 输出(含文件内容与命令输出)。
     */
    interceptToolResult(id: string, handler: PluginToolResultInterceptHandler): void {
      if (rejectLateCall('interceptToolResult')) return
      if (!declaredPermissions.has(PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT)) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolResult requires "${PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT}" in `
          + 'contributes.permissions (plugin.json). The install page tells the user this plugin '
          + 'can read and rewrite tool results before the model sees them, including file contents '
          + 'and command output.',
          undefined,
        )
        return
      }
      if (!host.registerToolResultInterceptHook) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolResult is not available on this host (no tool pipeline).`,
          undefined,
        )
        return
      }
      const unsub = host.registerToolResultInterceptHook(pluginId, id, handler)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered tool-result interceptor: ${id}`)
    },

    registerSkillRoot(provider: TSkillRootProvider): void {
      if (rejectLateCall('registerSkillRoot')) return
      const unsub = host.registerSkillRoot(pluginId, provider)
      skillRootUnsubs.push(unsub)
      Promise.resolve(host.invalidateSkillsCache?.()).catch(() => undefined)
      logger.debug(`[Plugin:${pluginId}] Registered skill root provider`)
    },

    /**
     * 统一请求通道的插件侧登记口(设计文档 §5 R2)。
     *
     * handler 拿到的 ctx 带 requestId / abortSignal / progress —— 与宿主工具
     * 执行上下文同构,长任务从第一天就有取消与中间态。
     */
    registerRequestHandler(action: string, handler: CorePluginRequestHandler): void {
      if (rejectLateCall('registerRequestHandler')) return
      const normalized = normalizePluginRequestAction(action)
      if (!normalized) {
        logger.error(`[Plugin:${pluginId}] registerRequestHandler needs a non-empty action`, undefined)
        return
      }
      // `panel:` 与 `ui:` 是宿主保留的命名空间。不挡的话,插件可以直接登记
      // `panel:render:<id>` / `ui:render:<anchor>:<id>` 顶掉宿主装好的那层 ——
      // 一条 replacing 日志之后,一棵没校验过的树就直通 renderer 了。
      // 这与"未声明的面板 id"同一性质,所以同款处理:报错 + 计熔断,不注册。
      if (isReservedPluginPanelAction(normalized) || isReservedPluginUiAction(normalized)) {
        logger.error(
          `[Plugin:${pluginId}] registerRequestHandler("${normalized}") is refused: the "panel:" and "ui:" `
          + 'action namespaces belong to the host. Use registerWorkspacePanel() / registerUiSlot() instead.',
          undefined,
        )
        reportFailure(pluginScope.registration('RequestHandler'), new Error(`reserved action "${normalized}"`))
        return
      }
      if (requestHandlers.has(normalized)) {
        logger.error(`[Plugin:${pluginId}] Duplicate request handler for action "${normalized}" (replacing)`, undefined)
      }
      requestHandlers.set(normalized, handler)
      logger.debug(`[Plugin:${pluginId}] Registered request handler: ${normalized}`)
    },

    onDispose(callback: () => void | Promise<void>): void {
      if (rejectLateCall('onDispose')) return
      disposeCallbacks.push(callback)
    },

    scheduler,
  }
}
