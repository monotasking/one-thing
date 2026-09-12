import { beforeEach, describe, expect, it } from 'vitest'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { HOOK_ONLY_COMMANDS, runShellCommand } from '../run-command'
import { KEYMAP_COMMANDS } from '../transitions'

/**
 * **壳命令的落点是一张模块级的表,不是一只 hook**(K2b-1)。
 *
 * 这一组守的就是那一句:`runShellCommand` 在**没有任何 React 树**的情况下认得
 * 注册表里的每一条命令。将来 SSE 送来的 `do(<shell 资源>, …)`(原子方案 §5,
 * `home: 'shell'` 那一路)落在同一只函数上,它的接收点不在组件里 —— 所以
 * 「不挂 hook 也跑得动」不是一句好听话,是那条路的前提。
 *
 * **例外表是被测的契约**:`HOOK_ONLY_COMMANDS` 上的命令回 `false`(它们只有
 * `useKeymapCommandRunner` 跑得动),不在表上的每一条回 `true`。今天那张表是空的,
 * 所以下面第一条断言的实质是「一条都没留在 hook 里」;哪天真留下一条,改的是
 * `run-command.ts` 那张表,用例自己跟着走 —— 这里不写死任何一条命令的名字。
 */

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  /*
   * `session.new` 那一条会真去建会话(async,要打端口)。这一组问的是「认不认得
   * 这条命令」,不是建会话本身 —— 那条 action 自己的判据在 expose 那边。
   */
  useExposeStore.setState({ newSessionInCurrentProject: async () => undefined })
})

describe('runShellCommand:注册表里的每一条都落得下去', () => {
  it('`app: true` 的每一条 id 都回 true;`app: false` 的每一条都回 false', () => {
    /*
     * K0:`app` 那一格**就是**「应用层有没有兜底实现」,所以这张动作表与它是
     * 一对一的 —— 跟随焦点那九条没有兜底(活动路径上没人答就放行),
     * `runShellCommand` 对它们回 false 不是漏了一格,那是它们的定义。
     * 哪天有人给 `app: false` 的命令写了一个应用层落点(或者反过来),这一条红。
     */
    const hookOnly = new Set<string>(HOOK_ONLY_COMMANDS)
    const wrong: string[] = []
    for (const command of KEYMAP_COMMANDS) {
      const want = command.app && !hookOnly.has(command.id)
      if (runShellCommand(command.id) !== want) wrong.push(command.id)
    }
    expect(wrong).toEqual([])
    // 前提:两族都真的不是空的(空表会让上一条空过)。
    expect(KEYMAP_COMMANDS.filter((c) => c.app).length).toBeGreaterThan(0)
    expect(KEYMAP_COMMANDS.filter((c) => !c.app).length).toBeGreaterThan(0)
  })

  it('例外表上的每一条**确实**回 false —— 表与行为对得上,不是一句注释', () => {
    for (const id of HOOK_ONLY_COMMANDS) expect(runShellCommand(id)).toBe(false)
  })

  it('认不出的 id 回 false —— **不猜**', () => {
    expect(runShellCommand('no.such.command')).toBe(false)
    expect(runShellCommand('')).toBe(false)
    // 前缀像但不是:`toggle:` 那一族按前缀分流,别的族没有这个待遇。
    expect(runShellCommand('shelf.nowhere.toggle')).toBe(false)
    expect(runShellCommand('workbench.moveTabNowhere')).toBe(false)
  })

  it('例外表是**导出的常量**,不是注释里的一句话(它得可被对表)', () => {
    expect(Array.isArray(HOOK_ONLY_COMMANDS)).toBe(true)
  })
})
