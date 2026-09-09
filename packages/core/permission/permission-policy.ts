import { Permission } from './index.js'
import * as PermissionGrants from './permission-grants.js'
import { coversAll } from './capability-registry.js'
import { principalId, type Principal } from './principal.js'
import { toJsonObject } from '../json.js'

export type PermissionPolicyMode = Permission.Mode
export type PermissionPolicyDecision = 'allow' | 'ask' | 'deny'
export type PermissionMetadata = Record<string, unknown>
export type PermissionGrantMatcher = typeof PermissionGrants.matchGrant
export interface PermissionBridge {
  getMode(sessionId: string): Permission.Mode
  ask(input: Parameters<typeof Permission.ask>[0]): Promise<void>
}

export interface PermissionEffect {
  kind: string
  resources: string[]
  barrier?: boolean
  external?: boolean
  sensitive?: boolean
  metadata?: PermissionMetadata
}

export interface PermissionPreview {
  title?: string
  metadata?: PermissionMetadata
  diff?: string
  path?: string
  additions?: number
  deletions?: number
}

export interface PermissionPolicyInput {
  sessionId: string
  mode: PermissionPolicyMode
  effects: PermissionEffect[]
  workspaceRoot?: string
  userId?: string
  workspaceId?: string
  grantMatcher?: PermissionGrantMatcher
}

export interface EnforcePermissionPolicyInput {
  sessionId: string
  messageId: string
  toolCallId?: string
  toolName: string
  effects: PermissionEffect[]
  preview?: PermissionPreview
  workspaceRoot?: string
  userId?: string
  workspaceId?: string
  /**
   * Who is running this tool. Carried from the engine boundary, never derived
   * here. Nothing in `decidePermission` reads it yet — P0 only makes the actor
   * visible (permission card, audit ledger); the judgment gains its subject
   * dimension in P3.
   */
  principal?: Principal
  grantMatcher?: PermissionGrantMatcher
  permissionBridge?: PermissionBridge
}

export interface PermissionPolicyResult {
  decision: PermissionPolicyDecision
  effect?: PermissionEffect
  reason?: string
  grantId?: string
}

/**
 * Covered by a capability the app or the user declared — see
 * ./capability-registry.js. Not a grant: nobody was asked, because the answer
 * was decided ahead of time and is listed in settings.
 */
function isCapabilityCovered(effect: PermissionEffect): boolean {
  if (effect.resources.length === 0) return false
  if (isAutoAcceptedEditEffect(effect)) return coversAll(effect.resources, 'write')
  if (effect.kind === 'read') return coversAll(effect.resources, 'read')
  return false
}

function isHardDeny(effect: PermissionEffect): boolean {
  return effect.metadata?.hardDeny === true
}

function isAutoAcceptedEditEffect(effect: PermissionEffect): boolean {
  return effect.kind === 'file_edit' ||
    effect.kind === 'file_write' ||
    effect.kind === 'file_destructive_edit'
}

/**
 * 不打扰人的效果类(原子 K2b-2,`docs/design/atom-2026-09.md` §6)。
 *
 * ## 为什么这里有第二张表
 *
 * `core/toolkit/effects.ts` 的 `EFFECT_POLICY` 已经给每一类效果写了
 * `silent | ask | never-grantable`,而这里又判一次 —— 那是**存量**,不是新增的:
 * 判定核这一侧从 R0 之前就写死了「`read` 之外都要问」,两张表管同一个问题。
 * 把这里改成读 `EFFECT_POLICY` 是对的方向,但那会顺手改掉 `net_fetch` /
 * `user_ask` / `session_message` / `session_spawn` 四类今天真会弹卡的行为 ——
 * 那是一次用户可感知的变化,归拍板,不归一次接线单(K2a' 留账写的就是这条)。
 *
 * ## 为什么 `ui_change` 可以现在就进来
 *
 * 它是 K2a' 新加的一类,**今天全仓零产地**,所以加进来不改任何既有类的行为:
 * 差别只在「壳侧资源提供者一上线之后,移动一格面板会不会弹一张权限卡」。
 * 那扇窗是这个人的窗,为它弹卡与 08-18「弹卡是噪音」那条判例是同一件事。
 *
 * 写成一张**集合**而不是再串一个 `&&`:第三类进来时改的是数据,不是判定式。
 */
const SILENT_EFFECT_KINDS: ReadonlySet<string> = new Set(['read', 'ui_change'])

function effectPattern(effect: PermissionEffect): string | string[] {
  return effect.resources.length === 0 ? effect.kind : effect.resources
}

