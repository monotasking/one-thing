import { useMemo } from 'react'
import { BUILTIN_COMMANDS, DEV_COMMANDS_VISIBLE } from '../../data/commands-source'
import type { CommandEntry } from '../../data/commands-source'
import { ASK_DEMO_SPEC, DEV_COMMANDS } from '../../composer/data'
import { matchCommands } from '../../composer/transitions'
import { registerReferenceKind } from '../registry'
import s from '../../content/user-message.module.css'
import type { PickContext, PickResult, ReferenceKind, RowSpec } from '../kind'

/**
 * **命令** `/x`。这一种覆盖内置那七条与 dev 扳机 —— 判据是它们自报的 `kind`
 * (`builtin` / `dev`),与 `mergeCommands` 挡 dev 的那一条同源:
 * dev 扳机与内置同属「命令」,「这一条只在开发档里看得见」不是一种组别。
 *
 * 拾取(`/` 抽屉的第一组)、落稿(命令徽 + 参数占位)、认出(整条消息开头那个词)、
 * 呈现(不可点的药丸)四格都在这里;**没有 `open`** —— 它是**已经发生过的事**
 * 的记号,不是一个还能按的按钮。
 */

/**
 * 抽屉里一行命令的三格:名 · 说明 · 用法。
 *
 * 用法与命令名一样时不画 —— `/compact` 的 usage 就是它自己,把同一个词在一行里
 * 写两遍是噪声,不是提示。这一句判据归命令这一族自己(它知道自己的 usage 长什么样)。
 */
export function commandRow(entry: CommandEntry): RowSpec {
  return {
    primary: entry.name,
    secondary: entry.desc,
    meta: entry.usage && entry.usage !== entry.name ? entry.usage : undefined,
  }
}

/**
 * 命令那一族**共用的落稿**(三家自述各自登记,但落稿的形只有一种):
 * 命令徽 + 一个空格 + 参数占位。徽上写什么、交出去就是什么 —— 它没有第二个身份,
 * 所以 `token` 那一格空着。
 */
export const commandDraft = {
  chip: (entry: CommandEntry) => ({ label: entry.name, tone: 'token' as const }),
  /*
   * 参数提示跟着命令一起插进去:`argHint` 是这条命令自己带的一格
   * (产地 `commands-source.argHintOf`,**全仓唯一那句 usage 解析**),
   * 输入面只负责把它挂成一枚幽灵占位。
   */
  argHint: (entry: CommandEntry) => entry.argHint,
}

/**
 * 内置 + dev。**编译期常量,所以没有取数态可言**(照实答 `ready`):
 * 抽屉的四态判据据此永远走「问完了」那一支 —— 这与从前命令那一半压根不看 status
 * 是同一个结论,只是今天它是说出来的,不是漏掉的。
 */
function useBuiltinCommands(ctx: PickContext): PickResult<CommandEntry> {
  const { active, query } = ctx
  const table = useMemo(
    () => (DEV_COMMANDS_VISIBLE ? [...BUILTIN_COMMANDS, ...DEV_COMMANDS] : BUILTIN_COMMANDS),
    [],
  )
  const hits = useMemo(() => (active ? matchCommands(table, query) : []), [active, table, query])
  return { hits, status: 'ready' }
}

/**
 * 整条消息开头那个命令词。
 *
 * `(?=\s|$)` 那一句是**这条规则唯一的刹车**:没有它,一条以绝对路径开头的消息
 * (`/Users/me/a.ts 看一下`)会把 `/Users` 读成命令。命令词里不许再出现斜杠,
 * 所以路径开头的消息在这里整条落空 —— 不是「猜得比较准」,是结构上不可能命中。
 */
const COMMAND_HEAD = /^\/([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)?)(?=\s|$)/

export const commandReferenceKind: ReferenceKind<
  CommandEntry,
  { kind: 'command'; token: string }
> = {
  id: 'command',

  source: {
    trigger: '/',
    /*
     * 命令是一句话的**主语**,不是句中的词 —— 所以整段话以 `/` 开头才触发。
     * 冒号也算命令词的一部分:技能引用叫 `/skill:<名字>`,而人是一个字一个字打
     * 出来的,打到冒号那一刻若 token 断掉,抽屉当场收起来。
     */
    where: 'line-start',
    tokenChars: ':-',
    group: { key: 'composer.headCommands' },
    hint: 'composer.hintCommand',
    useQuery: useBuiltinCommands,
    row: commandRow,
  },

  draft: {
    ...commandDraft,
    /*
     * dev-only:ask 形态今天没有真产地,`/ask-demo` 是它唯一的扳机 —— 选中它不落
     * chip,直接把本体行切成问卷。真接上 `ask_user` 事件后删掉这一支与
     * `composer/data.ts` 里那一条,形态本身一行不动。
     */
    onPick: (entry: CommandEntry, actions) => {
      if (entry.action !== 'ask-demo') return false
      actions.clearDraft()
      actions.openAsk(ASK_DEMO_SPEC)
      return true
    },
  },

  parse: {
    text: {
      pattern: COMMAND_HEAD,
      at: 'start',
      toRef: (m) => ({
        ref: { kind: 'command' as const, token: m[0] },
        start: m.index,
        end: m.index + m[0].length,
      }),
    },
  },

  render: (ref) => ({
    className: s.command,
    label: ref.token,
    // 不可点:它是**已经发生过的事**的记号,不是一个还能按的按钮。
    clickable: false,
  }),
}

registerReferenceKind(commandReferenceKind, import.meta.hot)
