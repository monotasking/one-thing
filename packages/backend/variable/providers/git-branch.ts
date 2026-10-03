import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ContextVariable, VariableContext, VariableProvider } from '../types.js'

const NAME = 'git_branch'


async function findGitDir(start: string): Promise<string | null> {
  let dir = start
  for (;;) {
    const dotGit = path.join(dir, '.git')
    try {
      const stat = await fs.stat(dotGit)
      if (stat.isDirectory()) return dotGit
      if (stat.isFile()) {
        // Worktree/submodule: .git is a file containing "gitdir: <path>".
        const content = await fs.readFile(dotGit, 'utf8')
        const m = content.match(/^gitdir: (.+)$/m)
        return m ? path.resolve(dir, m[1].trim()) : null
      }
    } catch {
      // No .git here; walk up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function readBranch(workdir: string): Promise<string | null> {
  const gitDir = await findGitDir(workdir)
  if (!gitDir) return null
  try {
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    const m = head.match(/^ref: refs\/heads\/(.+)$/)
    if (m) return m[1]
    return head ? `detached@${head.slice(0, 12)}` : null
  } catch {
    return null
  }
}

/**
 * Read-only state provider exposing the current git branch of the
 * active work directory. Reads .git/HEAD directly (no process spawn); emits
 * nothing when the workdir is unset or not inside a git repository.
 */
export class GitBranchProvider implements VariableProvider {
  readonly id = 'git-branch'
  readonly priority = 21

  constructor(private readonly gateway: {
    /** Active work directory for the session ('' when unset). */
    read(sessionId: string): string
  }) {}

  async list(ctx: VariableContext): Promise<ContextVariable[]> {
    const workdir = this.gateway.read(ctx.sessionId)
    if (!workdir) return []
    const branch = await readBranch(workdir)
    if (!branch) return []
    return [{
      name: NAME,
      value: branch,
      readonly: true,
      state: true,
      description: 'Current git branch of the work directory',
    }]
  }

  claims(name: string): boolean {
    return name === NAME
  }
}
