import { create } from 'zustand'
import { SHARED_SLASH_COMMANDS } from '@onething/core/slash-commands'
import type { PluginCommandInfo } from '@shared/ipc/plugins'
import { commandsPort } from './commands-port'
import { sessionsPort } from './sessions-port'
import { t } from '../i18n'
import type { CommandSpec } from '../composer/types'

/**
 * 斜杠命令的**真数据源**(D4 波二)。全应用一个:命令抽屉从这里取表,
 * 发送前的那次分派也从这里查表。
 *
 * ── 表 = 两处事实的并,不是壳自己编的一张 ─────────────────────────────────
 *  ① 内置七条 = `@onething/core/slash-commands` 的 `SHARED_SLASH_COMMANDS`。
 *     它是**编译期常量**,所以不需要取数、不需要状态、不会失败。抽屉里那几个字
 *     (`displayLabel` / `description` / `usage`)一个都不由壳现造 —— 现造就是
 *     在第二处定义同一件事,而那两份一定会漂。
 *  ② 插件命令 = `plugins.commands` 读面(懒拉一次)。**拉失败静默降级**:
 *     抽屉里只剩内置那七条,不弹提示 —— 人此刻正在打字选命令,一条 toast
 *     只会挡住他要点的那一行(与 models-source 的目录拉不到逐条同判例)。
 *
 * id 撞了以内置为准(Vue 壳 `getCommands` 的同一手):插件不该能顶掉 `/new`。
 *
 * ── 执行分三类,判据是「壳这一层做不做得了」──────────────────────────────
 *  ① **只插文本**(`goal` / `kegel` / `pomodoro` / `practice-stop`):选中就把命令
 *     插进输入框,按发送时**原样当一条消息交出去**。这是本批的诚实降级 ——
 *     那四条在 Vue 壳里由渲染层的注册表执行(目标读写 / 练习记账),而新壳今天
 *     没有那几个面。留账写在 `RUNNABLE_BUILTIN_IDS` 上。
 *  ② **动作类**(`new` / `compact` / `cd`):各自骑现成的口,见 `executeCommand`。
 *  ③ **插件类**:`plugins.executeCommand`,结果按后端原话报。
 *
 * ── 执行的时刻是「发送」,不是「选中」 ───────────────────────────────────
 * 选中一条命令**永远只是插文本**(那正是契约上 `insertText` 存在的理由),
 * 因为参数是选完之后才打的 —— `parseToken` 的命令正则遇到空格就不再匹配,
 * 抽屉在人打第一个参数字符之前就已经收了。所以带参数的命令(`/cd <路径>`)
 * 只可能在发送那一刻才是完整的。Vue 壳 `InputBox.sendMessage` 是同一条路。
 */

/* ── 形状 ──────────────────────────────────────────────────────────────── */

export type CommandKind = 'builtin' | 'skill' | 'plugin' | 'dev'

/**
 * 表里的一行。`CommandSpec`(抽屉画一行所需要的全部)是它的**显示半边**,
 * 这里多出来的几格全是「按下去之后怎么办」。
 */
export interface CommandEntry extends CommandSpec {
  id: string
  kind: CommandKind
  /** 用法那句(报错时原样念给人听;09-12 起抽屉里那一行也画它)。 */
  usage: string
  /** 选中时插进输入框的那一截。契约上就有这一格,不由壳现造。 */
  insertText: string
  /** 收不收参数。不收却带了参数 = 用法错,不是「多余的字」。 */
  allowArgs: boolean
  /**
   * usage 里**要人自己填的那一截**(`<path>` / `[分类]`),选中之后作为一枚灰色
   * 幽灵占位挂在输入框里(见 `ComposerInput.insert`)。不收参数的命令没有这一格。
   *
   * **解析只在 `argHintOf` 一处**(下面那只纯函数):输入面拿到的是解析好的结果,
   * 不许再解析一遍 usage —— 两处解析同一句语法,迟早给出两个答案。
   */
  argHint?: string
  /** dev-only 扳机(`/ask-demo`)。真接上 ask_user 事件后这一格连同那条命令一起删。 */
  action?: 'ask-demo'
}

