import type { ContentBlock, InitializeResponse, McpServer } from '@agentclientprotocol/sdk'
import { findAgentExecutorDescriptor } from '../agent/executor/capabilities.js'
import { ACPManager } from '../acp/manager.js'
import { ACP_CONNECTOR_ID } from '../acp/session-links.js'
import { translateACPPromptStream, type ACPWireStreamEvent } from '../acp/translate.js'
import type { ACPOpenSessionOptions, ACPPromptStreamOptions } from '../acp/types.js'
import { getLogger } from '../logging/index.js'
import type {
  ExternalAgentCapabilities,
  ExternalAgentConnector,
  ExternalAgentEvent,
  ExternalAgentImageInput,
  ExternalAgentTurnRequest,
} from './types.js'

export { ACP_CONNECTOR_ID }

/**
 * 连接器够得着 ACP 的那几件事。缺省全接 `ACPManager`;测试换成假的。
 * 连接器本身不持有任何连接或会话 —— 生命周期归 `ACPManager`(闲置回收 + 关机)。
 */
export interface AcpConnectorDeps {
  openSession(
    agentId: string,
    localSessionId: string,
    cwd: string,
    open?: ACPOpenSessionOptions,
  ): Promise<{ acpSessionId: string; cwd: string }>
  streamPrompt(agentId: string, options: ACPPromptStreamOptions): AsyncIterable<ACPWireStreamEvent>
  cancelSession(localSessionId: string): Promise<void>
  handshake(agentId: string): InitializeResponse | undefined
  /** 连上并握手、不开会话(A2-a):让 `capabilitiesFor` 在第一条消息上就答真话。 */
  prepare(agentId: string): Promise<void>
  /**
   * 宿主工具面(A4-b,方案 §3.6 / §11.5)。产品层不认识装配层的桥与凭据表,所以它是一个端口:
   * 缺席 = 这个进程没有宿主工具面,`session/new` 照旧递空表(旧行为)。
   */
  hostMcp?: AcpHostMcpPort
}

/** agent 握手自报的 MCP 传输能力(`agentCapabilities.mcpCapabilities` 的子集)。 */
export interface AcpMcpCapabilitiesInput {
  http?: boolean
  sse?: boolean
}

/**
 * 装配层递进来的宿主工具面(A4-b)。
 *
 * `serversFor` 在**握手之后、开会话之前**问:它要握手里的 `mcpCapabilities` 选形(HTTP 直连还是
 * stdio 桥),而答案要进 `session/new` —— 会话开出来之后再给就进不去了。它顺带签(或沿用)这对
 * (agent, 会话)的桥凭据,所以一条会话多轮拿到的是同一把钥匙。
 *
 * `beginTurn` 在这一轮的 prompt 发出去之前调,把这一轮的 `messageId` / 中止信号挂到那把钥匙背后
 * (agent 经桥调宿主工具时,工具就知道自己在替哪条消息说话);返回的函数在这一轮收场时调。
 */
export interface AcpHostMcpPort {
  serversFor(input: {
    agentId: string
    localSessionId: string
    cwd: string
    executionContext?: unknown
    mcpCapabilities?: AcpMcpCapabilitiesInput
  }): Promise<McpServer[]> | McpServer[]
  beginTurn?(
    agentId: string,
    localSessionId: string,
    turn: { messageId?: string; abortSignal?: AbortSignal },
  ): () => void
}

export type AcpConnectorOptions = Partial<AcpConnectorDeps>

/** 能力表(E0)说 ACP 执行器接得住宿主工具才递 —— 装上端口不等于开着(与 Claude 路同一道门)。 */
function executorAcceptsHostTools(): boolean {
  return findAgentExecutorDescriptor(ACP_CONNECTOR_ID)?.capabilities.hostTools === true
}

