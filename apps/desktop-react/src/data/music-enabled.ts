import { settingsRouter, type AppSettings } from '@shared/ipc/settings'

/**
 * **音乐的总开关**(2026-09-18,用户报障:点「开台」得到「音乐电台未启用:请在
 * 设置 → 音乐 完成配置并打开总开关」)。
 *
 * ── 病根是一条死胡同 ──────────────────────────────────────────────────────
 * 后端那句话让人去「设置 → 音乐」,而 **React 壳里没有这一页** —— 那是 Vue 壳时代
 * 的地址。于是:装好了、登上了、向导也走完了,人按「开台」,得到一句让他去一个不
 * 存在的地方的话。宿主接不住的路要修宿主(判例:结构修复不劝导),所以这一格由
 * **这块面自己**打开。
 *
 * ── 为什么「按开台」就可以替人把开关打开 ──────────────────────────────────
 * 这个开关问的是「这台机器要不要用音乐」。人已经装好 ncm-cli、登了自己的网易云、
 * 站在音乐面上按下「开台」—— **那一下就是答案**,再让他去别处勾一格是把同一个意思
 * 问第二遍。关掉它仍然要一个明面的地方(设置里那一页,留账见正本 §9),但打开它
 * 不需要。
 *
 * AI 那条路不走这里:模型调 `music:radio` 的 `open` 时开关还是硬闸,它不会替人做
 * 「这台机器从今天起用音乐」这个决定。
 */

export interface MusicEnabledPort {
  ready(): Promise<unknown>
  readSettings(): Promise<{ success: boolean; settings?: AppSettings; error?: string }>
  saveSettings(settings: AppSettings): Promise<{ success: boolean; error?: string }>
}

let port: MusicEnabledPort | undefined
let pending: Promise<MusicEnabledPort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureMusicEnabledPort(next: MusicEnabledPort | undefined): void {
  port = next
  pending = undefined
  known = false
}

async function musicEnabledPort(): Promise<MusicEnabledPort> {
  if (port) return port
  if (!pending) {
    pending = (async () => {
      const { onethingClient, whenConnected } = await import('../platform/connection')
      const client = await onethingClient()
      const api = client.api(settingsRouter)
      return {
        ready: () => whenConnected(),
        readSettings: () => api.getSettings({}),
        saveSettings: (settings: AppSettings) => api.saveSettings(settings),
      }
    })()
  }
  return pending
}

/** 已知它开着(开过一次之后就不必再问)。 */
let known = false

/** 测试用:忘掉缓存。 */
export function resetMusicEnabled(): void {
  known = false
}

/** 关着就打开它;答「这一下有没有真的把它从关翻成开」。读不到 / 存不进都答否。 */
async function enableIfDisabled(): Promise<boolean> {
  try {
    const p = await musicEnabledPort()
    await p.ready()
    const response = await p.readSettings()
    const settings = response.settings
    if (!response.success || !settings) return false
    if (settings.music?.enabled === true) {
      known = true
      return false
    }
    const saved = await p.saveSettings({
      ...settings,
      music: { ...settings.music, enabled: true } as AppSettings['music'],
    })
    if (!saved.success) return false
    known = true
    return true
  } catch {
    return false
  }
}

/**
 * 开台这一类做法的外衣:**先发,失败了再看是不是总开关关着**。
 *
 * 顺序是这么定的:点击那一下**当帧就得发出去**(壳 CLAUDE.md 第 5 轴,交互预算)——
 * 先去读一遍设置再发,等于给每一次开台挂上一次往返。而「总开关关着」在这台机器上
 * 一辈子只发生一次,为它让所有人都慢是算错了账。
 *
 * 所以:发 → 后端拒了 → 去看看是不是那一格关着 → 真是就打开它、**重发一次**。
 * 不去匹配后端那句话的字面(判例:别拿报错串当根因),问的是设置里那一格本身。
 */
export async function runWithMusicEnabled(run: () => Promise<unknown>, failed: () => boolean): Promise<void> {
  await run()
  if (!failed()) {
    known = true
    return
  }
  if (known) return
  if (await enableIfDisabled()) await run()
}
