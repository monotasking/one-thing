/**
 * **「跑一段脚本」那一口**(2026-09-14,`run` 动词的执行面)。
 *
 * ── 块层只说要什么,不说谁来做 ────────────────────────────────────────────
 * 一个 bash 代码块能说的全部就是「我这儿有一段脚本,要跑」。**谁来跑、跑在哪**
 * (哪一格终端、哪个目录、要不要新开一台)是**壳的装配**说了算 —— 所以这只文件
 * 是一格**单槽注入**,体例照 `content/terminal/registry.ts` 的
 * `configureTerminalScreenFactory`:契约住这儿,实现由装得出它的那一头登记
 * (今天是 `content/kinds/terminal.tsx`)。
 *
 * 这条分界买到的是两件事:①块层的 import 闭包里没有 xterm、没有终端注册表
 * (那张表被一大票渲染类测试静态 import,判词在 `kinds/terminal.tsx` 上);
 * ②将来第二种执行器(远程沙箱、一格作业)是**换一份实现**,不是在块里加一个 if。
 *
 * ── 没人安装 = 这颗钮不露出 ───────────────────────────────────────────────
 * `hasBlockRunPort()` 是 `isBlockActionRunnable` 对 `run` 的判据,与
 * `download` / `zoom` 问「取件口在不在」逐字同一条法(见 `shell/actions.ts`):
 * **点了没反应比没这个钮更糟**。没装上这一口的宿主(查看器单独回放、测试)檐上就只有
 * 「复制源码」;装了的宿主里「跑不跑得了」是执行器那一头的事,见正本留账。
 *
 * ── 为什么不配 HMR dispose ────────────────────────────────────────────────
 * 这里没有模块级副作用要收 —— 那一格槽的**写入方**才是有寿命的那一头,
 * 退役那一段因此写在安装点上(`kinds/terminal.tsx` 末尾),与
 * 「退役必须复用该模块已有的那一口拆卸」同一条法:摘的口就是 `configureBlockRunPort(undefined)`。
 */

/** 一次运行请求。块只填得出前两格,后两格由壳按现场补(见 `BlockShell`)。 */
export interface BlockRunRequest {
  shell: 'bash'
  /** 可以直接喂下去的那一份脚本。**末尾的换行由执行器补**,块不管。 */
  script: string
  /** 这块内容属于哪条会话(`BlockCtx.sessionId`)。缺席 = 这里没有会话。 */
  sessionId?: string
  /** 这块内容所在文档在哪个目录(`BlockCtx.baseDir`)。缺席 = 这里没有文档位置。 */
  baseDir?: string
}

export interface BlockRunPort {
  run(request: BlockRunRequest): Promise<void>
}

let port: BlockRunPort | undefined

/** 登记执行器(装配点与测试各调一次)。传 undefined 摘掉。 */
export function configureBlockRunPort(next: BlockRunPort | undefined): void {
  port = next
}

/** 取执行器。没人装 = undefined(调用方此前已经由 `hasBlockRunPort` 判过)。 */
export function blockRunPort(): BlockRunPort | undefined {
  return port
}

/** 装了没有。**这颗钮露不露出就问这一句**。 */
export function hasBlockRunPort(): boolean {
  return port !== undefined
}