const managerDeps: AcpConnectorDeps = {
  openSession: (agentId, localSessionId, cwd, open) => ACPManager.openSession(agentId, localSessionId, cwd, open),
  streamPrompt: (agentId, options) => ACPManager.streamPrompt(agentId, options) as AsyncIterable<ACPWireStreamEvent>,
  cancelSession: localSessionId => ACPManager.cancelSession(localSessionId),
  handshake: agentId => ACPManager.getAgentHandshake(agentId),
  prepare: agentId => ACPManager.prepareAgent(agentId),
}

const log = getLogger('acp.connector')

/**
 * 还没握过手时的答案:只说协议保证的那几条,自述才有的一律 false。
 * 握手之后由 `capabilitiesFromHandshake` 按那台 agent 自己的话改写。
 */
const ACP_BASELINE_CAPABILITIES: ExternalAgentCapabilities = {
  streamingText: true,
  thinking: true,
  toolSteps: true,
  permissionBridge: 'rpc',
  resume: false,
  fork: false,
  steer: false,
  imagesIn: false,
  mcpInjection: 'config',
  concurrentSessions: 'multiplexed',
}

/** 能力来自 agent 在 `initialize` 里的自述,不来自我们的猜测。 */
export function capabilitiesFromHandshake(handshake: InitializeResponse | undefined): ExternalAgentCapabilities {
  if (!handshake) return ACP_BASELINE_CAPABILITIES
  const agent = handshake.agentCapabilities
  const meta = handshake._meta as { steering?: { supported?: unknown } } | null | undefined
  return {
    ...ACP_BASELINE_CAPABILITIES,
    steer: Boolean(meta?.steering?.supported),
    imagesIn: agent?.promptCapabilities?.image === true,
    resume: agent?.loadSession === true || agent?.sessionCapabilities?.resume != null,
  }
}

/**
 * 图片 → ACP 内容块。data URL / 裸 base64 走 `image` 块;http(s) 地址走 `resource_link`
 * (协议基线要求每台 agent 都认它),不在这里替 agent 去下载。
 */
function imageToContentBlock(input: ExternalAgentImageInput): ContentBlock {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(input.image)
  if (dataUrl) return { type: 'image', mimeType: dataUrl[1]!, data: dataUrl[2]! }
  if (/^https?:\/\//i.test(input.image)) {
    const name = input.image.split('?')[0]!.split('/').pop() || 'image'
    return { type: 'resource_link', uri: input.image, name, ...(input.mediaType ? { mimeType: input.mediaType } : {}) }
  }
  return { type: 'image', mimeType: input.mediaType ?? 'image/png', data: input.image }
}

/**
 * ACP 的外部 agent 连接器(A0-3 起是生产实现,与 Claude 那条走同一个
 * `createExternalAgentProvider` 包装器)。一个连接器服务所有配置好的 ACP agent:
 * 本轮的 `model` 就是 agent id。
 *
 * 一轮 = 先开(或恢复)会话并交出链接(`session-established`),再把 prompt 的事件流
 * 交给 `acp/translate.ts` 翻成引擎回合事件。整份 system prompt 不送:ACP 没有 system 位,
 * 整份拼进用户消息会把本地工具说明灌给一个根本没有这些工具的 agent。只送 persona
 * (`request.persona`,A2-a):怎么送(`_meta` 还是首条 prompt 头块)、送不送(恢复的会话不送)
 * 由 `ACPClient` 按这条 agent 会话的实情定。
 */
