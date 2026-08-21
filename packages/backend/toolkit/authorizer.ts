/**
 * R2a —— `PermissionAuthorizer implements Authorizer`(设计文档 §5 / §10.1)。
 *
 * 这是"按效果授权"接上现有权限核的那一处,而且**只是接上**:三座桥(unattended /
 * collab / system-driven)、grant 匹配、能力覆盖、`auto-accept-edits` 的越界豁免全部
 * 留在 `app/tools/core/permission-policy.ts` 里一个字不动。这里做的事只有三件:
 *
 *  1. 把 `Intent.effects` + `Intent.preview` + `Invocation` 摆成
 *     `EnforcePermissionPolicyInput` 的形状(两边字段同名同义,是一次转手不是翻译);
 *  2. 把 `PermissionRejectedError` 翻成 `Decision.deny(...)`,其余错误原样往上抛;
 *  3. 兑现 `Intent.alwaysAsk`(用户在设置页把这只工具设成"每次问我")。
 *
 * ## 为什么不是"Authorizer 里再写一遍策略"
 *
 * 因为策略已经有一份了,而且它是被三条不同的回合类型咬着的(无人值守要立即拒、
 * 群房要无限等、系统驱动要 120 秒超时)。再写一份 = 两套判据,同一条 `rm -rf ./dist`
 * 迟早在两种会话里长成两张不同的卡。
 */

import {
  formatPermissionRejectedMessage,
  Permission,
  decidePermission as decideCorePermission,
} from '@onething/core/permission'
import { Decision, withUserToolSettings } from '@onething/core/toolkit'
import type {
  AbortScope,
  Authorizer,
  Effect,
  Intent,
  Invocation,
  ToolUserSetting,
} from '@onething/core/toolkit'
import {
  enforcePermissionPolicy,
  type EnforcePermissionPolicyInput,
  type PermissionEffect,
  type PermissionPreview,
} from '../wiring/tools/core/permission-policy.js'
import { getSettings } from '../stores/settings.js'

/**
 * 一条**不可静默**的效果。`Intent.alwaysAsk` 靠它落地。
 *
 * core `Permission` 没有"强制询问"的入口:`decidePermission` 的放行判据是
 * 「kind 是 read / 被 capability 覆盖 / 命中 grant」,没有一个能被外部一票否决。所以
 * 这里合成一条效果 —— 但**资源用 `<toolId>#<callId>`,每次调用都不一样**,于是它
 * 永远匹配不到任何一条已存的 grant,必然落进 `ask`。副作用是:用户在这张卡上选
 * "总是允许"时,记下的 grant 也绑在那个一次性资源上,下一次照样问 —— 那正是
 * `autoExecute: false` 这句话的意思。
 *
 * 它**只在真正需要时**才被追加(见 `decide`):否则一次 bash 调用会同时弹两张卡。
 */
const MANUAL_APPROVAL_EFFECT_KIND = 'tool_manual_approval'

function manualApprovalEffect(invocation: Invocation): PermissionEffect {
  return {
    kind: MANUAL_APPROVAL_EFFECT_KIND,
    resources: [`${invocation.toolId}#${invocation.callId}`],
    barrier: true,
    metadata: {
      toolName: invocation.toolId,
      reason: 'This tool is configured to ask every time (autoExecute is off).',
    },
  }
}

/** 内核 `Effect` 与权限核 `PermissionEffect` 字段同名同义,转手不翻译。 */
function toPermissionEffect(effect: Effect): PermissionEffect {
  return {
    kind: effect.kind,
    resources: [...effect.resources],
    barrier: effect.barrier,
    external: effect.external,
    sensitive: effect.sensitive,
    metadata: effect.metadata as PermissionEffect['metadata'],
  }
}

function toPermissionPreview(intent: Intent): PermissionPreview | undefined {
  if (!intent.preview) return undefined
  const { title, diff, path, additions, deletions, metadata } = intent.preview
  return { title, diff, path, additions, deletions, metadata: metadata as PermissionPreview['metadata'] }
}

function isPermissionRejected(error: unknown): error is Error & { reason?: string } {
  return error instanceof Error && error.name === 'PermissionRejectedError'
}

export interface PermissionAuthorizerOptions {
  /** 权限判定入口。默认是装配层那份带三座桥的 `enforcePermissionPolicy`。 */
  readonly enforce?: (input: EnforcePermissionPolicyInput) => Promise<void>
  /** 当前会话的权限模式。只用来预判"这一组效果会不会问人"。 */
  readonly getMode?: (sessionId: string) => Permission.Mode
  /** 命令跑在哪一棵树里。默认取调用坐标上的 cwd / workspaceRoot。 */
  readonly workspaceRootOf?: (invocation: Invocation) => string | undefined
}

