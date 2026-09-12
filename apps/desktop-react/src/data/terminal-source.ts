import type { TerminalInfo } from '@shared/ipc/terminal'
import { createQuery } from './kernel'
import { terminalPort } from './terminal-port'

/**
 * **终端的数据层**(T1 · 壳半边)。它只有**一条**读数,而这句「只有一条」
 * 本身是一条判断。
 *
 * ── 字节流不进 kernel ───────────────────────────────────────────────────
 * `data/kernel` 是**读数**的家:一格缓存、一次对账、一张脏表。终端输出不是
 * 读数 —— 它是一条按 `seq` 排好队、要**逐条**喂进一台屏幕模拟器的字节流,
 * 没有「重问一次」这回事(重问 = `attach`,那是另一件事:它换世代、清账本)。
 * 把它塞进 query 会当场得到两样坏东西:一格永远在变的 `data` 让所有订阅者
 * 每 16ms 重渲一次;而「后台补拉不清屏」那条律在一条流上根本没有意义。
 * 所以字节流走 `TerminalSession`(`content/terminal/session.ts`)直通 xterm,
 * 一格 store 都不占。
 *
 * ── 唯一进 kernel 的是 `list` ───────────────────────────────────────────
 * 「此刻还活着哪几格终端」**是**一句读数:Dock 右键那张菜单要画它,它会旧、
 * 要对账、重开菜单该先画旧的再后台补。所以它是这里唯一的一格。
 *
 * ── 它**不订推送** ─────────────────────────────────────────────────────
 * `terminal:exit` 是有推送的,但这条读数没有常驻订阅:一张只在右键那一下
 * 才出现的菜单,不值得让整台壳从开机起挂一条订阅。产地改了的人自己标脏
 * (`invalidateTerminalList()` —— 开一格 / 杀一格 / 收到 exit 的那三处),
 * 菜单挂载时 `ensure()`。这与 `music-source` 的「先订后拉」不矛盾:那块面
 * 是一直开着的,这张表不是。
 *
 * ── ① 生命周期(②③ 两张在消费它的那块面上)─────────────────────────────
 *  · 挂载   —— import 这只文件只建一格空 query,零往返、零订阅;
 *  · 首载   —— 菜单挂载时 `ensure()` 一次;
 *  · 标脏   —— 三处产地各一句 `invalidateTerminalList()`;有人在看就后台补拉,
 *              **旧行留在屏上**(律②),没人看就留个脏标记;
 *  · 卸载   —— 什么都不做(读数留在格子里,下次开菜单先画旧的再对账);
 *  · HMR    —— `resetTerminalSource()`,复用同一口拆卸。
 */

export const terminalListQuery = createQuery<readonly TerminalInfo[]>(
  'terminal.list',
  async () => {
    const port = await terminalPort()
    await port.ready()
    const answer = await port.list()
    if (!answer.success) throw new Error(answer.error || 'terminal.list 未成功')
    return answer.terminals ?? []
  },
)

/** 「活着的终端名单旧了」。开一格 / 杀一格 / 收到 exit 的那三处各一句。 */
export function invalidateTerminalList(): void {
  terminalListQuery.invalidate()
}

/** 回到出厂。测试与 HMR 用;幂等。 */
export function resetTerminalSource(): void {
  terminalListQuery.reset()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetTerminalSource)
}
