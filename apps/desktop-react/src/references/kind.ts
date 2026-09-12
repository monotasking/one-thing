import type { LucideIcon } from '../components/icons'
import type { MessageKey, MessageVars } from '../i18n'
import type { AskSpec } from '../composer/types'

/**
 * **一种引用 = 一份自述**(正本 `apps/desktop-react/docs/composer-references-2026-09.md` §2)。
 *
 * ── 这只文件里为什么一个种类名都没有 ──────────────────────────────────────
 * 仓根 CLAUDE.md「加功能不许改骨架 / 凡『按能力枚举』的地方改成『能力自述、别人读表』」
 * 在这条链上的字面落地。09-12 之前「一种引用」的知识散在五处各自枚举:
 * 拾取端(`DrawerKind` / `parseToken` 两条手写正则 / `usePickDrawer` 八处分支 /
 * `DrawerPickList` 六处分支)、落稿端(`ComposerInput.insert(kind)` 的闭合联合)、
 * 呈现端(`content/user-message.tsx` 两张 switch)。加一种引用要改五处;
 * 今天要改的是**它自己那只模块 + `references/index.ts` 一行登记**。
 *
 * 演练全文在正本 §3(「@ 一条会话」),守卫在 `__tests__/structure.test.ts`:
 * 那条演练在测试文件里现登记一份假自述,**一个生产文件都不改**。
 *
 * ── 五格 ──────────────────────────────────────────────────────────────────
 *   拾取 `source`  —— 哪个触发字符下出现、候选怎么查、一行画什么、组头念什么
 *   落稿 `draft`   —— 选中之后 chip 写什么、草稿里的记号长什么样、出站时怎么展开
 *   认出 `parse`   —— 从出站句子 / 从 `contentParts` 部件里怎么认出它
 *   呈现 `render`  —— 图标、标签、提示、可不可点(**数据,不是 JSX**)
 *   打开 `open`    —— 点了做什么
 *
 * 五格**没有一格是必填的**,而缺席各有各的意思(每一格自己那段注写着)。
 * 唯一的结构闸在 `registry.registerReferenceKind`:**有 `parse` 就必须有 `render`**
 * —— 认得出却画不出来,那是一格会在屏幕上开天窗的自述。
 */

/** 触发字符。它是**触发的词汇表**,不是种类名 —— 多种引用共用一个字符是常态。 */
export type ReferenceTrigger = '@' | '/'

/**
 * 这个触发字符在句子的哪儿算数。
 *  · `anywhere`   —— 句中也触发(`@` 引文件是常态);
 *  · `line-start` —— 整段话以它开头才触发(命令是一句话的主语,不是句中的词)。
 */
export type ReferenceWhere = 'anywhere' | 'line-start'

/** 取数的四态。与 `data/file-mentions-source.FileMentionsStatus` 同形(那是它的第一个实现)。 */
export type ReferenceStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 抽屉此刻的现场。每一种的 `useQuery` 都收同一份,自己决定要不要发。 */
export interface PickContext {
  /** 抽屉开在哪个触发字符下(null = 没开)。 */
  trigger: ReferenceTrigger | null
  /** 触发字符之后那几个字。 */
  query: string
  /** 这条会话的工作目录;拿不到 = null(判据的唯一产地在 `data/files-source`)。 */
  cwd: string | null
  sessionId: string
  /** **这一种此刻在不在场** = 抽屉开着、而且开的正是它那个触发字符。 */
  active: boolean
}

/**
 * 一次取数的答案。**取数状态进契约**(正本 §2 修正②):抽屉的四态
 * (正在找 / 旧候选留屏 / 失败并陈 / 真无匹配)从这一格读,不再按种类特判。
 * 没有取数可言的那一种(命令是编译期常量)照实答 `ready`。
 */
export interface PickResult<Hit> {
  hits: readonly Hit[]
  status: ReferenceStatus
}

/**
 * 抽屉里一行**画出来所需要的全部**,一格不多 —— 而且是**数据,不是 JSX**。
 *
 * 三格的分工照挤压纪律律一「一行恰有一个弯腰件」:`primary` 是身份(不许截),
 * `secondary` 是说明(唯一那个弯腰件,抢剩余宽 + 省略号),`meta` 是语法(不许截,
 * 窄档整格收掉)。只给 `primary` 的那一族(文件候选)因此是一行等宽路径。
 */
