import { platformApi } from '@/platform'
import { pluginsApi } from '@/platform/plugins-client'
import { notifyApi } from '@/platform/notify-client'
import { getLogger } from '@/services/log'
/**
 * Global IPC Event Hub
 *
 * Registers IPC listeners at app startup to ensure:
 * 1. Listeners are registered before any IPC calls (no race conditions)
 * 2. All events route to central store (single source of truth)
 * 3. No per-message listener setup/teardown needed
 *
 * Phase 4c: All events use unified session:event + session:stream channels.
 * Legacy individual channels fully removed.
 */

import { useChatStore } from '@/stores/chat'
import { installUiRefoldHandle, scheduleUiRefold } from '@/stores/ui-refold'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { useInteractionsStore } from '@/stores/interactions'
import { useScratchpadStore } from '@/stores/scratchpad'
import {
  isCollabDriveMessage,
  isCollabPassMessage,
  isCollabThinkingMessage,
} from '@onething/runtime/collab'
import { toast } from '@/composables/useToast'
import { setPluginWorkspacePanels } from '@/workspace/panel-registry'
import { setPluginUiSlots } from '@/workspace/ui-anchor-registry'
import { setPluginBackground, type PluginBackgroundLayer } from '@/workspace/background-registry'
import { setPluginAmbient, type PluginAmbientLayer } from '@/workspace/ambient-registry'
import { shouldNotifyInbound, summarizeNotificationBody } from './notify-inbound'
import { playPluginNotifySound } from './plugin-notify-sound'
import type { ChatMessage } from '@/types'
import type { SessionEventEnvelope } from '@shared/events/index.js'
import type { SessionStreamPayload } from '@/platform/types'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

let initialized = false

const log = getLogger('renderer.ipc-hub')

function logTime(): string {
  return new Date().toISOString()
}

function previewText(value: unknown, maxLength = 240): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

const debugLastChunkAt = new Map<string, number>()

function debugGapMs(key: string, now = Date.now()): number | undefined {
  const previous = debugLastChunkAt.get(key)
  debugLastChunkAt.set(key, now)
  return previous === undefined ? undefined : now - previous
}

/**
 * ui-refold 的**验证器侧**取数(§17.8 U1-b):屏幕上正在渲染的那一份。
 *
 * 门只读、不碰 store 的任何状态 —— 传成回调是为了让 `ui-refold.ts` 不依赖
 * chatStore(它于是可以被单测直接喂夹具)。
 */
function readHandMessages(sessionId: string) {
  return useChatStore().sessionMessages.get(sessionId) ?? []
}

