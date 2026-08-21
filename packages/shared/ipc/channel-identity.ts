import type { JsonObject } from '../json.js'
import { defineRouter } from './router.js'

export type OriginTransport = 'desktop' | 'voice' | 'api' | 'im'
export type ConversationType = 'desktop' | 'dm' | 'group' | 'thread'
export type ResolvedIdentityKind = 'client-user' | 'channel-user'

export interface ChannelActor {
  externalUserId: string
  displayName?: string
  handle?: string
  avatarUrl?: string
  locale?: string
  timezone?: string
}

export interface ChannelConversation {
  connector: string
  workspaceId?: string
  externalConversationId: string
  type: ConversationType
  title?: string
  threadId?: string
}

export interface ReplyTarget {
  connector: string
  workspaceId?: string
  externalConversationId: string
  threadId?: string
  externalMessageId?: string
}

export interface ResolvedIdentity {
  kind: ResolvedIdentityKind
  userId: string
  profileId?: string
  displayName?: string
  linkedClientUserId?: string
  externalUserKey?: string
}

/**
 * 插件注入消息的身份戳(N1,docs/design/pi-benchmark-adoption-2026-08.md)。
 *
 * 两件事:**归因**(这条消息是插件写的,不是用户 —— 界面不该冒充用户)与
 * **链长**(由插件触发的轮次所产生的再触发 hop+1,上限 8)。
 * `origin.source` 同时是 `plugin:<id>`,那是 `isSystemInternalSource` 的判据;
 * 这里的 `id` 是给读得懂结构的消费方(渲染归因、账单)用的。
 */
export interface PluginMessageOriginStamp {
  id: string
  /** 第几跳。第一次由插件发起的投递是 1。 */
  hop: number
}

/**
 * 发送前被插件改写过的痕迹(N2)。
 *
 * **只记谁改的,不存原文。** 存原文 = 每条被改写的消息在盘上有两份内容,而
 * 历史重建要回答"喂给模型的是哪一份"、编辑重发要回答"编辑框里放哪一份"、
 * 上下文压缩要决定摘要哪一份 —— 三个已经很复杂的地方各多一个分叉,换来的
 * 只是一次事后取证。改写的结果**就是**这条消息的真相(用户看到的、模型看到的、
 * 重放看到的是同一份字节);这里留下的是归因,不是备份。
 *
 * `by` 是按发生顺序的 pluginId 列表 —— 链上可以有多个改写者。
 */
export interface InputTransformStamp {
  by: string[]
}

/**
 * 派工回流的身份戳(`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-5)。
 *
 * 与插件戳同一族、同一条链长账:`origin.source` 是 `task:<taskSessionId>`
 * (`isSystemInternalSource` 的前缀判据),这里的结构化字段是给读得懂它的消费方 ——
 * 渲染归因(「这条是后台任务报回来的,不是用户打的」)与循环闸。
 */
export interface TaskMessageOriginStamp {
  /** 报告是哪条工作会话发回来的。 */
  sessionId: string
  /** 第几跳(与插件戳同一本账,上限同为 8)。 */
  hop: number
}

export interface MessageOrigin {
  transport: OriginTransport
  source: 'text' | 'voice' | 'api' | string
  actor?: ChannelActor
  conversation?: ChannelConversation
  replyTarget?: ReplyTarget
  externalMessageId?: string
  receivedAt: number
  resolvedIdentity?: ResolvedIdentity
  /** 插件注入(N1)。缺席 = 不是插件写的。 */
  plugin?: PluginMessageOriginStamp
  /** 后台派工的完成回投。缺席 = 不是任务报回来的。 */
  task?: TaskMessageOriginStamp
  /** 发送前被插件改写(N2)。缺席 = 这就是用户逐字打出来的。 */
  inputTransformed?: InputTransformStamp
}

export interface IMConnectorIncomingMessage {
  content: string
  attachments?: JsonObject[]
  origin: MessageOrigin
}

export interface IMConnectorReplyPayload {
  text: string
  sessionId: string
  messageId: string
}

export interface IMConnector {
  id: string
  sendReply(target: ReplyTarget, payload: IMConnectorReplyPayload): Promise<void>
  normalizeIncoming(raw: unknown): Promise<IMConnectorIncomingMessage>
}

export interface ChannelUserLink {
  id: string
  connector: string
  workspaceId?: string
  externalUserId: string
  clientUserId: string
  createdAt: number
  updatedAt: number
}

