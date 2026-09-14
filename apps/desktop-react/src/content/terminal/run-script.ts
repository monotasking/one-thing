import { sessionCwdOf } from '../../data/files-source'
import { useSessionsSource } from '../../data/sessions-source'
import { useStageStore } from '../../stage/store'
import { refId } from '../../workbench/kinds'
import { regionOfRefIn, useWorkbenchStore } from '../../workbench/store'
import { createTerminalTab, terminalLauncherRegion } from '../terminal-launcher'
import { peekTerminalSession, requestTerminalFocus, terminalSessionOf } from './registry'
import { terminalRef } from './terminal-ref'
import type { BlockRunRequest } from '../blocks/shell/run-port'

/**
 * **把一段脚本写进终端并回车**(2026-09-14 用户拍:「聊天里的 bash 代码块檐上
 * 加一颗运行钮,点下去像 IDE 一样」)。这只文件是 `BlockRunPort` 的唯一实现,
 * 装配点在 `content/kinds/terminal.tsx` 末尾。
 *
 * 五步,次序即语义:算目录 → 找(或开)这条会话那一格运行终端 → 亮出来 →
 * 写下去 → 出了事就抛(块层那一头记日志,零 Toast)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 生命周期:**运行动作是借用者,终端是所有者**
 * ══════════════════════════════════════════════════════════════════════════
 * 这里不产生一种新东西 —— 它借的就是那一族普通终端:寿命是那格 PTY、关标签 = 杀
 * (`content/kinds/terminal.tsx` 那条一字不改)、换宿主不丢屏。下面那张小账本
 * 只是「上次我是往哪一格写的」,它**不拥有**任何终端:那一格被人关掉、被人杀掉、
 * 被人拖走,这里下一次问的时候自然就答「不能复用」。
 *
 * **不复用用户自己开的终端**(用户拍):账本里只有这条路自己开出来的那几格。
 * 往一台人正在用的 shell 里插一行命令,是这颗钮最容易吓着人的失败方式。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 留账:**「那一格正在跑长任务」测不出来**
 * ══════════════════════════════════════════════════════════════════════════
 * 没有 shell integration(OSC 133 那一族),PTY 这一侧报不出前台进程是谁 ——
 * 所以复用那一支有可能把第二条命令打进一个正在跑的程序的 stdin(`top` 里按下
 * 一串字母)。这与 VS Code 的「在终端运行」是**同一种行为**,而唯一诚实的替代
 * 是接 shell integration,不是在这儿发明一条「看起来空闲」的启发式:猜错的那几次
 * 会比现在坏得多(新开一格终端 vs 把命令喂给一个不认识它的程序)。记在这里,
 * 等 shell integration 到了再动。
 */

/**
 * **账本键 → 上次给它开的那格终端 id**。
 *
 * 键 = `sessionId` ?? `dir:<baseDir>` ?? `'none'` —— 用户拍的是「每会话一格运行
 * 终端」,而块也长在没有会话的地方(查看器里回放一份 markdown),那时按文档目录
 * 分格;两样都没有的那一格共用一台。
 *
 * **它不配 HMR dispose**,这不是漏了:判据是「这东西的寿命是不是这个模块实例」
 * (CLAUDE.md 09-01 立法)。它的寿命是那几格 PTY —— 而 PTY 活在主进程里,热更
 * 一个字都动不了它。丢了这张表的后果只有一个:下一次运行多开一格终端。拿
 * dispose 去清它反而是在说「热更时这些终端该算没了」,那是假话。
 */
const RUN_TERMINALS = new Map<string, string>()

/** 这一次运行该记在哪一格账上。判词见 `RUN_TERMINALS`。 */
function ledgerKeyOf(request: BlockRunRequest): string {
  if (request.sessionId) return request.sessionId
  if (request.baseDir) return `dir:${request.baseDir}`
  return 'none'
}