export function decidePermission(input: PermissionPolicyInput): PermissionPolicyResult {
  for (const effect of input.effects) {
    if (isHardDeny(effect)) {
      return { decision: 'deny', effect, reason: String(effect.metadata?.reason || 'Hard-denied tool effect') }
    }
  }

  if (input.mode === 'dangerously-allow-all') {
    return { decision: 'allow' }
  }

  const promptEffects = input.effects.filter(
    effect => !SILENT_EFFECT_KINDS.has(effect.kind) && !isCapabilityCovered(effect),
  )
  if (promptEffects.length === 0) return { decision: 'allow' }

  const matchGrant = input.grantMatcher ?? PermissionGrants.matchGrant
  const grantMatches = promptEffects.map(effect => ({
    effect,
    grant: matchGrant({
      type: effect.kind,
      pattern: effectPattern(effect),
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      userId: input.userId,
      workspaceId: input.workspaceId,
    }),
  }))

  if (grantMatches.every(item => !!item.grant)) {
    return { decision: 'allow', effect: grantMatches[0]?.effect, grantId: grantMatches[0]?.grant?.id }
  }

  if (input.mode === 'auto-accept-edits' && promptEffects.every(isAutoAcceptedEditEffect)) {
    /**
     * **越界写不吃 auto-accept**(2026-08-11 止血,
     * `docs/audit/self-hosting-gap-audit-2026-08-11.md` 安全债第一条)。
     *
     * `auto-accept-edits` 是一句关于**这个项目**的授权:「我信任你在我打开的这棵
     * 树里改文件,别每次都问我」。它从来不是「你可以往这台机器的任何绝对路径
     * 写盘」—— 而在此之前它就是后者:write/edit 早就在 effect 上标了
     * `external: !matchedRoot`(`tools/builtin/write.ts` / `edit.ts` 的 analyze),
     * 但这条分支只看 kind 不看这一位,于是一次 `~/.ssh/config` 的覆写与一次
     * 仓库内的改动在这里长得一模一样,连一张卡都不弹。
     *
     * 越界的那一条回落 `ask`,让用户看见路径再决定;界内的写仍然一路直通 ——
     * 判据只有 `external` 这一位,所以正常工作目录内的写一步都没有变卡。
     */
    if (promptEffects.every(effect => effect.external !== true)) {
      return { decision: 'allow' }
    }
  }

  const askEffect = grantMatches.find(item => !item.grant)?.effect
  return askEffect ? { decision: 'ask', effect: askEffect } : { decision: 'allow' }
}

function titleForEffect(input: EnforcePermissionPolicyInput, effect: PermissionEffect): string {
  if (input.preview?.title) return input.preview.title
  if (effect.kind === 'bash') return String(effect.metadata?.command || 'Run bash command')
  if (effect.kind === 'mcp') return `Run MCP tool: ${input.toolName}`
  if (effect.kind === 'capability_change') {
    const target = String(effect.metadata?.variable || input.toolName)
    return `Repoint ${target} to: ${String(effect.metadata?.value || effect.resources[0] || '')}`
  }
  if (effect.kind === 'external_directory') return `Access directory outside project: ${effect.resources[0] || ''}`
  if (effect.kind === 'sensitive_file_read') return `Read sensitive file: ${String(effect.metadata?.path || effect.resources[0] || '')}`
  if (effect.kind === 'file_write') return `Write file: ${String(effect.metadata?.path || effect.resources[0] || '')}`
  if (effect.kind === 'file_edit' || effect.kind === 'file_destructive_edit') return `Edit file: ${String(effect.metadata?.path || effect.resources[0] || '')}`
  return `Use ${input.toolName}`
}

export async function enforcePermissionPolicy(input: EnforcePermissionPolicyInput): Promise<void> {
  if (input.effects.length === 0) return

  const permission = input.permissionBridge ?? Permission
  const mode = permission.getMode(input.sessionId)
  for (const effect of input.effects) {
    const result = decidePermission({
      sessionId: input.sessionId,
      mode,
      effects: [effect],
      workspaceRoot: input.workspaceRoot,
      userId: input.userId,
      workspaceId: input.workspaceId,
      grantMatcher: input.grantMatcher,
    })

    if (result.decision === 'deny') {
      throw new Error(result.reason || 'Tool call denied by permission policy')
    }

    if (result.decision === 'allow') continue

    await permission.ask({
      type: effect.kind,
      pattern: effectPattern(effect),
      sessionId: input.sessionId,
      messageId: input.messageId,
      callId: input.toolCallId,
      title: titleForEffect(input, effect),
      workingDirectory: input.workspaceRoot,
      userId: input.userId,
      workspaceId: input.workspaceId,
      principal: input.principal,
      metadata: toJsonObject({
        toolName: input.toolName,
        // Mirrored into metadata so transports that only carry the JSON blob
        // (SSE replay, persisted prompts) can still name the actor.
        ...(input.principal ? { principalId: principalId(input.principal) } : {}),
        ...(input.preview?.metadata ?? {}),
        ...(effect.metadata ?? {}),
        resources: effect.resources,
        effectKind: effect.kind,
        external: effect.external,
        sensitive: effect.sensitive,
        ...(input.preview?.diff && { diff: input.preview.diff }),
        ...(input.preview?.path && { path: input.preview.path }),
        ...(input.preview?.additions !== undefined && { additions: input.preview.additions }),
        ...(input.preview?.deletions !== undefined && { deletions: input.preview.deletions }),
      }),
    })
  }
}
