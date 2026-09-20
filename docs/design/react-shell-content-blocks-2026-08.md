# React 壳内容块系统 —— 块注册表 / 工具结果展示 / 代码组织(2026-08-30)

UI 选型经六轮比稿闭环(定稿规格页 artifact 69721397;拍板记录在会话 memory
`md-blocks-ui-picks`)。本文是实现批的**架构设计**:块注册表怎么立、工具的各种结果
怎么展示、代码怎么组织。设计经面向对象审视:每个概念一个归属,扩展走注册不走 if。

## 0. 一句话与三条铁律

**屏幕上的一条消息 = 一串段(Segment),每个段由注册表里的一个渲染器画;
段的模型是纯数据,产地(markdown 解析 / 工具结果呈现)与消费(渲染)彻底分离。**

铁律三条,贯穿全文:

1. **一张注册表,两个产地。** 聊天正文里的代码块和工具结果里的代码块是**同一个组件**;
   markdown 解析器和工具 presenter 都只产出 `BlockModel`,谁也不自带渲染。
   嵌套(工具抽屉里出现 diff)不是特例,是注册表复用的自然结果。
2. **模型是数据,不是组件。** `BlockModel` 可序列化、可单测、不可变;解析/归组/呈现
   全是纯函数。React 只在最外层出现一次(注册表把 kind 映到组件)。
   这延续折叠器哲学:屏幕画的是纯函数输出,组件不推导结构。
3. **壳管公共,块管本体。** 檐、动作组、块内横滚、限高折叠、错误边界、懒加载,
   六件公共事**只在 BlockShell 实现一次**;块渲染器以声明(chrome / actions /
   streaming)换取这些能力,自己一行都不写。UI 六轮定下的横切规范
   (动作常显住檐右端、词表统一、左竖线禁令)因此天然全局成立,不靠自觉。

## 1. 领域模型(词汇层)

两层词汇。**段(Segment)**是消息内部的排布单位,**块(Block)**是富文本的物件单位;
段里可以装块(text 段经 markdown 解析产出块序列)。

```ts
// src/content/model/segments.ts —— 纯类型,零 React
export type SegmentModel =
  | { kind: 'thinking'; text: string; live: boolean }            // 思考(S2 定稿)
  | { kind: 'rich-text'; blocks: BlockModel[] }                   // markdown 解析产物
  | { kind: 'tool'; row: ToolRowModel }                           // 单发调用(A1+V2)
  | { kind: 'tool-group'; group: ToolGroupModel }                 // 连续段(B2)
  | { kind: 'research'; episode: ResearchEpisodeModel }           // 检索段(四件套)
  | { kind: 'image'; blob: BlobRef }
  | { kind: 'stream-cursor' }                                     // 呼吸光标

// src/content/model/blocks.ts
export type BlockModel =
  | { kind: 'paragraph'; inline: InlineNode[] }                   // 行内树:文字/行内码/链接/引用角标
  | { kind: 'heading'; level: 1 | 2 | 3; inline: InlineNode[] }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][] }
  | { kind: 'quote'; blocks: BlockModel[] }                       // 呈现另设计(竖线禁令)
  | { kind: 'code'; lang: string | null; source: string; file?: string; closed: boolean }
  | { kind: 'table'; caption?: string; head: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'figure'; figKind: string; source: string; title?: string }  // mermaid/math/…
  | { kind: 'diff'; file?: string; hunks: DiffHunk[]; stat: { add: number; del: number } }
  | { kind: 'source-fallback'; reason: string; source: string }   // 一切失败的归宿
```

要点:

- `figure` 不枚举图种 —— `figKind` 是**二级注册表**的键(§3.3),
  今天只有 `mermaid-flowchart`,明天来 sequence / gantt / math / image 不改这里。
