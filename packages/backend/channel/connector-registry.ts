import type {
  IMConnector,
  ReplyTarget,
} from '@shared/ipc.js'

interface RegisteredConnector {
  connector: IMConnector
  /** 谁注册的 —— 运行期失败要记到它的熔断账上(R7)。宿主自己注册时为 undefined。 */
  ownerPluginId?: string
}

const connectors = new Map<string, RegisteredConnector>()

export interface RegisterIMConnectorOptions {
  /** 插件注册时传 —— 用于归属与失败上报。 */
  ownerPluginId?: string
  /**
   * 运行期投递失败的上报口(R7)。
   *
   * 没有它的话 `connector` 这个 scope 家族只有注册期生产者,而"降级而非禁用"
   * 这条拍板恰恰最需要一个运行期证据。
   */
  onSendFailure?(pluginId: string, connectorId: string, error: unknown): void
  onSendSuccess?(pluginId: string, connectorId: string): void
  /**
   * 这条渠道是否已被降级(R7)。
   *
   * **降级必须有牙齿。** 请求通道那两个 degrade-surface 家族在
   * `manager.handleRequest` 上被短路,而 connector 家族此前没有对应的闸 ——
   * 连败降级之后照样每次进插件的 sendReply,只多一个写着 "switched off" 的
   * 假徽章。那正是本期返工前批判的第一版形状。
   */
  isSurfaceDegraded?(pluginId: string, surface: string): boolean
  describeDegradedSurface?(pluginId: string, surface: string): string | undefined
  /**
   * 半开探测:降级满一个间隔之后放行一次(R7 收官)。
   *
   * 没有它的话降级是**单向死门** —— 解除降级要靠投递成功,而闸就在投递之前。
   */
  probeSurface?(pluginId: string, surface: string): boolean
}

let hooks: RegisterIMConnectorOptions = {}

/** 宿主接线:把投递失败接进熔断账。 */
export function configureIMConnectorHooks(options: RegisterIMConnectorOptions): void {
  hooks = options
}

export function registerIMConnector(
  connector: IMConnector,
  options: { ownerPluginId?: string } = {},
): () => void {
  const existing = connectors.get(connector.id)
  if (existing && existing.connector !== connector) {
    /*
     * 拒绝顶掉别人的 id。
     *
     * 退订按实例比对只防住了"撤下别人的",没防住"顶掉别人的":B 插件用同一个 id
     * 注册就劫持了 A 的渠道,而 A 侧没有任何错误。同期的 panel id 与 request
     * 命名空间都有守卫,这里没有就是自相矛盾。
     */
    throw new Error(
      `IM connector "${connector.id}" is already registered`
      + (existing.ownerPluginId ? ` by plugin "${existing.ownerPluginId}"` : ' by the host'),
    )
  }
  connectors.set(connector.id, { connector, ownerPluginId: options.ownerPluginId })
  return () => {
    const current = connectors.get(connector.id)
    if (current?.connector === connector) {
      connectors.delete(connector.id)
    }
  }
}

export function getIMConnector(connectorId: string): IMConnector | undefined {
  return connectors.get(connectorId)?.connector
}

/** 谁注册了这条渠道(宿主注册时为 undefined)。 */
export function getIMConnectorOwner(connectorId: string): string | undefined {
  return connectors.get(connectorId)?.ownerPluginId
}

export function listIMConnectorIds(): string[] {
  return Array.from(connectors.keys()).sort()
}

export async function sendIMReply(
  target: ReplyTarget,
  payload: {
    text: string
    sessionId: string
    messageId: string
  },
): Promise<void> {
  const registered = connectors.get(target.connector)
  if (!registered) {
    // fail-open(策略表已如实声明):说得清地失败,由调用方记为投递失败,
    // 而不是静默丢消息。没有"宿主默认渠道"可以回落。
    throw new Error(`IM connector "${target.connector}" is not registered`)
  }

  // 降级闸:与"未注册"走同一条 fail-open 路径,但错误信息要说清是**降级**
  // 而不是未注册 —— 两者的处置完全不同(一个等恢复,一个是配置错了)。
  if (registered.ownerPluginId) {
    const surface = `connector:${target.connector}`
    const degraded = hooks.isSurfaceDegraded?.(registered.ownerPluginId, surface)
    // 半开:满一个间隔放行一次真投递。成功则 onSendSuccess 解除降级,
    // 失败则重新计入熔断账 —— 这是这条渠道唯一可能自己走出来的路。
    const probing = degraded ? hooks.probeSurface?.(registered.ownerPluginId, surface) ?? false : false
    if (degraded && !probing) {
      const reason = hooks.describeDegradedSurface?.(registered.ownerPluginId, surface)
      throw new Error(
        `IM connector "${target.connector}" is switched off after repeated failures`
        + (reason ? `: ${reason}` : '.'),
      )
    }
  }
  try {
    await registered.connector.sendReply(target, payload)
    if (registered.ownerPluginId) {
      hooks.onSendSuccess?.(registered.ownerPluginId, target.connector)
    }
  } catch (error) {
    // 运行期失败进熔断账(scope `connector:<id>`)—— 策略表判为 degrade-surface:
    // 一条渠道坏掉不该放大成插件故障。
    if (registered.ownerPluginId) {
      hooks.onSendFailure?.(registered.ownerPluginId, target.connector, error)
    }
    throw error
  }
}
