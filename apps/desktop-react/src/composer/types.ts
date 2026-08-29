/**
 * Composer 形态学的形状。和 stage/ expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 一块面板三个器官 ——
 *   本体行:write ⇄ ask 两种形态,交叉淡变(该你回答时,回答就是输入框本身);
 *   抽屉槽:**一个**槽,files / commands / model / status 四种住户后来顶替先来;
 *   状态条:有执行时常驻,点它开合状态抽屉。
 * 三者共用同一份状态,所以「同时开两个抽屉」在类型层就不可表达。
 */

/** 抽屉里此刻住的是谁;null = 抽屉收着。四种住户共用一个槽,这是纪律不是巧合。 */
export type DrawerKind = 'files' | 'commands' | 'model' | 'status' | null

/** 本体行的两种形态。ask 不走抽屉 —— 它是本体自己变了个样。 */
export type ComposerMode = 'write' | 'ask'

/** 一条选项:l = 标签,d = 副说明(照搬设计稿的字段名,免得两边对不上)。 */
export interface AskOption {
  l: string
  d: string
}

export interface AskQuestion {
  /** 提交进流里时挂在答案前的短标 */
  tag: string
  q: string
  multi: boolean
  opts: AskOption[]
}

export interface AskSpec {
  questions: AskQuestion[]
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
}

/** 一条斜杠命令。dev 命令带 dev 标,真接引擎时按这个标筛掉。 */
export interface CommandSpec {
  name: string
  desc: string
  dev?: boolean
  /** 选中后要做的事;不给 = 只把命令徽插进输入框 */
  action?: 'ask-demo'
}

export interface ModelSpec {
  model: string
  desc: string
}

export interface ProviderGroup {
  provider: string
  models: ModelSpec[]
}

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

/**
 * 交出去的消息。Composer 只管「交」,谁来渲染是消费方的事(这一批是 ChatMock)——
 * 所以这里存的是**结构**不是文案:拒绝那条连字都不带,文案由渲染方走 i18n。
 */
export type OutboxEntry =
  | { id: string; kind: 'text'; text: string; attachments: number }
  | { id: string; kind: 'ask'; lines: { tag: string; answer: string }[] }
  | { id: string; kind: 'ask-rejected' }

export interface ComposerState {
  drawerKind: DrawerKind
  /** files / commands 抽屉当下在匹配的那截 token(@ 或 / 后面那几个字) */
  pickQuery: string
  /** 抽屉列表里的选中行 */
  pickIndex: number
  /** 模型抽屉的搜索词 */
  modelQuery: string
  model: string
  mode: ComposerMode
  askSpec: AskSpec | null
  askAnswers: AskAnswer[]
  askIdx: number
  attachments: Attachment[]
  /** 展开是**状态**,不是 hover 的副作用:删卡重排也保持展开 */
  attOpen: boolean
  status: StatusState | null
  outbox: OutboxEntry[]
}

/** @ / 的触发结果。q 可以是空串(刚敲下 @ 就该出全表)。 */
export interface TokenHit {
  kind: 'files' | 'commands'
  query: string
}

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
