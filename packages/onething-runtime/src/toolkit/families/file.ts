/**
 * R1 家族基类 —— `FileTool`(§4 的第二族)。
 *
 * 这一族每个成员都做的事只有一件:**把一个用户给的路径变成一个已解析、已定性的
 * 路径**(在不在沙箱根内、敏不敏感),再把这个定性翻成效果。除此之外它不碰 fs。
 *
 * 沙箱解析全部复用旧树的纯函数(`tools/sandbox.ts` / `tools/sensitive-files.ts`)
 * —— 那是"同一个动作谁跑都长一个样"的前提,重写一份判据就是两套判据。
 *
 * ## 越界不是异常,是一条效果
 *
 * 旧 `checkCoreFileAccess` 今天**不拒绝**任何路径(它退化成了一次 resolve);越界
 * 的表达方式是 plan 里多报一条 `external_directory`,由权限层去问人。新树原样保留
 * 这个口径:`resolvePath` 永远不抛,`external` 是返回值上的一位。`requireInside()`
 * 留给将来真的需要硬拒绝的工具(R1 六个都不用它)—— 家族基类提供统一的越界错误,
 * 但不替成员决定要不要抛。
 */

import { makeEffect } from '@onething/core/toolkit'
import type { Effect, Invocation, Preview, SessionSnapshot } from '@onething/core/toolkit'
import { Tool } from '@onething/core/toolkit'
import { basenamePath, dirnamePath, joinPaths } from '@onething/core/storage'
import {
  findCoreReadSandboxRootForPath,
  findCoreSandboxRootForPath,
  getCoreSandboxBoundary,
  getCoreSandboxRoots,
  resolveCoreToolPath,
} from '../../tools/sandbox.js'
import { classifySensitiveFile } from '../../tools/sensitive-files.js'

/** 宿主注入的沙箱面。形状与旧 read/write/edit 的 adapters 逐字同构。 */
export interface FileToolAdapters {
  getDefaultWorkingDirectory?(): string | undefined
  /** 可写沙箱的额外根(用户在设置里加的「接入目录」),per-space,按会话归属取。 */
  getConnectedDirectories?(sessionId?: string): string[]
  /** 只读沙箱的额外根(笔记目录、下载目录…),同样 per-session。 */
  getDefaultReadRoots?(sessionId?: string): string[]
}

/**
 * 一次调用的"工作目录语境"。
 *
 * 沙箱判定要的是一个**根列表**(会话可以挂多个工作目录根),而 `cwd` /
 * `workspaceRoot` 只是标量。R1 从会话快照的 metadata 里捞这份列表;R2a 决定① 把它
 * 升成了 `Invocation.workingDirectoryRoots` 一等字段,这里改读那个字段 ——
 * 坐标在引擎边界一次铸好,工具侧不再从一个自由形状的袋子里翻找。
 */
export interface FileScope {
  readonly sessionId: string
  readonly workingDirectory?: string
  readonly workingDirectoryRoots?: string[]
}

export interface FileToolContextLike {
  readonly invocation: Invocation
  readonly session?: SessionSnapshot
}

/**
 * 根列表的来源,优先级从高到低:调用坐标上的一等字段 → 会话快照的 workspaceRoot
 * → 调用坐标的 workspaceRoot。后两者是单根回退 —— 一个只有"当前项目"这一个根的
 * 会话,不必在每次调用里重复声明它。
 */
function rootsOf(invocation: Invocation, session?: SessionSnapshot): string[] | undefined {
  const declared = invocation.workingDirectoryRoots
  if (declared && declared.length > 0) return [...declared]
  const single = session?.workspaceRoot ?? invocation.workspaceRoot
  return single ? [single] : undefined
}

export function fileScopeOf(ctx: FileToolContextLike): FileScope {
  return {
    sessionId: ctx.invocation.sessionId,
    workingDirectory: ctx.invocation.cwd,
    workingDirectoryRoots: rootsOf(ctx.invocation, ctx.session),
  }
}

/** 一个已解析、已定性的路径。 */
export interface ResolvedFilePath {
  readonly input: string
  readonly absolute: string
  /** 命中的沙箱根;`undefined` = 越界。 */
  readonly root?: string
  readonly boundary: string
  readonly external: boolean
  readonly sensitive: boolean
  readonly sensitiveCategory?: string
  readonly sensitiveReason?: string
}

export class SandboxViolationError extends Error {
  readonly path: string
  readonly boundary: string

