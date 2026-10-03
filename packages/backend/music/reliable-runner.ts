/**
 * The conductor's only way of talking to ncm-cli.
 *
 * Every trap we measured is fossilized here so no call site has to remember
 * them (see docs/design/music-radio-conductor.md §7):
 *
 *  - Exit 0 is not success: refusals arrive as `{success:false}` with a zero
 *    exit code. The envelope is the verdict, the exit code a rumor.
 *  - A transport command saying "ok" is not proof either: after every
 *    state-changing command we read `state` back and judge by what the player
 *    actually does. `state` is measured side-effect-free, so the read is safe.
 *  - Retries are classified: server commands get 2 with backoff (network),
 *    warm transport gets 1 (measured ~100%, a retry is cheap insurance),
 *    cold start gets 0 — that path is the ~20% coin flip and belongs to the
 *    keepalive flow, never to a retry loop.
 */

import { extractNcmCliJson } from './ncm-cli-driver.js'
import { parseNowPlaying, type OnethingMusicNowPlaying } from './now-playing.js'
import type { OnethingMusicProcessRunner } from './types.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('music')

/**
 * `start` is for `play`: NON-IDEMPOTENT, so zero retries — a play that
 * "failed" may still make sound seconds later (controller disconnected, slow
 * fetch), and an automatic re-run means the same song starting twice
 * (field-measured). Reliability for starts is the caller's poll-verify plus
 * the conductor's next tick, never a blind re-run.
 */
export type OnethingMusicCommandClass = 'server' | 'transport' | 'start' | 'read'

const RETRIES: Record<OnethingMusicCommandClass, number> = {
  server: 2,
  transport: 1,
  start: 0,
  read: 0,
}

const TIMEOUTS: Record<OnethingMusicCommandClass, number> = {
  server: 20_000,
  transport: 10_000,
  start: 15_000,
  read: 8_000,
}

export class OnethingMusicCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
  ) {
    super(message)
    this.name = 'OnethingMusicCommandError'
  }
}

export interface OnethingMusicReliableRunner {
  /** Run one ncm-cli command; resolves with parsed stdout, rejects on refusal. */
  run(
    commandClass: OnethingMusicCommandClass,
    args: string[],
    env?: Record<string, string | undefined>,
  ): Promise<string>
  /**
   * Run a state-changing command, then read `state` back and hand the caller
   * the player's actual answer. `verify` gets that answer and returns whether
   * the command truly took; a false verdict burns one extra retry.
   */
  runVerified(
    args: string[],
    verify: (nowPlaying: OnethingMusicNowPlaying | null) => boolean,
  ): Promise<OnethingMusicNowPlaying | null>
  readState(): Promise<OnethingMusicNowPlaying | null>
}

/** The provider-specific slice the runner needs; defaults to ncm-cli. */
export interface OnethingMusicReliableRunnerCli {
  binary: string
  parse: {
    envelope(stdout: string): { ok: boolean; message?: string }
    nowPlaying(stdout: string): OnethingMusicNowPlaying | null
  }
}

export interface CreateOnethingMusicReliableRunnerOptions {
  runner: OnethingMusicProcessRunner
  logger?: { warn(message: string, ...args: unknown[]): void }
  /** Test seam. Default: real setTimeout. */
  sleep?(ms: number): Promise<void>
  /**
   * The active provider's binary + wire parsers. Absent = ncm-cli, so the
   * founding callers and tests keep today's behavior verbatim.
   */
  cli?: OnethingMusicReliableRunnerCli
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const defaultNcmCli: OnethingMusicReliableRunnerCli = {
  binary: 'ncm-cli',
  parse: {
    envelope(stdout) {
      const envelope = extractNcmCliJson(stdout)
      return envelope?.success === false
        ? { ok: false, message: envelope.message?.trim() || undefined }
        : { ok: true }
    },
    nowPlaying: parseNowPlaying,
  },
}

export function createOnethingMusicReliableRunner(
  options: CreateOnethingMusicReliableRunnerOptions,
): OnethingMusicReliableRunner {
  const sleep = options.sleep ?? defaultSleep
  const cli = options.cli ?? defaultNcmCli

  const runOnce = async (
    commandClass: OnethingMusicCommandClass,
    args: string[],
    env?: Record<string, string | undefined>,
  ): Promise<string> => {
    const spawnedAt = Date.now()
    const result = await options.runner.run({
      command: cli.binary,
      args,
      env,
      timeoutMs: TIMEOUTS[commandClass],
    })
    // Timing probe (slow ⏭ investigation): every call is a fresh CLI process,
    // so this line is the per-command fixed cost, spawn included.
    log.debug('cli command finished', {
      binary: cli.binary,
      args,
      commandClass,
      durationMs: Date.now() - spawnedAt,
    })
    const envelope = cli.parse.envelope(result.stdout)
    if (!envelope.ok) {
      throw new OnethingMusicCommandError(
        envelope.message || `${cli.binary} ${args.join(' ')} 被拒绝`,
        args,
      )
    }
    if (result.code !== 0) {
      throw new OnethingMusicCommandError(
        result.stderr.trim() || `${cli.binary} ${args.join(' ')} 退出码 ${result.code}`,
        args,
      )
    }
    return result.stdout
  }

  const run = async (
    commandClass: OnethingMusicCommandClass,
    args: string[],
    env?: Record<string, string | undefined>,
  ): Promise<string> => {
    let lastError: unknown
    for (let attempt = 0; attempt <= RETRIES[commandClass]; attempt += 1) {
      if (attempt > 0) {
        options.logger?.warn(`[music] retrying ${cli.binary} ${args.join(' ')} (attempt ${attempt + 1})`, lastError)
        await sleep(500 * attempt)
      }
      try {
        return await runOnce(commandClass, args, env)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  const readState = async (): Promise<OnethingMusicNowPlaying | null> => {
    const stdout = await run('read', ['state'])
    const state = cli.parse.nowPlaying(stdout)
    // An unreadable reply used to vanish into "not playing": the 2026-09-18
    // upgrade banner made every read null for hours and nothing said so.
    if (state === null) log.warn('state reply not understood', { binary: cli.binary, head: stdout.slice(0, 160) })
    return state
  }

  return {
    run,
    readState,
    async runVerified(args, verify) {
      let lastState: OnethingMusicNowPlaying | null = null
      // One honest attempt plus one insurance retry — same budget as 'transport'.
      for (let attempt = 0; attempt <= RETRIES.transport; attempt += 1) {
        await run('transport', args)
        lastState = await readState()
        if (verify(lastState)) return lastState
        options.logger?.warn(
          `[music] ${cli.binary} ${args.join(' ')} claimed success but state disagrees; ${
            attempt < RETRIES.transport ? 'retrying' : 'giving up'
          }`,
        )
      }
      throw new OnethingMusicCommandError(`${cli.binary} ${args.join(' ')} 声称成功但播放器状态未变`, args)
    },
  }
}
