import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { choosePlayer, extensionForMime, ProcessSpeechOutput, whichOnPath } from '../speech-output'
import type { SpeechChild, SpeechOutputDeps } from '../speech-output'

/**
 * **主进程出声**(宠物 P3,正本 `docs/design/pet-system-2026-09.md` §10.2 / §10.7)。
 *
 * `which` 与 `spawn` 全部注入:这份测试**从不**真起播放器、从不出声、从不写真临时目录。
 * 钉四件:选播放器的判据、放完删文件、中止即杀子进程、同一时刻只放一段。
 */

class FakeChild extends EventEmitter implements SpeechChild {
  killedWith: NodeJS.Signals | undefined
  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? 'SIGTERM'
    queueMicrotask(() => this.emit('exit', null, this.killedWith))
    return true
  }
  finish(code = 0): void {
    this.emit('exit', code, null)
  }
}

function harness(options: { which?: Record<string, string>; platform?: NodeJS.Platform } = {}) {
  const children: FakeChild[] = []
  const spawned: Array<{ command: string; args: readonly string[] }> = []
  const written: string[] = []
  const unlinked: string[] = []
  let n = 0
  const deps: SpeechOutputDeps = {
    which: command => options.which?.[command] ?? null,
    spawn: (command, args) => {
      spawned.push({ command, args })
      const child = new FakeChild()
      children.push(child)
      return child
    },
    writeFile: vi.fn(async (file: string) => {
      written.push(file)
    }),
    unlink: vi.fn(async (file: string) => {
      unlinked.push(file)
    }),
    tmpdir: () => '/fake-tmp',
    platform: options.platform ?? 'darwin',
    nonce: () => String(++n),
  }
  return { output: new ProcessSpeechOutput(deps), children, spawned, written, unlinked }
}

const AUDIO = { base64: Buffer.from('abc').toString('base64'), mimeType: 'audio/mpeg' }

describe('choosePlayer', () => {
  it('PATH 里有 mpv 就用 mpv(不出视频、不打字)', () => {
    expect(choosePlayer(c => (c === 'mpv' ? '/opt/homebrew/bin/mpv' : '/usr/bin/afplay'), 'darwin', '/t/a.mp3')).toEqual({
      command: '/opt/homebrew/bin/mpv',
      args: ['--no-video', '--really-quiet', '/t/a.mp3'],
    })
  })

  it('没有 mpv:macOS 退到 afplay;别的平台不退', () => {
    const onlyAfplay = (c: string) => (c === 'afplay' ? '/usr/bin/afplay' : null)
    expect(choosePlayer(onlyAfplay, 'darwin', '/t/a.mp3')).toEqual({ command: '/usr/bin/afplay', args: ['/t/a.mp3'] })
    expect(choosePlayer(onlyAfplay, 'linux', '/t/a.mp3')).toBeNull()
  })

  it('都没有:null', () => {
    expect(choosePlayer(() => null, 'darwin', '/t/a.mp3')).toBeNull()
  })

  it('扩展名跟着 MIME 走(afplay 靠它认格式)', () => {
    expect(extensionForMime('audio/mpeg')).toBe('mp3')
    expect(extensionForMime('audio/wav')).toBe('wav')
    expect(extensionForMime('audio/ogg; codecs=opus')).toBe('ogg')
    expect(extensionForMime('application/octet-stream')).toBe('mp3')
  })

  it('whichOnPath 只认可执行文件,找不到答 null', () => {
    expect(whichOnPath('definitely-not-a-real-binary-onething', '/nonexistent-dir')).toBeNull()
  })
})

describe('ProcessSpeechOutput', () => {
  it('没有播放器:立刻 resolve,不写文件、不起进程', async () => {
    const h = harness()
    await h.output.play(AUDIO, new AbortController().signal)
    expect(h.spawned).toEqual([])
    expect(h.written).toEqual([])
  })

  it('放完 resolve,临时文件删掉', async () => {
    const h = harness({ which: { mpv: '/bin/mpv' } })
    const playing = h.output.play(AUDIO, new AbortController().signal)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    expect(h.spawned[0]).toEqual({ command: '/bin/mpv', args: ['--no-video', '--really-quiet', '/fake-tmp/onething-speech-1.mp3'] })
    h.children[0]!.finish(0)
    await playing
    expect(h.unlinked).toEqual(['/fake-tmp/onething-speech-1.mp3'])
  })

  it('中止 = 杀子进程,resolve,文件照删', async () => {
    const h = harness({ which: { afplay: '/usr/bin/afplay' } })
    const abort = new AbortController()
    const playing = h.output.play(AUDIO, abort.signal)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    abort.abort()
    await playing
    expect(h.children[0]!.killedWith).toBe('SIGTERM')
    expect(h.unlinked).toHaveLength(1)
  })

  it('同一时刻只放一段:新的一段先停旧的', async () => {
    const h = harness({ which: { mpv: '/bin/mpv' } })
    const first = h.output.play(AUDIO, new AbortController().signal)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    const second = h.output.play(AUDIO, new AbortController().signal)
    await first
    expect(h.children[0]!.killedWith).toBe('SIGTERM')
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.children[1]!.finish(0)
    await second
    expect(h.children[1]!.killedWith).toBeUndefined()
  })

  it('播放器起不来 / 非零退出:resolve 不抛', async () => {
    const h = harness({ which: { mpv: '/bin/mpv' } })
    const failing = h.output.play(AUDIO, new AbortController().signal)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0]!.emit('error', new Error('ENOENT'))
    await expect(failing).resolves.toBeUndefined()
    const crashing = h.output.play(AUDIO, new AbortController().signal)
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.children[1]!.finish(1)
    await expect(crashing).resolves.toBeUndefined()
  })

  it('已经中止的信号:什么都不做', async () => {
    const h = harness({ which: { mpv: '/bin/mpv' } })
    const abort = new AbortController()
    abort.abort()
    await h.output.play(AUDIO, abort.signal)
    expect(h.spawned).toEqual([])
  })
})
