import type { ReferenceTrigger } from '../references/kind'

/**
 * Composer 形态学的形状。和 stage/ expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 一块面板三个器官 ——
 *   本体行:write ⇄ ask 两种形态,交叉淡变(该你回答时,回答就是输入框本身);
 *   抽屉槽:**一个**槽,files / commands / model / status 四种住户后来顶替先来;
 *   状态条:有执行时常驻,点它开合状态抽屉。
 * 三者共用同一份状态,所以「同时开两个抽屉」在类型层就不可表达。
 */

/**
 * 抽屉里此刻住的是谁;null = 抽屉收着。四位住户共用一个槽,这是纪律不是巧合。
 *
 * ── 来源那半边收成了「哪个触发字符」(09-12 引用种类注册表)──────────────────
 * 从前这一格是 `'files' | 'commands'` 两个**种类名**,于是「加一种从 `@` 进来的
 * 引用」第一步就得改这个联合 —— 那正是「按能力枚举」的形状。今天它只记**哪个
 * 触发字符开着**:同一个字符下有几种引用、各自查什么,归注册表
 * (`references/`),这一层一个种类名都不认得。
 *
 * `model` / `status` 两位不是引用(人主动开的两块面),所以原样留在这里。
 */
export interface PickDrawerKind {
  readonly kind: 'pick'
  readonly trigger: ReferenceTrigger
}

export type DrawerKind = PickDrawerKind | 'model' | 'status' | null

/**
 * 每个触发字符**恒是同一个对象**。
 *
 * 不是省内存:抽屉每敲一个字都要 `showPick` 一次,而 `drawerKind` 进了好几只
 * effect 的依赖表 —— 每次现造一个新对象等于每敲一个字就宣布一次「抽屉换住户了」,
 * 那几只 effect 会跟着重跑(首开那格 ref 判据首当其冲)。
 */
const PICK_DRAWERS = new Map<ReferenceTrigger, PickDrawerKind>()

export function pickDrawer(trigger: ReferenceTrigger): PickDrawerKind {
  let now = PICK_DRAWERS.get(trigger)
  if (!now) {
    now = { kind: 'pick', trigger }
    PICK_DRAWERS.set(trigger, now)
  }
  return now
}

/** 打字驱动的那两位住户在不在场。抽屉开着时上下键与回车归它,不归输入框。 */
export function isPickDrawer(drawer: DrawerKind): drawer is PickDrawerKind {
  return typeof drawer === 'object' && drawer !== null && drawer.kind === 'pick'
}

/** 本体行的两种形态。ask 不走抽屉 —— 它是本体自己变了个样。 */
export type ComposerMode = 'write' | 'ask'

/** 一条选项:l = 标签,d = 副说明(照搬设计稿的字段名,免得两边对不上)。 */
export interface AskOption {
  l: string
  d: string
}

export interface AskQuestion {
  allowFreeText?: boolean
  /** 提交进流里时挂在答案前的短标 */
  tag: string
  q: string
  multi: boolean
  opts: AskOption[]
}

export interface AskSpec {
  questions: AskQuestion[]
  /** Live requests answer their original tool call, never send a new chat turn. */
  interaction?: {
    id: string
    submit: (answers: readonly AskAnswer[]) => Promise<void>
    decline: () => Promise<void>
  }
}

/**
 * 一题的答案恰有三种形态:
 *   null      = 还没答;
 *   string    = 单选选中项的标签,或「其他」里手写的那句(两者同形,靠 isCustomAnswer 区分);
 *   number[]  = 多选选中的下标集合。
 * 不设第四种 —— 「其他」不是一种新答案类型,它就是一句自由文本。
 */
export type AskAnswer = string | number[] | null

/** 附件:url 有值即图片(拍立得方卡),否则文件(小票长卡)。 */
export interface Attachment {
  id: string
  name: string
  url?: string
  /** 原始字节随消息发送;对象 URL 只用于预览,不能代替文件。 */
  file?: File
}

