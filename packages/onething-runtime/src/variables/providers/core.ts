import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Stats } from 'node:fs'
import type { EnforcePermissionPolicyInput } from '../../permissions/index.js'
import {
  VariableError,
  type ContextVariable,
  type SetInput,
  type VariableContext,
  type VariableProvider,
} from '../types.js'

export interface WorkdirGateway {
  read(sessionId: string): string
  readRoots(sessionId: string): string[]
  write(sessionId: string, workdir: string, options?: { description?: string }): void | Promise<void>
  writeRoots(sessionId: string, roots: string[]): void | Promise<void>
  expandPath(input: string): string
  onChange?(callback: (sessionId: string) => void): () => void
}

export type WorkdirPermissionPolicyInput = EnforcePermissionPolicyInput

export interface CoreProviderAdapters {
  enforcePermission?: (input: WorkdirPermissionPolicyInput) => Promise<void>
  /**
   * Directories the user has already blessed (e.g. registered project dirs).
   * Switching the workdir into one of these skips the permission barrier.
   *
   * `ctx.sessionId` 是**必给**的第二参(批 B4):名册 per-space,判据必须落在
   * 会话归属的那一份上,否则 A 空间的名册会替 B 空间的会话免掉审批。
   */
  isPreauthorizedDirectory?: (
    path: string,
    ctx: { sessionId: string },
  ) => boolean | Promise<boolean>
}

const NAME_WORKDIR = 'workdir'
const DESC_WORKDIR = 'Ordered workdir list. values[0] is the active cwd for relative paths, bash defaults, AGENTS.md, project skills, and project todo state; later values are additional sandbox roots for file/bash tools. set replaces the active cwd, append adds a root, remove drops one; cannot be deleted. Values must be existing directories. set also auto-registers the directory in Known Projects; pass description to name/rename that entry.'

function normalizePath(input: string): string {
  return path.resolve(input)
}

function uniqueRoots(roots: string[], active: string): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  const activePath = active ? normalizePath(active) : ''

  for (const root of roots) {
    const normalized = normalizePath(root)
    if (!normalized || normalized === activePath || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }

  return output
}

function workdirVariable(active: string, roots: string[]): ContextVariable {
  const normalizedActive = active ? normalizePath(active) : ''
  const normalizedRoots = uniqueRoots(roots, normalizedActive)
  const values = normalizedActive
    ? [normalizedActive, ...normalizedRoots]
    : normalizedRoots

  return {
    name: NAME_WORKDIR,
    value: normalizedActive,
    values,
    scope: 'session',
    description: DESC_WORKDIR,
    readonly: false,
  }
}

export class CoreProvider implements VariableProvider {
  readonly id = 'core'
  readonly priority = 10

  constructor(
    private readonly gateway: WorkdirGateway,
    private readonly adapters: CoreProviderAdapters = {},
  ) {}

  list(ctx: VariableContext): ContextVariable[] {
    const wd = this.gateway.read(ctx.sessionId)
    const roots = this.gateway.readRoots(ctx.sessionId)
    return [workdirVariable(wd, roots)]
  }

  claims(name: string): boolean {
    return name === NAME_WORKDIR
  }

  async set(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    if (input.name !== NAME_WORKDIR) {
      throw new VariableError('NOT_FOUND', `CoreProvider does not own "${input.name}"`)
    }

    const resolved = await this.resolveExistingDirectory(input.value)
    const active = this.gateway.read(ctx.sessionId)
    const existingRoots = this.gateway.readRoots(ctx.sessionId)

    // set grants the same filesystem access as append (the new directory
    // becomes a sandbox root), so it must pass the same barrier — otherwise
    // set is a permission bypass around append.
    await this.enforceSetPermission(ctx, resolved, active, existingRoots)

    const roots = uniqueRoots(existingRoots, resolved)
    await this.gateway.write(ctx.sessionId, resolved, { description: input.description })
    await this.gateway.writeRoots(ctx.sessionId, roots)
    return workdirVariable(resolved, roots)
  }

