/**
 * 宠物系统两个流动的形:**时刻**(进来的事实)与**话语**(出去的事实)。
 * 正本 `docs/design/pet-system-2026-09.md` §2.2 / §2.3 / §9.4。
 *
 * 单开一只文件,是因为 `host.ts`、`ledger.ts`、`composer.ts` 三只都要它,而它们之间
 * 不该为了一个类型互相 import(账本不该认识宿主)。
 */

import type { MomentWeight } from '@onething/core/resource'

export type { MomentWeight }

/**
 * 一条喂给宿主的时刻。由装配层从资源事件折出来(§9.4):`scheme` / `event` 是那条事件的
 * 出处,`weight` / `gist` 抄自那种资源自述里 `events[event].moment`,`payload` 原样带着。
 */
export interface Moment {
  readonly scheme: string
  readonly event: string
  readonly weight: MomentWeight
  readonly gist: string
  readonly payload: unknown
  /** epoch ms,落账那一层盖的(`resource:event.at`)。 */
  readonly at: number
}

/**
 * 一句话语(§2.3)。**事实**,不是命令:它说「宠物在这一刻说了这句」。
 *
 *   · `speak`  —— 开口:占注意力预算,有声(P3)、亮 ON AIR、让出声的应用压低音量;
 *   · `mutter` —— 嘀咕:只冒字,不占预算。
 */
export interface Utterance {
  readonly id: string
  readonly petId: string
  readonly mode: 'speak' | 'mutter'
  readonly text: string
  /** 因为哪条时刻。`say` 做法说出来的没有。 */
  readonly about?: { readonly scheme: string; readonly event: string }
  readonly at: number
  /** 要不要让正在出声的应用把音量压低。开口 = 要,嘀咕 = 不要。 */
  readonly duck: boolean
}

/** 一次开口请求被挡掉的原因(§9.2)。 */
export type UtteranceDropReason = 'busy' | 'cooldown' | 'nothing-to-say'
