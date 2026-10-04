/**
 * 插件 API 的会话面:往会话里插话(`steer` / `followUp` / 跨会话的 `sendMessage`)、看会话快照(`sessions` / `isIdle`)、受管 LLM 调用与原子三动词(`resources`)。
 *
 * 从 `plugin-api-builder.ts` 按面拆出(大文件拆分批 2,2026-10-04):每一格的方法正文与拆分前一字不差,
 * 从前读闭包变量的地方,现在读开头从上下文(`plugin-api-context.ts`)解构出来的同名局部量。
 * 键的顺序不在这里定 —— `createCorePluginAPI` 按拆分前那只对象字面量的顺序拼。
 */
import { deepFreezeCorePluginValue } from './plugin-freeze.js'
import {
  PLUGIN_PERMISSION_SESSIONS_POST,
  PLUGIN_PERMISSION_SESSIONS_TRIGGER,
  pluginDeliveryStartsTurn,
  resolvePluginDelivery,
  type PluginSendMessageOptions,
  type PluginSendMessageResult,
  type PluginSessionPeek,
  type PluginSessionPeekLite,
} from './plugin-sessions.js'
import {
  PLUGIN_PERMISSION_LLM_COMPLETE,
  PluginLlmError,
  normalizePluginLlmMessages,
  type PluginLlmCompleteOptions,
  type PluginLlmCompleteResult,
} from './plugin-llm.js'
import { pluginScope } from '@onething/backend/plugin-contract'
import {
  PLUGIN_PERMISSION_RESOURCES_DO,
  PLUGIN_PERMISSION_RESOURCES_READ,
  PLUGIN_PERMISSION_RESOURCES_WATCH,
  type PluginResourcesApi,
} from './plugin-resources.js'
import {
  type ResourceEvent,
  type ReadOutcome as ReadOutcomeValue,
  ReadOutcome,
} from '@onething/backend/resource'
import { Outcome, type Outcome as OutcomeValue } from '@onething/backend/toolkit'
import type { CorePluginAPITypeArgs, PluginApiBuildContext } from './plugin-api-context.js'

