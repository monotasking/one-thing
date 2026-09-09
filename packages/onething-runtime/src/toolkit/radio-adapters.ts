/**
 * K3-b —— 电台那四条端口的形状。**纯类型,没有工具**。
 *
 * 它是旧 `toolkit/builtin/radio.ts` 里活下来的那一半:那只工具随 K3-b 退役
 * (音乐成了一个 scheme,自述在 `../music/resource-spec.ts`、实现在
 * `@onething/backend/wiring/resource/music-provider.ts`),但**这份契约不该跟着死** ——
 * 它说的是「装配层与音乐子系统之间,开台 / 关台 / 状态 / 点歌这四件事长什么样」,
 * 而那四件事一件没少,只是换了一个出口。`radioAdapters()`(装配层那只既有工厂)与
 * 新的 `MusicResourceProvider` 吃的都是它,所以它一个字都没改。
 *
 * 为什么住在 `toolkit/` 而不是 `music/`:`radioAdapters()` 今天从
 * `@onething/runtime/toolkit` 取它,而这一单的硬约束是「一条端口都不重写」——
 * 顺手把它挪去另一个命名空间,就是让这一单同时变成一次搬家。留账:等音乐这一族
 * 的端口下次真的要动的时候,它该和 `music/` 那份自述做邻居。
 */

/** 电台此刻是什么状态。`music:radio` 的 `radio` 读法交出去的就是这一份。 */
export interface RadioToolStatus {
  active: boolean
  intent: string
  programmeLength: number
  nowPlayingTitle?: string
  lastError?: string
}

export interface RadioToolAdapters {
  /** Stage+apply the intent (open or retune); retune also clears the programme. */
  open(intent: string, options: { clearProgramme: boolean }, executionContext?: unknown): Promise<RadioToolStatus>
  /** active:false + stop playback, in the order that avoids auto-revive. */
  close(executionContext?: unknown): Promise<RadioToolStatus>
  status(executionContext?: unknown): RadioToolStatus
  /** Cut a named song in as the next track (search + playability check inside). */
  request(song: string, executionContext?: unknown): Promise<{ success: boolean; title?: string; error?: string }>
}