export function initializeIPCHub() {
  if (initialized) {
    log.debug('hub already initialized, skipping')
    return
  }
  initialized = true
  // §17.8 U1-b:ui-refold 的现场把手(`window.__onethingUiRefold.stats()`)。
  installUiRefoldHandle()

  // ── Unified event channel ─────────────────────
  // All structured events (steps, tools, stream lifecycle, etc.)
  platformApi.onSessionEvent((envelope: SessionEventEnvelope) => {
    const store = useChatStore()
    const { sessionId, event } = envelope

    switch (event.type) {
      // Stream lifecycle
      case SESSION_EVENT_TYPES.STREAM_COMPLETE:
        log.trace('session event stream:complete', { sessionId, event })
        store.handleStreamComplete({ sessionId, ...event.data })
        // §17.8 U1-b:**收尾采样** —— 屏幕上那份 ≡ 账本折出来的那份。
        // 挂在分发口这一处(不散进 chatStore),现有 case 的行为一格未改;
        // 判定同步、比对丢宏任务,自吞不进渲染路径(见 `ui-refold.ts`)。
        scheduleUiRefold(sessionId, readHandMessages)
        break

      case SESSION_EVENT_TYPES.STREAM_ERROR:
        log.trace('session event stream:error', { sessionId, event })
        store.handleStreamError({ sessionId, ...event.data })
        scheduleUiRefold(sessionId, readHandMessages)
        break

      case SESSION_EVENT_TYPES.STREAM_ABORTED:
        store.handleStreamComplete({ sessionId, aborted: true })
        scheduleUiRefold(sessionId, readHandMessages)
        break

      // Per-turn usage: snaps the composer's live token readout to real numbers.
      case SESSION_EVENT_TYPES.STREAM_USAGE:
        store.handleStreamUsage({ sessionId, usage: event.usage, accumulated: event.accumulated })
        break

      case SESSION_EVENT_TYPES.STREAM_START:
        log.trace('session event stream:start', {
          at: logTime(),
          sessionId,
          messageId: event.messageId || event.assistantMessageId,
        })
        store.handleStreamStarted({ sessionId, messageId: event.messageId || event.assistantMessageId })
        break

      // Tool events → mapped to stream chunk format for store compatibility.
      //
      // `event.messageId` 是发射器盖的号(core/engine/event-only-emitter.ts),必须
      // 原样传下去。这里从前一律填空串,store 只好退回 `activeStreams` 去猜「当前
      // 这条流是谁」—— 而那个绑定丢了(窗口中途重载、第二个窗口、跑起来之后才切
      // 进会话),整批工具事件就被泊死或丢弃,消息永远长不出那条调用,随后带真号
      // 来的 permission:request 就只能空等,卡片一张都不出。空串保留为兜底,给的
      // 是旧重放数据。
      case SESSION_EVENT_TYPES.TOOL_CALL:
        store.handleStreamChunk({ type: 'tool_call', sessionId, messageId: event.messageId || '', content: '', toolCall: event.toolCall })
        break

      case SESSION_EVENT_TYPES.TOOL_RESULT:
        store.handleStreamChunk({ type: 'tool_result', sessionId, messageId: event.messageId || '', content: '', toolCall: event.toolCall })
        break

      case SESSION_EVENT_TYPES.TOOL_INPUT_START:
        store.handleStreamChunk({
          type: 'tool_input_start', sessionId, messageId: event.messageId || '', content: '',
          toolCallId: event.toolCallId, toolName: event.toolName, toolCall: event.toolCall,
        })
        break

      case SESSION_EVENT_TYPES.TOOL_INPUT_END:
        store.handleStreamChunk({
          type: 'tool_input_end', sessionId, messageId: event.messageId || '', content: '',
          toolCallId: event.toolCallId, toolCall: event.toolCall,
        })
        break

      case SESSION_EVENT_TYPES.TOOL_EXECUTION_START:
        store.handleToolExecutionStart({ sessionId, messageId: '', ...event })
        break

      case SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE:
        store.handleToolExecutionUpdate({ sessionId, messageId: '', ...event })
        break

      case SESSION_EVENT_TYPES.TOOL_EXECUTION_END:
        store.handleToolExecutionEnd({ sessionId, messageId: '', ...event })
        break

      // Content events → mapped to stream chunk format
      case SESSION_EVENT_TYPES.CONTENT_PART:
        store.handleStreamChunk({ type: 'content_part', sessionId, messageId: '', content: '', contentPart: event.part })
        break

      case SESSION_EVENT_TYPES.CONTENT_CONTINUATION:
        store.handleStreamChunk({ type: 'continuation', sessionId, messageId: '', content: '', turnIndex: event.turnIndex })
        break

      // Step events(同上:认发射器盖的号,不猜活跃流)
      case SESSION_EVENT_TYPES.STEP_ADDED:
        store.handleStepAdded({ sessionId, messageId: event.messageId || '', step: event.step })
        break

      case SESSION_EVENT_TYPES.STEP_UPDATED:
        store.handleStepUpdated({ sessionId, messageId: event.messageId || '', stepId: event.stepId, updates: event.updates })
        break

      // Skill events
      case SESSION_EVENT_TYPES.SKILL_ACTIVATED:
        store.handleSkillActivated({ sessionId, messageId: '', skillName: event.skillName })
        break

      // Permission events —— 三条都只是"这个会话的欠账动了"这一句话。
      //
      // 这里从前是按事件 ± 地改 chat store 的卡片状态,与 collabBoard 的反查账本
      // 并列成两种存储模型(架构收敛 C4 §5)。现在事件统一交给账本:它去重新问一次
      // `getPendingPermissions`,再把那份全量投影到消息上。卡片出现、queued 晋升
      // actionable、settle 后消失,全部是同一份账的三个断面,不再有先后之争。
      //
      // settle 的 decision 是事件里独有的事实(账本答得出"还欠不欠",答不出"上次
      // 是批还是拒"),`notePermissionEvent` 会当场转达,不等那 200ms 的反查。
      case SESSION_EVENT_TYPES.PERMISSION_REQUEST:
      case SESSION_EVENT_TYPES.PERMISSION_QUEUED:
      case SESSION_EVENT_TYPES.PERMISSION_SETTLED:
        useCollabBoardStore().notePermissionEvent(sessionId, event)
        break

      // Interaction events(agent 提问 → 用户应答,E2)。与审批那三条逐字同一条
      // 纪律:事件只说「这个会话的欠账动了」,账本自己去 `getPendingInteractions`
      // 反查全量。settle 额外转达一个只有事件里才有的事实 —— 用户答了什么、
      // 怎么收的场 —— 卡片的历史态靠它。
      //
      // 落在**独立**的 interactions store 而不是 collabBoard:提问不是协作专属
      // (协议里 `origin: 'host-tool'` 是一等分支),而水龙头仍然只有这一个。
      case SESSION_EVENT_TYPES.INTERACTION_REQUESTED:
      case SESSION_EVENT_TYPES.INTERACTION_SETTLED:
        useInteractionsStore().noteInteractionEvent(sessionId, event)
        break

      // Message lifecycle events (event-driven message creation)
      case SESSION_EVENT_TYPES.MESSAGE_USER_CREATED:
        refreshSessionListIfUnknown(sessionId)
        noteReadWatermark(sessionId, event.message)
        notifyInbound(sessionId, event.message)
        store.handleMessageCreated({ sessionId, message: event.message })
        break

      case SESSION_EVENT_TYPES.MESSAGE_CREATED:
        noteReadWatermark(sessionId, event.message)
        notifyInbound(sessionId, event.message)
        store.handleMessageCreated({ sessionId, message: event.message })
        break

      case SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED:
        noteReadWatermark(sessionId, event.message)
        notifyInbound(sessionId, event.message)
        store.handleAssistantCreated({ sessionId, message: event.message })
        break

      case SESSION_EVENT_TYPES.MESSAGE_UPDATED:
        store.updateSessionMessage(sessionId, event.messageId, event.updates)
        break

      case SESSION_EVENT_TYPES.MESSAGE_DELETED:
        store.handleMessageDeleted({ sessionId, messageId: event.messageId })
        break

      // Steering lifecycle: track which persisted steer messages are still
      // pending in the queue (retractable before the next loop turn).
      case SESSION_EVENT_TYPES.STEERING_QUEUED:
        store.handleSteeringQueued({ sessionId, messageId: event.messageId })
        break

      case SESSION_EVENT_TYPES.STEERING_CONSUMED:
        store.handleSteeringConsumed({ sessionId, messageIds: event.messageIds })
        break

      case SESSION_EVENT_TYPES.STEERING_RETRACTED:
        store.handleSteeringConsumed({ sessionId, messageIds: [event.messageId] })
        break

      // 草稿纸的某一版真的进了模型 —— 已读水位线只认这条,不猜。
      case SESSION_EVENT_TYPES.SCRATCHPAD_CONSUMED:
        useScratchpadStore().noteConsumed(sessionId, event.version)
        break

      case SESSION_EVENT_TYPES.MESSAGES_REPLACED:
        store.handleMessagesReplaced({ sessionId, messages: event.messages })
        break

      case SESSION_EVENT_TYPES.SESSION_RENAMED:
        store.handleSessionRenamed({ sessionId, name: event.name })
        break

      // 房间配置(名册 / 房名 / PM / 预算 / 冻结 / 响应模式)变了(架构收敛 C4 §3)。
      // 载全量小快照,列表就地合并 —— 写入方不再需要各自 `loadSessions()` 全量重拉。
      case SESSION_EVENT_TYPES.SESSION_COLLAB_UPDATED:
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().applyCollabRoomUpdate(sessionId, {
            name: event.name,
            room: event.room,
          })
        })
        break

      case SESSION_EVENT_TYPES.REQUEST_SNAPSHOT:
        log.debug('request snapshot received', { sessionId, turn: event.snapshot?.turn })
        store.handleRequestSnapshot({ sessionId, snapshot: event.snapshot })
        break

      case SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED:
        // Per-turn input-token usage. Inspector's Context tab uses
        // contextSize as "last turn input" against the model's window.
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().updateSessionTokenStats(sessionId, {
            contextSize: event.contextSize,
            lastInputTokens: event.contextSize,
          })
        })
        break

      // P1(2026-08-14):压缩通知的唯一正路。started 置位、completed 清位 ——
      // stream:error 与会话切换都**不**清这个位:压缩是会话级的后台作业,和
      // 某一条流的死活无关。SSE 重连有 ring buffer 的 ?after= 回放,不丢事件。
      case SESSION_EVENT_TYPES.CONTEXT_COMPACT_STARTED:
        store.setSessionCompacting(sessionId, true)
        // C6:新一轮压缩开始 → 进度清零(上一轮的 2/5 不该留在状态条上)。
        store.setSessionCompactProgress(sessionId, null)
        break

      // C6:分块进度。只有多块摘要会发,单块压缩全程没有这条。
      case SESSION_EVENT_TYPES.CONTEXT_COMPACT_PROGRESS:
        store.setSessionCompactProgress(sessionId, {
          chunk: event.chunk,
          totalChunks: event.totalChunks,
        })
        break

      case SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED:
        store.setSessionCompacting(sessionId, false)
        store.setSessionCompactProgress(sessionId, null)
        break

      case SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED:
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().updateSessionVariables(sessionId, {
            workingDirectory: event.workingDirectory,
            workingDirectoryRoots: event.workingDirectoryRoots,
            variables: event.variables,
          })
        })
        break

      case SESSION_EVENT_TYPES.SESSION_GOAL_UPDATED:
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().updateSessionGoal(
            sessionId,
            event.goal ?? null,
            event.goals,
          )
        })
        break
    }
  })

  // ── Unified stream channel ────────────────────
  // High-frequency chunks: text-delta, reasoning-delta, tool-input-delta
  // Already batched by IPCBridge (16ms coalescing), so route directly to store.
  platformApi.onSessionStream(({ sessionId, chunk }: SessionStreamPayload) => {
    const store = useChatStore()
    // `isLevelEnabled` 是性能护栏,不是开关:previewText / debugGapMs 不该在
    // trace 关着的时候还逐 chunk 跑一遍。
    if (log.isLevelEnabled('trace')) {
      const text = chunk.type === 'text-delta'
        ? chunk.text
        : chunk.type === 'reasoning-delta'
          ? chunk.reasoning
          : chunk.type === 'tool-input-delta'
            ? chunk.argsTextDelta
            : ''
      log.trace('session stream chunk', {
        at: logTime(),
        gapMs: debugGapMs(`${sessionId}:${chunk.messageId}:${chunk.type}`),
        sessionId,
        messageId: chunk.messageId,
        type: chunk.type,
        chars: text.length,
        text: previewText(text),
      })
    }

    switch (chunk.type) {
      case 'text-delta':
        store.handleStreamChunk({ type: 'text', sessionId, messageId: chunk.messageId || '', content: chunk.text, turnIndex: chunk.turnIndex })
        break

      case 'reasoning-delta':
        store.handleStreamChunk({ type: 'reasoning', sessionId, messageId: chunk.messageId || '', content: '', reasoning: chunk.reasoning, turnIndex: chunk.turnIndex, placement: chunk.placement })
        break

      case 'tool-input-delta':
        store.handleStreamChunk({ type: 'tool_input_delta', sessionId, messageId: chunk.messageId || '', content: '', toolCallId: chunk.toolCallId, argsTextDelta: chunk.argsTextDelta })
        break
    }
  })

  // ── Plugin notifications (global, non-session) ─
  //
  // 同一条通道服务两件事:插件自己的 api.ui.notify,以及失败熔断自动禁用时的
  // 告警。两者此前都发到零订阅者的全局总线上,用户什么也看不到。
  platformApi.onPluginNotification?.((payload) => {
    if (!payload?.message) return
    // **有 kind 就是机械信号**,一律不弹 toast。
    //
    // 判据必须是"有没有 kind",不能是"是不是 config-changed":后者是白名单的
    // 反面,每加一种机械信号都得记得回来改这里,而漏改的代价是刷屏 ——
    // panel-refresh 的 message 是 `plugin-panel-refresh:log-monitor:logs`
    // 这样的机器串,插件每次 ctx.refresh() 用户就看到一个弹窗。
    // 给人看的通知(api.ui.notify、熔断告警)不带 kind。
    // 契约里已声明 kind 的全部取值(shared/ipc/plugins.ts),不再需要 cast。
    const isMechanical = Boolean(payload.kind)
    if (!isMechanical) {
      if (payload.level === 'error') toast.error(payload.message)
      else toast.info(payload.message)
      // 提示音(M1)。横幅在上面已经弹了 —— 声音是**独立的第二件事**:被静音时
      // 主进程把 sound 抹成 'none',横幅照常。这里不再判静音/限频,那两道闸在
      // 主进程判过了(判两遍 = 两份口径,多窗口下还会各响一次)。
      playPluginNotifySound(payload.sound)
    }
    // 布局动词(I 期):同一条通知轨上的另一种机械信号。手势闸与 unsupported
    // 都在主进程判完了,这里只负责把动词交给持有布局的那一层(App.vue)——
    // 深在组件树里的 ipc-hub 够不着侧栏/右栏的状态,与 practice/todo-plan 同款
    // window 事件解耦线路。
    if (payload.kind === 'layout') {
      if (payload.layout?.verb) {
        window.dispatchEvent(new CustomEvent('onething:plugin-layout', {
          detail: { ...payload.layout, pluginId: payload.pluginId },
        }))
      }
      // 布局动词与插件清单无关 —— 不该顺手触发一次面板重拉。
      return
    }
    // 面板清单只有**一条**重拉路径:派发 onething:plugins-changed,由下面那个
    // 唯一的监听器去拉。此前这里既直接调 refresh 又派发事件,同一条通知会拉两次。
    if (payload.kind !== 'panel-refresh') {
      window.dispatchEvent(new CustomEvent('onething:plugins-changed', {
        detail: { pluginId: payload.pluginId },
      }))
    }
  })

  window.addEventListener('onething:plugins-changed', () => {
    void refreshPluginWorkspacePanels()
  })

  // 插件面板清单:入口来自 manifest,所以这一步**不执行任何插件代码**。
  // 插件系统是 post-window 非阻塞装配的,这一次很可能拉了个空清单 ——
  // 装配完成时 manager 会发 kind:'catalog-changed',那一条负责把它补上。
  void refreshPluginWorkspacePanels()

  log.info('ipc hub listeners registered')
}

