import { platformApi } from '@/platform'
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
import type { SessionEventEnvelope } from '@shared/events/index.js'

let initialized = false

function shouldDebugStream(): boolean {
  try {
    return localStorage.getItem('onething:debug-stream') === '1'
  } catch {
    return false
  }
}

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

export function initializeIPCHub() {
  if (initialized) {
    console.log('[IPC Hub] Already initialized, skipping')
    return
  }
  initialized = true

  // ── Unified event channel ─────────────────────
  // All structured events (steps, tools, stream lifecycle, etc.)
  platformApi.onSessionEvent((envelope: SessionEventEnvelope) => {
    const store = useChatStore()
    const { sessionId, event } = envelope

    switch (event.type) {
      // Stream lifecycle
      case 'stream:complete':
        if (shouldDebugStream()) {
          console.log('[IPC Hub] session:event stream:complete', { sessionId, event })
        }
        store.handleStreamComplete({ sessionId, ...event.data })
        break

      case 'stream:error':
        if (shouldDebugStream()) {
          console.log('[IPC Hub] session:event stream:error', { sessionId, event })
        }
        store.handleStreamError({ sessionId, ...event.data })
        break

      case 'stream:aborted':
        store.handleStreamComplete({ sessionId, aborted: true })
        break

      case 'stream:start':
        if (shouldDebugStream()) {
          console.log('[IPC Hub] session:event stream:start', {
            time: logTime(),
            sessionId,
            messageId: event.messageId || event.assistantMessageId,
          })
        }
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
      case 'tool:call':
        store.handleStreamChunk({ type: 'tool_call', sessionId, messageId: event.messageId || '', content: '', toolCall: event.toolCall })
        break

      case 'tool:result':
        store.handleStreamChunk({ type: 'tool_result', sessionId, messageId: event.messageId || '', content: '', toolCall: event.toolCall })
        break

      case 'tool:input-start':
        store.handleStreamChunk({
          type: 'tool_input_start', sessionId, messageId: event.messageId || '', content: '',
          toolCallId: event.toolCallId, toolName: event.toolName, toolCall: event.toolCall,
        })
        break

      case 'tool:input-end':
        store.handleStreamChunk({
          type: 'tool_input_end', sessionId, messageId: event.messageId || '', content: '',
          toolCallId: event.toolCallId, toolCall: event.toolCall,
        })
        break

      case 'tool:execution-start':
        store.handleToolExecutionStart({ sessionId, messageId: '', ...event })
        break

      case 'tool:execution-update':
        store.handleToolExecutionUpdate({ sessionId, messageId: '', ...event })
        break

      case 'tool:execution-end':
        store.handleToolExecutionEnd({ sessionId, messageId: '', ...event })
        break

      // Content events → mapped to stream chunk format
      case 'content:part':
        store.handleStreamChunk({ type: 'content_part', sessionId, messageId: '', content: '', contentPart: event.part })
        break

      case 'content:continuation':
        store.handleStreamChunk({ type: 'continuation', sessionId, messageId: '', content: '', turnIndex: event.turnIndex })
        break

      // Step events(同上:认发射器盖的号,不猜活跃流)
      case 'step:added':
        store.handleStepAdded({ sessionId, messageId: event.messageId || '', step: event.step })
        break

      case 'step:updated':
        store.handleStepUpdated({ sessionId, messageId: event.messageId || '', stepId: event.stepId, updates: event.updates })
        break

      // Skill events
      case 'skill:activated':
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
      case 'permission:request':
      case 'permission:queued':
      case 'permission:settled':
        useCollabBoardStore().notePermissionEvent(sessionId, event)
        break

      // Interaction events(agent 提问 → 用户应答,E2)。与审批那三条逐字同一条
      // 纪律:事件只说「这个会话的欠账动了」,账本自己去 `getPendingInteractions`
      // 反查全量。settle 额外转达一个只有事件里才有的事实 —— 用户答了什么、
      // 怎么收的场 —— 卡片的历史态靠它。
      //
      // 落在**独立**的 interactions store 而不是 collabBoard:提问不是协作专属
      // (协议里 `origin: 'host-tool'` 是一等分支),而水龙头仍然只有这一个。
      case 'interaction:requested':
      case 'interaction:settled':
        useInteractionsStore().noteInteractionEvent(sessionId, event)
        break

      // Message lifecycle events (event-driven message creation)
      case 'message:user-created':
        refreshSessionListIfUnknown(sessionId)
        noteReadWatermark(sessionId, (event as any).message)
        notifyInbound(sessionId, (event as any).message)
        store.handleMessageCreated({ sessionId, message: (event as any).message })
        break

      case 'message:created':
        noteReadWatermark(sessionId, (event as any).message)
        notifyInbound(sessionId, (event as any).message)
        store.handleMessageCreated({ sessionId, message: (event as any).message })
        break

      case 'message:assistant-created':
        noteReadWatermark(sessionId, (event as any).message)
        notifyInbound(sessionId, (event as any).message)
        store.handleAssistantCreated({ sessionId, message: (event as any).message })
        break

      case 'message:updated':
        store.updateSessionMessage(sessionId, (event as any).messageId, (event as any).updates)
        break

      case 'message:deleted':
        store.handleMessageDeleted({ sessionId, messageId: (event as any).messageId })
        break

      // Steering lifecycle: track which persisted steer messages are still
      // pending in the queue (retractable before the next loop turn).
      case 'steering:queued':
        store.handleSteeringQueued({ sessionId, messageId: (event as any).messageId })
        break

      case 'steering:consumed':
        store.handleSteeringConsumed({ sessionId, messageIds: (event as any).messageIds })
        break

      case 'steering:retracted':
        store.handleSteeringConsumed({ sessionId, messageIds: [(event as any).messageId] })
        break

      // 草稿纸的某一版真的进了模型 —— 已读水位线只认这条,不猜。
      case 'scratchpad:consumed':
        useScratchpadStore().noteConsumed(sessionId, (event as any).version)
        break

      case 'messages:replaced':
        store.handleMessagesReplaced({ sessionId, messages: (event as any).messages })
        break

      case 'session:renamed':
        store.handleSessionRenamed({ sessionId, name: (event as any).name })
        break

      // 房间配置(名册 / 房名 / PM / 预算 / 冻结 / 响应模式)变了(架构收敛 C4 §3)。
      // 载全量小快照,列表就地合并 —— 写入方不再需要各自 `loadSessions()` 全量重拉。
      case 'session:collab-updated':
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().applyCollabRoomUpdate(sessionId, {
            name: (event as any).name,
            room: (event as any).room,
          })
        })
        break

      case 'request:snapshot':
        console.log('[IPCHub] request:snapshot', sessionId, (event as any).snapshot?.turn)
        store.handleRequestSnapshot({ sessionId, snapshot: (event as any).snapshot })
        break

      case 'context:size-updated':
        // Per-turn input-token usage. Inspector's Context tab uses
        // contextSize as "last turn input" against the model's window.
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().updateSessionTokenStats(sessionId, {
            contextSize: (event as any).contextSize,
            lastInputTokens: (event as any).contextSize,
          })
        })
        break

      case 'session:variables-updated':
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().updateSessionVariables(sessionId, {
            workingDirectory: (event as any).workingDirectory,
            workingDirectoryRoots: (event as any).workingDirectoryRoots,
            variables: (event as any).variables,
          })
        })
        break

      case 'session:goal-updated':
        import('@/stores/sessions').then(({ useSessionsStore }) => {
          useSessionsStore().updateSessionGoal(
            sessionId,
            (event as any).goal ?? null,
            (event as any).goals,
          )
        })
        break
    }
  })

  // ── Unified stream channel ────────────────────
  // High-frequency chunks: text-delta, reasoning-delta, tool-input-delta
  // Already batched by IPCBridge (16ms coalescing), so route directly to store.
  platformApi.onSessionStream(({ sessionId, chunk }: { sessionId: string; chunk: any }) => {
    const store = useChatStore()
    if (shouldDebugStream()) {
      const text = typeof chunk.text === 'string'
        ? chunk.text
        : typeof chunk.reasoning === 'string'
          ? chunk.reasoning
          : typeof chunk.argsTextDelta === 'string'
            ? chunk.argsTextDelta
            : ''
      console.log('[IPC Hub] session:stream chunk', {
        time: logTime(),
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

  console.log('[IPC Hub] Unified listeners registered (session:event + session:stream + plugin notifications)')
}

/**
 * 拉一次插件面板清单。
 *
 * 数据源是 `/api/plugins` 或 IPC 的列表投影 —— 里面已经带着 manifest 的
 * `contributes.panels`(R2 建的管道)。宿主凭它渲染入口,一行插件代码都不跑。
 */
async function refreshPluginWorkspacePanels(): Promise<void> {
  try {
    const result = await platformApi.getPlugins()
    if (!result?.success) return
    setPluginWorkspacePanels((result.plugins || [])
      // 停用的插件不贡献入口 —— 用户把它关了,它的界面就该消失。
      // 但**启用却加载失败**的插件入口要留着:入口来自 manifest,不需要插件跑起来,
      // 于是它还能把"这插件没起来"这件事告诉用户(声明先于代码的实际好处)。
      .filter((plugin: any) => plugin.enabled)
      .flatMap((plugin: any) =>
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
      .filter((plugin: any) => plugin.enabled)
      .flatMap((plugin: any) =>
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
    console.error('[IPC Hub] Failed to refresh plugin workspace panels:', error)
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
function noteReadWatermark(sessionId: string, message: unknown): void {
  const role = (message as { role?: string } | undefined)?.role
  if (role !== 'user' && role !== 'assistant') return
  const raw = (message as { timestamp?: number } | undefined)?.timestamp
  const at = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : Date.now()
  import('@/stores/sessions').then(({ useSessionsStore }) => {
    const sessionsStore = useSessionsStore()
    if (role === 'user') sessionsStore.markSessionRead(sessionId, at)
    else sessionsStore.noteInboundActivity(sessionId, at)
  }).catch(error => {
    console.error('[IPC Hub] Failed to update read watermark:', error)
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

function notifyInbound(sessionId: string, message: unknown): void {
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
    void platformApi.notify?.show({
      title: identity?.name || '新消息',
      body,
      sessionId,
    })
  }).catch(error => {
    console.error('[IPC Hub] Failed to raise inbound notification:', error)
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
    console.error('[IPC Hub] Failed to refresh session list:', error)
  })
}
