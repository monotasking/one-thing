import * as os from 'os'
import * as path from 'path'

export type CoreFileAccessTargetType = 'file' | 'directory'

export interface CoreSandboxBoundaryOptions {
  workingDirectory?: string
  defaultWorkingDirectory?: string
  cwd?: string
}

export interface CoreSandboxRootsOptions extends CoreSandboxBoundaryOptions {
  workingDirectoryRoots?: string[]
  /**
   * 「接入目录」——用户在设置里亲手加的全局可写根,与 `workingDirectoryRoots`
   * (每会话)不同,它跨会话生效。
   *
   * 进这个列表是**权限面变化**:write/edit 的 effect 靠
   * `findCoreSandboxRootForPath` 命中与否来标 `external`,而
   * `auto-accept-edits` 只放行 `external !== true` 的写
   * (`core/permission/permission-policy.ts:146`)。所以这里只能装用户显式
   * 添加的目录;缺席/空数组时 `getCoreSandboxRoots` 的结果逐字节不变。
   */
  connectedDirectories?: string[]
}

export interface CoreReadSandboxRootsOptions extends CoreSandboxRootsOptions {
  defaultReadRoots?: string[]
}

export interface CoreFileAccessContext {
  sessionId: string
  messageId: string
  toolCallId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
}

export interface CoreFileAccessOptions extends CoreSandboxBoundaryOptions {
  targetType?: CoreFileAccessTargetType
}

export function expandCorePath(dir: string): string {
  // Only a bare '~' or a '~/' prefix is a home reference. '~foo' is a literal
  // (or another user's home, which is not ours to guess) and must stay as-is.
  if (dir === '~') {
    return os.homedir()
  }
  if (dir.startsWith('~/')) {
    return path.join(os.homedir(), dir.slice(2))
  }
  return dir
}

export function getCoreSandboxBoundary(options: CoreSandboxBoundaryOptions = {}): string {
  if (options.workingDirectory) {
    return options.workingDirectory
  }

  if (options.defaultWorkingDirectory) {
    return expandCorePath(options.defaultWorkingDirectory)
  }

  return options.cwd ?? process.cwd()
}

export function resolveCoreToolPath(
  filePath: string,
  options: CoreSandboxBoundaryOptions = {},
): string {
  const expandedPath = expandCorePath(filePath)
  // Both branches normalize, so '/a/./b', '/a/b/' and '/a/b' resolve to one
  // canonical string — callers key caches (read tracking, mutation queues) off
  // this path and must not see the same file under two names.
  return path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(getCoreSandboxBoundary(options), expandedPath)
}

export function isCorePathContained(boundary: string, targetPath: string): boolean {
  const resolvedBoundary = path.resolve(boundary)
  const resolvedTarget = path.resolve(targetPath)
  return resolvedTarget === resolvedBoundary || resolvedTarget.startsWith(resolvedBoundary + path.sep)
}

export function uniqueCorePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const item of paths) {
    if (!item) continue
    const resolved = path.resolve(expandCorePath(item))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    output.push(resolved)
  }
  return output
}

export function getCoreSandboxRoots(options: CoreSandboxRootsOptions = {}): string[] {
  return uniqueCorePaths([
    getCoreSandboxBoundary(options),
    ...(options.workingDirectoryRoots ?? []),
    ...(options.connectedDirectories ?? []),
  ])
}

export function getCoreReadSandboxRoots(options: CoreReadSandboxRootsOptions = {}): string[] {
  return uniqueCorePaths([
    ...getCoreSandboxRoots(options),
    ...(options.defaultReadRoots ?? []),
  ])
}

export function findCoreSandboxRootForPath(
  targetPath: string,
  options: CoreSandboxRootsOptions = {},
): string | undefined {
  const absoluteTarget = resolveCoreToolPath(targetPath, options)
  return getCoreSandboxRoots(options)
    .find(root => isCorePathContained(root, absoluteTarget))
}

export function findCoreReadSandboxRootForPath(
  targetPath: string,
  options: CoreReadSandboxRootsOptions = {},
): string | undefined {
  const absoluteTarget = resolveCoreToolPath(targetPath, options)
  return getCoreReadSandboxRoots(options)
    .find(root => isCorePathContained(root, absoluteTarget))
}

export async function checkCoreFileAccess(
  filePath: string,
  ctx: CoreFileAccessContext,
  operation: string,
  options: CoreFileAccessOptions = {},
): Promise<string> {
  void operation
  void options.targetType

  return resolveCoreToolPath(filePath, {
    workingDirectory: ctx.workingDirectory,
    defaultWorkingDirectory: options.defaultWorkingDirectory,
    cwd: options.cwd,
  })
}
