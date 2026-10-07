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
 *  - 「宿主有没有外壳能力」(当年的 `hasShellHost()`,第④步批 1 随 `shell` 端口退役)在 React 桌面上
 *    曾经是 `false`,拿它当判据会把桌面也判成无人值守 —— 而桌面恰恰是能弹卡给人答的那一台;
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

/**
 * 「卡没人答,多久按拒绝收场」—— 宿主自己声明的那一条(第④步批 3,决策 D7)。
 *
 * 它补的是 CLI 守护进程退役之后留下的那一格:从前 `HeadlessBackend` 在每一条 `chat.ask` 的活流上挂一只 60 秒
 * 计时器,命令行里的人 60 秒没答,卡就按拒绝收场 —— 那是**进程级**的事实(这台进程上只有一个终端在答卡,而且
 * 可能已经走开了),不是某一个主体的事。CLI 改走 HTTP 之后,CLI 自己拉起的那台后端(`ONETHING_BACKEND_LAUNCHER=cli`)
 * 由档案声明这一句;桌面拉起的那台不声明(有窗口答卡,照旧一直等)。
 *
 * 与上面那半的分工:`markHostUnattended` 只管 `system` 主体(没有人能答那张卡,60 秒后自动拒),**本机用户的卡
 * 照旧等**(`permission-enforcement-unattended-host.test.ts` 那一条是有意的);这一半管的是「有人可能答、但不保证
 * 一直守着」—— 任何主体的卡,到点都按拒绝收场。两者都是宿主装配时自己说一句、谁说谁收回。
 *
 * 同一进程里声明过多次时取最短的那个期限(测试里可能先后有两台后端)。
 */
const unansweredAskDeadlines = new Map<symbol, number>()

/** 这台宿主上的卡最多等 `timeoutMs` 毫秒,没人答就按拒绝收场。返回收回这次声明的函数。 */
export function declareUnansweredAskDeadline(timeoutMs: number, label = 'host'): () => void {
  const token = Symbol(label)
  unansweredAskDeadlines.set(token, timeoutMs)
  return () => {
    unansweredAskDeadlines.delete(token)
  }
}

/** 声明过的期限(毫秒);没有声明 = `undefined`(一直等)。 */
export function unansweredAskDeadlineMs(): number | undefined {
  if (unansweredAskDeadlines.size === 0) return undefined
  return Math.min(...unansweredAskDeadlines.values())
}