export function createAcpConnector(options: AcpConnectorOptions = {}): ExternalAgentConnector {
  const deps: AcpConnectorDeps = { ...managerDeps, ...options }
  return {
    id: ACP_CONNECTOR_ID,
    capabilities: ACP_BASELINE_CAPABILITIES,

    capabilitiesFor(model: string | undefined): ExternalAgentCapabilities {
      return model ? capabilitiesFromHandshake(deps.handshake(model)) : ACP_BASELINE_CAPABILITIES
    },

    /**
     * A0-3 留账:包装器在 `streamTurn` 之前就问能力,那时还没握过手,首轮带图被说成「送不出」。
     * 这里先连上握手;失败不抛 —— 同一个错误会在 `streamTurn` 开会话时以正常的方式交给用户。
     */
    async prepare(model: string | undefined): Promise<void> {
      if (!model || deps.handshake(model)) return
      try {
        await deps.prepare(model)
      } catch (error) {
        log.warn('prepare (connect before capabilities) failed', { agentId: model }, error)
      }
    },

    async *streamTurn(request: ExternalAgentTurnRequest): AsyncIterable<ExternalAgentEvent> {
      const agentId = request.model
      if (!agentId) throw new Error('ACP agent id is missing (the turn model names the agent)')

      const persona = request.persona?.trim() || undefined
      /*
       * A4-b 顺序:握手 → 问名册 → 开会话。名册的形状取决于握手(agent 自报 `mcpCapabilities.http`
       * 就给 HTTP 直连,否则 stdio 桥),而它只进得去 `session/new` / `load` / `resume`。包装器通常
       * 已经 `prepare` 过;没有就在这里补一次(失败不抛:开会话会以正常的方式把同一个错交出去)。
       */
      let mcpServers: McpServer[] | undefined
      if (deps.hostMcp && executorAcceptsHostTools()) {
        if (!deps.handshake(agentId)) {
          await deps.prepare(agentId).catch(error => log.warn('prepare before host tools failed', { agentId }, error))
        }
        const mcpCapabilities = deps.handshake(agentId)?.agentCapabilities?.mcpCapabilities ?? undefined
        try {
          mcpServers = await deps.hostMcp.serversFor({
            agentId,
            localSessionId: request.localSessionId,
            cwd: request.cwd,
            ...(request.executionContext === undefined ? {} : { executionContext: request.executionContext }),
            ...(mcpCapabilities ? { mcpCapabilities } : {}),
          })
        } catch (error) {
          // 组不出名册的代价是这一轮没有宿主工具,抛出去的代价是这一轮什么都没有(与 Claude 路同一取舍)。
          log.warn('host MCP servers unavailable for this turn', { agentId, sessionId: request.localSessionId }, error)
        }
      }
      const opened = await deps.openSession(agentId, request.localSessionId, request.cwd, {
        ...(persona ? { persona } : {}),
        ...(mcpServers ? { mcpServers } : {}),
      })
      const now = Date.now()
      yield {
        type: 'session-established',
        link: {
          localSessionId: request.localSessionId,
          connectorId: ACP_CONNECTOR_ID,
          agentId,
          externalSessionId: opened.acpSessionId,
          cwd: opened.cwd,
          createdAt: request.resume?.createdAt ?? now,
          lastUsedAt: now,
        },
      }

      const extraContent = (request.images ?? []).map(imageToContentBlock)
      // 这一轮挂到桥凭据背后(宿主工具据此知道在替哪条消息说话);收场(含中止 / 抛错)时摘掉。
      const endTurn = mcpServers
        ? deps.hostMcp?.beginTurn?.(agentId, request.localSessionId, {
            ...(request.messageId ? { messageId: request.messageId } : {}),
            ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
          })
        : undefined
      try {
        yield* translateACPPromptStream(
          deps.streamPrompt(agentId, {
            localSessionId: request.localSessionId,
            prompt: request.prompt,
            cwd: request.cwd,
            abortSignal: request.abortSignal,
            ...(request.messageId ? { messageId: request.messageId } : {}),
            ...(extraContent.length > 0 ? { extraContent } : {}),
            ...(persona ? { persona } : {}),
          }),
          request.turn,
        )
      } finally {
        endTurn?.()
      }
    },

    /** `session/cancel`:对这条本地会话在任一台 ACP agent 上的在飞回合。 */
    async interrupt(localSessionId: string): Promise<void> {
      await deps.cancelSession(localSessionId)
    },

    async dispose(): Promise<void> {
      // 连接与会话归 ACPManager(闲置回收 + 关机),连接器这里没有东西要收。
    },
  }
}