/**
 * 抽屉里一行命令**画出来所需要的全部**,一格不多。
 *
 * D4 波二起「按下去之后怎么办」那几格(id / kind / usage / insertText / allowArgs)
 * 住在 `data/commands-source.ts` 的 `CommandEntry` 上 —— 它 extends 这一条。
 * 分家的判据同 `ProviderGroup` 搬去 models-source:**形状归产地**,
 * 而画一行的那两个字段归这里(抽屉与匹配函数只认得它们)。
 */
export interface CommandSpec {
  name: string
  desc: string
}

/*
 * 模型抽屉的两个形状(`ModelOption` / `ProviderGroup`)在 D2 波一搬去了
 * `data/models-source.ts`:它们描述的是**目录的投影**,产地在那边,形状就该在
 * 那边定义一次(与 `AgentOption` 住在 agents-source 同一条判例)。这里留一条
 * 路标,免得下一个人照着旧文件头去找。
 */

/** 执行流水里的一步。 */
export interface StatusStep {
  label: string
  detail: string
}

/**
 * 一次执行的说明书。**由调用方给** —— 这一批没有引擎,
 * 所以状态条只会因为 beginStatus 而出现,不会自己长出来。
 */
export interface StatusSpec {
  /** 执行的是谁(例:'/review') */
  name: string
  /** 触发这次执行的那句话 */
  prompt: string
  steps: StatusStep[]
}

export interface StatusState extends StatusSpec {
  stepIdx: number
  running: boolean
}

/*
 * D3(2026-08-29):`OutboxEntry` 与 `ComposerState.outbox` 已退役。
 *
 * 那条假队列存在的理由是「交出去」这件事还没有收件人 —— 现在收件人是会话命令
 * 总线,交出去的东西变成账本上的真消息,屏幕上那一条由折叠器画。还没落账的
 * 那一格(送出中 / 送不出去)归聊天数据源的 overlay 车道(`data/chat-fold.ts`
 * 的 `PendingSend`),不归输入面板 —— 输入面板不该记得它交出去过什么。
 *
 * 接缝见 `composer/sink.ts`。
 */

export interface ComposerState {
  drawerKind: DrawerKind
  /** files / commands 抽屉当下在匹配的那截 token(@ 或 / 后面那几个字) */
  pickQuery: string
  /** 抽屉列表里的选中行 */
  pickIndex: number
  /** 模型抽屉的搜索词 */
  modelQuery: string
  /*
   * D2 波一:`model` 这一格**不在这里了**。输入面板的 store 是「此刻的形态」
   * (文件头第一段:重启该干净),而「这条会话跑的是哪个模型」是**会话上的
   * 一格绑定** —— 它的产地是账本(`SessionMeta.lastProvider/lastModel`),
   * 存一份副本在这里就会与它漂开。现在由 `data/models-source.ts` 的
   * `resolveModelSelection` 现算,谁要谁读。
   */
  mode: ComposerMode
  askSpec: AskSpec | null
  askAnswers: AskAnswer[]
  askIdx: number
  askSubmitting: boolean
  askError: string | null
  attachments: Attachment[]
  /** 展开是**状态**,不是 hover 的副作用:删卡重排也保持展开 */
  attOpen: boolean
  status: StatusState | null
}

/*
 * 触发结果(`TokenHit`)09-12 搬去了 `references/registry.ts`:它的形
 * (`{trigger, query}`)是**注册表算出来的**,而 `parseToken` 那两条手写正则
 * 连同这一格一起退役了。这里留一条路标,免得下一个人照着旧文件去找。
 */

/** 一张附件卡在摞里的位置。收拢态只画顶三张,其余 hidden。 */
export interface AttCardLayout {
  id: string
  hidden: boolean
  left: number
  rotate: number
  zIndex: number
}

export interface AttStackLayout {
  cards: AttCardLayout[]
  /** 内层排的总宽(展开态撑出横滚) */
  rowWidth: number
  /** 收拢态摞的实宽;展开态是 null = 交给视口封顶(CSS 里的 100%) */
  stackWidth: number | null
}
