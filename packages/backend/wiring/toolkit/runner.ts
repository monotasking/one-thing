/**
 * R2a —— `createAppToolRunner()`:把端口装进 `ToolRunner`。
 *
 * 这是新树的"装配配方",与 `createOnethingBackend` 同一个性质:排序约束与默认端口
 * 住在这一处,别处不重复。**只导出工厂,任何模块都不在 import 期调用它** ——
 * `app/__tests__/import-side-effect-free.test.ts` 那道栅栏对新树同样成立。
 *
 * R2a 到此为止:引擎、agent-loop、旧 registry、IPC bridge、渲染器一个字都没动。
 * 把这个 runner 接到那三处缝上是 R2b。
 */

import { ToolRunner } from '@onething/core/toolkit'
import type {
  Authorizer,
  Interceptor,
  Invocation,
  JobRegistry,
  Observer,
  SandboxPolicy,
  SessionSnapshot,
  SpillPort,
  Validator,
} from '@onething/core/toolkit'
import { ZodValidator } from '@onething/runtime/toolkit'
import { classifySensitiveFile } from '@onething/runtime/tools/sensitive-files'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../../store.js'
import {
  getOnethingToolOutputsDir,
} from '@onething/runtime/storage'
import {
  findReadSandboxRootForPath,
  getSandboxBoundary,
  isPathContained,
  resolveToolPath,
} from '../tools/core/sandbox.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { createPermissionAuthorizer } from './authorizer.js'
import { AuditProjector, combineObservers, type ToolAuditSink } from '@onething/runtime/toolkit/audit-observer'
import { BackgroundJobRegistry } from './jobs.js'

/**
 * 溢出落盘。目录就是 bash 的输出累积器今天用的那一个(`getOnethingToolOutputsDir()`)——
 * 一个目录意味着**一条清扫路径**(§11.1 第 2 条),而不是每个工具一个。
 */
export function createToolOutputSpill(): SpillPort {
  return request => {
    const dir = getOnethingToolOutputsDir()
    mkdirSync(dir, { recursive: true })
    const name = `spill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${request.toolId ?? 'tool'}.txt`
    const path = join(dir, name)
    writeFileSync(path, request.text, 'utf-8')
    return path
  }
}

/**
 * 沙箱端口。R1 的六只工具**不用**它(`FileTool` 持有自己那组按会话解析的
 * adapters,因为沙箱根是 per-space 的,而这个端口的签名里没有会话)。它存在是为了
 * 让没有会话语境的工具(R3 的那批)有一条统一的问路口,判据仍然是同一批函数。
 */
export interface SandboxPolicyOptions {
  /**
   * 这个作用域(= 发起会话)带进来的额外**读根**,今天就是那条会话自己的
   * 工作目录。缺席 / 空数组 = 与没有这一格时逐字节相同。
   *
   * 为什么是一只函数而不是一个列表:作用域是**每次调用**才知道的
   * (`readable(target, scope)`),而端口是装配期造一次的。
   */
  readonly workingDirectoryRootsFor?: (scope?: string) => readonly string[]
}

export function createSandboxPolicy(
  cwd?: () => string | undefined,
  options: SandboxPolicyOptions = {},
): SandboxPolicy {
  const workingDirectory = () => cwd?.()
  return {
    root: () => getSandboxBoundary(workingDirectory()),
    resolve: (target, at) => resolveToolPath(target, at ?? workingDirectory()),
    contains: target => isPathContained(getSandboxBoundary(workingDirectory()), target),
    /**
     * 「读得到吗」(2026-09-10)。判据是 `read` 工具判 `external_directory` 用的
     * **那一张读根表**,不是第二份:`findReadSandboxRootForPath` → 产品层的
     * `getOnethingDefaultReadRoots`(笔记根 + 接入目录 + 应用产物目录 + 下载目录)
     * 并上写根。所以模型经 `read` 读一个文件、与界面 / 脚本经 `dir` 资源列它的父
     * 目录,认的是同一批目录 —— 两张表是「用户接入了一个目录,却发现能改不能列」
     * 这种自相矛盾权限面的标准形状。
     *
     * `scope` 在这台宿主上被解释成**发起会话**:接入目录是 per-space 的,取哪一份
     * 由会话归属决定(批 B2 / 设计盲点 1 —— A 空间的会话在跑时用户切到 B,那条流
     * 仍然该看见 A 的目录)。缺席退回全局层,与
     * `getConnectedDirectoriesForSession` 自己那句诚实降级逐字同义,绝不去猜
     * 「用户现在在看哪个空间」。
     *
     * `workingDirectoryRoots` 这一格由 `options.workingDirectoryRootsFor` 填
     * (2026-09-13):它原本恒 `undefined`,而工具那条路
     * (`toolkit/families/file.ts` 的 `sandboxRoots`)一直把 `scope.workingDirectory`
     * 当读根 —— 于是**同一条会话、同一个仓**,`read` 工具读得到、`dir:` / `git:`
     * 资源答「outside the sandbox root」。那不是两种严格程度,那是两把尺子,而两把
     * 尺子里松的那把迟早会被当成规矩。缺席仍然退回原样(更紧,不更松)。
     */
    readable: (target, scope) => findReadSandboxRootForPath(
      target,
      workingDirectory(),
      [...(options.workingDirectoryRootsFor?.(scope) ?? [])],
      { getConnectedDirectories: () => getConnectedDirectoriesForSession(scope) },
    ) !== undefined,
    isSensitive: target => classifySensitiveFile(target).sensitive,
  }
}

