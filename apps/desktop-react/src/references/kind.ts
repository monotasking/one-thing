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
 *   落稿 `draft`   —— 选中的候选变成哪一枚引用、它在句子里占哪几个字、怎么展开
 *   认出 `parse`   —— 从出站句子 / 从 `contentParts` 部件里怎么认出它
 *   呈现 `render`  —— 图标、标签、提示、可不可点(**数据,不是 JSX**);
 *                     09-14 起这一格是**三个宿主唯一那一份形**(草稿 / 在飞 / 落账)
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
  /**
   * **`@` 从哪些目录里找**(09-18,正本 `docs/composer-open-dir-mentions-2026-09.md` §2.2)。
   * 工作目录在第一格(`primary`),其后是此刻开着、自述了 `referenceRoot` 的内容。唯一产地是
   * `references/roots.ts`;空 = 一个根都没有(退回宿主自己的搜索根)。
   *
   * 它与 `cwd` 并存而不是替掉它:技能按**工作目录**发现(`kinds/skill.ts`),那是另一个问题。
   */
  roots: readonly PickRoot[]
  sessionId: string
  /** **这一种此刻在不在场** = 抽屉开着、而且开的正是它那个触发字符。 */
  active: boolean
}

/** 一个 `@` 根。形状的判词在 `references/roots.ts`。 */
export interface PickRoot {
  /** 绝对路径,无尾斜杠。 */
  path: string
  /** 会话工作目录那一格。它的候选念相对路径、排在最前、不带根名。 */
  primary: boolean
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
 * 一枚引用**画成什么**。它是数据:`references/ReferenceChip` 只按这张表摆元素,
 * 一个种类名都不认得。
 *
 * ── 09-14:它从「气泡那一半的呈现」升成**三个宿主唯一那一份形** ─────────────
 * 从前输入框里那枚 chip 有自己的一格自述(`ReferenceDraft.chip` 交 `{label, tone}`,
 * 由 `ComposerInput` 拿 `document.createElement` 画),于是同一枚引用在草稿里是
 * `@相对路径`、在气泡里是 basename —— 一条消息按下回车之后换两次形。今天草稿里
 * 那一枚也是 `ReferenceChip` 画的(宿主节点 + portal),所以**这张表是唯一那一份**:
 * 输入框、在飞的乐观气泡、落账的气泡读的都是它。
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
  /**
   * **屏幕上那句提示改画成这条路径**(09-13)。给了就把悬停时看到的东西换成
   * 「名字一行 + 目录一行、家目录缩成 `~`」,而 `tooltipKey` 那一句
   * (「打开 /Users/…」)**留在 `aria-label` 上** —— 动词从可见文字里退出,
   * 无障碍名照旧说得出「这是可以打开的什么」,可见文字包含在无障碍名里,
   * WCAG 2.5.3 成立。
   *
   * 它与别处的 `TitleTip` 路径形是同一件事的同一格:**「这是一条路径」由这一种
   * 自述**,`ReferenceChip` 只读表,不许 `if (looksLikePath(label))`
   * (判词整段在 `content/model/title-tip.ts`)。缺席 = 提示就是 `tooltipKey`
   * 那句话。
   */
  tooltipPath?: { path: string; dir?: boolean }
  /**
   * **屏幕上那句提示就是这几个字**(09-14,给网页那一种用)。
   *
   * 它不过字典,因为它**是数据**不是文案 —— 一条 URL 没有中英两说。与
   * `tooltipKey` 互斥(同时给以 `tooltipPath` ▷ `tooltipText` ▷ `tooltipKey`
   * 为序,判词在 `ReferenceChip`)。
   */
  tooltipText?: string
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
export interface ReferenceDraft<Hit, Ref> {
  /**
   * 抽屉选中的那条候选 → **这一枚引用本身**(09-14)。
   *
   * 从前这一格是 `chip(hit): ChipDraft` —— 「草稿里写什么」由落稿那一头说,
   * 而「气泡里画什么」由 `render(ref)` 说,于是同一枚引用有**两种写法**,
   * 用户看见的就是按下回车之后 chip 换一次形。今天落稿交出来的是 Ref,
   * 画成什么三个宿主一律问 `render(ref)`:**一枚引用只有一种写法**。
   */
  toRef(hit: Hit): Ref
  /**
   * 这一枚在**线上那句话**里占的那截字(`{{file:/abs}}` / `/cd`)。
   *
   * 它收的是 Ref 而不是候选 —— 草稿是可以存下来、铺回去、再发出去的,而那时候
   * 那条候选早就不在了(表已经换过好几批)。记号由 Ref 算得出来,是「Ref 才是
   * 真相」这句话的另一半。
   *
   * **不是可选格**:每一种落得了稿的引用都得说得出自己在句子里占哪几个字 ——
   * 缺席就只能回到「屏幕上写什么、交出去就是什么」,而那正是这一单拆掉的东西。
   */
  token(ref: Ref): string
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
  promptId?: string
}

/** 从 **`contentParts` 部件**里认出来的那一半。 */
export interface ReferencePartParse<Ref> {
  type: string
  toRef(part: ReferencePart): Ref | null
  /**
   * 这一格在**用户打的那句话里**长什么样(`/skill:x`、`{{prompt:id}}`)。
   *
   * 只有一个读者:`segment.displayTextOfParts` —— 把账本上的一条用户消息
   * 还原成发送方手里那句话,给 `reconcileOverlay` 的文本兜底比对用(引擎写账本前
   * 会把正文换成模型版,`content` 与那句话从来不是同一句;按 id 认领是正路,
   * 这一格只管旧引擎 / steering 那几条没有 id 可认的路)。缺席 = 这一格在
   * 那句话里不占字。
   */
  typed?(part: ReferencePart): string | null
}

 
export interface ReferenceKind<Hit = any, Ref = any> {
  /** 这一种的名字。全表唯一(重复登记直接抛,见 registry)。 */
  id: string
  source?: ReferenceSource<Hit>
  draft?: ReferenceDraft<Hit, Ref>
  parse?: { text?: ReferenceTextParse<Ref>; part?: ReferencePartParse<Ref> }
  render?(ref: Ref): ChipSpec
  /**
   * 点了做什么。**同步开完就同步答**(`boolean`),要等一发才交一个 promise ——
   * 抽 pending 那一格的判据就是这个:交 promise 的才画「在飞」。
   * 缺席 = 只是个记号,不可点(`render` 那边的 `clickable` 要跟着说 false)。
   */
  open?(ref: Ref): boolean | Promise<boolean>
  /**
   * **这一枚引用把哪个资源摆在了助手面前**(09-18,正本
   * `docs/composer-open-dir-mentions-2026-09.md` §2.5.0)。答资源地址;缺席 / `null` = 不算。
   * 读者只有 `references/presented.ts`;发送时随命令走,后端今天只校验不授权(给鉴权留的入口)。
   */
  presents?(ref: Ref): string | null
}
 
