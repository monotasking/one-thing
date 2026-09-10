/**
 * K3-c —— 目录这一 scheme 的实现(`docs/design/atom-2026-09.md` §9 K3 三样板)。
 *
 * 自述在产品层(`@onething/runtime/files/resource-spec`),实现在这里 —— 与会话那
 * 一对同一个形状,理由也逐字相同:只有装配层够得着脊柱(这里够的是宿主外壳口与
 * 沙箱端口)。
 *
 * ── 列目录 / stat 的代码从哪来:一行都没有新写的 ──────────────────────────────
 * `listOnethingDirectory` / `statOnethingPath` / `revealOnethingPath` 是
 * `@onething/runtime/files` 里的**纯函数**(fs 由调用方注入),`rpc/domains/files.ts`
 * 的 `listDirectory` / `stat` / `reveal` 调的就是它们。所以这只 provider 递的是同一
 * 组函数、同一份注入(`fs.readdir(withFileTypes)` / `fs.stat().catch(()=>null)` /
 * `getShellHost().revealPath`),不是第二份写法:`node_modules` / `.git` 跳过、目录
 * 在前同类按名排、失败的措辞,三样自动与 `files` 域一致,而不是靠某天有人回来对表。
 *
 * 这一层自己只做两件事:**判沙箱**,和把出参投影成自述说的那个形状
 * (`type: 'file' | 'directory'` → `kind: 'file' | 'dir'`,理由在自述那一格上)。
 *
 * ── 沙箱:缺席一律拒,不是放行 ──────────────────────────────────────────────
 * `ResourceReadContext.sandbox` 是可选的,而那一格的注释写着「缺席 = 这台宿主没有
 * 沙箱这一格,**不是随便读**:一条要判越界的读法在缺席时该自己决定怎么退」。目录
 * 这一条要判越界,所以它的答案是拒:一台没有给出读根的宿主上,「这个路径在不在
 * 界内」这个问题没有答案,而把没有答案当成「在界内」是一次静默的授权洞。
 *
 * 尺子是**工具 runner 那一把**(`wiring/toolkit/runner.ts` 的 `createSandboxPolicy`,
 * 由 `wiring/resource/index.ts` 注进内核)。所以模型经 `read` 工具读一个路径与经
 * `dir` 资源列它的父目录,判的是同一条边界 —— 两把尺子是「一个洞会在两处之一悄悄
 * 张开」的标准形状。
 *
 * **判的是读根那把尺子,不是写根那把**(2026-09-10 拍板,K3-c 留账第 3 条还的):
 * `contains` 是 `getSandboxBoundary` 的单根 —— 用它判,用户在设置里亲手接入的目录
 * 就落在界外,于是那些目录**能改却列不出来**。`SandboxPolicy.readable` 是为此加的
 * 一格,判据是 `read` 工具判 `external_directory` 用的同一张读根表(写根 ∪ 接入目录
 * ∪ 笔记根 ∪ 下载目录)。`contains` 的语义一个字没动:写面(`K3-c'` 的三条)将来
 * 照旧问它。
 *
 * `readable` 的第二参是不透明的作用域键,这里递的是**发起会话** —— 接入目录是
 * per-space 的,取哪一份由会话归属决定(`ctx.sessionId` / `ctx.invocation.sessionId`,
 * 两条路各有各的那一格)。
 *
 * ── 授权诚实账(K2c-1 / K2c-2 留下的那一格)────────────────────────────────
 * `files.listDirectory` 对**非本机可信**的调用方还有一层 per-caller 的
 * `context.sandboxRoot` 夹持,而资源那条路的 `Invocation` 里今天没有这一格 —— 于是
 * 同一个目录,经 `resources.read` 会比经 `files` 域宽。这只 provider 判的是**进程级**
 * 的沙箱,补不上 per-caller 那一格;补它的是内核那只 `ReadGuard`
 * (`./read-guard.ts`:非本机可信的进程一律拒 `dir` 读)。两层各判各的,谁都不替
 * 谁说话。
 */