/**
 * 从 usage 里取出**要人自己填的那一截**。全仓唯一的那一句解析。
 *
 *   `/cd <path>`                                   → `<path>`
 *   `/pomodoro [分类]`                             → `[分类]`
 *   `/goal [<objective> | pause | … ]`             → 整段 `[…]`
 *   `/compact` / `/kegel`(不收参数)               → undefined
 *
 * 两种括号**取先出现的那一个整段**:`/goal` 那一条的方括号里还套着尖括号,
 * 只取第一个 `<…>` 会念出半句 `<objective>`,把「还可以写 pause / clear」吃掉。
 * 所以判据是位置,不是括号的种类。
 *
 * 命令名那一截先剥掉:`/skill:写作 [说明]` 里的冒号、`/practice-stop` 里的连字符
 * 都不该被当成语法。
 */
export function argHintOf(usage: string): string | undefined {
  const rest = usage.replace(/^\S+/, '')
  const bracket = /\[[^\]]*\]/.exec(rest)
  const angle = /<[^>]*>/.exec(rest)
  if (bracket && angle) return bracket.index <= angle.index ? bracket[0] : angle[0]
  return bracket?.[0] ?? angle?.[0]
}

/**
 * 内置七条里,**壳这一批真的会执行**的那三条。其余四条落 `sendAsText`。
 *
 * 这张表是留账本身:它短一天,就有四条命令在新壳里只是「一句以斜杠开头的话」。
 */
export const RUNNABLE_BUILTIN_IDS = ['new', 'compact', 'cd'] as const

export const BUILTIN_COMMANDS: CommandEntry[] = SHARED_SLASH_COMMANDS.map((command) => ({
  id: command.id,
  name: command.displayLabel,
  desc: command.description,
  usage: command.usage,
  kind: 'builtin' as const,
  insertText: command.insertText,
  allowArgs: command.allowArgs === true,
  argHint: command.allowArgs === true ? argHintOf(command.usage) : undefined,
}))

/**
 * 线上形状 → 表里的一行。
 *
 * 插件命令的 `name` 后端给的就是带斜杠的原名,而**执行时要原样交回去**
 * (后端按它查表),所以这里一个字都不改写。它没有 `insertText` 这一格 ——
 * 补一个「名字 + 一个空格」,与内置那几条的形状对齐。
 */
export function toPluginCommand(info: PluginCommandInfo): CommandEntry {
  const name = info.name.startsWith('/') ? info.name : `/${info.name}`
  return {
    id: info.id,
    name,
    desc: info.description,
    usage: info.usage || name,
    kind: 'plugin',
    insertText: `${name} `,
    // 后端不声明收不收参数,而插件命令本来就靠 `args` 传话 —— 一律放行,
    // 参数合不合法由插件自己说(它比壳知道)。
    allowArgs: true,
    // 插件自己写的 usage 里有语法就画,没有就不画 —— 壳不替它编一句。
    argHint: argHintOf(info.usage || name),
  }
}

/**
 * dev 命令这一刻看不看得见。**判据只有这一句**,别处不许再问一次 `import.meta.env`。
 *
 * 它是 `mergeCommands` 的默认值而不是里面写死的一句,是为了让门能把两种形都跑一遍
 * ——单测自己就跑在 dev 形里(vitest 的 `import.meta.env.DEV` 恒真),写死了就永远
 * 只测得到一半。
 */
export const DEV_COMMANDS_VISIBLE: boolean = import.meta.env.DEV === true

/**
 * 内置在前,插件在后;**同名以内置为准**(插件顶不掉 `/new`)。
 *
 * ── dev 命令不进用户的命令表(08-31 真机走查)──────────────────────────
 * 走查在真机上敲 `/`,抽屉里第一条就是 `/ask-demo` —— 一条只为「ask 形态还没有
 * 真产地」而存在的扳机(composer/data.ts 的 `DEV_COMMANDS`),用户看见它只会当成
 * 一个坏掉的功能。
 *
 * 筛的判据是**这条命令自报的 `kind`**,不是「它从第几个参数传进来的」:
 * 一条 `kind: 'dev'` 混进 builtin 或插件表里同样该被挡掉,而参数位置管不到那种情况。
 * 这也正是 `CommandKind` 那一格的用处 —— 它此前只用来画徽,现在它是一条判据。
 */
export interface CommandTables {
  builtin: readonly CommandEntry[]
  /** `/skill:<name>` 那一族(`data/skills-source`)。 */
  skill?: readonly CommandEntry[]
  plugin?: readonly CommandEntry[]
  dev?: readonly CommandEntry[]
  /** dev 命令这一刻看不看得见。缺省 `DEV_COMMANDS_VISIBLE`(理由见它自己)。 */
  devVisible?: boolean
}