- `diff` 是一等块,不是 code 的变体:它有自己的行结构与 ±统计,且被两个产地共用
  (markdown 的 ```diff 围栏、edit/write 工具的结果)。
- `closed: false` 的 code 块是流式中的未闭合围栏 —— 流式契约(§6)靠它成立。
- InlineNode 里有 `citation` 节点(检索引用角标),让"正文引用"不是后处理
  而是行内词汇的一员。

**数学公式(2026-09-20 补)。**词汇里多两格,块与行内各一:

```ts
// BlockModel 多一员 —— 纸上居中的一行
  | { kind: 'math'; source: string; closed: boolean }
// InlineNode 多一员 —— 夹在字里的一个词
  | { type: 'math'; tex: string }
```

- **两格装的是同一种内容**:定界符**之内**的那段 TeX(不含 `$` / `$$` / `\(` / `\[`),
  与 image 的「块 / 行内两个位置」逐字同构。定界符是 markdown 的语法,不是这段数学
  的内容,所以它不进词汇。
- **它不是 figure 的一种图种**(§3.3 当初把 katex 列在候选里,这一批推翻)。三条
  差别:图是 `object`(白卡 + 檐 + 放大 + 导出 PNG),公式是纸上的一行字,套卡等于
  把一句话装进相框;图种表交出来的是一段 SVG,katex 交出来的是一段 HTML;图在流式
  期由 `code(closed:false)` 代画,而公式从第一个 `$$` 起就已经是 math 块。
- `closed` 与 code 的那一格是**同一条流式判据**:只从源文本看得出来(AST 对没收尾的
  `$$` 一样产出 math 节点,它在 EOF 处闭合)。
- **呈现三态,两条降级落同一处**:还没收尾 / 库还没到 → 那段 TeX 源码(`SourceView`,
  与兜底块同一个画法);排不出来 → 源码 + 一行灰说明(KaTeX 的原话,不改写);
  排好了 → KaTeX 产出。行内那一档没有地方画说明行,原话挂在 `ui/Tooltip` 上。
- 流式五问:`midway: 'grow'` / `settled: 'same'` / `failure: 'source'` /
  `identity: 'origin'` / `geometry: 'flow'`。前两问与图**相反**,判词在
  `blocks/kinds/math/index.ts`:公式不经过「由别的型代画」那一段,kind 从头到尾是
  `math`,所以既不是 `hold` 也不是 `swap`。

## 2. 装配管线:ProjectedMessage → SegmentModel[]

折叠器的输出(`ProjectedMessage`:`content` / `reasoning` / `contentParts`
(text|reasoning|image)/ `toolCalls[]`)不带排布;排布由一条**五步纯函数管线**现算:

```
ProjectedMessage
  │ ① anchor   —— synthesizeCoreToolAnchors(core 单实现):把 tool-call 锚点
  │              按 turnIndex 织进 contentParts。“工具卡按锚点归位”不在壳里
  │              发明第二份算法 —— renderer(Vue)与主进程已在用它,React 壳是
  │              第三个消费者,三处逐字同算(§15.16 判例:流式分界=刷新分界)。
  │ ② group    —— 扫锚点后的序列,把“相邻、同族、无其它 part 打断”的工具调用
  │              折成 tool-group;web_search/web_open 族折成 research 段。
  │              判据是数据性质,与后端形状无关:专用 research 引擎的单调用
  │              天然一组,模型裸连发也归得出同一段。
  │ ③ present  —— 每个工具调用过 ToolPresenter 注册表(§5):产出 ToolRowModel
  │              (V2 状态图标/成果词)与 detail 的惰性描述。
  │ ④ markdown —— text part → BlockModel[](§3.2)。只解析,不渲染。
  │ ⑤ key      —— 给每个段/块发稳定 key(源偏移派生),流式重解析不换 key,
  │              React 不重挂(§6)。
  ▼
SegmentModel[]
```

纪律:

- **五步全部纯函数**,住 `src/content/assemble/`,vitest 直测,jsdom 都不用起。
- **按消息缓存**:装配结果以 message 引用为键 memo(折叠器已保证不可变、变则换引用
  —— 主仓 F 线物化缓存同款判据)。非活跃消息零重算;活跃消息走 §6 的增量。
- ChatStream 瘦成纯排布:`messages.map(m => assemble(m).map(renderSegment))`,
  自己不认识任何块。

## 3. 块注册表

### 3.1 契约

```ts
// src/content/blocks/registry.ts
export interface BlockDef<M extends BlockModel = BlockModel> {
  kind: M['kind']
  /** object = 进 BlockShell 的物件;flow = 直排在纸上(paragraph/heading/quote/思考) */
  presentation: 'object' | 'flow'
  /** 本体渲染器。只画 body,公共件一行不写。 */
  Component: ComponentType<{ model: M; ctx: BlockCtx }>
  /** 檐声明:左端身份 + 中段(表题)。undefined = 无檐(flow 块必然无檐)。 */
  chrome?: (model: M) => { id?: string; meta?: string; title?: string }
  /** 动作声明:壳画前 1–2 个 + ⋯ 菜单。词表见 §4.2。 */
  actions?: (model: M, ctx: BlockCtx) => BlockAction[]
  /** 流式契约:append = 可半成品渲染(code);atomic = 闭合才画(table/figure)。 */
  streaming: 'append' | 'atomic'
  /** 重渲染器懒加载(shiki/mermaid/katex)。返回值缓存,失败走降级。 */
  loader?: () => Promise<unknown>
}

const REGISTRY = new Map<string, BlockDef>()
export function registerBlock(def: BlockDef): void   // 重复注册 = 抛错,不静默覆盖
export function resolveBlock(kind: string): BlockDef // 查不到 = source-fallback 的 def
```

纪律:

- **注册只发生在一个 barrel**(`src/content/blocks/index.ts` 逐个 import 各 kind 的
  `index.ts`)。运行时注册面留着(将来插件接入走同一个 `registerBlock`,与主仓插件
  UI 的"描述性数据 + 受控注册"哲学同构),但本批没有第二个调用方。
- **未知 kind 不是错误**:解析器可以产出注册表还不认识的 kind(版本错位、插件缺席),
  `resolveBlock` 兜到 `source-fallback` —— 源码永远可见,这是全系统的失败语义。
- **错误边界粒度 = 单块**:BlockShell 内建边界,渲染器抛错 → 当场降级为
  `source-fallback` 画源码 + 一行错误说明。一块炸不塌一条消息(与 renderContent
  的面板边界同哲学,粒度更细)。

### 3.2 markdown 产地

- 解析器选 **micromark/mdast(unified 家族)**:AST 稳定、扩展点(GFM 表格、数学)
  是官方包、体积可控且可 tree-shake。**AST 不外泄**:`markdown/to-blocks.ts` 把
  mdast 翻成 §1 的 BlockModel,翻译表之外的节点类型统统落 `source-fallback`。
  换解析器 = 换这一个文件。
- 围栏语言即路由:` ```mermaid `→ `figure(figKind:'mermaid-flowchart')`、
  ` ```diff `→ `diff`、其余 → `code`。路由表与块注册表分开(它是 markdown 产地的
  私事,工具产地不经过它)。

**数学那一支的四条(2026-09-20 补,落点全在 `markdown/` 里)。**

1. **扩展只在 parse.ts 组装**:`extensions` 加 `math()`、`mdastExtensions` 加
   `mathFromMarkdown()`。单 `$` 行内保持开着(扩展缺省)。
2. **定界符先等长归一**(`markdown/math-delimiters.ts`):`\(` `\)` `\[` `\]` 各换成
   `$$`,**两个字符换两个字符,输出长度恒等于输入长度**。理由是源偏移 ——
   块的身份号由它派生、增量切点按它验证、降级与「查看源码」按它回读原文。于是
   **解析器吃归一文本,翻译表吃原文**:屏幕上落回源码的地方仍然是作者写的字节。
   四处不换:围栏代码里、数学围栏里、同一行的行内码里、`\\(`(反斜杠已被转义)。
   行内要同一行成对才换;独占一行的 `\[` **无条件**换(等配对会让前缀的译法被后面
   到的字符改掉,屏幕上就是一次回跳)。已知代价:成对的 `\[…\]` **转义**写法会被
   当成公式,记在那个文件的头注里。
3. **围栏判据一张表**(`markdown/fences.ts`):代码围栏与数学围栏各一行,归一器与
   稳定切点(`stable-cut.ts`)读**同一张表**。于是「`$$` 块里的空行不是块边界」不用
   在两处各写一遍正则。加一种围栏只动这张表。
4. **提升与那道闸,判据各只有一处**:独占一段、且定界符是 `$$` / `\[` 的行内公式
   提升成块(与「独占一段的 image 提升」写在同一处、同一种判法 —— 按**源节点**判,
   不按翻译结果判);单个 `$` 过 pandoc 四条(内容非空、首尾非空白、闭合后一位不是
   数字),不过的原文照抄成文字(「花了 $5 和 $10」因此保持原文)。词法认得宽、
   翻译表判得严,两层分工。

### 3.3 figure 二级注册表

图种是第二张表,与主表同构(`registerFigureKind({ kind, render, loader, toPng? })`),
主表的 `figure` 渲染器只做:查表 → Suspense 懒加载 → 画 → 失败降级 code。
mermaid 全家共用一个 loader(动态 import mermaid,一次拉起);math 将来是 katex。
**“下载 PNG”是壳能力**:SVG→PNG 转换住 `blocks/shell/export-png.ts`,
任何图种自动获得,不各自实现。

## 4. BlockShell(壳)

### 4.1 结构

```
<BlockShell def model ctx>
  ├─ ErrorBoundary(降级 source-fallback)
  ├─ Suspense(def.loader → 骨架:surface-1 静默占位,不转菊花)
  ├─ 檐(仅 object 且 chrome 非空):左 id/meta(小写 mono 灰)· 中 title · 右动作组
  ├─ body 容器:块内横滚(overflow-x + overscroll contain)· 限高折叠(渐隐 + 展开钮)
  └─ 块本体(def.Component)
```

UI 定稿逐条落位:代码檐 = `chrome → { id: lang, meta: file }`;图檐 =
`{ id: figKind 词 }`;表格檐 = `{ title: caption }`(空 caption = 空左端,檐仍在
—— 动作要有家)。思考/段落是 flow,不进壳。

### 4.2 动作组

```ts
type BlockAction =
  | { verb: 'copy';     what: 'markdown' | 'csv' | 'source' | 'column'; … }
  | { verb: 'download'; what: 'csv' | 'png' | 'svg'; … }
  | { verb: 'view-source' }
  | { verb: 'zoom' }        // QuickLook 同族浮层
```

动词是**封闭词表**(六轮定稿:复制 = 进剪贴板、下载 = 落文件、源码、放大),
新动作 = 词表加一格,是拍板件不是随手件。执行器住壳
(`shell/actions.ts`:剪贴板、CSV 序列化、PNG 导出、QuickLook 唤起),
块只声明。露出规则:前 1–2 个 + ⋯ 菜单(复用 `src/ui/Menu`);
静默 text-4,悬到单钮才亮。表格的"复制列 ⧉"是**块内交互**(长在列头上),
不进动作组 —— 动作组管块级动作,块内热区归块本体,两者共用同一个执行器模块。

## 5. 工具结果展示

### 5.1 ToolPresenter 注册表

“不同工具的结果怎么展示”是第三张表 —— 它不产出组件,产出**摘要行模型 + 详情块**:

```ts
// src/content/tools/presenter.ts
export interface ToolPresenter {
  match(call: ProjectedToolCall): boolean          // 按 toolName / result 形状认领
  row(call): ToolRowModel                           // A1 卡行的数据:图标名 / mono 名 /
                                                    // 参数摘要 / 状态(V2)/ 成果词(右端)
  detail(call): BlockModel[]                        // C1 抽屉的内容 = 内容块(嵌套即复用)
}
export function registerToolPresenter(p: ToolPresenter): void  // 有序表,先注册先认领
```

内建 presenter 一览(每个一个文件,`tools/presenters/`):

| presenter | row 摘要 | detail 产出 |
| --- | --- | --- |
| read | 文件名 + 成果词「N 行」 | `code`(lang 由扩展名推,带文件檐) |
| edit / write | 文件名 + 「+a −d」 | `diff`(结构化 hunks;拿不到结构 → 源文本 diff 围栏) |
| bash | 命令 + 成果词(退出码/尾行摘要) | `code`(输出;ANSI 剥离本批,染色留扩展位) |
| web_search / web_open | 查询词 / 域名 | 通常被 ② 折进检索段,散发时 detail = 链接列表 |
| task / agent 类 | 代理名 + 状态 | `source-fallback`(JSON)——嵌套消息流留扩展位 |
| default(兜底) | 工具名 + 状态 | `source-fallback`(参数与结果 JSON 原样) |

**兜底是合同的一部分**:任何新工具零配置就有诚实的展示(JSON 可见),
presenter 是渐进增强,不是准入门槛。

### 5.2 三件套组件(定稿形)

`tools/` 下三个组件消费上面的模型,UI 全按定稿:
`ToolRow`(A1 卡行 + V2 图标即状态:成功常灰 / 失败红 / 运行中紫呼吸;右端成果词
或失败原因,无「✓ 完成」)、`ToolGroup`(B2 计数句收起 ↔ 执行清单展开;
清单里同名连发聚合一行「×N」,点开逐条、失败置顶)、`ToolDrawer`(C1 行内抽屉:
参数 + detail 块序列,原位下拉)。状态映射一张表
(后端八态 → 图标三态 + 文案),延续 ChatStream 现有 TOOL_STATUS_KEYS 的
"认不出原样显示"纪律。

### 5.3 检索段

`research/` 自成目录:`ResearchEpisodeModel`(查询词组 → 来源列表 → 引用映射)由
② group 步产出;四件套组件(流中态行 / favicon 收起行 / 来源清单 / 引用角标 +
预览卡 + 消息尾来源条)按定稿画。引用角标是 InlineNode(§1),markdown 步在
text 里布点,预览卡与来源清单读同一份 episode —— 一份事实两处呈现。
favicon 经壳的缓存取站点图标,拿不到降级字母圆片(比稿页的代位即降级态)。

## 6. 流式契约

- 活跃消息的装配走**增量**:活尾巴纪律(D3:只许文本追加)保证变化只发生在
  最后一个 text part 的尾部 → 只重跑 ④ 的**最后一个 rich-text 段**,
  且解析按"稳定前缀 + 活动尾"切:未闭合围栏渲染为 `code(closed:false)`
  逐行追加(streaming:'append'),table / figure 未闭合前按 code 显示,
  闭合那一刻原位换装(streaming:'atomic')。
- **key 稳定性是硬约束**:块 key 由源偏移派生,重解析不换 key → React 打补丁
  不重挂 —— 否则流式期间代码块逐帧重建,tab 卡顿批的教训原样重演。
- 重解析按帧节流(与 SessionStreamCoalescer 的 16ms 批一个节拍),
  并只对活跃消息生效;历史消息永远走 §2 的整段缓存。

## 7. 代码组织

```
apps/desktop-react/src/content/
├── ChatStream.tsx            # 只做排布:消费 SegmentModel,零块知识
├── model/                    # §1 纯类型(segments.ts / blocks.ts / inline.ts)
├── assemble/                 # §2 五步管线(anchor/group/present/markdown/key)+ memo
├── markdown/                 # mdast → BlockModel 翻译表 + 围栏路由 + 增量解析
├── blocks/
│   ├── registry.ts           # 主注册表 + resolveBlock + source-fallback def
│   ├── index.ts              # 唯一注册 barrel
│   ├── shell/                # BlockShell / actions.ts / export-png.ts / 折叠
│   └── kinds/<kind>/         # 每块一目录:model 已在 model/,这里只有
│                             # Component + 注册 index.ts(figure/ 下挂二级表与图种)
├── tools/
│   ├── presenter.ts          # ToolPresenter 契约 + 注册表 + default
│   ├── presenters/<tool>.ts  # 每工具一文件
│   └── ToolRow/ToolGroup/ToolDrawer
└── research/                 # 检索段模型 + 四件套组件
```

**依赖方向单向**:`model` ← `assemble`/`markdown`/`tools(模型半边)` ←
`blocks`/`tools(组件半边)` ← `ChatStream`。注册表不 import 任何组件
(组件注册时自己找上门),砍掉环;`model`/`assemble` 不 import React。

**扩展三问自答**(可迭代性的验收):新图种 = `blocks/kinds/figure/<kind>/` 一目录
+ 二级表一行;新工具展示 = `tools/presenters/<tool>.ts` 一文件;新 markdown 块 =
`model/blocks.ts` 加变体 + `markdown/to-blocks.ts` 加翻译 + `blocks/kinds/` 一目录。
每问的答案都不含"改 ChatStream / 改壳 / 改别的块"。

## 8. 性能与测试

- 装配 memo 以消息引用为键;块组件一律 `memo`(model 不可变,浅比即准);
  懒渲染器的产物按 source hash 缓存(mermaid 同源不二渲)。
- 测试面全在纯函数上:翻译表(mdast→blocks)、归组判据、presenter、增量解析
  (未闭合围栏三态)、key 稳定性(同源重解析 key 逐字相等)—— jsdom 只留给
  BlockShell 的边界/降级两条。真机门:gate-chat 加两断言(markdown 消息上屏含
  code/table 块、流式围栏闭合原位换装不重挂——以 DOM 节点身份断言)。

## 9. 分期总览

| 期 | 内容 | 验收 |
| --- | --- | --- |
| P0 | model + assemble 管线 + 注册表 + BlockShell + source-fallback;ChatStream 切到段渲染,**纯文本行为零变化** | 现有 11 条 ChatStream 测试原样绿;段装配单测 |
| P1 | markdown 产地:paragraph/heading/list/inline + code(shiki 懒加载)+ table(T0 全配方)+ 流式契约 | 翻译表/增量解析单测;gate-chat 新断言 |
| P2 | 工具三件套:presenter 表 + 锚点归位(synthesizeCoreToolAnchors)+ A1/V2/B2/C1 | presenter 单测;工具卡与旧一行摘要卡的替换走查 |
| P3 | figure 二级表 + mermaid(懒加载/降级/PNG 导出)+ diff 块(edit presenter 接入) | 图种表单测;降级路径测试 |
| P4 | 检索段:归组判据 + 四件套 + 引用角标/预览卡 | 归组单测(引擎/裸连发两形态同段) |
| P5 | quote 呈现(竖线禁令下另设计,先拍板再做)+ ANSI 染色 / 嵌套代理流等扩展位 | 各自拍板后排 |

P0 是结构批(零可感知变化),P1 起每期都有可见交付;期间随批纪律:
颜色零新增、动作词表封闭、失败必降级到源码可见。