export function buildPluginApiSessions<T extends CorePluginAPITypeArgs>(ctx: PluginApiBuildContext<T>) {
  const { pluginId, host, logger, state, unsubs, declaredPermissions, reportFailure, reportSuccess, rejectLateCall, requireSessionsPeek } = ctx

  async function peekSessionForPlugin(sessionId: string): Promise<PluginSessionPeek | null> {
    if (!requireSessionsPeek('sessions.peek')) return null
    const targetId = String(sessionId ?? '').trim()
    if (!targetId || !host.peekSession) return null
    try {
      const peek = await host.peekSession(pluginId, targetId)
      return peek ? deepFreezeCorePluginValue(peek) : null
    } catch (error) {
      logger.error(`[Plugin:${pluginId}] sessions.peek error:`, undefined, error)
      return null
    }
  }

  return {
    steer(sessionId: string, content: string): void {
      if (rejectLateCall('steer')) return
      try {
        host.steer(pluginId, sessionId, content)
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] steer error:`, undefined, error)
        reportFailure(pluginScope.steer(), error)
      }
    },

    followUp(sessionId: string, content: string): void {
      if (rejectLateCall('followUp')) return
      try {
        host.followUp(pluginId, sessionId, content)
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] followUp error:`, undefined, error)
        reportFailure(pluginScope.followUp(), error)
      }
    },

    /**
     * 跨会话信使(N1)—— 三态投递矩阵,不是布尔。
     *
     *  - `{triggerTurn:true}`:目标空闲 → 起一轮;忙 → 降级为 steer。**不抛错**,
     *    结果里 `delivered` 如实说走了哪一格,`targetWasBusy` 说为什么。
     *  - `{triggerTurn:false}` / 缺省:持久化 + 显示,不起轮(fail-closed)。
     *  - `{deliverAs}`:显式选既有队列;`nextTurn` 诚实映射到 follow-up
     *    (引擎没有第三条队列,见 PLUGIN_DELIVER_AS_NOTES)。
     *
     * 声明门与循环闸的**拒绝都回结构化 reason**:插件感知得到自己被拒了。
     * 门本身不计熔断 —— 那是作者写错了 manifest,不该为一次笔误连坐整个插件
     * (与 theme.updateBackground 同规)。
     */
    async sendMessage(
      sessionId: string,
      content: string,
      options: PluginSendMessageOptions = {},
    ): Promise<PluginSendMessageResult> {
      if (rejectLateCall('sendMessage')) {
        return { ok: false, reason: 'unsupported', detail: 'plugin was disposed' }
      }
      const targetId = String(sessionId ?? '').trim()
      if (!targetId) return { ok: false, reason: 'unknown-session', detail: 'sessionId is required' }
      if (typeof content !== 'string' || !content.trim()) {
        return { ok: false, reason: 'empty-content', detail: 'content must be a non-empty string' }
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_SESSIONS_POST)) {
        logger.error(
          `[Plugin:${pluginId}] sendMessage requires "${PLUGIN_PERMISSION_SESSIONS_POST}" in `
          + 'contributes.permissions (plugin.json). Declare it first — the install page shows it to the user.',
          undefined,
        )
        return { ok: false, reason: 'not-declared', detail: PLUGIN_PERMISSION_SESSIONS_POST }
      }
      // 可能起轮的那一格要**额外**一档声明。判据是矩阵在最坏情况下的结果:
      // 目标此刻的忙闲由宿主说了算,但"空闲时会起轮"这件事在这里就已经确定。
      if (
        pluginDeliveryStartsTurn(resolvePluginDelivery(options, false))
        && !declaredPermissions.has(PLUGIN_PERMISSION_SESSIONS_TRIGGER)
      ) {
        logger.error(
          `[Plugin:${pluginId}] sendMessage({triggerTurn:true}) requires `
          + `"${PLUGIN_PERMISSION_SESSIONS_TRIGGER}" in contributes.permissions — starting a model turn `
          + 'spends the user\'s tokens, so it is its own declaration.',
          undefined,
        )
        return { ok: false, reason: 'not-declared', detail: PLUGIN_PERMISSION_SESSIONS_TRIGGER }
      }
      if (!host.sendMessage) {
        return { ok: false, reason: 'unsupported', detail: 'this host has no session delivery surface' }
      }
      const scope = pluginScope.sendMessage()
      try {
        const result = await host.sendMessage(pluginId, targetId, content, options ?? {})
        reportSuccess(scope)
        return result
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] sendMessage error:`, undefined, error)
        reportFailure(scope, error)
        return {
          ok: false,
          reason: 'error',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },

    /**
     * 感知快照(N1,架构图 §4 的修正)。
     *
     * 「A 知道 B 在干什么」是一个**压缩快照动词**,不是一条事件流:agent 想看
     * 才调,一句话级。事件流是给插件代码在 main 进程消化的,不进模型上下文。
     * 返回值全部来自现成内存态(零新统计),深冻结 + JSON-可序列化。
     */
    sessions: {
      peek: peekSessionForPlugin,
      async list(): Promise<PluginSessionPeekLite[]> {
        if (!requireSessionsPeek('sessions.list')) return []
        if (!host.listSessions) return []
        try {
          return deepFreezeCorePluginValue(await host.listSessions(pluginId))
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] sessions.list error:`, undefined, error)
          return []
        }
      },
    },

    /**
     * `peek().state === 'idle'` 的便捷函数(pi 的 `ctx.isIdle()`)。
     * 读不到会话 = false:"不知道"绝不能被当成"可以随便打扰"。
     */
    async isIdle(sessionId: string): Promise<boolean> {
      return (await peekSessionForPlugin(sessionId))?.state === 'idle'
    },

    /**
     * 受管 LLM 调用(N7-b)—— "插件从搬运升到判断"的钥匙。
     *
     * 与 pi 的裸 `ctx.modelRegistry.complete()` 的关键差异:插件拿不到 apiKey /
     * registry,只交出 messages、拿回 text。**受管三要素**(计费 `source=plugin:<id>`
     * + 硬超时 + 配额)全在宿主实现里;core 这一层只做:
     *  - **声明门**:manifest 没声明 `llm:complete` → 抛 `not-declared`,**不计熔断**
     *    (manifest 笔误不该连坐整个插件,与 sendMessage / interceptInput 同规);
     *  - **输入校验**:messages 非空且形状合法,否则抛 `invalid-input`;
     *  - **诚实降级**:宿主没接这条线 → 抛 `unsupported`,不假装成功。
     *
     * 失败(provider / 超时 / 配额 / 校验)一律**抛给插件**自己 catch。在
     * beforeContextCompact 钩子里没 catch 时,N7-a 的 fail-open 兜底回落宿主自压。
     */
    llm: {
      async complete(options: PluginLlmCompleteOptions): Promise<PluginLlmCompleteResult> {
        if (rejectLateCall('llm.complete')) {
          throw new PluginLlmError('unsupported', 'plugin was disposed')
        }
        if (!declaredPermissions.has(PLUGIN_PERMISSION_LLM_COMPLETE)) {
          logger.error(
            `[Plugin:${pluginId}] llm.complete requires "${PLUGIN_PERMISSION_LLM_COMPLETE}" in `
            + 'contributes.permissions (plugin.json). The install page tells the user this plugin '
            + 'can make AI model calls on its behalf (uses tokens).',
            undefined,
          )
          throw new PluginLlmError('not-declared', PLUGIN_PERMISSION_LLM_COMPLETE)
        }
        if (!host.llmComplete) {
          throw new PluginLlmError('unsupported', 'this host has no managed LLM surface')
        }
        // 抛 invalid-input(纯校验),在把请求交给宿主之前。
        const messages = normalizePluginLlmMessages((options ?? {}).messages)
        return host.llmComplete(pluginId, {
          messages,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          signal: options?.signal,
        })
      },
    },

    /**
     * 原子的三个动词(K4-b)。
     *
     * 这一段刻意**短**:它做的全部事情是「晚到闸 → 声明门 → 转手」。没有一句
     * 「如果是 session 就……」,没有一处 `ref.split(':')` —— 插件面与内核同一条
     * 纪律(§2 不变量 3:内核不认识任何 scheme)。
     *
     * 拒绝一律用内核自己的词(`denied`),理由写在 `resources.ts` 的
     * `PluginResourcesApi` 注释里:同一次「规则不让」在插件眼里不该有两个名字。
     */
    resources: {
      async read(
        ref: string,
        name: string,
        query: Record<string, unknown> = {},
      ): Promise<ReadOutcomeValue> {
        if (rejectLateCall('resources.read')) {
          return ReadOutcome.denied('plugin was disposed')
        }
        if (!declaredPermissions.has(PLUGIN_PERMISSION_RESOURCES_READ)) {
          logger.error(
            `[Plugin:${pluginId}] resources.read requires "${PLUGIN_PERMISSION_RESOURCES_READ}" in `
            + 'contributes.permissions (plugin.json). Declare it first — the install page shows it to the user.',
            undefined,
          )
          return ReadOutcome.denied(PLUGIN_PERMISSION_RESOURCES_READ)
        }
        if (!host.readResource) {
          return ReadOutcome.denied('this host has no resource kernel')
        }
        // 转手之后**不 try/catch**:装配层那一侧已经把抛出物折成结局(它同时要
        // 记熔断,而记账要在离故障最近的地方做)。这里再包一层只会让同一次失败
        // 有两个产地,而其中一个不记账。
        return host.readResource(pluginId, String(ref ?? ''), String(name ?? ''), query ?? {})
      },
      async do(
        ref: string,
        op: string,
        params: Record<string, unknown> = {},
      ): Promise<OutcomeValue> {
        if (rejectLateCall('resources.do')) {
          return Outcome.denied('plugin was disposed')
        }
        if (!declaredPermissions.has(PLUGIN_PERMISSION_RESOURCES_DO)) {
          logger.error(
            `[Plugin:${pluginId}] resources.do requires "${PLUGIN_PERMISSION_RESOURCES_DO}" in `
            + 'contributes.permissions (plugin.json) — it changes the user\'s things, so it is its own '
            + 'declaration and the install page reads it out.',
            undefined,
          )
          return Outcome.denied(PLUGIN_PERMISSION_RESOURCES_DO)
        }
        if (!host.doResource) {
          return Outcome.denied('this host has no resource kernel')
        }
        return host.doResource(pluginId, String(ref ?? ''), String(op ?? ''), params ?? {})
      },
      /**
       * 看住一个前缀。
       *
       * 前缀非法时事件总线是**抛**的(它的头注释:「一个静默失效的订阅是最难查的
       * 那种 bug」)。插件面不把这句抛给插件 —— `api.*` 的既有口径是不抛错 ——
       * 但也不能把它变成沉默:记一条按插件归因的 `error`,返回一个诚实的空退订。
       * 于是插件作者在日志里第一时间看得见,而它的 entry 不会因此炸掉。
       *
       * **不计熔断**:前缀写错是作者的一次笔误,与声明门同规。
       */
      watch(prefix: string, listener: (event: ResourceEvent) => void): () => void {
        if (rejectLateCall('resources.watch')) return () => {}
        if (!declaredPermissions.has(PLUGIN_PERMISSION_RESOURCES_WATCH)) {
          logger.error(
            `[Plugin:${pluginId}] resources.watch requires "${PLUGIN_PERMISSION_RESOURCES_WATCH}" in `
            + 'contributes.permissions (plugin.json).',
            undefined,
          )
          return () => {}
        }
        if (!host.watchResources) {
          logger.error(`[Plugin:${pluginId}] resources.watch: this host has no resource kernel.`, undefined)
          return () => {}
        }
        if (typeof listener !== 'function') {
          logger.error(`[Plugin:${pluginId}] resources.watch: listener must be a function.`, undefined)
          return () => {}
        }
        try {
          const unsub = host.watchResources(pluginId, String(prefix ?? ''), event => {
            // 与 `api.on` 逐字同一条:拆除之后到达的事实不再进插件。退订本身排在
            // `unsubs` 里由拆除流程撤,这一句挡的是「撤销之前最后那几毫秒」。
            if (state.disposed) return
            try {
              listener(event)
            } catch (error) {
              logger.error(`[Plugin:${pluginId}] resources.watch listener error:`, undefined, error)
            }
          })
          unsubs.push(unsub)
          return unsub
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] resources.watch(${String(prefix)}) was refused:`, undefined, error)
          return () => {}
        }
      },
    } satisfies PluginResourcesApi,
  }
}
