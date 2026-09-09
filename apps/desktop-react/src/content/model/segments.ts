import type { ProjectedMessage } from '../../data/chat-fold'
import type { MessageKey, MessageVars } from '../../i18n'
import type { CompactMarker } from '../compact/marker'
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
  /**
   * **头行里这一步叫什么** —— presenter 自述(§6.1)。
   *
   * 缺席是常态,回落规则是「工具名 + 行名(两者相同就只说一次)」:read 的行名是
   * 文件名,读作「read a.ts」,正是人要的那句。
   *
   * 有它的只有一种工具:行名**本身就是动词**的那种。`bash` 的行名是命令首词
   * (`rg`),按回落规则头行会读成「bash rg」—— 把首词念了两遍。
   *
   * 为什么是一格自述而不是 card.ts 里的一个 if:那个 if 里必须出现 `'bash'` 这个
   * 字面量,于是「头行怎么念」就成了**按能力枚举** —— 下一个「行名即动词」的工具
   * (`git` / `docker` / 一个插件工具)接进来,要么头行说错,要么再加一行 if。
   * 能力自述、card.ts 只读表,是这条纪律唯一的解法。
   */
  headLabel?: string
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
 * 卡里的一格(展开时的一行)。
 *
 * **同名连续调用聚合在数据层**,不在渲染层:`children` 是逐条,`count` 是几条。
 * 聚合键是**工具名**而不是行名 —— 连读两个文件时行名是两个文件名,但它们仍然
 * 是「read ×2」;按行名聚合会把它们当成两种东西。
 */
