/**
 * 「这条路径读得 / 写不得」——资源面上**一把尺子的唯一产地**。
 *
 * 这段判词原本长在 `dir-provider.ts` 的文件尾(K3-c / K3-c'),第二种要判路径的资源
 * (`git-provider.ts`,「改动」面那一单)到来时被**搬**到这里,不是抄一份:两只
 * provider 判的必须是同一条边界、同一个顺序、同一句话。两把尺子是「一个洞会在两处
 * 之一悄悄张开」的标准形状,而一份复制品正是两把尺子的第一天。
 *
 * ── 两根界,名字里就写着判的是哪一根 ────────────────────────────────────────
 * · `resolveReadable` —— **读根**(`SandboxPolicy.readable`):写根 ∪ 用户亲手接入的
 *   目录 ∪ 笔记根 ∪ 下载目录。判据是 `read` 工具判 `external_directory` 用的同一张
 *   读根表(2026-09-10 拍板)。`scope` 是发起会话 —— 接入目录是 per-space 的,取哪
 *   一份由会话归属决定。
 * · `resolveWritable` —— **写根**(`SandboxPolicy.contains`,单根)。没有 `scope`
 *   这一格,而且这是一句关于语义的话不是省略:写根只有一个,与哪条会话在问无关。
 *
 * 读根比写根宽,而「列得出」与「改得动」本来就不是同一个答案:接入一个目录是让助手
 * **看见**它,不是把它交出去随便改。
 *
 * ── 三关的顺序是想清楚的:没有沙箱 → 越界 → 敏感 ────────────────────────────
 * 先说宿主缺能力(那与这个路径无关),再说这个路径在不在界内(界外的东西不必再问
 * 它敏不敏感)。**缺席一律拒,不是放行**:`ResourceReadContext.sandbox` 是可选的,
 * 而一台没有给出读根的宿主上,「这个路径在不在界内」这个问题没有答案,把没有答案
 * 当成「在界内」是一次静默的授权洞。
 *
 * ── 为什么错的名字里还留着 `Dir` ───────────────────────────────────────────
 * `DirOutsideSandboxError` 是 K3-c 起就被调用方与测试按**类名**匹配的那只错
 * (`core/tools/abort.ts` 那条判例:判定读类名)。判词已经与目录无关,但改名会让
 * 每一处 `rejects.toThrowError(...)` 跟着动,换来的只是一个更好听的名字 —— 那不是
 * 一次修复,是一次改名。留着,并在这里说清它判的是**路径**不是目录。
 */

import type { SandboxPolicy } from '@onething/core/toolkit'

/**
 * 这个路径不许读 / 写。
 *
 * 一只具名错带一格 `reason`,而不是三只错:调用方对三种拒绝要做的事是同一件 ——
 * 都是「不给」。`reason` 是给读日志的人分辨用的,不是给分支用的。
 */
export type DirRefusalReason = 'no-sandbox' | 'outside' | 'sensitive'

export class DirOutsideSandboxError extends Error {
  readonly path: string
  readonly reason: DirRefusalReason

  constructor(path: string, reason: DirRefusalReason) {
    super(`${path}: ${DIR_REFUSAL_MESSAGES[reason]}`)
    this.name = 'DirOutsideSandboxError'
    this.path = path
    this.reason = reason
  }
}

const DIR_REFUSAL_MESSAGES: Record<DirRefusalReason, string> = {
  // 「这台宿主没有给读根」——说的是宿主缺一格能力,不是这个路径犯了什么错。
  'no-sandbox': 'this host handed the resource kernel no sandbox, so no path can be judged in or out of bounds',
  outside: 'it is outside the sandbox root',
  sensitive: 'it is a sensitive file (credentials, keys, environment secrets)',
}

/**
 * 一个地址 → 一个判过界的绝对路径。三关,顺序见文件头。
 *
 * 「在不在界内」这一句由调用方递进来 —— 界有两根,而三关的顺序、那只错、那三句话
 * 只有一份。
 */
function resolveInside(
  rawPath: string,
  sandbox: SandboxPolicy | undefined,
  inBounds: (policy: SandboxPolicy, resolved: string) => boolean,
): string {
  if (!sandbox) throw new DirOutsideSandboxError(rawPath, 'no-sandbox')
  const resolved = sandbox.resolve(rawPath)
  if (!inBounds(sandbox, resolved)) throw new DirOutsideSandboxError(resolved, 'outside')
  if (sandbox.isSensitive(resolved)) throw new DirOutsideSandboxError(resolved, 'sensitive')
  return resolved
}

/**
 * 读那一根界:**读根**(`sandbox.readable`)。`scope` 是发起会话,由各条路各自从
 * 自己的上下文里取(读那条是 `ResourceReadContext.sessionId`,做那条是
 * `PlanContext.invocation.sessionId`)。
 *
 * 目录的 `reveal` 也走这一只,不走写的那只:它没有一格效果(只是把文件管理器叫到
 * 前台),而「看得见 / 列得出的目录能不能在访达里指给我看」若与「列得出」不是同一
 * 个答案,用户看到的就是一条列得出来却定位不了的目录。
 */
export function resolveReadable(
  rawPath: string,
  sandbox: SandboxPolicy | undefined,
  scope: string | undefined,
): string {
  return resolveInside(rawPath, sandbox, (policy, resolved) => policy.readable(resolved, scope))
}

/**
 * 写那一根界:**写根**(`sandbox.contains`,单根)。理由见文件头「两根界」。
 */
export function resolveWritable(rawPath: string, sandbox: SandboxPolicy | undefined): string {
  return resolveInside(rawPath, sandbox, (policy, resolved) => policy.contains(resolved))
}
