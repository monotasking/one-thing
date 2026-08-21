/**
 * 批量裁决的**生产适配器** —— `CollabRefereeJudgePort` 的真实现(D3)。
 *
 * 一个触发事件一次模型调用:把这一批候选、压缩窗、每人的状况拼成一份材料,问一句
 * 「这一轮谁开口、按什么次序」,把回复读成一份授牌名单(qm P0-2,O(N)→O(1))。
 *
 * **本期零调用点**(与 `engine-mind-port.ts` 同款纪律):v2 的调度链仍然是生产,
 * D3 一行都没动它。这个文件写好放着,D6 接线时是「换一个端口实现」,不是「改
 * RefereeActor」—— 那正是端口存在的全部理由。
 *
 * ## 为什么不复用 `willingness-runner.ts` 的装配
 *
 * 那个文件属于 **v2 调度链,D6 会整层删掉**。为一段活不过这个月的代码抽一层公共
 * 导出,换来的是一次多余的回归面 + 一个删除时必须拆的结:删掉那一侧时,这里就是
 * 唯一的一份。所以下面这几段(死线、provider 解析、计费口)是**字面借鉴**,溯源
 * 写在各自的注释里,一个 import 都不连过去。
 *
 * ## 三个参数为什么是这几个数
 *
 *  - `thinking: false` —— 真机实测过的坑(v2 判定 §):继承 provider 的 thinking 配置
 *    时,推理模型会把整个 token 预算和死线烧在思维链上,回复是空的,于是**全员静默**。
 *    裁决是一次调度判断,不是一次思考;
 *  - `maxTokens` 取 **160** —— 与判定那侧的 64 同一个量级(都是"一小段 JSON"),
 *    但答案是一个**名单加一句理由**而不是一个布尔,64 会在第三个句柄那里被截断,
 *    而截断的 JSON 读不出来 = 每次都降级;
 *  - `temperature: 0` —— 同一份材料应该排出同一个次序。裁决的随机性没有任何产品价值,
 *    它只会让「为什么这次是他先说」变成一个答不出的问题。
 */
import { isAgentPairDmRoom, isUserDmRoom } from '@onething/runtime/collab'
import {
  buildCollabRefereeJudgePrompt,
  parseCollabRefereeVerdict,
  type CollabRefereeVerdict,
} from '@onething/runtime/collab/actors'
import { isActiveAgent } from '@shared/ipc.js'

import { findAgent } from '../../agents/index.js'
import { getEffectiveProviderConfig, resolveProviderAuth } from '../../engine/stream/provider-helpers.js'
import { generateChatResponse } from '../../providers/index.js'
import * as store from '../../../store.js'
import { billCollabPlanUsage } from '../../usage/bill-side-line.js'
import { collabUserPromptFields } from '../user-identity.js'
import type { CollabRefereeJudgePort, CollabRefereeJudgeRequest } from '@onething/runtime/collab/actors/referee-actor'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.referee')


/** 裁决的死线。与 v2 判定同档 —— 它是每条房间消息都要付的延迟税。 */
const REFEREE_TIMEOUT_MS = 8_000
/** 回复是一个短名单 + 一句理由。见文件头「三个参数为什么是这几个数」。 */
const REFEREE_MAX_TOKENS = 160

type GenerateConfig = Parameters<typeof generateChatResponse>[1]

/**
 * 死线兜底。超时给回 `fallback`,不抛。
 *
 * 字面借鉴 v2 `app/collab/willingness-runner.ts` 的 `withDeadline`(见文件头:
 * 那个文件 D6 整层删,所以这里是复制而不是 import)。
 */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    void work.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/**
 * 降级 —— 并说清是**哪一种**降级。
 *
 * 行为上四种失败等价(房间一律回落举手 FIFO,这是安全方向),变的只是它们留下的账:
 * 全部塌缩成一个 `degraded: true` 的话,「裁判觉得这轮没人该说」和「这条链断了」在
 * 状态条上一模一样,而后者是必须修的 bug(v2 判定 `CollabWillingnessOutcomeKind`
 * 的同一条教训)。
 */
function degraded(token: string, why: string): CollabRefereeVerdict {
  return { token, grants: [], degraded: true, why }
}

export interface CollabEngineRefereeJudgePortOptions {
  /**
   * 用哪位同事的模型绑定去买这次调用。
   *
   * 裁判**不是**房间里的任何一个人(它不入戏,见 `COLLAB_REFEREE_SYSTEM`),所以
   * 缺省走房间会话的 effective 配置 —— 与 v2 编排那一路同一套。给了 id 就用那位的
   * 绑定,让「裁判用便宜模型」成为一个可配的事。
   */
  refereeAgentId?: string
  timeoutMs?: number
  maxTokens?: number
}

/**
 * 造一个走真模型的裁决端口。**目前没有任何调用点** —— D6 接线时它接在
 * `CollabRefereeActor` 的 `judge` 上,`RefereeActor` 一行不用改。
 */