/**
 * 插件目录投影里这条路真正读到的那几个字段。
 *
 * 形状的单源是主进程的 `OnethingRendererPluginInfo`(plugin-list.ts),但
 * renderer 不该反向依赖 runtime 去拿它;而 `ElectronAPI['getPlugins']` 那份声明
 * 至今只覆盖了投影的前半截(没有 contributes / requestActions)。在补齐之前,
 * 这里按**本文件实际读到的字段**收窄,而不是退回 any。
 */
type PluginCatalogEntry = {
  id: string
  name: string
  enabled: boolean
  loaded?: boolean
  requestActions?: string[]
  contributes?: {
    panels?: Array<{
      id: string
      label: string
      view?: string
      entry?: string
      unsupported?: boolean
      placements?: string[]
    }>
    uiSlots?: Array<{
      anchor: string
      id: string
      label: string
      unsupported?: boolean
      drawer?: boolean
      side?: string
    }>
  }
}

/**
 * 拉一次插件面板清单。
 *
 * 数据源是 `plugins.list` 的列表投影(通用 RPC,两个宿主同一条)—— 里面已经带着 manifest 的
 * `contributes.panels`(R2 建的管道)。宿主凭它渲染入口,一行插件代码都不跑。
 */
async function refreshPluginWorkspacePanels(): Promise<void> {
  try {
    const result = await pluginsApi.getPlugins()
    if (!result?.success) return
    setPluginWorkspacePanels((result.plugins || [])
      // 停用的插件不贡献入口 —— 用户把它关了,它的界面就该消失。
      // 但**启用却加载失败**的插件入口要留着:入口来自 manifest,不需要插件跑起来,
      // 于是它还能把"这插件没起来"这件事告诉用户(声明先于代码的实际好处)。
      .filter((plugin: PluginCatalogEntry) => plugin.enabled)
      .flatMap((plugin: PluginCatalogEntry) =>
        (plugin.contributes?.panels || [])
          // 非法的 webview 声明(缺 entry / entry 越界 / 静态根非法)在投影层
          // 已经判过并标了 unsupported —— 这里把它丢掉,理由在设置页卡片上说。
          // 与未知锚点同规:降级不拒载,不计熔断。
          .filter((panel: { unsupported?: boolean }) => !panel.unsupported)
          .map((panel: { id: string; label: string; view?: string; entry?: string; placements?: string[] }) => ({
            pluginId: plugin.id,
            pluginName: plugin.name,
            panelId: panel.id,
            label: panel.label,
            loaded: Boolean(plugin.loaded),
            view: panel.view === 'webview' ? 'webview' as const : 'descriptor' as const,
            entry: panel.entry || '',
            // 出现在哪些宿主表面(H1)。投影层已缺省成 ['workspace'];这里兜底
            // 一次,让 web 端(走 /api 投影)与老版本响应也有确定值。
            placements: Array.isArray(panel.placements) && panel.placements.length
              ? panel.placements
              : ['workspace'],
            // 事实源是**活状态**(manager 登记的 action 表),不是 manifest:
            // "声明了 webview" 与 "登记了初始化数据 handler" 是两件事,
            // 纯静态面板只有前者。
            hasInit: (plugin.requestActions || []).includes(`panel:init:${panel.id}`),
          })),
      ))
    // 锚点块清单(R5.x):同一条投影路径、同一个 enabled 闸门。
    // unsupported 的块保留在注册表里(设置页据此说"该锚点宿主不认识"),
    // 挂点组件会把它们过滤掉。
    setPluginUiSlots((result.plugins || [])
      .filter((plugin: PluginCatalogEntry) => plugin.enabled)
      .flatMap((plugin: PluginCatalogEntry) =>
        // drawer / side 都是投影层**裁决后**的结果(锚点开了那个能力 + 这条
        // 声明了它;side 已归一到缺省侧);renderer 不再判第二遍,原样收下。
        (plugin.contributes?.uiSlots || []).map((slot: { anchor: string; id: string; label: string; unsupported?: boolean; drawer?: boolean; side?: string }) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          anchor: slot.anchor,
          slotId: slot.id,
          label: slot.label,
          loaded: Boolean(plugin.loaded),
          unsupported: Boolean(slot.unsupported),
          drawer: Boolean(slot.drawer),
          // 响应里没有这个字段(旧宿主 / server 只读镜像)时留空 ——
          // 分侧锚点上 uiSlotSideOf 会兜回缺省侧,不分侧的锚点本来就没有侧。
          side: typeof slot.side === 'string' ? slot.side : '',
        })),
      ))
    // 背景层(G 期,L2.5):裁决(谁压谁、启用闸门、钳制、URL 拼装)全在主进程
    // 的清单投影里做完,这里收的是**结论**。搭的是同一班车 —— 同一次拉取、
    // 同一条 onething:plugins-changed,没有第二条通道。
    // 响应里没有这个字段(旧宿主 / server 只读镜像)时读成 null = 没有背景,
    // 而不是"保持上一次" —— 那会让一次降级把一张撤不掉的图钉在屏幕上。
    setPluginBackground((result as { background?: PluginBackgroundLayer | null }).background ?? null)
    // 氛围层(G2,全窗动画覆盖):与背景层同一条规矩 —— 裁决全在主进程投影里
    // 做完,这里收的是**结论**(胜出的 winner 或 null),搭同一班车。字段缺失
    // (旧宿主 / server 只读镜像)读成 null = 没有氛围,而不是"保持上一次"。
    // 用户的总闸 / 每插件静音在 App.vue 那一层叠加,不在这里。
    setPluginAmbient((result as { ambient?: PluginAmbientLayer | null }).ambient ?? null)
  } catch (error) {
    log.error('plugin workspace panel refresh failed', {}, error)
  }
}