export class PermissionAuthorizer implements Authorizer {
  private readonly options: PermissionAuthorizerOptions

  constructor(options: PermissionAuthorizerOptions = {}) {
    this.options = options
  }

  async decide(intent: Intent, invocation: Invocation, _scope: AbortScope): Promise<Decision> {
    const effects = intent.effects.map(toPermissionEffect)
    const workspaceRoot = this.workspaceRoot(invocation)

    // 先问一次策略:这一组效果**会不会**惊动人。两个用处 ——
    //  (a) `alwaysAsk` 时才知道要不要补那条一次性效果(否则会多出一张卡);
    //  (b) 结论里的 `asked` 位有个诚实的来源(它是策略的答案,不是猜的)。
    const wouldAsk = this.wouldAsk(invocation, effects, workspaceRoot)
    if (intent.alwaysAsk && !wouldAsk) effects.push(manualApprovalEffect(invocation))

    // 零效果 = 不必打扰任何人。`enforcePermissionPolicy` 自己也会立刻返回,这一句
    // 只是省掉一次无意义的 store 读。
    if (effects.length === 0) return Decision.allow()

    const enforce = this.options.enforce ?? enforcePermissionPolicy
    try {
      await enforce({
        sessionId: invocation.sessionId,
        messageId: invocation.messageId ?? '',
        toolCallId: invocation.callId,
        toolName: invocation.toolId,
        effects,
        preview: toPermissionPreview(intent),
        workspaceRoot,
        principal: invocation.principal,
      })
    } catch (error) {
      if (isPermissionRejected(error)) {
        const rejectionReason = error.reason
        return Decision.deny(formatPermissionRejectedMessage(rejectionReason), {
          asked: true,
          byUser: true,
          rejectionReason,
        })
      }
      /**
       * 硬拒绝(`metadata.hardDeny`)与权限核自己的故障走**失败**,不走 denied ——
       * 与旧管线逐字一致(`enforcePermissionPolicy` 抛的是一条普通 Error,旧的
       * `executeToolDirectly` 把它落成 `{ success: false, error }`)。把它改判成
       * denied 会让一次"这条命令永远不许跑"看起来像"这次用户没同意"。
       */
      throw error
    }

    return Decision.allow({ asked: wouldAsk || intent.alwaysAsk })
  }

  private workspaceRoot(invocation: Invocation): string | undefined {
    if (this.options.workspaceRootOf) return this.options.workspaceRootOf(invocation)
    return invocation.cwd ?? invocation.workspaceRoot
  }

  /**
   * 「这一组效果会不会弹卡」。纯读:同一个 `decidePermission`、同一组输入,只是
   * 提前问一次答案。它不替代 `enforce` —— 真正的判定与 ask 仍然发生在那边。
   */
  private wouldAsk(
    invocation: Invocation,
    effects: PermissionEffect[],
    workspaceRoot: string | undefined,
  ): boolean {
    if (effects.length === 0) return false
    try {
      const getMode = this.options.getMode ?? ((id: string) => Permission.getMode(id))
      const result = decideCorePermission({
        sessionId: invocation.sessionId,
        mode: getMode(invocation.sessionId),
        effects,
        workspaceRoot,
      })
      return result.decision !== 'allow'
    } catch {
      // 预判炸了不该改变结局:当作"不知道会不会问",让真正的 enforce 去回答。
      return false
    }
  }
}

/**
 * 桌面/服务端的成品授权者:真权限核 + 用户的 per-tool 设置。
 *
 * `autoExecute === false` 的读法见 `core/toolkit/ports.ts` 的
 * `withUserToolSettings` —— 它只在 Intent 上打一位 `alwaysAsk`,怎么问是上面那件事。
 */
export function createPermissionAuthorizer(options: PermissionAuthorizerOptions = {}): Authorizer {
  return withUserToolSettings(
    new PermissionAuthorizer(options),
    // 设置页那张 per-tool 表:`settings.tools.tools[toolId] = { enabled, autoExecute }`
    // —— 与旧 `canAutoExecute` 读的是同一张表(`headless/cli-projections.ts` 也写它)。
    toolId => getSettings().tools?.tools?.[toolId] as ToolUserSetting | undefined,
  )
}
