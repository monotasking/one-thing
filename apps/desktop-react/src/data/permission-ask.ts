import { effectPolicyFor } from '@onething/core/toolkit'
import type { PermissionInfo, PermissionResponse } from '@shared/ipc/permissions'
import type { PermissionRequestEvent } from '@shared/events/session-events'

/**
 * **一张权限卡的事实**(应用级许可 · 壳半边,2026-09-10)。
 *
 * ── 为什么它是一条**自己的车道**,而不是折叠产物上那几格 ────────────────────
 * `@shared/ipc/tools.ts` 的 `ToolCall` 上确实有 `permissionId` / `canRespond` /
 * `permissionQueued` 三格 —— 但屏幕上那棵树不是从那个形状来的:它是
 * `materializeChatMessagesCached` 交出来的 **core 折叠产物**,而 core 的投影里
 * 压根没有这三格(`grep permissionId packages/core` 只落在 `permission/` 自己身上)。
 * 硬把字段接到那些对象上有两个后果,都是这台壳明令禁止的:①物化是**按 `(节点,
 * node.rev)` 缓存**的,而一次审批不改账本、`rev` 不动 —— 补上去的字段永远不会
 * 上屏;②那棵树的产地只有一处(「React 侧零拼装」,`chat-source.ts` 文件头),
 * 就地改写它就是开第二个产地。
 *
 * 所以它与 `overlay`(待送出的消息)同款:store 上的**第四条车道**,按
 * `toolCallId` 对齐 —— 而字段名逐字照抄那份契约,是为了让「壳这一格说的是契约上
 * 的哪一格」不需要翻译。
 */
export interface PermissionAsk {
  /**
   * 卡的地址:这次审批挂在哪一次工具调用上。**它同时是应答时带的那把键**
   * (契约 `PermissionRespondCommand.toolCallId`:耐久相关键,不依赖看见过
   * 那个易逝的 requestId)。
   */
  toolCallId: string
  /** 这次 ask 的 id(事件的 `requestId` / `PermissionInfo.id`)。排障与对账用。 */
  permissionId: string
  /** 卡上那句标题 —— 后端算好的人话(`titleForEffect`),壳不重编。 */
  title: string
  /** 效果类(`PermissionInfo.type` = `EffectClass`)。 */
  type: string
  /** 这次要动的资源。一条或几条,后端给什么样就是什么样。 */
  pattern?: string | string[]
  /**
   * 「始终允许这个应用」那一档的作用面。**缺席 = 不画那个键**
   * (a50d4f99 留账原话:壳只读这一格,不自己解析 `pattern` 猜命名空间 ——
   * 自己解析就会记出 `/Users:*` 这种荒唐 grant)。
   */
  alwaysScope?: { scheme: string }
  /**
   * 排在别人后面,还没轮到(`permission:queued`)。画等待态,**不给键** ——
   * 内核那份序列化队列一次只交出一张能答的卡。
   */
  permissionQueued: boolean
  /** 这一面此刻能不能答。排队中 / 已经答出去了都是 false。 */
  canRespond: boolean
  /**
   * **已经答出去了,等核心确认**(交互稳定律③那一拍)。
   *
   * 记的是**答了哪一下**而不是一个布尔:卡上要说「已允许 / 已拒绝」,而两句话
   * 分不出来的话就只能说一句含混的「已提交」。清掉它的是 `permission:settled`
   * —— 也就是说这一格由**事件**收尾,不由发出去那一下的应答收尾(远端答掉、
   * 超时自结算这两条路上壳一下都没点过)。
   */
  answered?: PermissionResponse
}

/** 空车道的恒等引用 —— 免得每次都换一张新空表(律④)。 */
export const NO_PERMISSION_ASKS: Readonly<Record<string, PermissionAsk>> = Object.freeze({})

/**
 * 这一类效果的答案**记不记得住**。
 *
 * 读的是 core 那张策略表(`@onething/core/toolkit` 的 `effectPolicyFor`),不是
 * 本地一份名单 —— `permission-grants.ts` 的 `isGrantableType` 读的就是同一列,
 * 而那只文件自己的文件头写着这条法的由来:「一份重复的名单迟早只被改一半」。
 * 壳不能直接 import 它(那只文件吃 `node:crypto` / `node:path`,进不了浏览器包),
 * 所以这里读的是**它读的那张表**,不是抄它的结论。
 *
 * 它决定卡上画不画「本会话」「本工作目录」两键:`capability_change` 这一族在核里
 * 是 `never-grantable`,而 `Permission.respond('session')` 那一支**没有**
 * `isGrantableType` 前置(`workdir` / `always` 两支有),直接落到会抛的
 * `PermissionGrants.addGrant` 上。画一个按下去会炸的键,比不画糟得多。
 */
export function isGrantablePermissionType(type: string): boolean {
  return effectPolicyFor(type).policy !== 'never-grantable'
}

/** 活事件(`permission:request`)→ 一张能答的卡。 */
export function askFromRequestEvent(event: PermissionRequestEvent): PermissionAsk {
  return {
    toolCallId: event.toolCallId,
    permissionId: event.requestId,
    title: event.title,
    type: event.permissionType,
    ...(event.pattern !== undefined ? { pattern: event.pattern } : {}),
    ...(event.alwaysScope ? { alwaysScope: event.alwaysScope } : {}),
    permissionQueued: false,
    canRespond: true,
  }
}

/**
 * 对账口(`permission.getPending`)→ 一张卡。
 *
 * `promptState` 缺席按 `'actionable'` 读 —— 契约上那一格自己写着这条兜底
 * (「Absent from older backends; treat as 'actionable'」)。
 * 没有 `callId` 的 pending 交不出地址,**整条丢掉**:一张挂不到任何一次调用上的
 * 卡在屏幕上无处可画,编一个位置比不画糟。
 */
export function askFromPendingInfo(info: PermissionInfo): PermissionAsk | undefined {
  if (!info.callId) return undefined
  const queued = info.promptState === 'queued'
  return {
    toolCallId: info.callId,
    permissionId: info.id,
    title: info.title,
    type: info.type,
    ...(info.pattern !== undefined ? { pattern: info.pattern } : {}),
    ...(info.alwaysScope ? { alwaysScope: info.alwaysScope } : {}),
    permissionQueued: queued,
    canRespond: !queued,
  }
}