/**
 * 已读水位的唯一喂料口(docs/design/agent-im-dm.md P4)。
 *
 * 判定按**消息的 role**,不按事件名 —— 房间里 agent 的 say 走的正是
 * `message:user-created` 这条通道(`app/collab/say-tool.ts` 头注释),事件名在这里
 * 什么也证明不了。
 * - `user`      自己说的话(含网关那头的自己):推进水位,不是未读源;
 * - `assistant` 对方说话:未读源;
 * - `system`    预算/断路器/冻结这类机械台账(`postSystemLine`):既不是人说话,
 *               也不该让联系人行冒红点,一律不计。
 *
 * 只吃 message:* 落库事件,不碰流式 chunk —— 徽标因此不会在生成过程中闪。
 */
function noteReadWatermark(sessionId: string, message: ChatMessage): void {
  const role = (message as { role?: string } | undefined)?.role
  if (role !== 'user' && role !== 'assistant') return
  const raw = (message as { timestamp?: number } | undefined)?.timestamp
  const at = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : Date.now()
  import('@/stores/sessions').then(({ useSessionsStore }) => {
    const sessionsStore = useSessionsStore()
    if (role === 'user') sessionsStore.markSessionRead(sessionId, at)
    else sessionsStore.noteInboundActivity(sessionId, at)
  }).catch(error => {
    log.error('read watermark update failed', { sessionId, role }, error)
  })
}