export interface ChannelUserProfile {
  id: string
  name: string
  isMain?: boolean
  source?: 'local' | 'channel' | 'manual'
  /** Set for source 'channel': where this person was first observed. */
  connector?: string
  workspaceId?: string
  externalUserId?: string
  createdAt: number
  updatedAt: number
  lastSentAt?: number
  lastTransport?: OriginTransport
  lastConnector?: string
}

export interface ChannelIdentityListProfilesResponse {
  success: boolean
  profiles?: ChannelUserProfile[]
  error?: string
}

export interface ChannelIdentityCreateProfileRequest {
  id?: string
  name: string
  isMain?: boolean
}

export interface ChannelIdentityCreateProfileResponse {
  success: boolean
  profile?: ChannelUserProfile
  error?: string
}

export interface ChannelIdentityUpdateProfileRequest {
  id: string
  name?: string
  isMain?: boolean
}

export interface ChannelIdentityUpdateProfileResponse {
  success: boolean
  profile?: ChannelUserProfile
  error?: string
}

export interface ChannelIdentityListLinksRequest {
  connector?: string
  workspaceId?: string
  clientUserId?: string
}

export interface ChannelIdentityListLinksResponse {
  success: boolean
  links?: ChannelUserLink[]
  error?: string
}

export interface ChannelIdentityCreateLinkRequest {
  connector: string
  workspaceId?: string
  externalUserId: string
  clientUserId: string
}

export interface ChannelIdentityCreateLinkResponse {
  success: boolean
  link?: ChannelUserLink
  error?: string
}

export interface ChannelIdentityDeleteLinkRequest {
  id: string
}

export interface ChannelIdentityDeleteLinkResponse {
  success: boolean
  error?: string
}

export interface ChannelIdentityResolveRequest {
  origin: MessageOrigin
}

export interface ChannelIdentityResolveResponse {
  success: boolean
  identity?: ResolvedIdentity
  origin?: MessageOrigin
  sessionId?: string
  error?: string
}

export interface ChannelReplyDeliveryRecord {
  assistantMessageId: string
  sessionId: string
  connector: string
  replyTarget: ReplyTarget
  status: 'sent' | 'failed'
  externalReplyId?: string
  error?: string
  createdAt: number
  updatedAt: number
}

export interface ChannelDeliveryListResponse {
  success: boolean
  deliveries?: ChannelReplyDeliveryRecord[]
  error?: string
}

/**
 * 渠道身份域(主线 T1 第二批)。
 *
 * 迁移前这个域在 server 上是一份**平行实现**:`createServerChannelIdentityApi`
 * 自己读写 `<dataRoot>/channel-identity.json`,而 `@onething/backend` 的
 * `ChannelIdentityStore`(会话路由、出站回投都吃它)读的是 `<store>/channel-identity.json`。
 * 也就是说 server 的 HTTP 面和 server 自己的引擎面看的是两本账。迁到通用 RPC
 * 通道后两侧共用同一个 store —— 这不是等价搬迁,是**顺带修好一处分账**。
 *
 * 八个方法全是纯读写,零窗口、零流式、零事件推送。
 */
export type ChannelIdentityRoutes = {
  listProfiles: { input: Record<string, never>; output: ChannelIdentityListProfilesResponse }
  createProfile: { input: ChannelIdentityCreateProfileRequest; output: ChannelIdentityCreateProfileResponse }
  updateProfile: { input: ChannelIdentityUpdateProfileRequest; output: ChannelIdentityUpdateProfileResponse }
  listLinks: { input: ChannelIdentityListLinksRequest; output: ChannelIdentityListLinksResponse }
  createLink: { input: ChannelIdentityCreateLinkRequest; output: ChannelIdentityCreateLinkResponse }
  deleteLink: { input: ChannelIdentityDeleteLinkRequest; output: ChannelIdentityDeleteLinkResponse }
  resolve: { input: ChannelIdentityResolveRequest; output: ChannelIdentityResolveResponse }
  listDeliveries: { input: Record<string, never>; output: ChannelDeliveryListResponse }
}

export const channelIdentityRouter = defineRouter<ChannelIdentityRoutes>('channelIdentity', [
  'listProfiles',
  'createProfile',
  'updateProfile',
  'listLinks',
  'createLink',
  'deleteLink',
  'resolve',
  'listDeliveries',
])