/**
 * 会话快照:只读、只带工具看得见的那几样。
 *
 * `metadata.workspaceId`(S6 加):这条会话归哪个 space。`SessionSnapshot.metadata`
 * 这一格一直在类型上,但从来没人填 —— 于是任何读它的工具拿到的都是 `undefined`,
 * 而那读起来和「这条会话没有 space」一模一样。`search` 是第一个要问这件事的工具
 * (`SearchContext.spaceId`),所以在这里把它填**真**:缺席仍然是缺席(旧会话零迁移,
 * 读取端自己缺省成 default space),但存在的时候不再被这一层吞掉。
 */
export function sessionSnapshotFor(invocation: Invocation): SessionSnapshot | undefined {
  const session = store.getSession(invocation.sessionId) as
    | { id: string; title?: string; kind?: string; workingDirectory?: string; workspaceId?: string }
    | undefined
  if (!session) return undefined
  return {
    id: session.id,
    title: session.title,
    kind: session.kind,
    workspaceRoot: session.workingDirectory ?? invocation.workspaceRoot,
    ...(typeof session.workspaceId === 'string' ? { metadata: { workspaceId: session.workspaceId } } : {}),
  }
}

/**
 * 「这次调用跑在哪一棵树里」,在**调用坐标上没有 cwd 时**退到发起会话的工作目录。
 *
 * 为什么需要它:`PermissionAuthorizer` 的缺省判据是 `invocation.cwd ??
 * invocation.workspaceRoot`,而模型那条路(`wiring/toolkit/wiring.ts` 拼 `Invocation`
 * 的地方)两格都从执行上下文填了真值,资源内核那条路(`core/resource/kernel.ts`
 * 的 `do` / `read`)**一格都没有** —— 它的坐标是 `principal` + `sessionId`,没有
 * cwd 这个概念。后果不是"少一格信息"而是两件真事:
 *   · 项目级的授权(`workdir` / `always`)落不下去(`addGrant` 对 workspace 档缺
 *     root 会抛,所以在此之前那两档在资源面上根本不成立);
 *   · 就算落下去了也匹配不上 —— `matchGrant` 只在 `workspaceRoot` 在场时才去翻
 *     工作区那张表。
 * 于是「在这个项目里始终允许这个应用」在资源面上会是一个点了没有反应的键。
 *
 * 判据用的是**发起会话**的工作目录,与 `sessionSnapshotFor` 读的同一格 ——
 * 「这次调用属于哪个项目」在资源面上唯一说得清的答案就是发起它的那条会话在哪。
 * 没有发起会话(`NO_ORIGIN_SESSION`)或那条会话没有工作目录时仍然是 `undefined`,
 * 于是项目级的两档照旧不出现,而不是编一个根出来。
 */
export function sessionWorkspaceRootFor(invocation: Invocation): string | undefined {
  return invocation.cwd ?? invocation.workspaceRoot ?? sessionSnapshotFor(invocation)?.workspaceRoot
}

export interface AppToolRunnerOptions {
  /** 事件流的出口。桌面接 `IpcProjector`,server 接 SSE 的那一个。 */
  readonly observer: Observer
  /** 审计出口。R2b 接事件日志;不给就不记。 */
  readonly audit?: ToolAuditSink
  /** 插件拦截。R2b 接 `app/plugins/tool-call-intercept.ts` 那两个挂点。 */
  readonly interceptor?: Interceptor
  readonly authorizer?: Authorizer
  readonly jobs?: JobRegistry
  readonly sandbox?: SandboxPolicy
  readonly spill?: SpillPort
  readonly session?: (invocation: Invocation) => SessionSnapshot | undefined
  /**
   * 契约解释权(K2a)。缺省是 `ZodValidator` —— 产品层的工具用 zod 写契约,那张
   * WeakMap 反查得回来。
   *
   * 资源那台 runner 传的是一位**组合**校验者(`wiring/resource/index.ts`):生成的
   * 资源契约不在 zod 那张表里,反查失败就 passthrough,于是未知 op 只能等到 plan
   * 期抛、判成 `failed`。给它配一位认得生成 schema 的校验者,是 K1 在
   * `core/resource/errors.ts` 头注释里写明的正路(而不是在内核里给 plan 开一个能
   * 返回 `Outcome` 的后门)。
   */
  readonly validator?: Validator
}

export function createAppToolRunner(options: AppToolRunnerOptions): ToolRunner {
  const observer = options.audit
    ? combineObservers(options.observer, new AuditProjector(options.audit))
    : options.observer

  return new ToolRunner({
    authorizer: options.authorizer ?? createPermissionAuthorizer(),
    observer,
    validator: options.validator ?? new ZodValidator(),
    interceptor: options.interceptor,
    jobs: options.jobs ?? new BackgroundJobRegistry(),
    sandbox: options.sandbox ?? createSandboxPolicy(),
    spill: options.spill ?? createToolOutputSpill(),
    session: options.session ?? sessionSnapshotFor,
  })
}
