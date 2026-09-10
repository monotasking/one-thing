import { Permission } from './index.js'
import * as PermissionGrants from './permission-grants.js'
import { coversAll } from './capability-registry.js'
import { principalId, type Principal } from './principal.js'
import { parseRef } from '../resource/ref.js'
import { effectPolicyFor } from '../toolkit/effects.js'
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
 * 这一条效果要不要惊动人 —— **判据只有策略表一处**(合表,2026-09-10 用户拍板)。
 *
 * ## 这里曾经有第二张表
 *
 * 判定核从 R0 之前就写死了「`read` 之外都要问」,K2b-2 把它整理成一张集合
 * `SILENT_EFFECT_KINDS = {read, ui_change}`。而 `core/toolkit/effects.ts` 的
 * `EFFECT_POLICY` 早就给每一类写了 `silent | ask | never-grantable` —— 两张表管同一
 * 个问题,且**行为的产地是这一侧**:策略表里写 `silent` 的 `net_fetch` / `user_ask`
 * / `session_message` / `session_spawn` 四类,真跑起来照样弹卡。一个 kind 的策略要
 * 在两个文件里各说一遍,而其中一遍不作数,这本身就是「按能力枚举」的形状。
 *
 * 合表把这张名单删掉,判据改成向策略表要答案。落到用户身上的变化只有两类
 * (另外两类在这一侧本来就在问,是策略表那一行跟上了行为):
 *
 *  - `net_fetch`(web_search / web_open 抓页)**从此不弹卡** —— 只读的出网取材,
 *    每查一次资料一张卡是把审批变成噪音。
 *  - `user_ask`(ask_user)**从此不弹卡** —— 它本身就是一次询问,为「我要问你」
 *    先问一次「准不准我问你」是同一件事问两遍。
 *
 * 未知 kind 的口径一字未变:`effectPolicyFor` 给不认识的名字兜底成 `ask`,所以拼错
 * 的效果名、插件/MCP 送进来的将来效果、以及授权者合成的那条一次性
 * `tool_manual_approval`,全都照旧落进询问。
 */
function isSilentEffect(effect: PermissionEffect): boolean {
  return effectPolicyFor(effect.kind).policy === 'silent'
}

function effectPattern(effect: PermissionEffect): string | string[] {
  return effect.resources.length === 0 ? effect.kind : effect.resources
}

/**
 * 这一条效果**认得出一个应用吗** —— 「始终允许这个应用做这一类事」这一档能不能
 * 出现在卡上,由这只函数一处判定(2026-09-10 拍板)。
 *
 * 判据三条,全是结构性的,没有一条按名字枚举:
 *
 *  ① 类型可授权。`capability_change` 这一族永远只能答「这一次」(策略表里那一行
 *     写着 `never-grantable`,`isGrantableType` 读的就是它),给它画一个「始终」
 *     的键是在教用户点一个点不动的按钮。
 *  ② 每一条 resource 都是一个**合法地址**(`core/resource/ref.ts` 的语法)。
 *     裸路径(`/Users/x/a.ts`)、一串 bash 命令、一个工具名 —— 它们都不是地址,
 *     解析回 `null`,于是这一档不出现。这正是「文件写不给应用级许可」的落点:
 *     `file:` 那种以路径当身份的资源将来若真的进来,它带的会是 `file:/Users/…`,
 *     那时判据仍然只有「解析得出 scheme」这一条,不用改这里。
 *  ③ 全部落在**同一个** scheme 下。一条效果横跨两个应用时,「这个应用」是一句
 *     没有主语的话;宁可不出现这一档,也不替用户把两个命名空间一起许了。
 *
 * 地址语法只有 `core/resource/ref.ts` 一份实现 —— 这里 `parseRef` 而不是自己写一次
 * 「在第一个冒号处切」,理由写在那只文件的头上(同一条语法两份实现必然漂移)。
 */
function alwaysScopeOf(effect: PermissionEffect): { scheme: string } | undefined {
  if (!PermissionGrants.isGrantableType(effect.kind)) return undefined
  if (effect.resources.length === 0) return undefined
  let scheme: string | undefined
  for (const resource of effect.resources) {
    const parsed = parseRef(resource)
    if (!parsed) return undefined
    if (scheme === undefined) scheme = parsed.scheme
    else if (scheme !== parsed.scheme) return undefined
  }
  return scheme === undefined ? undefined : { scheme }
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
    effect => !isSilentEffect(effect) && !isCapabilityCovered(effect),
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
  /**
   * K3-a —— 破坏性会话操作。资源上的效果带的是**地址**(`planFromSpec` 把 `ref`
   * 摊进 `resources`),所以卡上说得出「删的是哪一条」;没有地址时退回效果类自己
   * 那句默认话,不编一个具体对象出来。
   *
   * 它排在 `titleForEffect` 的 `preview?.title` **之后**(那一句在函数第一行):
   * 一条做法自己写了 `describe(params)` 的人话,永远比这里的通用句子准。
   */
  if (effect.kind === 'session_destructive') {
    const target = effect.resources[0]
    return target ? `Remove session content: ${target}` : 'Remove session content'
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

    // 「始终允许这个应用」的出现条件由后端算好随 ask 交给壳(卡上第四个键)。
    const alwaysScope = alwaysScopeOf(effect)

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
      ...(alwaysScope ? { alwaysScope } : {}),
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
