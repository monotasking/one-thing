/**
 * 每日摘要的后台生成(collab-agent-view.md P2)。
 *
 * 触发时机是**回合收尾之后**,不是投影构建的时候:投影是同步的,而这里要发一次
 * 模型调用。所以它永远晚一步 —— 今天第一个回合看到的折叠段还没有摘要,那一轮
 * 结束后才补上,下一轮才读得到。这是刻意的:让投影去等一次网络往返,等于把
 * 每个回合的首字延迟押在一个后台任务上。
 *
 * 可配置(用户要求:**后台触发一律可关**):`room.context.dailyDigest`。
 * 缺省开启 —— 一间房一天一次、输入是那一天的原文、输出 ≤200 字符,真机量级约
 * 每天每房 $0.003;而关掉之后 `<Folded>` 行仍在,只是不再说被折掉了什么。
 *
 * 三条纪律,与 willingness-runner 同源:
 *  - 有死线(30s),超时/报错/解析不出都当"这天没摘要",不写文件、不重试到死;
 *  - 计费打 `collab-digest`,这笔后台开销在用量面板里看得见;
 *  - 同一间房同一天不并发跑两次(inFlight 去重),回合是并行的,而它们看到的
 *    折叠段是同一份。
 */
import {
  buildCollabDigestPrompt,
  collectCollabFoldedFacts,
  parseCollabDigestReply,
  planCollabHistoryWindow,
  type CollabAgentLike,
  type CollabDayDigest,
} from '@onething/runtime/collab'
import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import { findAgent } from '../agents/index.js'
import { collabSessionRoomMembers } from './members.js'
import { generateChatResponse } from '../providers/index.js'
import {
  getEffectiveProviderConfig,
  resolveProviderAuth,
} from '../engine/stream/provider-helpers.js'
import { collabUserPromptFields } from './user-identity.js'
import type { CollabDigestStore } from '@onething/runtime/collab/digest-store'
import { getLogger } from '../logging/index.js'

import type { RuntimeRequestContext } from '@onething/core'
import type { SessionAccess } from '../../session/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import type { captureUsageRecorder } from '../usage/index.js'
import { ONETHING_USAGE_SOURCES } from '@onething/runtime/usage'
import { getCurrentBackend } from '../../current.js'

const log = getLogger('collab.digest')


/** 一次摘要调用的死线。它是后台任务,没人在等它,但也不该永远挂着。 */
const DIGEST_TIMEOUT_MS = 30_000
/** 输出上限。摘要要跟 `<Folded>` 并排,不是一篇纪要。 */
const DIGEST_MAX_TOKENS = 256

type GenerateConfig = Parameters<typeof generateChatResponse>[1]

/** 摘要功能开关。缺省开启;`false` 关掉整条后台链路。 */
export function isCollabDigestEnabled(session: ChatSession | undefined): boolean {
  return session?.room?.context?.dailyDigest !== false
}

