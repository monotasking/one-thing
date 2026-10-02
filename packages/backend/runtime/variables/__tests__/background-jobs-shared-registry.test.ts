import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { registerBackgroundJob } from '../../tools/background-jobs.js'
import { BackgroundJobsProvider } from '../providers/background-jobs.js'

/**
 * The state board only works if BackgroundJobsProvider's DEFAULT deps read
 * the very registry the bash tool writes (one shared module instance).
 * If a bundler or a host ever splits them, the board goes silently empty —
 * this test pins the same-instance assumption with a real process.
 */
describe('background jobs shared registry', () => {
  it('default provider deps see jobs registered through the bash-tool registry', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    if (!child.pid) throw new Error('failed to spawn test process')

    const sessionId = `shared-registry-${process.pid}-${Date.now()}`
    const job = registerBackgroundJob({
      command: 'sleep 30',
      cwd: '/tmp',
      sessionId,
      shellPid: 0,
      pgid: child.pid,
    })

    try {
      const provider = new BackgroundJobsProvider() // default deps on purpose
      const [variable] = provider.list({ sessionId })
      expect(variable?.name).toBe('background_jobs')
      expect(variable?.value).toContain(job.id)
      expect(variable?.value).toContain('running')
      expect(variable?.state).toBe(true)

      // Session isolation must hold through the default path too.
      expect(provider.list({ sessionId: 'some-other-session' })).toEqual([])
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // best-effort cleanup
      }
    }
  })
})