export interface RowSpec {
  primary: string
  secondary?: string
  meta?: string
}

/**
 * 输入框里那枚 chip 的**两种画法**。它是**输入面自己的呈现词汇表**(皮肤住在
 * `Composer.module.css`,由 `ComposerInput` 认),不是种类名 —— 所以加一种引用
 * 不必新增一档,除非它真的要长成第三个样子。
 *  · `reference` —— 一枚有身份、指向别处的小牌(文件 / 目录 / 网页);
 *  · `token`     —— 就是这句话的一部分,只是写法特殊(命令徽 / 技能引用)。
 */
export type ChipTone = 'reference' | 'token'

/** 选中一条候选之后,草稿里落下的那枚 chip。 */
export interface ChipDraft {
  /** chip 上写的那几个字(`@` 那一族自己带前缀 —— 前缀是它的写法,不是壳的规矩)。 */
  label: string
  tone: ChipTone
}

/**
 * 气泡里那一枚引用**画成什么**。同样是数据:`content/user-message.tsx` 只按这张
 * 表摆元素,一个种类名都不认得。
 */
export interface ChipSpec {
  /** 外层类名(皮肤归各种类自己那份 CSS —— 「能力自述」的呈现半边)。 */
  className: string
  /** 屏幕上那几个字。 */
  label: string
  /** 标签外面那一层(截断 + 省略号那一格);缺席 = 标签直接当文字放。 */
  labelClassName?: string
  /** 图标那一族。 */
  icon?: LucideIcon
  iconClassName?: string
  /** 字符记号那一族(◇ 这种)。与 `icon` 可以并存,今天没有人两样都要。 */
  mark?: string
  /** 落在元素上的种类标记(门与测试按它找)。 */
  dataKind?: string
  /** 鼠标停上去说的整句;它同时是无障碍名。缺席 = 不挂提示、不挂 aria-label。 */
  tooltipKey?: MessageKey
  tooltipArgs?: MessageVars
  /** 可点 = 一枚真按钮(`open` 缺席时这一格必须是 false —— 屏幕上不该有按了没反应的东西)。 */
  clickable?: boolean
  /** `open` 答 false 时说的那句话(异步反馈纪律:失败得有人说话)。 */
  failKey?: MessageKey
  /** 那条通知的来源标(它进通知面板的分组,所以由种类自己说)。 */
  failSource?: string
}

/** 抽屉宿主交给候选的那几口动作(选中这一条不落 chip 的那一族要用)。 */
export interface PickActions {
  /** 清空草稿。 */
  clearDraft(): void
  /** 把本体行切成问卷形。今天唯一的用户是那条 dev 扳机。 */
  openAsk(spec: AskSpec): void
}

/** ── 拾取 ────────────────────────────────────────────────────────────── */
export interface ReferenceSource<Hit> {
  trigger: ReferenceTrigger
  /** 缺席 = `anywhere`。同一触发字符下有人说 `line-start`,整个字符就按它来(见 registry)。 */
  where?: ReferenceWhere
  /**
   * 触发字符之后,除 `\w` 之外**还算 token 的字符**。`parseToken` 的字符组由
   * 同一触发字符下所有种类的这一格并起来 —— 所以 `@` 收 `.-`、`/` 收 `:-`,
   * 两边互不影响(并的是同字符下那几家,不是全表)。
   */
  tokenChars?: string
  /**
   * 这一组的组头。`always` = 空着也画 —— 给「这个触发字符下只有这一组」那一族:
   * 组头说的是整列是什么,不是「这里有几条」。缺席 = 不画组头。
   */
  group?: { key: MessageKey; always?: boolean }
  /** 选中那一行右端念的那句(「↵ 引用」/「↵ 运行」)。 */
  hint?: MessageKey
  /**
   * 候选怎么查。**它是一只 hook** —— 候选住在 zustand 里,取数由 effect 推着走。
   * 抽屉按注册序逐个调它,所以**注册表在渲染期间不许变**(演练与测试要在渲染
   * 之前登记;判词在 `registry.ts` 的 `referencePickKinds` 上)。
   */
  useQuery(ctx: PickContext): PickResult<Hit>
  row(hit: Hit): RowSpec
  /**
   * 这条候选**落稿时算哪一种**。缺席 = 就是这一种。
   * 今天唯一的用户:`@` 那一列里目录与文件是同一次取数的两种结果,
   * 而它们在气泡里是两种引用 —— 拾取归一家,落稿归两家。
   */
  kindOf?(hit: Hit): string
}