export function createCollabDigestRunner(options: {
  store: CollabDigestStore
  access: SessionAccess
  assertOwned(): void
  recordUsage: ReturnType<typeof captureUsageRecorder>
  timeoutMs?: number
}) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new RangeError('Digest timeout must be positive')
  let closed = false
  const controllers = new Map<AbortController, string>()
  const active = new Map<Promise<void>, string>()
  function assertRoom(context: RuntimeRequestContext, roomSessionId: string): void {
    if (closed) throw new Error('Collab digest runner is shutting down')
    options.assertOwned()
    options.access.resolve(context, roomSessionId, 'write')
  }
  /** 同房同日不并发。key = `${roomSessionId}\n${day}`。 */
  const inFlight = new Set<string>()

  /** 本地时区的 `YYYY-MM-DD` —— 与信封时间、折叠行同口径。 */
  function dayOf(timestamp: number): string {
    const at = new Date(timestamp)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  }

  /**
   * 摘要的署名表。
   *
   * 与激活面相反,这里 **退休的照列**(`includeRetired`):摘要回答的是"这条是
   * 谁说的",而退休不会让说过的话消失 —— 漏掉它,那一天的转录里就会冒出一个
   * 「前成员」占位顶替一个名字还在的人。
   *
   * 不带头像也不带 description:摘要是散文,进不去也用不上。
   */
  function roomAgents(session: ChatSession): CollabAgentLike[] {
    return collabSessionRoomMembers(session, { withAvatar: false, includeRetired: true })
  }

  /**
   * 这间房当前**真正被折叠掉**的那些消息(P5-2)。
   *
   * 摘要读的必须和同事读不到的是同一批话 —— 摘要一旦覆盖模型明明看得见的内容,
   * 它就是在复述;一旦漏掉真被折掉的内容,那段历史就彻底断线。所以这里不再自己
   * 写一套"什么算一条消息"的筛法(此前那套把 MARKED 系统行整段丢掉,于是卡片
   * 流转记录既进不了摘要、也查不回来),而是喂给投影用的同一个规划器。
   *
   * **按房算,不按人算**:不传游标 → 没有未读 → 折叠集合取到最大,那正是所有
   * 同事折叠段的并集。一个刚回来、未读横跨三天的同事看到的折叠段更短,但它看到的
   * 那几天一定在这个集合里。
   */
  function foldedFactsOfRoom(session: ChatSession, now: number): ChatMessage[] {
    const messages = sessionReads.listMessages(session.id).messages
    const window = planCollabHistoryWindow({
      messages,
      now,
      ...(session.room?.context ?? {}),
    })
    if (window.cut === undefined) return []
    return collectCollabFoldedFacts(messages, window)
  }

  function messagesOfDay(session: ChatSession, day: string, now: number): ChatMessage[] {
    return foldedFactsOfRoom(session, now).filter(
      message => dayOf(message.timestamp ?? 0) === day,
    )
  }

  async function generateOne(roomSessionId: string, day: string, context: RuntimeRequestContext): Promise<void> {
    assertRoom(context, roomSessionId)
    const controller = new AbortController()
    controllers.set(controller, roomSessionId)
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DIGEST_TIMEOUT_MS)
    let receivingUsage = false
    try {
      const session = store.getSession(roomSessionId)
      if (session?.kind !== 'room') return
      const messages = messagesOfDay(session, day, Date.now())
      if (!messages.length || !options.store.needsCollabDigest(roomSessionId, day, messages.length)) return

      const { providerId, providerConfig, model } = getEffectiveProviderConfig(store.getSettings(), roomSessionId, null)
      if (!providerConfig || !model) return
      const auth = await resolveProviderAuth(providerId, providerConfig)
      if (controller.signal.aborted || !auth) return
      assertRoom(context, roomSessionId)
      const config = {
        ...providerConfig, model,
        selectedModels: providerConfig.selectedModels?.length ? providerConfig.selectedModels : [model],
        apiKey: auth.kind === 'api-key' ? auth.apiKey : '',
        authContext: auth,
        oauthToken: auth.kind === 'oauth' ? auth.token : providerConfig.oauthToken,
      } as unknown as GenerateConfig
      const { system, user } = buildCollabDigestPrompt({
        roomName: session.name || '房间', day, messages, agents: roomAgents(session),
        resolveAgentName: agentId => findAgent(agentId)?.name,
        ...collabUserPromptFields(),
      })

      receivingUsage = true
      // Keep awaiting the real provider promise even if it ignores abort; a UI
      // deadline never releases the Backend lease under a late writer.
      const reply = await generateChatResponse(providerId, config, [
        { role: 'system', content: system }, { role: 'user', content: user },
      ], {
        temperature: 0, maxTokens: DIGEST_MAX_TOKENS, thinking: false,
        abortSignal: controller.signal, debugPurpose: 'collab-digest', debugSessionId: roomSessionId,
        onUsage: usage => {
          if (!receivingUsage) return
          try {
            options.assertOwned()
            options.recordUsage({ sessionId: roomSessionId, providerId, modelId: model,
              source: ONETHING_USAGE_SOURCES.collabDigest, usage })
          } catch (error) {
            log.error('digest usage recording failed', { roomSessionId, day }, error)
          }
        },
      })
      if (controller.signal.aborted) return
      assertRoom(context, roomSessionId)
      // Empty summaries still mark the folded day as examined, as before.
      const digest: CollabDayDigest = {
        day, summary: parseCollabDigestReply(reply), messageCount: messages.length, generatedAt: Date.now(),
      }
      options.store.saveCollabDigest(roomSessionId, digest)
    } catch (error) {
      if (!controller.signal.aborted) log.error('daily digest failed', { roomSessionId, day }, error)
    } finally {
      receivingUsage = false
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }

  /**
   * 这间房**当前会被折叠**的那些天。
   *
   * 按房算而不是按人算:折叠切点对所有人是同一个(游标只影响未读,而未读永不
   * 折叠),所以这里给的是所有同事折叠段的**并集** —— 一个刚回来、未读横跨三天的
   * 同事看到的折叠段更短,但它看到的那几天一定在这个集合里。
   *
   * 今天(切点之后)不生成:那一天还在长,一份写到一半的摘要既会过期又会误导。
   */
  function collabFoldedDays(roomSessionId: string, now: number, context?: RuntimeRequestContext): string[] {
    assertRoom(fixedExecutionContext(context), roomSessionId)
    const session = store.getSession(roomSessionId)
    if (session?.kind !== 'room') return []
    const days = new Set<string>()
    for (const message of foldedFactsOfRoom(session, now)) {
      days.add(dayOf(message.timestamp ?? 0))
    }
    return [...days].sort()
  }

  /** Admission and tracking happen synchronously before returning to the room turn. */
  function ensureCollabDigestsForRoom(roomSessionId: string, context?: RuntimeRequestContext): Promise<void> {
    const captured = fixedExecutionContext(context)
    return ensureCollabDigests(roomSessionId, collabFoldedDays(roomSessionId, Date.now(), captured), captured)
  }

  function ensureCollabDigests(roomSessionId: string, days: readonly string[], context?: RuntimeRequestContext): Promise<void> {
    const captured = fixedExecutionContext(context)
    assertRoom(captured, roomSessionId)
    if (!isCollabDigestEnabled(store.getSession(roomSessionId))) return Promise.resolve()
    const pending = days.filter(day => {
      const key = roomSessionId + '\n' + day
      if (inFlight.has(key)) return false
      inFlight.add(key)
      return true
    })
    if (!pending.length) return Promise.resolve()
    const work = (async () => {
      try {
        for (const day of pending) {
          if (closed) break
          try { await generateOne(roomSessionId, day, captured) }
          finally { inFlight.delete(roomSessionId + '\n' + day) }
        }
      } finally {
        for (const day of pending) inFlight.delete(roomSessionId + '\n' + day)
      }
    })()
    active.set(work, roomSessionId)
    void work.then(() => active.delete(work), () => active.delete(work))
    return work
  }

  /**
   * runner 是那份摘要档唯一的写者,所以关闸这件事整台一起做 —— 从前是装配层
   * 那一句 `own()` 里手写「先 runner 后 store」,现在归位到这里(工单 5 §1:
   * 骨架里不许出现按子系统分叉的登记)。`store.quiesce()` 幂等。
   */
  function quiesce(): void {
    closed = true
    for (const controller of controllers.keys()) controller.abort()
    options.store.quiesce()
  }
  async function drain(): Promise<void> {
    quiesce()
    while (active.size) await Promise.allSettled([...active.keys()])
  }
  async function abortAndDrain(roomSessionId: string): Promise<void> {
    for (const [controller, room] of controllers) if (room === roomSessionId) controller.abort()
    for (;;) {
      const pending = [...active].filter(([, room]) => room === roomSessionId).map(([work]) => work)
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  return { quiesce, drain, abortAndDrain, collabFoldedDays, ensureCollabDigestsForRoom, ensureCollabDigests }
}
export type CollabDigestRunner = ReturnType<typeof createCollabDigestRunner>
export const collabFoldedDays: CollabDigestRunner['collabFoldedDays'] = (...args) => getCurrentBackend('collabDigests').collabDigests.collabFoldedDays(...args)
export const ensureCollabDigestsForRoom: CollabDigestRunner['ensureCollabDigestsForRoom'] = (...args) => getCurrentBackend('collabDigests').collabDigests.ensureCollabDigestsForRoom(...args)
export const ensureCollabDigests: CollabDigestRunner['ensureCollabDigests'] = (...args) => getCurrentBackend('collabDigests').collabDigests.ensureCollabDigests(...args)
