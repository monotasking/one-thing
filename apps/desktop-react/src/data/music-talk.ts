import { create } from 'zustand'

/**
 * **主持人回话的那一下**(跟主持人说话 §7.2 / §7.3)。
 *
 * ── 它为什么不是一条 query ──────────────────────────────────────────────
 * 与 `music-setup-log` 同一条判据:这件事**问不回来**。后端没有一条读法答得出
 * 「他刚才回了没有」—— `hostReplied` 是一次性的事实,而屏幕这边要的也只是那一下:
 * 你的气泡该撤了、黑豆可以从 `busy` 回到该在的姿势。
 *
 * ── 屏上不画他说的那句话,所以这里不存它 ────────────────────────────────
 * 他回的话走的是宠物那条路(`pet:` 的话语,气泡出在唱机那边的黑豆头上,§7.2)。
 * 这一格只是**时刻**,不是内容 —— 存一句没人读的话,下一个人就会拿它去画第二个气泡,
 * 于是同一句话在屏上出现两次。
 *
 * `repliedAt` 是墙钟(`Date.now()`):等的那一方记下自己发话的时刻,比一比谁在后面。
 * 用序号也行,但墙钟顺带答得出「他回得有多快」,而序号答不出。
 */
interface HostReplyState {
  /** 他最近一次回话的时刻;`0` = 这一程还没回过。 */
  readonly repliedAt: number
}

export const useHostReply = create<HostReplyState>()(() => ({ repliedAt: 0 }))

/** 主持人回了一句(`music-source` 收到 `hostReplied` 时按一下)。 */
export function noteHostReplied(at: number = Date.now()): void {
  useHostReply.setState({ repliedAt: at })
}

/** 回到出厂。`resetMusicSource()` 与 HMR 走的是这一口。 */
export function resetHostReply(): void {
  useHostReply.setState({ repliedAt: 0 })
}