/** ── 落稿 ────────────────────────────────────────────────────────────── */
export interface ReferenceDraft<Hit> {
  chip(hit: Hit): ChipDraft
  /**
   * 写进草稿的**位置记号**(`{{file:/abs}}`)。缺席 = chip 上写什么、交出去就是
   * 什么(命令徽那一族:它本来就是这句话里的那几个字,没有第二个身份)。
   */
  token?(hit: Hit): string
  /**
   * 出站时记号 → 句子。缺席 = 记号本身就是句子。
   * **展开在草稿出口**(`ComposerInput.readDraft`,正本 §2 修正③):乐观上屏那
   * 一句必须与账本上的逐字相同,所以它不许再发生在端口里。
   */
  expand?(token: string): string
  /** 选完之后还要人填的那一截(灰色幽灵占位)。 */
  argHint?(hit: Hit): string | undefined
  /**
   * 选中这一条时**先问它**:答 true = 这一下由它自己消化掉了(不落 chip、不收抽屉)。
   * 缺席 = 照常落 chip。今天唯一的用户是那条 dev 扳机(选中即切问卷形)。
   */
  onPick?(hit: Hit, actions: PickActions): boolean
}

/** 从**出站句子**里认出来的那一半。 */
export interface ReferenceTextParse<Ref> {
  pattern: RegExp
  /** 只在整条消息的开头认(命令那一族)。缺席 = 全文都认。 */
  at?: 'start'
  /** 同一位置上谁先试,大的先(`/skill:x` 比 `/x` 具体)。缺席 = 0。 */
  specificity?: number
  /**
   * 一次命中 → 一枚引用 + **它到底吃掉了哪一段**(绝对下标,相对这一截正文)。
   * 答 null = 这一条不是我的(扫描器接着试下一家 / 下一处)。
   *
   * `start` / `end` 与 `m[0]` 不必相等:文件那一族要把尾随标点**还给正文**,
   * 靠的就是 `end` 短于整条命中。
   */
  toRef(m: RegExpExecArray): { ref: Ref; start: number; end: number } | null
}

/** 引擎折出来的一格 `contentParts`。形状故意是宽的,收窄发生在各家的 `toRef` 里。 */
export interface ReferencePart {
  type?: string
  content?: string
  title?: string
  name?: string
  skillId?: string
}

/** 从 **`contentParts` 部件**里认出来的那一半。 */
export interface ReferencePartParse<Ref> {
  type: string
  toRef(part: ReferencePart): Ref | null
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 注册表装的是异构的自述:
 * 每一份自述内部 `Hit` / `Ref` 都是具体类型(在它自己那只模块里闭合),
 * 而表这一层只知道「有这么五格」。写成 unknown 会让每一家在登记那一行都得断言一次。 */
export interface ReferenceKind<Hit = any, Ref = any> {
  /** 这一种的名字。全表唯一(重复登记直接抛,见 registry)。 */
  id: string
  source?: ReferenceSource<Hit>
  draft?: ReferenceDraft<Hit>
  parse?: { text?: ReferenceTextParse<Ref>; part?: ReferencePartParse<Ref> }
  render?(ref: Ref): ChipSpec
  /**
   * 点了做什么。**同步开完就同步答**(`boolean`),要等一发才交一个 promise ——
   * 抽 pending 那一格的判据就是这个:交 promise 的才画「在飞」。
   * 缺席 = 只是个记号,不可点(`render` 那边的 `clickable` 要跟着说 false)。
   */
  open?(ref: Ref): boolean | Promise<boolean>
}
/* eslint-enable @typescript-eslint/no-explicit-any */