export interface ToolCardEntry {
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

/**
 * 多步卡的**头行**(§6.1)。
 *
 * 它不是一句旁白(「执行了 7 步」那种计数句 C2-a 退役了),而是**这几步本身**:
 * 一叠最多三枚工具图标 + 由各步的名拼成的摘要句 + 右端总耗时与失败点。
 * 计数只在「×N」聚合上出现 —— 那是事实,不是徽。
 */
export interface ToolCardHead {
  /** 图标名叠(最多三枚),按工具**种类**首次出现序去重 —— 种类没变就不重画。 */
  icons: string[]
  /** 摘要句「rg · read ×3 · edit ChatStream.tsx」。 */
  text: string
  /** 失败条数(0 = 右端不画那一格)。 */
  failed: number
  /** 总耗时(ms);一条都算不出就缺席。 */
  durationMs?: number
  /** 还有步没收场 —— 头行的色调按它走。 */
  live: boolean
}

/**
 * 一张工具卡(§6.1「一件事一张脸」)。
 *
 * 一次调用是一步的卡,连续多次调用是多步的卡 —— **同一个模型、同一张壳**,
 * 没有第二种画法。所以这里没有「单发」那一支:`steps.length === 1` 时 `head`
 * 缺席,如此而已。
 *
 * `steps` 是**时间序,不重排**(拍点 ⑨:失败不置顶)——顺序是这张卡唯一的结构,
 * 把出事的那条提上来等于把「先做了什么」抹掉。`entries` 是同一批 step 的聚合视图
 * (同名连发折成一格),两者指向**同一批对象**,不是两份拷贝。
 */
export interface ToolCardModel {
  /** 逐步,时间序。 */
  steps: ToolStepModel[]
  /** 展开时按格画;`entries` 里的 children 就是 `steps` 里的那些对象。 */
  entries: ToolCardEntry[]
  /** 多步才有;一步的卡里只有那一行,没有头。 */
  head?: ToolCardHead
  /** 调用数(= steps.length,聚合之后与 entries.length 不再相等)。 */
  total: number
  /** 失败条数。 */
  failed: number
}

/**
 * 一条来源(检索段清单里的一行、预览卡里的一张脸)。
 *
 * **一份事实两处呈现**:清单行与(将来的)引用预览卡读的是同一个对象,不是各取
 * 各的一份 —— 两份就会分叉。
 */
export interface ResearchSource {
  /** 段内稳定身份:`<引入它的那次调用 id>#<序>`。同一个 URL 在一段里只有一条。 */
  id: string
  url: string
  title?: string
  /** 域名(去 `www.`);解析不了就是原样那串字符 —— 不编一个。 */
  domain: string
  /** 摘录:搜索结果的 snippet 或打开页面的 excerpt,已剥 HTML。取不到就缺席。 */
  excerpt?: string
  /** 引入它的那次调用 —— 来源行点开的抽屉认这一格。 */
  callId: string
  /** 被 `web_open` 真打开过。 */
  opened: boolean
  /** 打开它的那次调用(有就用它开抽屉:比「搜到过它」更贴近人想看的东西)。 */
  openCallId?: string
  /**
   * 打开的结局。**没打开过就缺席** —— 不拿「搜索成功」冒充「页面打开成功」:
   * 搜到一条链接和读到那一页是两件事,后者常常失败(反爬、无正文)。
   */
  openStatus?: 'ok' | 'failed'
}

/**
 * 按查询词分的一组。
 *
 * 未署名组(`query` 缺席)是**开在最前的 `web_open`**:模型直接给了一个 URL,
 * 没有先搜。给它编一个查询词是造事实,所以它自成一组、用「直接打开」当组头。
 */
export interface ResearchQueryGroup {
  /** 组的稳定身份(渲染 key)。 */
  id: string
  /** 查询词。未署名组缺席。 */
  query?: string
  /** 产生这一组的那次 `web_search`(未署名组没有)。 */
  callId?: string
  sources: ResearchSource[]
}

/** 流中态那一行现在在忙什么 —— 由**最后一次还没收场的调用**说了算。 */
export interface ResearchActivity {
  kind: 'search' | 'open'
  query?: string
  domain?: string
  title?: string
}

/** 检索段(§5.3 四件套读它)。 */
export interface ResearchEpisodeModel {
  /** 按查询词分组的清单(展开态画它)。 */
  groups: ResearchQueryGroup[]
  /**
   * 全部来源,按首次出现序、按 URL 去重 —— `groups` 里的**同一批对象引用**。
   * 收起行的「N 个来源」数的就是它,所以它与清单上看得见的行数逐条相等。
   */
  sources: ResearchSource[]
  /** 署了名的查询词(收起行的「M 组查询」数的是它的长度)。 */
  queries: string[]
  /** 段里每一次调用的行 + 事实:来源行的抽屉按 callId 到这里取。 */
  steps: ToolStepModel[]
  /** 真打开过几个页面(流中态副行的 M)。 */
  openedCount: number
  /** 失败了几次调用。 */
  failed: number
  /** 总耗时(ms);一次都算不出就缺席。 */
  durationMs?: number
  /** 还有调用没收场 —— 画流中态行而不是收起行。 */
  running: boolean
  /** 只在 `running` 时有。 */
  active?: ResearchActivity
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
  /**
   * `ids` 是 R4a 的**块流身份号**(与 blocks 一一对应)。旧路缺席 —— 那时身份由
   * 渲染侧按 `offsets` 现算。两列并存不是重复:偏移是**解析事实**(工具产地的块
   * 序列没有它),身份号是**流的事实**,将来资产型的号会由内容地址派生而不是偏移。
   */
  | { kind: 'rich-text'; blocks: BlockModel[]; offsets: readonly number[]; ids?: readonly string[] }
  /**
   * 挨着做的那几件事。**一次调用也是一张卡** —— C2-a 起单发与连发是同一个组件、
   * 同一张壳(§6.1),一步的卡里只是没有头行。
   *
   * 从前这里还有一格 `{kind:'tool'}`,09-01 P2 撤掉:段种带进 key,第二次调用一
   * 到达同一位置就换段种,React 把整段卸载重挂(真机 t=6614 那一帧整行替换)。
   * 「画成一行还是画成头行 + 一列」是呈现的事,不该决定「这是不是同一件东西」。
   * 段种名 `tool-group` 一字不改,理由同上:改名就是换 key 就是重挂。
   */
  | { kind: 'tool-group'; card: ToolCardModel }
  | { kind: 'research'; episode: ResearchEpisodeModel }
  /**
   * **压缩折痕**(U2,设计正本 `docs/compact-seam-2026-09.md`)。
   *
   * 账本上它只是一条 system 消息,正文是一段 JSON;装配管线**按内容自述**把它认出来
   * (`content/compact/marker.ts` 的 `parseCompactMarker`),于是「这条 system 消息
   * 是不是压缩标记」这个判断有且只有一个产地,MessageRow 与 SegmentView 都不加分支。
   *
   * 段里装的是**已经解析好的事实**,不是那串 JSON:折痕不自己解析,读数环读的也是
   * 同一只函数 —— 两个消费方各 `JSON.parse` 一次就是两份对协议的理解。
   */
  | { kind: 'compact'; marker: CompactMarker }
  | { kind: 'image'; blob: BlobRef }
  | { kind: 'stream-cursor' }

export type SegmentKind = SegmentModel['kind']
