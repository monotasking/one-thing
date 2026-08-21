/**
 * The sandbox guard for context-carrying RPC domains (主线 T 批 3,
 * docs/design/dsh-architecture-adoption-2026-08.md §3).
 *
 * 批 1 把 `markdown` / `permission-grants` / `files` / `project-dirs` /
 * `spaces` 记进「不可迁清单」第 2 类 ——「迁了会掉安全护栏」。护栏本身没什么
 * 神秘的：`apps/server` 每个 owner 有一个沙箱根 `<workspaceRoot>/<uid>/<wid>`，
 * 请求里的每条路径都要夹进去。真正缺的是**输入**：通用信封不带 context，
 * handler 无从知道自己该不该夹。`RpcDispatchContext` 补上输入之后，护栏就可以
 * 从 server 搬进 app 层，两个宿主共用同一份实现 —— 这个文件就是那份实现。
 *
 * 三条不变量：
 * 1. **fail-closed**：`transport:'http'` 却没有 sandboxRoot = 宿主接线漏了，
 *    直接拒绝，绝不退回「不夹」。宁可一条 RPC 报错，也不要在联网宿主上悄悄放开
 *    整个文件系统。
 * 2. **desktop 不夹**：`transport:'ipc'` 是用户自己的机器，语义与迁移前
 *    `@main` handler 逐字一致（那些 handler 从来没有沙箱概念）。
 * 3. **只认已解析路径**：所有比较都在 `resolve()` 之后做，`..` 与符号链接式的
 *    相对拼接在比较前就已经塌掉了。
 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'

/** 未夹紧：桌面宿主，请求可以碰用户机器上的任何路径（迁移前的行为）。 */
export interface UnconfinedRpcSandbox {
  confined: false
}

/** 夹紧：联网宿主，本次请求的文件系统触达范围就是 `root` 这棵子树。 */
export interface ConfinedRpcSandbox {
  confined: true
  root: string
}

export type RpcSandbox = UnconfinedRpcSandbox | ConfinedRpcSandbox

/**
 * 一个路径落在沙箱内吗。
 *
 * 与 `apps/server` 里那份同名 helper 逐字同义（迁移的等价性就压在这上面）：
 * 用 `relative()` 而不是字符串前缀，避免 `/a/bc` 被判进 `/a/b`。
 */
export function isPathInside(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

/**
 * 宿主给的 context → 本次请求的沙箱。
 *
 * 抛出（而不是返回 null）的那一支是**接线 bug** 而非用户输入错误：一个联网
 * 宿主没有把沙箱根交下来，这条 RPC 就没有任何安全的语义可言。错误信息写给
 * 改代码的人看，不写给终端用户看。
 */
export function resolveRpcSandbox(context: RpcDispatchContext): RpcSandbox {
  if (context.transport === 'ipc') return { confined: false }
  const root = typeof context.sandboxRoot === 'string' ? context.sandboxRoot.trim() : ''
  if (!root || !isAbsolute(root)) {
    throw new Error(
      '[rpc] A networked (transport:"http") dispatch context arrived without an absolute '
      + 'sandboxRoot. The host must mint one — refusing rather than running unconfined.',
    )
  }
  return { confined: true, root: resolve(root) }
}

/**
 * 把一条请求里来的路径夹进沙箱；夹不住返回 null。
 *
 * 未夹紧时原样返回（只做 `resolve`），因为桌面语义就是「用户说哪就是哪」。
 * 夹紧时的规则与 `resolveServerWorkspaceFilePath` 一致：
 * - 相对路径以沙箱根为基准；
 * - `~` / `~/x` 展开到沙箱根（联网宿主上「家目录」只能是沙箱）；
 * - 绝对路径原样解析，然后必须落在根内。
 */
export function resolveInsideSandbox(
  sandbox: RpcSandbox,
  requestedPath: string,
): string | null {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') return null
  if (!sandbox.confined) return resolve(expandHome(requestedPath))

  const expanded = requestedPath === '~'
    ? sandbox.root
    : requestedPath.startsWith('~/')
      ? join(sandbox.root, requestedPath.slice(2))
      : requestedPath
  const candidate = resolve(isAbsolute(expanded) ? expanded : join(sandbox.root, expanded))
  return isPathInside(candidate, sandbox.root) ? candidate : null
}

/**
 * 未夹紧分支的 `~` 展开。桌面 handler 迁移前拿到的是渲染层给的绝对路径，
 * 这里不额外造语义：只有真的以 `~` 开头才碰 `process.env.HOME`，拿不到就原样
 * 留着（让下游的 fs 调用去报它自己的错，而不是我们编一个路径出来）。
 */
function expandHome(value: string): string {
  if (value !== '~' && !value.startsWith('~/')) return value
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return value
  return value === '~' ? home : join(home, value.slice(2))
}

/** 已解析的绝对路径落在沙箱内吗（未夹紧恒真）。 */
export function isAllowedBySandbox(sandbox: RpcSandbox, absolutePath: string): boolean {
  if (!sandbox.confined) return true
  return isPathInside(absolutePath, sandbox.root)
}

/**
 * 宿主拼沙箱根用的路径分段消毒。
 *
 * 与 `apps/server/src/runtime.ts` 的 `safePathSegment` 逐字同义 —— 导出到这里
 * 是为了让「沙箱根长什么样」只有一份定义，宿主适配器直接引用，而不是各抄一遍
 * 正则。
 */
export function safeOwnerPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
}

/** `<workspaceRoot>/<uid>/<wid>` —— 联网宿主的 per-owner 沙箱根。 */
export function ownerSandboxRoot(
  workspaceRoot: string,
  ownerUid: string,
  workspaceId: string,
): string {
  return join(workspaceRoot, safeOwnerPathSegment(ownerUid), safeOwnerPathSegment(workspaceId))
}