import fs from 'node:fs/promises'
import {
  listOnethingDirectory,
  revealOnethingPath,
  statOnethingPath,
  type OnethingDirectoryEntry,
} from '@onething/runtime/files'
import { getShellHost, hasShellHost, SHELL_HOST_UNAVAILABLE } from '@onething/runtime/shell/host-ports'
import { dirResourceSpec } from '@onething/runtime/files/resource-spec'
import { planFromSpec } from '@onething/core/resource'
import type { ResourceProvider, ResourceReadContext, ResourceRef } from '@onething/core/resource'
import type { PlanContext, Result, RunContext, SandboxPolicy } from '@onething/core/toolkit'
import { Intent, textResult } from '@onething/core/toolkit'

/** 一个目录项 / 一次 stat 交出去的「是什么」。与自述那两格逐字同名。 */
export type DirEntryKind = 'file' | 'dir'

/**
 * 这个路径不许读。
 *
 * 一只具名错带一格 `reason`,而不是三只错:判定读的是**类名**
 * (`core/tools/abort.ts` 那条判例),而调用方对三种拒绝要做的事是同一件 —— 都是
 * 「不给看」。`reason` 是给读日志的人分辨用的,不是给分支用的。
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

/** 底下那一层(readdir / stat / 定位)说不。那句话原样带出来。 */
export class DirOperationFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirOperationFailedError'
  }
}

/** 这台宿主没有外壳能力(server / CLI:没有文件管理器可以定位)。 */
export class DirShellUnavailableError extends Error {
  constructor(reason: string = SHELL_HOST_UNAVAILABLE) {
    super(`Cannot show a path in the file manager: ${reason}`)
    this.name = 'DirShellUnavailableError'
  }
}

