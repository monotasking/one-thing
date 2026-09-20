import { useMemo } from 'react'
import { BUILTIN_COMMANDS, DEV_COMMANDS_VISIBLE } from '../../data/commands-source'
import type { CommandEntry } from '../../data/commands-source'
import { ASK_DEMO_SPEC, DEV_COMMANDS } from '../../composer/data'
import { insertComposerReference } from '../../composer/references'
import { matchCommands } from '../../composer/transitions'
import { registerReferenceKind } from '../registry'
import s from '../ReferenceChip.module.css'
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
 * 一条命令发出去之后,它在那句话里就是开头那个词 —— Ref 里因此只有那个词。
 *
 * ── `offer` 是「这一枚是**提议**,不是记录」(B2)──────────────────────────
 * 两种来处,两种东西:
 *  · 用户自己打的 `/compact`(从抽屉落稿、或者气泡里认出来的)—— 它是**已经发生
 *    过的事**的记号,点不动,行为与 09-14 之前逐字相同;
 *  · 助手写的 `<ref type="command" name="compact"/>` —— 它是一句「要不要跑一下
 *    这个」,点了把 `/compact` 填进输入框(**不发送**:发不发是人的事)。
 *
 * 判据写成 Ref 上的一格,而不是「问它是从哪条路来的」:`render` 是一只纯函数,
 * 它只该读手上这一枚说了什么。缺席 = 记录形 —— 于是旧账本里那几枚一个字不变。
 */
export interface CommandRef {
  kind: 'command'
  token: string
  /** 还要跟在命令后面的那一截(`<path>` 那样的占位、或者助手替你填好的实参)。 */
  args?: string
  /** 助手提议的那一枚:可点,点了填进输入框。 */
  offer?: true
}

/**
 * 命令那一族**共用的落稿**(命令与插件命令两家登记,落稿的形只有一种)。
 *
 * 徽上写什么、交出去就是什么 —— 它没有第二个身份,所以 `token(ref)` 就是
 * `ref.token` 本人。**这一格仍然要写出来**(09-14 起 `token` 不是可选格):
 * 缺席就只能回到「屏幕上写什么、交出去就是什么」,而那正是这一单拆掉的东西。
 *
 * 技能**不在**这一族里了:它的 Ref 带着名字(气泡里画的是名字,不是 `/skill:名`),
 * 所以它有自己的 `toRef`(见 `kinds/skill.ts`),只借这里的 `argHint`。
 */
export const commandDraft = {
  toRef: (entry: CommandEntry): CommandRef => ({ kind: 'command', token: entry.name }),
  // 实参跟在命令后面;没有实参的那一枚逐字还是从前那一截(旧账本一个字不变)。
  token: (ref: CommandRef) => (ref.args ? `${ref.token} ${ref.args}` : ref.token),
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

export const commandReferenceKind: ReferenceKind<CommandEntry, CommandRef> = {
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
     * **线上形不变**(正本 §2.4):`/compact` 是一句话的主语,引擎照它执行。
     * 下面那格 `tag` 因此只服务**认出**(助手写的那一枚),不服务出站 ——
     * 把一条要执行的命令改写成一枚要渲染的引用,就换了它的语义。
     */
    wire: 'token' as const,
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

  /*
   * **助手写的那一枚**(B2)。`name` 不带斜杠(正本 §1 的类型表),`args` 可选;
   * 认回来的 Ref 带着 `offer` —— 于是它可点,而用户自己打的那几枚照旧不可点。
   *
   * ── 这一种**不收 `label`**,而那是一条判词不是一处遗漏 ────────────────────
   * 别的几种收它(文件 / 目录 / 技能 / 出处):屏幕上那几个字与它指着的那个东西
   * 是两件事,写的人比壳更知道这一处在这句话里该念作什么。命令不是 ——
   * **屏上那一行就是点一下要填进输入框的那一行**。给它换几个字,人看见的是
   * 「清理上下文」、按下去进输入框的是 `/compact --hard`,那是骗人。
   * 所以这里读 `name` 与 `args`,`label` 连看都不看。
   */
  tag: {
    type: 'command',
    toRef: (tag) => {
      const name = tag.attrs.name?.trim()
      // 命令词里不许有空白与斜杠:`<ref type="command" name="/a b"/>` 认不出,
      // 照实画中性 chip —— 猜一个命令出来是最坏的答案(点了会跑错东西)。
      if (!name || /[\s/]/.test(name)) return null
      const args = tag.attrs.args?.trim()
      return {
        kind: 'command' as const,
        token: `/${name}`,
        ...(args ? { args } : {}),
        offer: true as const,
      }
    },
    toTag: (ref) => {
      const attrs: Record<string, string> = { name: ref.token.replace(/^\//, '') }
      if (ref.args) attrs.args = ref.args
      return { type: 'command', attrs }
    },
  },

  /*
   * 皮 B(09-14):命令**不是链接** —— 它是已经发生过的事的记号,所以不带图标、
   * 不画下划线,走记号那一形(墨色 mono 小块 + 5% 墨底)。
   *
   * **可不可点由 `offer` 说**(B2):用户自己打的那一枚照旧不可点(屏幕上不该
   * 出现一个按下去没反应的东西);助手提议的那一枚可点 —— 点了把它填进输入框。
   */
  render: (ref) => ({
    className: s.token,
    label: commandDraft.token(ref),
    ...(ref.offer
      ? {
          clickable: true as const,
          tooltipKey: 'chat.ref.fillCommand' as const,
          tooltipArgs: { command: commandDraft.token(ref) },
          failKey: 'chat.ref.fillCommandFailed' as const,
          failSource: 'chat.commandRef',
        }
      : { clickable: false as const }),
  }),

  /**
   * **填进这条会话的输入框,不发送**(正本 §1 的类型表:「发不发是人的事」)。
   *
   * 落的是**一枚 chip 而不是一段正文** —— 走的就是 `@` 选一个文件那条路
   * (`insertComposerReference` → `ComposerInput.appendReference`),所以它在草稿
   * 里的形、出站时展成什么、退格怎么整枚删,三样都与别的引用逐字相同。落下去的
   * 那一枚**不带 `offer`**:进了输入框它就是用户自己的一句话了,再点一下不该又
   * 往里填一遍。
   *
   * 收件人是 `ctx.sessionId`(这条消息所在的会话),不是「此刻焦点在哪条」——
   * 人点的是**那条消息里**的一枚 chip。答不出会话(没有宿主 / 那条会话此刻没有
   * 挂着的输入面板)就答 false,由 chip 说一句人话。
   */
  open: (ref, ctx) => {
    if (!ref.offer) return false
    const { token, args } = ref
    return insertComposerReference(
      { kindId: commandReferenceKind.id, ref: { kind: 'command', token, ...(args ? { args } : {}) } },
      ctx.sessionId,
    )
  },
}

registerReferenceKind(commandReferenceKind, import.meta.hot)
