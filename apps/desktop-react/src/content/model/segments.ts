import type { ProjectedMessage } from '../../data/chat-fold'
import type { MessageKey, MessageVars } from '../../i18n'
import type { BlockModel } from './blocks'

/**
 * 段词汇 —— 一条消息**内部的排布单位**(§1)。
 *
 * 两层词汇的分工:**段**是「屏幕上从上到下依次是什么」,**块**是「一段富文本里的
 * 物件」。段里可以装块(`rich-text` 段就是 markdown 解析出来的块序列),反过来不行。
 *
 * 段是**封闭词汇**:它由装配管线(assemble/)独家产出,不接受插件或解析器扩展 ——
 * 所以它没有注册表,渲染侧是一个穷尽 switch(SegmentView)。块不同:块的产地有两个
 * (markdown 解析、工具 presenter),而且将来要接插件,所以块有注册表、有未知兜底。
 * 「谁有注册表」不是风格问题,是「这份词汇由谁定义」的事实。
 */

/** 大块二进制的引用(图片 / 附件),真正的字节在账本的 blob 里。 */
export interface BlobRef {
  hash: string
  bytes: number
  mime?: string
}

/**
 * 一个工具调用的**原始事实**(折叠器物化出来的那一份)。
 *
 * 词汇住在 model 层而不是 tools/ 下,是因为**段模型自己要带它**:C1 抽屉的详情是
 * 惰性的(`presenter.detail(call)` 只在抽屉真被拉开那一刻算),所以段里必须留着
 * 那份原始事实,而不是一个函数。它是纯数据、可序列化,与「模型是数据」不冲突 ——
 * 进模型的是**事实**,不是渲染。
 */
export type ProjectedToolCall = NonNullable<ProjectedMessage['toolCalls']>[number]

/**
 * 右端那一格的内容(成果词 / 失败原因 / 状态)。
 *
 * **不是一个已经翻译好的字符串**:presenter 是纯函数,拿不到当前语言;真在
 * presenter 里调一次 `t()` 的话,装配结果会被那一刻的语言腌进 memo,切语言时
 * 已经算过的行不会跟着变。所以模型只说「是哪一句 + 变量是什么」,翻译发生在
 * 渲染那一层(它订阅了 locale)。
 *
 * `text` 那一支是**后端说的原话**(错误信息、工具自报的标题)—— 它按定义不进
 * 字典:换一门语言它不该跟着变。
 */
export type ToolOutcomeModel =
  | { text: string }
  | { key: MessageKey; vars?: MessageVars }

/**
 * 工具卡那一行的数据(A1 + V2)。
 *
 * `status` 故意是 `string` 而不是后端那个联合:后端哪天加一档新状态,这里要能
 * **原样把那个英文枚举摆出来**,而不是在类型上假装它不存在(与 ChatStream 那张
 * 状态字典表同一条纪律)。
 */
export interface ToolRowModel {
  callId: string
  /** 图标名(components/icons 的注册键),不是组件 —— 模型不持有组件。 */
  icon: string
  /** 行首那个词:read 是文件名、bash 是命令首词 —— presenter 说了算。 */
  name: string
  /** 悬停才看得到的全称(全路径 / 整条命令)。拿不到就缺席,不编。 */
  title?: string
  /** 参数摘要(V2):文件名之后那一小段灰字。 */
  summary?: string
  status: string
  /** 右端成果词或失败原因(V2)。 */
  outcome?: ToolOutcomeModel
  /** 耗时(ms)。折叠器算得出就有,算不出就缺席 —— 渲染层不猜一个。 */
  durationMs?: number
}

/**
 * 清单里的一格:**一行 + 它背后那份事实**。
 *
 * 两件东西必须一起走:行是画出来的那一行(presenter 的产物),call 是抽屉被拉开
 * 时才用得上的原始事实。分开放会让「哪一行对应哪一次调用」变成渲染层要重新配对
 * 的活儿 —— 配对是装配的事,不是画画的事。
 */
export interface ToolStepModel {
  row: ToolRowModel
  call: ProjectedToolCall
}

/**
 * 组里的一格(B2 清单的一行)。
 *
 * **同名连续调用聚合在数据层**,不在渲染层:`children` 是逐条,`count` 是几条。
 * 聚合键是**工具名**而不是行名 —— 连读两个文件时行名是两个文件名,但它们仍然
 * 是「read ×2」;按行名聚合会把它们当成两种东西。
 */
export interface ToolGroupEntry {
  /** 聚合键 = 工具名。 */
  tool: string
  /** 代表行:`count === 1` 时就是它本身,聚合时取首条(图标从它来)。 */
  row: ToolRowModel
  count: number
  /** 逐条。`count === 1` 时它就是 `[row 对应的那一格]`,不另设空数组特例。 */
  children: ToolStepModel[]
  /** 这一格里失败了几条(聚合行上那点红)。 */
  failed: number
}

/** 连续调用折成的一组(B2)。 */
export interface ToolGroupModel {
  entries: ToolGroupEntry[]
  /** 计数句里那个 N —— 是调用数,不是格数(聚合之后两者不再相等)。 */
  total: number
  /** 用到哪几种工具,按首次出现序去重(计数句里那串名字)。 */
  names: string[]
  /** 失败条数。 */
  failed: number
  /** 总耗时(ms);一条都算不出就缺席。 */
  durationMs?: number
}

/** 检索段(P4 的四件套读它)。 */
export interface ResearchEpisodeModel {
  queries: string[]
  sources: ResearchSource[]
}

export interface ResearchSource {
  id: string
  url: string
  title?: string
  domain: string
}

export type SegmentModel =
  /** 思考。`live` 的产地是折叠器给的 `isStreaming`;P0 没有渲染器读它。 */
  | { kind: 'thinking'; text: string; live: boolean }
  /**
   * markdown 解析的产物。
   *
   * `offsets[i]` = `blocks[i]` 在**源文本里的起始偏移** —— 它是解析的一个事实
   * (mdast 的 `position.start.offset`),不是渲染的字段:流式重解析时,同一个块
   * 的源偏移逐帧不变,而它的**下标会变**(前面插进来一个块,后面全体平移)。
   * key 由偏移派生(assemble/key.ts),React 因此不会在流式期间把代码块整棵重挂。
   *
   * 与「key 不进模型」不冲突:进模型的是**偏移**(哪来的),不是 key(怎么画)。
   */
  | { kind: 'rich-text'; blocks: BlockModel[]; offsets: readonly number[] }
  /** 单发(A1 卡行)。带着 call —— C1 抽屉的详情要惰性算。 */
  | { kind: 'tool'; step: ToolStepModel }
  | { kind: 'tool-group'; group: ToolGroupModel }
  | { kind: 'research'; episode: ResearchEpisodeModel }
  | { kind: 'image'; blob: BlobRef }
  | { kind: 'stream-cursor' }

export type SegmentKind = SegmentModel['kind']