/** 地址缺席时的那句话。目录的每一条读法与做法都作用在**一个**路径上。 */
export class DirRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} needs a directory address, e.g. "dir:/Users/you/project"`)
    this.name = 'DirRefRequiredError'
  }
}

/** `plan` 交给 `apply` 的载荷:已经解析并判过界的那个绝对路径。 */
export interface DirOpPayload {
  readonly op: 'reveal'
  readonly path: string
}

function requireDirPath(ref: ResourceRef | null, member: string): string {
  if (!ref || !ref.path) throw new DirRefRequiredError(member)
  return ref.path
}

/** `'file' | 'directory'`(共用那只函数的词) → `'file' | 'dir'`(自述的词)。 */
function kindOf(type: OnethingDirectoryEntry['type'] | undefined): DirEntryKind {
  return type === 'directory' ? 'dir' : 'file'
}

export class DirResourceProvider implements ResourceProvider<DirOpPayload> {
  readonly spec = dirResourceSpec

  async read(name: string, ref: ResourceRef | null, _query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    const target = resolveInsideSandbox(requireDirPath(ref, name), ctx.sandbox, ctx.sessionId)
    switch (name) {
      case 'list':
        return this.list(target)
      case 'stat':
        return this.stat(target)
      default:
        // 走不到:两条路(`ResourceTool` / `ResourceKernel.read`)都先查过读法名在不在
        // 自述里。留一句诚实的错,而不是回 `undefined` 让调用方去猜。
        return Promise.reject(new TypeError(`Dir resource has no read named ${JSON.stringify(name)}`))
    }
  }

  async plan(op: string, ref: ResourceRef | null, _params: unknown, ctx: PlanContext): Promise<Intent<DirOpPayload>> {
    if (op !== 'reveal') throw new TypeError(`Dir resource has no op named ${JSON.stringify(op)}`)
    // 沙箱与读那一条同一句话、同一把尺子:**先夹后降级** —— 越界的答案是越界,
    // 不是「这台宿主没有外壳能力」(与 `rpc/domains/files.ts` 的 `reveal` 逐字同序)。
    const target = resolveInsideSandbox(requireDirPath(ref, op), ctx.sandbox, ctx.invocation.sessionId)
    // 宿主口缺席在 **plan** 期就判,与 `ResourceTool` 对 `home: 'shell'` 的那一句
    // 同一个理由:一次注定跑不了的做法不该先去弹一张权限卡问人。
    if (!hasShellHost()) throw new DirShellUnavailableError()
    return planFromSpec<DirOpPayload>(this.spec, op, ref, { op: 'reveal', path: target }, {
      title: `Show ${target} in the file manager`,
    })
  }

  async apply(op: string, intent: Intent<DirOpPayload>, _ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    if (payload.op !== 'reveal') throw new TypeError(`Dir resource has no op named ${JSON.stringify(op)}`)
    // 投影函数与注入**逐字抄自 `rpc/domains/files.ts` 的 `reveal`**:先 stat(路径
    // 不在就是失败,不是一次静默的无操作),再经宿主口定位;未注入 = 抛,投影自己
    // catch 成 `{ success:false, error }`。
    const response = await revealOnethingPath({
      path: payload.path,
      stat: target => fs.stat(target),
      revealPath: async target => {
        const outcome = await getShellHost().revealPath(target)
        if (!outcome.success) throw new Error(outcome.error ?? SHELL_HOST_UNAVAILABLE)
      },
    })
    if (!response.success) throw new DirOperationFailedError(response.error ?? 'Failed to reveal path')
    return textResult(`Showed ${payload.path} in the file manager`)
  }

  private async list(target: string): Promise<unknown> {
    const response = await listOnethingDirectory({
      path: target,
      readDir: dirPath => fs.readdir(dirPath, { withFileTypes: true }),
      stat: entryPath => fs.stat(entryPath).catch(() => null),
    })
    if (!response.success) throw new DirOperationFailedError(response.error ?? 'Failed to list directory')
    return {
      entries: (response.entries ?? []).map(entry => ({
        name: entry.name,
        path: entry.path,
        kind: kindOf(entry.type),
        // 缺席的格子**不出现**,不写成 `null` / `0`:一个 stat 不到的项与一个 0 字节
        // 的项在读者眼里不该是同一件事(与会话摘要那几格同一条)。
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
      })),
    }
  }

  private async stat(target: string): Promise<unknown> {
    // `homeDir` 不给:`~` 已经在 `sandbox.resolve` 那一步展开过了(那只函数的
    // `expandCorePath`),这里再展一次等于两处各有一份 home 的解释权。
    const response = await statOnethingPath({ path: target, stat: path => fs.stat(path) })
    if (!response.success) throw new DirOperationFailedError(response.error ?? 'Failed to stat path')
    return {
      path: response.path ?? target,
      kind: kindOf(response.type),
      ...(response.size !== undefined ? { size: response.size } : {}),
      ...(response.mtimeMs !== undefined ? { mtimeMs: response.mtimeMs } : {}),
    }
  }
}

/**
 * 一个地址 → 一个判过界的绝对路径。读与做共用这一只 —— 两条路上的边界必须是同一
 * 句话,写两遍的下场是某天有人只改了其中一条。
 *
 * 三关,顺序是想清楚的:**没有沙箱 → 越界 → 敏感**。先说宿主缺能力(那与这个路径
 * 无关),再说这个路径在不在界内(界外的东西不必再问它敏不敏感)。
 *
 * 界 = **读根**(`sandbox.readable`),不是写根。`scope` 是发起会话,由两条路各自
 * 从自己的上下文里取(读那条是 `ResourceReadContext.sessionId`,做那条是
 * `PlanContext.invocation.sessionId`)。
 *
 * `reveal` 也按读根判,不按写根:它没有一格效果(只是把文件管理器叫到前台),
 * 而「看得见 / 列得出的目录能不能在访达里指给我看」若与「列得出」不是同一个答案,
 * 用户看到的就是一条列得出来却定位不了的目录。
 */
function resolveInsideSandbox(
  rawPath: string,
  sandbox: SandboxPolicy | undefined,
  scope: string | undefined,
): string {
  if (!sandbox) throw new DirOutsideSandboxError(rawPath, 'no-sandbox')
  const resolved = sandbox.resolve(rawPath)
  if (!sandbox.readable(resolved, scope)) throw new DirOutsideSandboxError(resolved, 'outside')
  if (sandbox.isSensitive(resolved)) throw new DirOutsideSandboxError(resolved, 'sensitive')
  return resolved
}