  private async enforceSetPermission(
    ctx: VariableContext,
    resolved: string,
    active: string,
    existingRoots: string[],
  ): Promise<void> {
    if (!ctx.messageId || !this.adapters.enforcePermission) return

    const granted = [active, ...existingRoots]
      .filter(Boolean)
      .map(root => normalizePath(root))
    const covered = granted.some(
      root => resolved === root || resolved.startsWith(root + path.sep),
    )
    if (covered) return
    if (await this.adapters.isPreauthorizedDirectory?.(resolved, { sessionId: ctx.sessionId })) return

    await this.adapters.enforcePermission({
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      toolCallId: ctx.toolCallId,
      toolName: 'workdir',
      workspaceRoot: active || resolved,
      effects: [{
        kind: 'external_directory',
        resources: [resolved, path.join(resolved, '*')],
        barrier: true,
        external: true,
        metadata: {
          operation: 'set_workdir',
          directory: resolved,
          activeWorkingDirectory: active || undefined,
        },
      }],
      preview: {
        title: `Set work directory: ${resolved}`,
        metadata: {
          operation: 'set_workdir',
          directory: resolved,
          activeWorkingDirectory: active || undefined,
        },
      },
    })
  }

  async append(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    if (input.name !== NAME_WORKDIR) {
      throw new VariableError('NOT_FOUND', `CoreProvider does not own "${input.name}"`)
    }

    const resolved = await this.resolveExistingDirectory(input.value)
    const active = this.gateway.read(ctx.sessionId)
    const roots = uniqueRoots([...this.gateway.readRoots(ctx.sessionId), resolved], active)

    if (ctx.messageId && this.adapters.enforcePermission) {
      await this.adapters.enforcePermission({
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        toolCallId: ctx.toolCallId,
        toolName: 'workdir',
        workspaceRoot: active || resolved,
        effects: [{
          kind: 'external_directory',
          resources: [resolved, path.join(resolved, '*')],
          barrier: true,
          external: true,
          metadata: {
            operation: 'append_workdir_root',
            directory: resolved,
            activeWorkingDirectory: active || undefined,
          },
        }],
        preview: {
          title: `Add workdir root: ${resolved}`,
          metadata: {
            operation: 'append_workdir_root',
            directory: resolved,
            activeWorkingDirectory: active || undefined,
          },
        },
      })
    }

    await this.gateway.writeRoots(ctx.sessionId, roots)
    return workdirVariable(active, roots)
  }

  async remove(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    if (input.name !== NAME_WORKDIR) {
      throw new VariableError('NOT_FOUND', `CoreProvider does not own "${input.name}"`)
    }

    const resolved = normalizePath(this.gateway.expandPath(input.value))
    const active = this.gateway.read(ctx.sessionId)
    if (active && normalizePath(active) === resolved) {
      throw new VariableError('INVALID_VALUE', 'Cannot remove the active workdir; set a different workdir first.')
    }

    const roots = uniqueRoots(
      this.gateway.readRoots(ctx.sessionId).filter(root => normalizePath(root) !== resolved),
      active,
    )
    await this.gateway.writeRoots(ctx.sessionId, roots)
    return workdirVariable(active, roots)
  }

  onExternalChange(emit: (ctx?: VariableContext) => void): () => void {
    if (!this.gateway.onChange) return () => undefined
    return this.gateway.onChange(sessionId => emit({ sessionId }))
  }

  private async resolveExistingDirectory(input: string): Promise<string> {
    const resolved = normalizePath(this.gateway.expandPath(input))
    let stat: Stats
    try {
      stat = await fs.stat(resolved)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') {
        throw new VariableError('WORKDIR_NOT_FOUND', `Directory does not exist: ${resolved}`)
      }
      throw new VariableError(
        'WORKDIR_NOT_FOUND',
        `Cannot access directory: ${resolved} (${(error as Error)?.message ?? 'unknown error'})`,
      )
    }
    if (!stat.isDirectory()) {
      throw new VariableError('WORKDIR_NOT_FOUND', `Not a directory: ${resolved}`)
    }
    return resolved
  }
}