  constructor(path: string, boundary: string) {
    super(`Path is outside the allowed directories: ${path} (boundary: ${boundary})`)
    this.name = 'SandboxViolationError'
    this.path = path
    this.boundary = boundary
  }
}

export abstract class FileTool<In, Payload> extends Tool<In, Payload> {
  protected readonly adapters: FileToolAdapters

  constructor(adapters: FileToolAdapters = {}) {
    super()
    this.adapters = adapters
  }

  /**
   * 路径解析 + 定性。`mode` 决定拿哪一组根:写只认工作目录根 + 接入目录,读还额外
   * 认默认读根(笔记/下载)。两套根列表本来就在旧树里分开,这里只是把"哪个工具该
   * 用哪一套"从工具里提到家族。
   */
  protected resolvePath(
    rawPath: string,
    ctx: FileToolContextLike,
    mode: 'read' | 'write',
  ): ResolvedFilePath {
    const scope = fileScopeOf(ctx)
    const defaultWorkingDirectory = this.adapters.getDefaultWorkingDirectory?.()
    const absolute = resolveCoreToolPath(rawPath, {
      workingDirectory: scope.workingDirectory,
      defaultWorkingDirectory,
    })
    const boundary = getCoreSandboxBoundary({
      workingDirectory: scope.workingDirectory,
      defaultWorkingDirectory,
    })
    const root = mode === 'read'
      ? findCoreReadSandboxRootForPath(absolute, {
          workingDirectory: scope.workingDirectory,
          workingDirectoryRoots: scope.workingDirectoryRoots,
          defaultWorkingDirectory,
          defaultReadRoots: this.adapters.getDefaultReadRoots?.(scope.sessionId),
        })
      : findCoreSandboxRootForPath(absolute, {
          workingDirectory: scope.workingDirectory,
          workingDirectoryRoots: scope.workingDirectoryRoots,
          connectedDirectories: this.adapters.getConnectedDirectories?.(scope.sessionId),
          defaultWorkingDirectory,
        })
    const sensitivity = classifySensitiveFile(absolute)

    return {
      input: rawPath,
      absolute,
      root,
      boundary,
      external: !root,
      sensitive: sensitivity.sensitive,
      sensitiveCategory: sensitivity.category,
      sensitiveReason: sensitivity.reason,
    }
  }

  /** 可写沙箱的全部根 —— `ProcessTool` 之外还需要它的只有诊断用途。 */
  protected sandboxRoots(ctx: FileToolContextLike): string[] {
    const scope = fileScopeOf(ctx)
    return getCoreSandboxRoots({
      workingDirectory: scope.workingDirectory,
      workingDirectoryRoots: scope.workingDirectoryRoots,
      connectedDirectories: this.adapters.getConnectedDirectories?.(scope.sessionId),
      defaultWorkingDirectory: this.adapters.getDefaultWorkingDirectory?.(),
    })
  }

  /** 硬拒绝越界。R1 六个工具都不用它(旧口径是报效果、由人裁决)。 */
  protected requireInside(resolved: ResolvedFilePath): ResolvedFilePath {
    if (resolved.external) throw new SandboxViolationError(resolved.absolute, resolved.boundary)
    return resolved
  }

  /**
   * 读一个路径的效果面。与旧 `read.ts` 的 `analyze` 逐字同口径:越界时先一条
   * `external_directory`(资源粒度是所在目录),再一条 `read` 或
   * `sensitive_file_read`。
   */
  protected readEffects(resolved: ResolvedFilePath, operation = 'Read file'): Effect[] {
    const effects: Effect[] = []
    if (resolved.external) {
      effects.push(makeEffect('external_directory', [joinPaths(dirnamePath(resolved.absolute), '*')], {
        barrier: true,
        external: true,
        metadata: {
          path: resolved.absolute,
          boundary: resolved.boundary,
          operation,
          targetType: 'file',
        },
      }))
    }
    effects.push(makeEffect(
      resolved.sensitive ? 'sensitive_file_read' : 'read',
      [resolved.absolute],
      {
        barrier: resolved.sensitive,
        sensitive: resolved.sensitive,
        metadata: resolved.sensitive
          ? { path: resolved.absolute, category: resolved.sensitiveCategory, reason: resolved.sensitiveReason }
          : { path: resolved.absolute },
      },
    ))
    return effects
  }

  protected readPreview(resolved: ResolvedFilePath): Preview {
    return {
      title: resolved.sensitive
        ? `Read sensitive file: ${basenamePath(resolved.absolute)}`
        : `Read ${basenamePath(resolved.absolute)}`,
      path: resolved.absolute,
    }
  }
}
