import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackgroundJob } from '../../tools/background-jobs.js'
import { BackgroundJobsProvider } from '../providers/background-jobs.js'
import { DateTimeProvider, formatHourGranularity } from '../providers/datetime.js'
import { GitBranchProvider } from '../providers/git-branch.js'

describe('DateTimeProvider', () => {
  it('emits a read-only turn variable at hour granularity', () => {
    const fixed = new Date(2026, 6, 10, 9, 37, 42)
    const provider = new DateTimeProvider(() => fixed)
    const [variable] = provider.list()
    expect(variable.name).toBe('datetime')
    expect(variable.value).toBe(formatHourGranularity(fixed))
    expect(variable.value).toContain('2026-07-10 09:00 ')
    expect(variable.readonly).toBe(true)
    expect(variable.state).toBe(true)
  })

  it('keeps values byte-identical within the same hour', () => {
    const a = formatHourGranularity(new Date(2026, 6, 10, 9, 1, 0))
    const b = formatHourGranularity(new Date(2026, 6, 10, 9, 59, 59))
    expect(a).toBe(b)
  })
})

describe('GitBranchProvider', () => {
  const tempDirs: string[] = []

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branch-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  function providerFor(workdir: string): GitBranchProvider {
    return new GitBranchProvider({ read: () => workdir })
  }

  it('reads the branch from .git/HEAD, including from a subdirectory', async () => {
    const repo = await makeTempDir()
    await fs.mkdir(path.join(repo, '.git'))
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
    const nested = path.join(repo, 'src', 'deep')
    await fs.mkdir(nested, { recursive: true })

    const [fromRoot] = await providerFor(repo).list({ sessionId: 's' })
    expect(fromRoot).toMatchObject({ name: 'git_branch', value: 'feature/x', readonly: true, state: true })

    const [fromNested] = await providerFor(nested).list({ sessionId: 's' })
    expect(fromNested.value).toBe('feature/x')
  })

  it('reports detached HEAD with a short sha', async () => {
    const repo = await makeTempDir()
    await fs.mkdir(path.join(repo, '.git'))
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ed25206abcdef012345678901234567890abcdef\n')
    const [variable] = await providerFor(repo).list({ sessionId: 's' })
    expect(variable.value).toBe('detached@ed25206abcde')
  })

  it('follows a worktree .git file pointer', async () => {
    const main = await makeTempDir()
    const gitDir = path.join(main, 'real-git')
    await fs.mkdir(gitDir)
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n')
    const worktree = await makeTempDir()
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    const [variable] = await providerFor(worktree).list({ sessionId: 's' })
    expect(variable.value).toBe('wt-branch')
  })

  it('emits nothing for non-git directories or an unset workdir', async () => {
    const plain = await makeTempDir()
    expect(await providerFor(plain).list({ sessionId: 's' })).toEqual([])
    expect(await providerFor('').list({ sessionId: 's' })).toEqual([])
  })
})

describe('BackgroundJobsProvider', () => {
  const NOW = new Date(2026, 6, 10, 9, 30, 0).getTime()

  function job(partial: Partial<BackgroundJob>): BackgroundJob {
    return {
      id: 'bg-1',
      command: 'bun run dev',
      cwd: '/tmp',
      sessionId: 's1',
      shellPid: 1,
      pgid: 1,
      childPids: [],
      status: 'running',
      startedAt: new Date(2026, 6, 10, 9, 12, 40).getTime(),
      ...partial,
    }
  }

  function providerWith(jobs: BackgroundJob[]): BackgroundJobsProvider {
    return new BackgroundJobsProvider({ listJobs: () => jobs, now: () => NOW })
  }

  it('renders running jobs as a single read-only state variable, without live durations', () => {
    const [variable] = providerWith([
      job({ ports: [5174] }),
      job({ id: 'bg-2', command: '  bun   run\nbuild ', startedAt: new Date(2026, 6, 10, 9, 20, 5).getTime() }),
    ]).list({ sessionId: 's1' })
    expect(variable).toMatchObject({ name: 'background_jobs', readonly: true, state: true })
    expect(variable.value).toBe(
      'bg-1: bun run dev — running, started 09:12, ports 5174; bg-2: bun run build — running, started 09:20',
    )
  })

  it('keeps recently ended jobs on the board and drops old ones', () => {
    const recent = job({ id: 'bg-1', status: 'exited', endedAt: NOW - 5 * 60 * 1000 })
    const stale = job({ id: 'bg-2', status: 'exited', endedAt: NOW - 30 * 60 * 1000 })
    const [variable] = providerWith([recent, stale]).list({ sessionId: 's1' })
    expect(variable.value).toContain('bg-1')
    expect(variable.value).toContain('exited')
    expect(variable.value).not.toContain('bg-2')
  })

  it('shows only jobs owned by the requesting session (never unowned or foreign ones)', () => {
    const provider = providerWith([
      job({ id: 'bg-1', sessionId: 's1' }),
      job({ id: 'bg-2', sessionId: 's2' }),
      job({ id: 'bg-3', sessionId: undefined }),
    ])
    const [forS1] = provider.list({ sessionId: 's1' })
    expect(forS1.value).toContain('bg-1')
    expect(forS1.value).not.toContain('bg-2')
    expect(forS1.value).not.toContain('bg-3')
    expect(provider.list({ sessionId: 's3' })).toEqual([])
  })

  it('emits nothing when no jobs are active or recent', () => {
    expect(providerWith([]).list({ sessionId: 's1' })).toEqual([])
    expect(providerWith([job({ status: 'exited', endedAt: NOW - 60 * 60 * 1000 })]).list({ sessionId: 's1' })).toEqual([])
  })
})
