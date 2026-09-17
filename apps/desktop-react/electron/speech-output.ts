import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SpeechAudio, SpeechOutputPort } from '@onething/runtime/voice/speech-output'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

/**
 * **主进程出声**(宠物 P3,正本 `docs/design/pet-system-2026-09.md` §10.2「壳的实现」那一行)。
 *
 * 宿主表 `speechOutput` 那一格的 React 壳实现:一段合成好的音频 → 写进临时文件 → 起一个子进程
 * 放 → 放完删文件、resolve。电台口播(以及接管它的宠物)从此在这个壳上真的有声音,不再往一个
 * 没人听的渲染进程推送里空等 30 秒。
 *
 * ── 播放器怎么选(`choosePlayer`,纯函数)────────────────────────────────────
 *   1. `PATH` 里有 `mpv` → `mpv --no-video --really-quiet <file>`(电台本来就要 mpv,多半在);
 *   2. 否则 macOS 上有 `afplay` → `afplay <file>`(系统自带);
 *   3. 都没有 → `play` **立刻 resolve**,记一条 warn(每个进程只记一次:每首歌一句的 warn
 *      只会把日志淹掉,不会多告诉谁什么)。
 * `PATH` 照音乐 CLI 那一套补上 Homebrew / /usr/local(Finder 双击起的 app 不带登录 shell 的
 * PATH,`runtime/music/process-runner.ts` 同一个理由)。
 *
 * ── 规矩 ─────────────────────────────────────────────────────────────────
 *  · **同一时刻只放一段**:新的一段先停旧的(旧的那一次 `play` 随之 resolve);
 *  · **中止 = 杀子进程**(`SIGTERM`),`play` resolve;
 *  · 子进程起不来 / 非零退出 → 记 warn,resolve —— 调用方要的是「这句结束了」;
 *  · 临时文件放完(或失败、或中止)一定删。
 *
 * 不 import electron:依赖(`which` / `spawn` / 写删文件 / 平台)全部可注入,测试从不真起
 * 播放器、从不出声。
 */

const log = getLogger('shell.speech-output')

/** 子进程这一侧要的全部。 */
export interface SpeechChild {
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export interface SpeechOutputDeps {
  /** 可执行文件的绝对路径;找不到答 `null`。 */
  which(command: string): string | null
  spawn(command: string, args: readonly string[]): SpeechChild
  writeFile(file: string, data: Buffer): Promise<void>
  unlink(file: string): Promise<void>
  tmpdir(): string
  platform: NodeJS.Platform
  /** 临时文件名里那一截,缺省随机。 */
  nonce?: () => string
}

export interface PlayerChoice {
  command: string
  args: string[]
}

/** 选播放器(见文件头)。`file` 是要放的那个文件。 */
export function choosePlayer(
  which: (command: string) => string | null,
  platform: NodeJS.Platform,
  file: string,
): PlayerChoice | null {
  const mpv = which('mpv')
  if (mpv) return { command: mpv, args: ['--no-video', '--really-quiet', file] }
  if (platform === 'darwin') {
    const afplay = which('afplay')
    if (afplay) return { command: afplay, args: [file] }
  }
  return null
}

/** 按 MIME 定扩展名:afplay 靠扩展名认格式。认不出按 mp3(云 TTS 的缺省产物)。 */
export function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('wav')) return 'wav'
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg'
  if (normalized.includes('aac') || normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a'
  if (normalized.includes('flac')) return 'flac'
  return 'mp3'
}

interface Playing {
  child: SpeechChild
  stop: () => void
}

export class ProcessSpeechOutput implements SpeechOutputPort {
  private current: Playing | null = null
  private warnedNoPlayer = false
  private seq = 0

  constructor(private readonly deps: SpeechOutputDeps) {}

  async play(audio: SpeechAudio, signal: AbortSignal): Promise<void> {
    // 同一时刻只放一段:新的一段先停旧的。
    this.current?.stop()
    if (signal.aborted) return
    this.seq += 1
    const nonce = this.deps.nonce ? this.deps.nonce() : `${process.pid}-${Date.now().toString(36)}-${this.seq}`
    const file = path.join(this.deps.tmpdir(), `onething-speech-${nonce}.${extensionForMime(audio.mimeType)}`)
    const player = choosePlayer(this.deps.which, this.deps.platform, file)
    if (!player) {
      if (!this.warnedNoPlayer) {
        this.warnedNoPlayer = true
        log.warn('no audio player found (mpv / afplay); spoken lines stay silent')
      }
      return
    }
    try {
      await this.deps.writeFile(file, Buffer.from(audio.base64, 'base64'))
      if (signal.aborted) return
      await this.run(player, signal)
    } catch (error) {
      log.warn('speech playback failed', { player: path.basename(player.command) }, error)
    } finally {
      await this.deps.unlink(file).catch(() => undefined)
    }
  }

  private run(player: PlayerChoice, signal: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const child = this.deps.spawn(player.command, player.args)
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', stop)
        if (this.current === playing) this.current = null
        resolve()
      }
      const stop = () => {
        child.kill('SIGTERM')
        finish()
      }
      const playing: Playing = { child, stop }
      this.current = playing
      child.once('exit', (code, exitSignal) => {
        if (!settled && code !== 0 && exitSignal === null) {
          log.warn('audio player exited with an error', { player: path.basename(player.command), code })
        }
        finish()
      })
      child.once('error', error => {
        if (!settled) log.warn('audio player could not start', { player: path.basename(player.command) }, error)
        finish()
      })
      signal.addEventListener('abort', stop, { once: true })
    })
  }
}

/** 与 `runtime/music/process-runner.ts` 同一份补丁:GUI 起的 app 不带登录 shell 的 PATH。 */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function whichOnPath(command: string, envPath: string | undefined = process.env.PATH): string | null {
  const dirs = [...(envPath?.split(path.delimiter) ?? []), ...EXTRA_PATH].filter(Boolean)
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, command)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // 下一个目录。
    }
  }
  return null
}

/** 真依赖:宿主表里交出去的那一只。 */
export function createShellSpeechOutput(): SpeechOutputPort {
  return new ProcessSpeechOutput({
    which: command => whichOnPath(command),
    spawn: (command, args) => nodeSpawn(command, [...args], { stdio: 'ignore' }),
    writeFile: (file, data) => writeFile(file, data, { mode: 0o600 }),
    unlink: file => unlink(file),
    tmpdir: () => os.tmpdir(),
    platform: process.platform,
  })
}
