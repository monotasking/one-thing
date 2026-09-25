import type { ContentBlock, InitializeResponse } from '@agentclientprotocol/sdk'
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
}

export type AcpConnectorOptions = Partial<AcpConnectorDeps>

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
      const opened = await deps.openSession(agentId, request.localSessionId, request.cwd, persona ? { persona } : {})
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
