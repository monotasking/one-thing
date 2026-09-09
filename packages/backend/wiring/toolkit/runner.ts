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
  getSandboxBoundary,
  isPathContained,
  resolveToolPath,
} from '../tools/core/sandbox.js'
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
export function createSandboxPolicy(cwd?: () => string | undefined): SandboxPolicy {
  const workingDirectory = () => cwd?.()
  return {
    root: () => getSandboxBoundary(workingDirectory()),
    resolve: (target, at) => resolveToolPath(target, at ?? workingDirectory()),
    contains: target => isPathContained(getSandboxBoundary(workingDirectory()), target),
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
