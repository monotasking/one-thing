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

/** 会话快照:只读、只带工具看得见的那几样。 */
export function sessionSnapshotFor(invocation: Invocation): SessionSnapshot | undefined {
  const session = store.getSession(invocation.sessionId) as
    | { id: string; title?: string; kind?: string; workingDirectory?: string }
    | undefined
  if (!session) return undefined
  return {
    id: session.id,
    title: session.title,
    kind: session.kind,
    workspaceRoot: session.workingDirectory ?? invocation.workspaceRoot,
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
}

export function createAppToolRunner(options: AppToolRunnerOptions): ToolRunner {
  const observer = options.audit
    ? combineObservers(options.observer, new AuditProjector(options.audit))
    : options.observer

  return new ToolRunner({
    authorizer: options.authorizer ?? createPermissionAuthorizer(),
    observer,
    validator: new ZodValidator(),
    interceptor: options.interceptor,
    jobs: options.jobs ?? new BackgroundJobRegistry(),
    sandbox: options.sandbox ?? createSandboxPolicy(),
    spill: options.spill ?? createToolOutputSpill(),
    session: options.session ?? sessionSnapshotFor,
  })
}