export function mergeCommands({
  builtin,
  skill = [],
  plugin = [],
  dev = [],
  devVisible = DEV_COMMANDS_VISIBLE,
}: CommandTables): CommandEntry[] {
  const taken = new Set(builtin.map((entry) => commandTokenOf(entry)))
  const notTaken = (entry: CommandEntry) => !taken.has(commandTokenOf(entry))
  /*
   * **这个顺序就是抽屉里从上到下的顺序**(09-12)。
   *
   * 从前是 `[builtin, plugin, dev]` —— dev 扳机垫底。抽屉分组之后那个顺序不成立:
   * dev 命令与内置同属「命令」那一组,排在插件后面就会让「命令」这个组头出现
   * **两次**,而分组只许一次(禁令区)。所以 dev 紧跟内置,技能与插件各自成段。
   *
   * 四张表因此在这一处排定,别处不许再排一次:抽屉的组是**按这条扁平序切段**
   * 出来的(`composer/transitions.groupCommands`),键盘走位也走同一条扁平序。
   */
  const merged = [
    ...builtin,
    ...dev,
    ...skill.filter(notTaken),
    ...plugin.filter(notTaken),
  ]
  return devVisible ? merged : merged.filter((entry) => entry.kind !== 'dev')
}

/** 一条命令在输入框里被打出来的那个词(名字去掉前导斜杠,小写)。 */
export function commandTokenOf(entry: CommandSpec): string {
  return entry.name.replace(/^\//, '').toLowerCase()
}

/**
 * 草稿是不是一条命令。判据与 Vue 壳 `InputBox.sendMessage` 逐字相同:
 * **整段话**就是 `/词` 或者 `/词 <参数>`,别的一律不是。
 *
 * 「整段」是要紧的一格:`看看 /new 那条` 里的 `/new` 是人在说话,不是命令。
 *
 * 参数那一截是 `.*` 而**不是** `[\s\S]*`(与 Vue 壳逐字相同):`.` 不吃换行,
 * 所以一段以 `/cd` 开头的**多行**草稿整段都不算命令,原样当一句话发出去。
 * 换成吃换行的写法,`/cd /a/b⏎还有别的话` 就会把后面那几行一起当成路径打进去。
 */
export function parseDraftCommand(text: string): { token: string; args: string } | null {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/.exec(text.trim())
  if (!match) return null
  return { token: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}

export function findCommand(
  commands: readonly CommandEntry[],
  token: string,
): CommandEntry | undefined {
  const normalized = token.toLowerCase()
  return commands.find((entry) => commandTokenOf(entry) === normalized)
}

/* ── 执行 ──────────────────────────────────────────────────────────────── */

/**
 * 一次执行的归宿恰有三种。
 *
 * `sendAsText` 不是「失败」也不是「什么都没做」——它是**这一条壳不执行**:
 * 那句话原样当消息交出去,由引擎那侧去认。把它和 failed 合成一种,
 * `/goal 把徽标改了` 就会变成一条错误提示而不是一句话。
 */
export type CommandOutcome =
  | { kind: 'sendAsText' }
  | { kind: 'done'; message?: string }
  | { kind: 'failed'; error: string }

/**
 * 执行现场要用到的、**这一层拿不到的**那两件事。
 *
 * 「当前是哪条会话」与「怎么建一条」都不是命令表的事实:前者是调用现场的事实,
 * 后者的唯一编排点在 `expose/store.newSession`,而 data/ 不该认识总览 store
 * (那会长出一个 `expose ↔ commands` 的环)。所以两件都由调用现场递进来 ——
 * 与 `useCurrentModelSelection(sessionId)` 是同一条方向纪律。
 */
export interface CommandContext {
  /** 当前会话;空串 = 还没有。 */
  sessionId: string
  /** 惰性建一条会话(唯一编排点在 `expose/store.newSession`)。 */
  startSession(): Promise<string | undefined>
}

export async function executeCommand(
  entry: CommandEntry,
  args: string,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  const usage = (): CommandOutcome => ({ kind: 'failed', error: t('command.usage', { usage: entry.usage }) })
  const needsSession = (): CommandOutcome => ({ kind: 'failed', error: t('command.needsSession') })

  if (!entry.allowArgs && args) return usage()

  /*
   * 技能引用**壳一个字都不执行**:`/skill:<name> …` 原样当一条消息交出去,
   * 展开在引擎那头(`prompts/resolver.collectReferenceMatches` 认这个前缀,
   * `wiring/engine/stream/agent-loop-runtime` 在每条用户消息上跑它)。
   *
   * 这一支写在 switch 之前而不是靠 `default` 兜住:兜底那条按 `entry.id` 分派,
   * 而技能的 id 是路径推出来的 —— 哪天有一份技能的 id 恰好叫 `cd`,
   * 引用它就会变成一次改工作目录。判据必须是它自报的 `kind`。
   */
  if (entry.kind === 'skill') return { kind: 'sendAsText' }

  if (entry.kind === 'plugin') {
    if (!ctx.sessionId) return needsSession()
    try {
      const port = await commandsPort()
      const response = await port.executePluginCommand(entry.name, args, ctx.sessionId)
      if (!response.success) {
        return { kind: 'failed', error: response.error || t('command.failed', { name: entry.name }) }
      }
      return { kind: 'done', message: response.message }
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  switch (entry.id) {
    case 'new': {
      // 建成之后编排点自己会切过去并把光标交回输入框,所以这里不再多做一步。
      const sessionId = await ctx.startSession()
      // 没建成:编排点已经 notify(error) 过了,这里**不再加第二条提示**
      // (与 `doSend` 首开草稿态那一段逐字同一条纪律)。
      return sessionId ? { kind: 'done' } : { kind: 'failed', error: '' }
    }
    case 'compact': {
      if (!ctx.sessionId) return needsSession()
      // 压缩的结果会以一张卡落在会话里(账本上的 `session/compacted`),
      // 所以这里**只发不等** —— 壳没有第二块地方去画「压缩中」。
      try {
        const port = await commandsPort()
        const response = await port.compactContext(ctx.sessionId)
        if (!response?.success) {
          return { kind: 'failed', error: response?.error || t('command.compactFailed') }
        }
        return { kind: 'done', message: t('command.compactStarted') }
      } catch (error) {
        return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
    }
    case 'cd': {
      // 没带路径:说一句用法就完了。**不开原生目录对话框** —— 新壳没有 dialog
      // 桥(`shell:invoke` 的 dialogRouter 只在 Electron 宿主那棵树上),
      // 而假装弹一个再什么都不发生比直说更坏。留账见文件头。
      if (!args) return usage()
      if (!ctx.sessionId) return needsSession()
      try {
        const port = await sessionsPort()
        const response = await port.updateWorkingDirectory(ctx.sessionId, args)
        if (!response.success) {
          return { kind: 'failed', error: response.error || t('command.failed', { name: entry.name }) }
        }
        return { kind: 'done', message: t('command.cdDone', { path: args }) }
      } catch (error) {
        return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
    }
    default:
      // 内置里剩下那四条(goal / kegel / pomodoro / practice-stop)与 dev 扳机:
      // 壳不执行,原样当一条消息交出去。
      return { kind: 'sendAsText' }
  }
}

/* ── store ────────────────────────────────────────────────────────────── */

export type PluginCommandsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface CommandsSourceState {
  pluginStatus: PluginCommandsStatus
  pluginCommands: CommandEntry[]
  /** 拉一次插件命令表。懒的 —— 抽屉第一次开的时候才发。已经拉过就直接返回。 */
  ensurePluginCommands(): Promise<void>
  reset(): void
}

export const useCommandsSource = create<CommandsSourceState>()((set, get) => {
  let inflight: Promise<void> | undefined

  return {
    pluginStatus: 'idle',
    pluginCommands: [],

    ensurePluginCommands: async () => {
      if (get().pluginStatus === 'ready') return
      inflight ??= (async () => {
        set({ pluginStatus: 'loading' })
        try {
          const port = await commandsPort()
          const response = await port.listPluginCommands()
          if (!response.success) {
            set({ pluginStatus: 'error', pluginCommands: [] })
            return
          }
          set({
            pluginStatus: 'ready',
            pluginCommands: (response.commands ?? []).map(toPluginCommand),
          })
        } catch {
          // 静默降级:抽屉里只剩内置那七条(见文件头)。
          set({ pluginStatus: 'error', pluginCommands: [] })
        } finally {
          inflight = undefined
        }
      })()
      return inflight
    },

    reset: () => {
      inflight = undefined
      set({ pluginStatus: 'idle', pluginCommands: [] })
    },
  }
})
