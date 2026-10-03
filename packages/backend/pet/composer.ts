/**
 * **作曲端口**:一条时刻来了、预算也放行了,这一句到底说什么(§2.3 第 3 条、§9.1)。
 *
 * 它是端口而不是宿主里的一段逻辑,因为「说什么」是分期换实现的那一格:
 *   · P2 —— `SayPassthroughComposer`:只认时刻自己带着的现成台词(`payload.say`);
 *   · P4 —— 模型写词(persona + gist + 事实 + 记忆,走 `toolCallModel`)。
 * 宿主的注意力预算、账本、换宠物一个字不跟着换。
 *
 * 返回 `null` = 没什么可说的,宿主记一笔 `dropped: 'nothing-to-say'`。返回值允许是
 * promise:模型写词是异步的,而同步实现不必为此包一层。
 */

import type { PetManifest } from './manifest.js'
import type { PetLedgerLine } from './ledger.js'
import type { Moment } from './types.js'

export interface MomentComposeInput {
  readonly pet: PetManifest
  readonly moment: Moment
  /** 这只宠物最近的账本行(旧的在前)。P4 挑其中几条交给模型。 */
  readonly memory: readonly PetLedgerLine[]
}

export interface MomentComposer {
  compose(input: MomentComposeInput): string | null | Promise<string | null>
}

/**
 * P2 缺省:时刻的 `payload.say` 是非空字符串就说它,否则没什么可说。
 *
 * 为什么只认这一格:P2 里能开口的只有「时刻自己带着现成台词」那一类(§9 开头那段),
 * 比如 P3 电台发的「下一首的口播词准备好了」。其余时刻没有台词,等 P4 的模型来写。
 */
export class SayPassthroughComposer implements MomentComposer {
  compose({ moment }: MomentComposeInput): string | null {
    const payload = moment.payload
    if (!payload || typeof payload !== 'object') return null
    const say = (payload as Record<string, unknown>).say
    if (typeof say !== 'string') return null
    const text = say.trim()
    return text.length > 0 ? text : null
  }
}

/**
 * P4 的组合(§11.2 最后一行):时刻自己带着现成台词(`payload.say`)就直通,否则交给后面那一只
 * (模型作曲器)。现成台词是写好的节目,不该被一个小模型改写。
 */
export class SayOrElseComposer implements MomentComposer {
  private readonly passthrough = new SayPassthroughComposer()

  constructor(private readonly fallback: MomentComposer) {}

  compose(input: MomentComposeInput): string | null | Promise<string | null> {
    return this.passthrough.compose(input) ?? this.fallback.compose(input)
  }
}
