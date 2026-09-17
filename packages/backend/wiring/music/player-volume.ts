/**
 * **播放器音量的读与写**,以及电台口播时的**压低音乐**(宠物 P3,正本
 * `docs/design/pet-system-2026-09.md` §10.2「压低音乐」那一行)。
 *
 * 读与写从前只住在 `operations.ts`(播放条的音量钮)。电台口播也要这两件,而电台作用域
 * 建在操作面**之前**(操作面依赖电台),所以两件搬到这里做纯函数,两边各 import 一次 ——
 * 同一把尺子,不抄第二份。
 *
 * ── 读数从哪来是 provider 的事 ─────────────────────────────────────────────
 * ncm 把音量存在自己的 prefs 文件里(`state` 报 null)。`volumeSource: 'state'` 的 provider
 * 今天一个都没有,这里**不猜**:读不到就答 `undefined`,压低就整个跳过 —— 压到一个编出来的
 * 值、再「恢复」到另一个编出来的值,比不压更糟。
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MusicProvider, OnethingMusicProcessRunner } from '@onething/runtime/music/index'

type VolumeProvider = Pick<MusicProvider, 'reliability'>

/** 播放器此刻的音量(0–100);provider 不把它存在文件里 / 读不出来 → `undefined`。 */
export function readProviderVolume(provider: VolumeProvider): number | undefined {
  if (provider.reliability.volumeSource !== 'prefs-file') return undefined
  const prefsPath = provider.reliability.probePaths?.volumePrefs
  if (!prefsPath) return undefined
  try {
    const expanded = prefsPath.startsWith('~')
      ? path.join(os.homedir(), prefsPath.slice(1))
      : prefsPath
    const raw = readFileSync(expanded, 'utf8')
    const volume = (JSON.parse(raw) as { volume?: unknown }).volume
    return typeof volume === 'number' && Number.isFinite(volume)
      ? Math.max(0, Math.min(100, Math.round(volume)))
      : undefined
  } catch {
    return undefined
  }
}

/** `volume` 的 argv。ncm-cli 收绝对值 0–100。 */
export function volumeArgs(value: number): string[] {
  return ['volume', String(Math.max(0, Math.min(100, Math.round(value))))]
}

/**
 * 设一次音量,成败如实回答(不抛)。与播放条的音量钮同一条判据:退出码 0 不算成功,
 * CLI 会在信封里拒绝还退 0。
 */
export async function setProviderVolume(
  runner: Pick<OnethingMusicProcessRunner, 'run'>,
  provider: Pick<MusicProvider, 'descriptor' | 'cli'>,
  level: number,
): Promise<boolean> {
  try {
    const result = await runner.run({ command: provider.descriptor.binary, args: volumeArgs(level), timeoutMs: 10_000 })
    return result.code === 0 && provider.cli.parse.envelope(result.stdout).ok
  } catch {
    return false
  }
}

/** 压着前奏说话时,音乐压到原音量的这个比例(§10.2)。 */
export const PATTER_DUCK_RATIO = 0.35

export interface PatterDuckPorts {
  read(): number | undefined
  set(level: number): Promise<boolean>
  /** 恢复失败 / 读不到音量时记一句。 */
  warn(message: string, fields?: Record<string, unknown>): void
}

/**
 * 一句口播的一次压低。`duck()` 在出声前调(只压一次),`restore()` 在说完后调(压过才恢复,
 * 恢复失败记 warn、不重试 —— §10.2 原话)。
 *
 * 读不到音量 → 不压(见文件头);音量已经是 0 → 不压(0 的 35% 还是 0,恢复成 0 也没意义);
 * 设音量被拒 → 当没压过,于是不会「恢复」一个从没改过的值。
 */
export class PatterDuck {
  private original: number | undefined
  private ducked = false

  constructor(private readonly ports: PatterDuckPorts, private readonly ratio = PATTER_DUCK_RATIO) {}

  async duck(): Promise<void> {
    if (this.ducked) return
    const current = this.ports.read()
    if (current === undefined) {
      this.ports.warn('player volume unreadable; patter over music is not ducked')
      return
    }
    if (current <= 0) return
    const target = Math.round(current * this.ratio)
    if (!(await this.ports.set(target))) {
      this.ports.warn('ducking the music under the patter failed', { from: current, to: target })
      return
    }
    this.original = current
    this.ducked = true
  }

  async restore(): Promise<void> {
    if (!this.ducked || this.original === undefined) return
    const level = this.original
    this.ducked = false
    this.original = undefined
    if (!(await this.ports.set(level))) {
      this.ports.warn('restoring the music volume after the patter failed', { to: level })
    }
  }
}

export interface SpeechActivityDuckPorts extends PatterDuckPorts {
  /** 播放器此刻是不是正在放(暂停 / 停着 / 没有播放器 = 不压)。 */
  isPlaying(): boolean
}

/**
 * **有人在说话时把音乐压低**(宠物 P4,§11.3)。订的是进程内事件 `speech:activity`,不认识说话的是谁。
 *
 * P3 的压低是电台自己在口播前后调 `PatterDuck`;P4 起任何出声的一方(宠物自发开口、电台口播)都只
 * 发一对 `speech:activity`,压 / 恢复只在这里做一次 —— 两处各压一次会把音量压到 35% 的 35%,再
 * 「恢复」到一个已经被压过的值。
 *
 * 规矩:
 *  · **叠着说按计数**:第一段开始时压,最后一段结束时恢复(交错的两段不会让音乐在中间弹回来);
 *  · **只在播放器正在放时压**:开始那一刻不在放(暂停 / 在静音里说)→ 这一轮不压,结束也不恢复;
 *  · 压与恢复排在一条链上:一次还没写完的设音量不会被下一次读成「当前音量」。
 */
export class SpeechActivityDuck {
  private active = 0
  private duck: PatterDuck | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly ports: SpeechActivityDuckPorts, private readonly ratio = PATTER_DUCK_RATIO) {}

  onActivity(active: boolean): void {
    if (active) {
      this.active += 1
      if (this.active !== 1) return
      // 「在不在放」在事件到的那一刻判,不在链上轮到时判:链上排着的恢复可能还要几百毫秒。
      if (!this.ports.isPlaying()) return
      this.enqueue(async () => {
        const duck = new PatterDuck(this.ports, this.ratio)
        this.duck = duck
        await duck.duck()
      })
      return
    }
    if (this.active === 0) return
    this.active -= 1
    if (this.active !== 0) return
    this.enqueue(async () => {
      const duck = this.duck
      this.duck = undefined
      await duck?.restore()
    })
  }

  /** 等压 / 恢复都落地。测试与收尾用。 */
  settled(): Promise<void> {
    return this.chain
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch(error => {
      this.ports.warn('speech ducking failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }
}
