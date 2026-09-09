/**
 * Sessions nobody is watching (the radio DJ's, background drives). A
 * permission dialog raised there hangs the turn forever — the first radio
 * field test froze exactly this way, twelve searches deep, waiting on a
 * file-write prompt in a session the user had never opened. For these
 * sessions "ask" degrades to an immediate, well-explained deny: the model
 * sees the failure and can route around it, instead of the turn silently
 * dying.
 */
const unattendedSessions = new Set<string>()

export function markSessionUnattended(sessionId: string): void {
  unattendedSessions.add(sessionId)
}

export function isSessionUnattended(sessionId: string): boolean {
  return unattendedSessions.has(sessionId)
}

/**
 * 无人值守的**宿主**(K4-d,`docs/design/atom-2026-09.md` §4「MCP 服务端(出口)」
 * 那一行的留账 1)。
 *
 * 上面那半问的是「这条**会话**有没有人看着」,这半问的是「这台**进程**上有没有人
 * 可以答一张权限卡」——两件事,同一句话的两个量词。CLI 守护进程是后者的样本:
 * 它没有窗口,经 `onething mcp` 桥进来的资源 `do` 也没有活流(60 秒自动拒那一条
 * 接在 `chat.ask` 的流上),于是一张卡在那里永远是 pending。
 *
 * 为什么是**宿主自己声明**,而不是从别的宿主事实里推:
 *  - `hasShellHost()` 在今天的 React 桌面上是 `false`(那个壳 `shell: null`),拿它
 *    当判据会把桌面也判成无人值守 —— 而桌面恰恰是能弹卡给人答的那一台;
 *  - `isHostLocallyTrusted()` 回答的是「这个调用方可不可以做」,不是「有没有人在」,
 *    两句话今天答案碰巧一致,碰巧不是判据。
 * 所以照 `localTrust` 那条判例办:**宿主装配时自己说一句**,谁说谁负责收回。
 *
 * 用 token 集合而不是布尔 / 计数:一个进程里可能先后(测试里甚至同时)有两台后端,
 * 每次声明拿回自己那一把钥匙,收回只收自己那一把 —— 不会出现「A 关机把 B 的声明
 * 也撤了」。
 */
const unattendedHosts = new Set<symbol>()

/**
 * 这台宿主上没有人可以应答权限卡。返回**收回**这次声明的函数(装配处 `own()` 它)。
 */
export function markHostUnattended(label = 'headless'): () => void {
  const token = Symbol(label)
  unattendedHosts.add(token)
  return () => {
    unattendedHosts.delete(token)
  }
}

export function isHostUnattended(): boolean {
  return unattendedHosts.size > 0
}