/**
 * 这一次该在哪个目录里跑。
 *
 * 会话绑着目录就用它(`sessionCwdOf` —— 与 `content/dir-open.sessionDirOf` 同一把
 * 尺,只是这里问的是**请求里那条会话**而不是环境会话:一片没获得焦点的会话叶里
 * 那颗钮按下去,跑的必须是**它自己**那条的目录)。答不出再看文档所在目录。
 * 两样都没有 = `undefined`,让后端按自己那条 spawn 规矩落地 —— 壳这边不编一个 `~`
 * 出来(判词在 `terminal-launcher.createTerminalTab` 上)。
 */
function targetDirOf(request: BlockRunRequest): string | undefined {
  if (request.sessionId) {
    const cwd = sessionCwdOf(useSessionsSource.getState().sessions, request.sessionId)
    if (cwd) return cwd
  }
  return request.baseDir ?? undefined
}

/**
 * 账本上那一格还能用吗。三问全过才算:
 *
 *  ① 这一侧的实例还在(`peekTerminalSession` —— 不造,问的是「屏幕上有没有」);
 *  ② 它没死(`exited` = PTY 退了,`dead` = 账上有 id 机器上没有那格);
 *  ③ **它还在拼贴台树上** —— 人把这一格关掉之后,实例会被 `closeTerminal` 摘掉,
 *    但「摘了没有」与「树上还在不在」是两件事实,一并问比赌它们同步诚实。
 *
 * 任何一问不过就把账本上那一笔忘掉:留着它只会让下一次再走一遍同样的三问。
 */
function reusableTerminal(key: string): string | undefined {
  const id = RUN_TERMINALS.get(key)
  if (!id) return undefined
  const live = peekTerminalSession(id)
  const state = live?.get().state
  const onTree =
    regionOfRefIn(useWorkbenchStore.getState().regions, refId(terminalRef(id))) !== null
  if (!state || state === 'exited' || state === 'dead' || !onTree) {
    RUN_TERMINALS.delete(key)
    return undefined
  }
  return id
}

/**
 * 开一格新的运行终端并摆出来。次序照 `terminal-launcher.openTerminal` 一字不改:
 * **先点名再摆**(那一格挂载时自己把条子取走 —— 判词整段在
 * `registry.requestTerminalFocus` 上),落点问的是那块启动瓦的记忆
 * (`terminalLauncherRegion`),所以用户把终端摆到哪儿,这颗钮开出来的就在哪儿。
 */
async function openRunTerminal(key: string, cwd: string | undefined): Promise<string> {
  const id = await createTerminalTab(cwd)
  RUN_TERMINALS.set(key, id)
  const ref = terminalRef(id)
  requestTerminalFocus(id)
  useStageStore.getState().placeRef(ref, terminalLauncherRegion(ref))
  return id
}

/**
 * 跑这一段。
 *
 * 亮出来那一步走 `summonRef(ref, 'reveal')`:召唤四态里 **`reveal` 意图永远不会
 * 把它藏起来**(第四态「看得见、焦点已经在里面」在这一档上退成诚实的空动作 ——
 * 判词在 `stage/summon.ts` 的 `SummonIntent` 上)。`toggle` 在这里是错的:人点
 * 「运行」两次,第二次不该把终端收走。焦点由同一条路送(`reveal` 与 `focus` 两态
 * 都会 `sendKeyboard`),所以这里不必再补一句 —— 新开那一支才需要点名,因为那一格
 * 此刻还没挂载。
 *
 * 末尾那个换行就是「回车」。脚本自己带了就不补第二个(多一个回车 = shell 里多一个
 * 空提示符,无害但是噪音)。
 */
export async function runScriptInTerminal(request: BlockRunRequest): Promise<void> {
  const key = ledgerKeyOf(request)
  const reuse = reusableTerminal(key)
  const id = reuse ?? (await openRunTerminal(key, targetDirOf(request)))
  if (reuse) useStageStore.getState().summonRef(terminalRef(reuse), 'reveal')
  const script = request.script.endsWith('\n') ? request.script : `${request.script}\n`
  await terminalSessionOf(id).input(script)
}

/** 测试用:把小账本清空(它没有 HMR 退役,理由见 `RUN_TERMINALS`)。 */
export function __resetRunTerminalsForTests(): void {
  RUN_TERMINALS.clear()
}
