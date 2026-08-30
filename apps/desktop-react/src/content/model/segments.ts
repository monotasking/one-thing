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
  /** mono 显示的工具名。 */
  name: string
  /** 参数摘要(V2 补;P0 的 default presenter 不产)。 */
  summary?: string
  status: string
  /** 右端成果词或失败原因(V2 补)。 */
  outcome?: string
}

/** 连续同族调用折成的一组(B2)。P0 不归组,类型先立着。 */
export interface ToolGroupModel {
  rows: ToolRowModel[]
  /** 收起时那句计数文案要的数;失败条数决定要不要置顶。 */
  failed: number
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
  | { kind: 'tool'; row: ToolRowModel }
  | { kind: 'tool-group'; group: ToolGroupModel }
  | { kind: 'research'; episode: ResearchEpisodeModel }
  | { kind: 'image'; blob: BlobRef }
  | { kind: 'stream-cursor' }

export type SegmentKind = SegmentModel['kind']
