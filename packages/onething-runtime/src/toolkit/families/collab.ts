/**
 * R3a 家族基类 —— `CollabTool`(§4 的第六族)。
 *
 * 协作四件套(send_message / board / history / notebook)共享三件事,今天这三件事
 * 在四个工具里各写了一遍:
 *
 *  1. **场子门**。`COLLAB_TOOL_VENUES` 是唯一事实(`collab/tool-surface.ts`),
 *     归一化只有一个方向:认不出的 kind 一律算 `chat`。它在这里有**两个**出口 ——
 *     `visibleIn(scene)` 把工具从这一回合的面上摘掉(模型根本看不见它),
 *     `plan` 再判一次(有人硬调时,拒绝文案由各工具自己给)。两道都要:面是给
 *     模型看的清单,门是不能被绕过的那一道。
 *  2. **actor 解析**。`principal` 优先(它是回合入口铸好的、有来路的身份),
 *     认不出 agent 时回退到会话自己的 `agentId`。旧路四个工具各反查一次
 *     `session.agentId`(say 的 `resolveSayContext`、board 的 `resolveContext`、
 *     history 的 `resolveSelfAgentId`、notebook 的 `appendNote`),四份手写里
 *     漏一份就是一个静默的授权洞 —— 收成一处。
 *  3. **效果**。`send_message` 是唯一真的把东西送出去的那个,报一条
 *     `session_message`(策略表里 `ask` —— 合表 2026-09-10;判定核一直在问它,
 *     与今天弹卡逐字一致)。board /
 *     history / notebook **不报任何效果**:旧实现没有 `analyze`,权限层今天
 *     看到的就是空的;为它们发明一个 `collab_board_write` kind 会是一个"功能
 *     形状的洞"(§10.2-② 的纪律:新增 kind 必须同 commit 给策略行 + 文案 +
 *     渲染,而这三处今天都不需要变)。见设计文档 §13 的记录。
 *
 * 拒绝**文案**刻意不进这个基类:每个执行器那句话都是精心写过的可操作措辞
 * (「boards exist only in collab rooms and their work sessions」「笔记本只在
 * 群聊/私聊的回合与工作台会话里可用」),换成一句通用的"场子不对"会让模型不
 * 知道下一步能做什么。基类只提供 `allowed` 这一位。
 */

import { Intent, Tool } from '@onething/core/toolkit'
import type {
  Effect,
  PlanContext,
  Preview,
  Result,
  RunContext,
  Scene,
} from '@onething/core/toolkit'
import type { Principal } from '@onething/core/permission'
import {
  isCollabToolAllowedInVenue,
  resolveCollabVenue,
  type CollabVenue,
  type CollabVenueTool,
} from '../../collab/tool-surface.js'

/** 场子门与身份回退要用到的宿主面。两项都可缺席(测试里就常常缺席)。 */
export interface CollabToolAdapters {
  /** 会话的 `kind`。缺席 = 从 `ctx.session?.kind` 取。 */
  sessionKind?(sessionId: string): string | undefined
  /** 会话归属的 agent。`principal` 认不出 agent 时的回退。 */
  sessionAgentId?(sessionId: string): string | undefined
}

/** plan 算出来、apply 直接用的那份语境。 */
export interface CollabScope<In> {
  readonly input: In
  readonly sessionId: string
  readonly venue: CollabVenue
  /** 这个工具在这个场子里成立吗。 */
  readonly allowed: boolean
  /** 谁在动作。`undefined` = 用户侧(board 的第三人称视角就靠它)。 */
  readonly actorAgentId?: string
}

/** `principal` 优先,认不出 agent 才回退到会话自己的 agentId。 */
export function collabActorAgentId(
  principal: Principal | undefined,
  fallback: string | undefined,
): string | undefined {
  if (principal?.kind === 'agent' && principal.agentId) return principal.agentId
  const trimmed = fallback?.trim()
  return trimmed || undefined
}

export abstract class CollabTool<In, Payload = CollabScope<In>> extends Tool<In, Payload> {
  protected readonly collab: CollabToolAdapters

  constructor(adapters: CollabToolAdapters = {}) {
    super()
    this.collab = adapters
  }

  /** 这只工具在场子表里的那一行。 */
  protected abstract readonly venueTool: CollabVenueTool

  /**
   * 面:场子表说了算。`scene.venue` 是产品层 `resolveScene` 已经归一化好的答案;
   * 没有它就退回 `scene.kind` 自己归一化一次(两条路同一个函数,不会分家)。
   */
  visibleIn(scene: Scene): boolean {
    return isCollabToolAllowedInVenue(this.venueTool, sceneVenue(scene))
  }

  async plan(input: In, ctx: PlanContext): Promise<Intent<Payload>> {
    const scope = this.scopeOf(input, ctx)
    const effects = this.effectsFor(scope)
    const preview = this.previewFor(scope)
    if (effects.length === 0 && !preview) return Intent.none(scope as unknown as Payload)
    return Intent.of({
      effects,
      ...(preview ? { preview } : {}),
      payload: scope as unknown as Payload,
    })
  }

  async apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result> {
    return await this.perform(intent.payload as unknown as CollabScope<In>, ctx)
  }

  protected scopeOf(input: In, ctx: PlanContext): CollabScope<In> {
    const sessionId = ctx.invocation.sessionId
    const kind = this.collab.sessionKind?.(sessionId) ?? ctx.session?.kind
    const venue = resolveCollabVenue(kind)
    const actorAgentId = collabActorAgentId(
      ctx.principal,
      this.collab.sessionAgentId?.(sessionId),
    )
    return {
      input,
      sessionId,
      venue,
      allowed: isCollabToolAllowedInVenue(this.venueTool, venue),
      ...(actorAgentId ? { actorAgentId } : {}),
    }
  }

  /** 默认一条效果都不报(board / history / notebook)。send_message 覆盖它。 */
  protected effectsFor(_scope: CollabScope<In>): Effect[] {
    return []
  }

  protected previewFor(_scope: CollabScope<In>): Preview | undefined {
    return undefined
  }

  protected abstract perform(scope: CollabScope<In>, ctx: RunContext): Promise<Result>
}

/** `scene.venue`(已归一化)优先,否则从 `scene.kind` 现算一次。 */
export function sceneVenue(scene: Scene): CollabVenue {
  return resolveCollabVenue(scene.venue ?? scene.kind)
}