/**
 * 私聊来消息的系统通知(agent-dm-user.md §4.3)—— 与水位同一个分流点。
 *
 * 挂在 `noteReadWatermark` 旁边不是巧合:两者吃的是同一批事件、同一条"这是不是
 * 有人跟你说话"的判定。分开挂就会分开漂移。
 *
 * 「是不是用户私聊房」读 store 的 `isUserDmRoomSession` selector,**禁止**在这里
 * 自己写 `room.dm` 判定 —— 房形态的口径只有一处。
 */
const lastNotifiedAt = new Map<string, number>()

function notifyInbound(sessionId: string, message: ChatMessage): void {
  const record = message as {
    role?: string
    content?: string
    agentId?: string
  } | undefined
  if (!record || record.role !== 'assistant') return

  // 只有 store 走动态 import(hub 一贯的解环手法);判定用的三个谓词是产品层
  // 纯函数,静态引进来 —— 它们不参与任何环,而每多一次动态 import 就多一拍延迟。
  Promise.all([
    import('@/stores/sessions'),
    import('@/stores/settings'),
    import('@/stores/agents'),
  ]).then(([
    { useSessionsStore },
    { useSettingsStore },
    { useAgentsStore },
  ]) => {
    const sessionsStore = useSessionsStore()
    const now = Date.now()
    const decided = shouldNotifyInbound({
      role: record.role,
      structural: isCollabDriveMessage(record as never)
        || isCollabPassMessage(record.content ?? '')
        || isCollabThinkingMessage(record as never),
      onScreen: sessionsStore.isSessionOnScreen(sessionId),
      userDmRoom: sessionsStore.isUserDmRoomSession(sessionId),
      enabled: useSettingsStore().settings?.general?.dmNotifications !== false,
      lastNotifiedAt: lastNotifiedAt.get(sessionId),
      now,
    })
    if (!decided) return

    const body = summarizeNotificationBody(record.content)
    if (!body) return

    lastNotifiedAt.set(sessionId, now)
    // 标题是发言人,不是房名:私聊房的名字就是 agent 的名字,而通知栏里
    // 「小李」比「小李 · 私聊」更像一条来自人的消息。
    const identity = useAgentsStore().displayAgent(record.agentId)
    void notifyApi.show({
      title: identity?.name || '新消息',
      body,
      sessionId,
    })
  }).catch(error => {
    log.error('inbound notification failed', { sessionId }, error)
  })
}

/**
 * Sessions created in the main process (gateway conversations, the radio DJ's
 * curation sessions, any future internal drives) never pass through the
 * renderer's own create flow — the first the renderer hears of them is a
 * message event for an id it does not know. Reload the list then, or the
 * session stays invisible until an app restart.
 */
function refreshSessionListIfUnknown(sessionId: string): void {
  import('@/stores/sessions').then(({ useSessionsStore }) => {
    const sessionsStore = useSessionsStore()
    if (sessionsStore.getSessionItem(sessionId)) return
    void sessionsStore.loadSessions()
  }).catch(error => {
    log.error('session list refresh failed', { sessionId }, error)
  })
}