export function createCollabEngineRefereeJudgePort(
  options: CollabEngineRefereeJudgePortOptions = {},
): CollabRefereeJudgePort {
  const timeoutMs = options.timeoutMs ?? REFEREE_TIMEOUT_MS
  const maxTokens = options.maxTokens ?? REFEREE_MAX_TOKENS

  return {
    name: 'engine-referee',
    async judge(request: CollabRefereeJudgeRequest): Promise<CollabRefereeVerdict> {
      // 已经作废就一个字节都别发:抢占发生在 provider 解析/鉴权之前的概率不低
      // (那两步都要 await),而这一句是它唯一的止损点。
      if (request.signal?.aborted) return degraded(request.token, 'aborted')

      // 裁判的模型绑定(配了的话)。退休的裁判不买调用 —— 与判定那侧同一道门。
      const referee = options.refereeAgentId ? findAgent(options.refereeAgentId) : undefined
      if (options.refereeAgentId && (!referee || !isActiveAgent(referee))) {
        return degraded(request.token, 'referee-unresolved')
      }
      const override = referee?.model?.providerId
        ? { providerId: referee.model.providerId, model: referee.model.modelId }
        : null

      const settings = store.getSettings()
      const { providerId, providerConfig, model } = getEffectiveProviderConfig(
        settings,
        request.roomId,
        override,
      )
      // 「调用根本没发出去」—— 它与"裁判说这轮没人该说"必须分得开,否则一间配错
      // provider 的房会表现为"裁判总觉得没人该说话",而那是查不出来的。
      if (!providerConfig || !model) return degraded(request.token, 'provider-unresolved')

      const auth = await resolveProviderAuth(providerId, providerConfig)
      if (!auth) return degraded(request.token, 'auth-unresolved')

      const config = {
        ...providerConfig,
        model,
        selectedModels: providerConfig.selectedModels?.length ? providerConfig.selectedModels : [model],
        apiKey: auth.kind === 'api-key' ? auth.apiKey : '',
        authContext: auth,
        oauthToken: auth.kind === 'oauth' ? auth.token : providerConfig.oauthToken,
      } as unknown as GenerateConfig

      // 房形态与真回合同源(app/engine/prompt/system-prompt.ts 那两行推导)。私聊房
      // 本来就免裁决(房间那侧的 `pairDm` 门),这两行留着是为了直接构造 request 的
      // 调用方 —— 一个在 pair 房里问出来的裁决,至少不该把用户说成"群成员"。
      const roomShape = store.getSession(request.roomId)?.room
      void isUserDmRoom(roomShape)
      void isAgentPairDmRoom(roomShape)

      const { system, user } = buildCollabRefereeJudgePrompt({
        roomName: request.roomName,
        candidates: request.candidates,
        members: request.members,
        recent: request.recent,
        // 窗口里的用户发言按 label 署名(agent-dm-user.md §2.3)。与真回合共用同一份
        // 身份:裁决看到「一天: …」而回合看到「用户: …」,同一条消息在两拍里就成了
        // 两个人说的。
        userLabel: request.userLabel ?? collabUserPromptFields().userLabel,
        ...(request.mentionedAgentIds ? { mentionedAgentIds: request.mentionedAgentIds } : {}),
        ...(request.memberState ? { memberState: request.memberState } : {}),
        ...(request.constraints ? { constraints: request.constraints } : {}),
        // persona 节选:候选行的「他是谁」。真机 2026-08-02 的实测 —— 在用的同事
        // `title` 与 `description` 全空,人格整个在 systemPrompt 里,不给的话候选表
        // 会渲染成一串光秃秃的名字,裁判判「谁该说」时手上什么都没有。
        resolvePersona: request.resolvePersona ?? (agentId => findAgent(agentId)?.systemPrompt),
        resolveAgentName: request.resolveAgentName ?? (agentId => findAgent(agentId)?.name),
      })

      const controller = new AbortController()
      // 死线是不是我们自己踩的 —— `withDeadline` 只会给回一个空串,分不出"超时了"
      // 和"模型回了个空"。这个标记是唯一能把两者分开的东西。
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      // 外部取消(用户插话)与内部死线共用一个 controller:任一先到都是同一个结果。
      const cancelExternally = (): void => controller.abort()
      request.signal?.addEventListener('abort', cancelExternally, { once: true })
      try {
        const reply = await withDeadline(
          generateChatResponse(
            providerId,
            config,
            [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            {
              temperature: 0,
              maxTokens,
              thinking: false,
              abortSignal: controller.signal,
              debugPurpose: 'collab-referee',
              debugSessionId: request.roomId,
              // 计在编排那条线上:它与 `collab-willingness` 此消彼长(一个 O(1)/条、
              // 一个 O(N)/条),两条线在用量面板里并排,换算法省了多少才有得看。
              onUsage: billCollabPlanUsage(providerId, model, request.roomId),
            },
          ),
          timeoutMs,
          '',
        )
        if (timedOut) return { ...degraded(request.token, 'timeout'), model }
        if (request.signal?.aborted) return { ...degraded(request.token, 'aborted'), model }
        // 解析在纯层 —— 读不懂同样回 `degraded`,四条兜底见 `parseCollabRefereeVerdict`。
        const verdict = parseCollabRefereeVerdict(reply, {
          token: request.token,
          candidates: request.candidates.map(hand => hand.agentId),
          members: request.members,
        })
        // 用完即弃的那一格接住了(D8 §3.3):模型名只进时间轴,不进动词。
        return { ...verdict, model }
      } catch (error) {
        log.error('adjudication model call failed', { roomId: request.roomId, model }, error)
        return { ...degraded(request.token, timedOut ? 'timeout' : 'error'), model }
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', cancelExternally)
      }
    },
  }
}
