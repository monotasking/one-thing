# 检索面终稿(2026-09-06)——一次改全,不逐条

> 起因:09-05 用户看真机检索面连报「割裂」「组头多余」「零命中占行」「Create prompt 冒充结果」「预览标题两遍」「Load more 跳回顶部」,并斥「你明明知道应该什么样,还得我一个问题一个问题说」「设计时就说了组件的设计模式、生命周期、交互、状态,你注意了个屁」。两条都成立:S4 两批没交方案 §9 要求的三张状态表,也没人把整面的每个状态对着屏过一遍。
> 本稿是补交:整面 139 处问题(七个镜头独立找、按相似度归并、逐条反驳核实)全部收进一份规格,骨架不换(顶栏 / 输入框 / 档位条 / 过滤片行 / 左列表右预览),状态机、组件树、三张状态表、分页设计在附录 B 逐条落到 file:line。取舍全部由编排者定,不再列拍点问用户;每条取舍写在 §6,不同意就改那一行。
> **落地记录 2026-09-06**:十步全部入库(§7 十步表逐行带 sha:①`ae9cbcde` ②`43fcf0a2` ③`054e70a3`
> ④`e3ae05c1` ⑤`36b1d554` ⑥`10f97cc9` ⑦⑧`e6986e06` ⑨⑩本批)。§8 落差总账 35 行全部已落;
> §9 的拍点全部生效(三处落地时改了口,逐条在末列),还开着的九条搬进 §9 末尾的「本批留账」。
> 附录 B 的三张状态表已按落地改成事实 —— 它现在描述的是屏幕上真有的东西,不是计划。
>
> 落点:壳 `apps/desktop-react/src/search/**`、`src/data/search-listing-source.ts`(新)、`src/ui/scroll-memory.ts`(新)、`src/ui/FilterChip`、`src/expose/components/Highlight`;契约 `packages/shared/ipc/search.ts` 只加;后端 `runtime/src/search/{service,capabilities/*}.ts`、`core/search/pipeline/snippet.ts`。检索方案正本 `docs/design/search-index-2026-09.md` §7.2 / §9 / §4.5 ⑤ 三处旧裁定由本稿推翻(§7)。

## 0. 一页结论

1. **一张清单,不分组。** 全部档与浏览态是同一种列表:若干「块」相邻(每块 = 一个能力的命中,次序按自述 order,跨块不混排,块之间一格空 + 一条发线),块内是行,行首徽说种类;没有组头、没有「N in total」、没有「View all」。零命中的能力一块都不占。
2. **每块自己原地续页。** 块末一条与浏览态同款的项「加载更多 · 已显示 5 / 41」,按下只把这一块长一页,旧行一像素不动、滚动不动、焦点不动;取尽即消失。后端 `groups[].cursor` 只加一格。
3. **动作不是结果。** 「新建提示词 “jira”」「新建今天的日记」是清单末尾分隔线下的动作行,前缀「＋」,不计数、不戴徽、不进预览、不参与零结果判据;由能力以页级 `actions` 自报。
4. **预览栏只说一次,不说内部话。** 檐画标题一次(带命中高亮),体从事实起笔;自述没有预览的能力不发请求、画行的放大版;真算不出画一句人话,原话进日志。
5. **分页与状态归一台机。** 一把键 = 主语三元组(问谁 / 词 / 片),limit 与页码不进键;翻页是对同一格的追加;活动项按 id;滚动只随选中变;换词期间旧行留屏。三张状态表(生命周期 / UI 生命状态 / 交互)见附录 B §2–§4,每格判据都是可读字段。

## 1. 规矩(整面都遵守,门里逐条钉)

| # | 规矩 | 门 |
| --- | --- | --- |
| R1 | 列表零组头、零「in total」、零「View all」;块之间只有一格空 + 一条发线 | `search-css.test`: 无 `.groupBand`;真机:`[data-group]` 零个 |
| R2 | 零命中的能力不占行;块级失败只在页脚一行说「<能力名>没搜成 · 重试」 | 真机:注入一个零命中能力 → DOM 里不出现它 |
| R3 | 动作行在分隔线下,不计入任何条数,不进预览、不进多选;是 ↑↓ 序列末项 | 单测:`sequence` 末项 kind=action;真机:页脚计数不含动作行 |
| R4 | 每块原地续页:按下后 `[data-row="0"]` 同一 DOM 节点、`scrollTop` 差 0、`activeElement` 仍是输入框、别的块行数不变 | 真机四条断言 |
| R5 | 浏览态与查询态是同一只 `SearchList`:DOM 形状、徽、右列、块尾项、页脚读数集合逐字相同 | 真机:两态 `[role=option]` 三列形状与 `[data-readout]` 集合逐字同 |
| R6 | 预览檐标题只出现一次;`Body` 不含标题;无预览零请求;error 只画字典句 | `preview.test`:Body 不含 title、error 不含原话;真机:`data-preview` 内 `.title` 恰一个 |
| R7 | 高亮只换底不改字距(`padding: 0`,自有 token `--st-mark`);区间永远相对屏上那串字;截断处只有省略号 | 单测:`Highlight` 零 padding;真机截图比对多档宽度 |
| R8 | 行上一切文字是纯文本:markdown 记号剥掉、脱敏占位画「[已隐去]」、窗口从命中前约 20 字起、前置「…」 | 单测:语料 200 条摘要零 `**` / 反引号 / `<redacted` |
| R9 | 过滤片「键 · 值」,两态片改成「归档 · 含 / 不含」两格,死选项(自定时间)不摆 | `FilterChip.test`;真机片文案 |
| R10 | 焦点恒在输入框:行与块尾项 `tabIndex=-1`,listbox `aria-activedescendant`;面板根键盘委托只认输入框为来源;Tab 序 = 输入框 → 档位 → 历史钮 → 片;IME 组字期间不接键 | `gate:a11y` 检索面纳入扫描;`gate:focus` 场景 |
| R11 | 换词 / 换档 / 换片期间旧行留屏(`useQueryHeld`),「无结果」只在一次真答复为零时出现且带下一步 | 单测律②′;真机:换词途中 `[role=option]` 数不归零 |
| R12 | 一切给人看的句子由壳按键查出,后端只交数据(`labelKey + params` / `reason` 码);中英成对 | `i18n.test` 成对;边界用例:`capabilities/*.ts` 零成品句 |

## 2. 各状态屏上是什么(摘要;判据与全表见附录 B §3)

| 状态 | 列表 | 块尾项 | 预览栏 | 页脚 |
| --- | --- | --- | --- | --- |
| 空词浏览态 | 声明了 browse 的能力各一块(今天只有会话),行 = 徽 + 标题 + 出处/时间 | 「加载更多 · 已显示 20 / 483」 | 活动行的会话概览(标题一次 + 条数 / 更新于 / 空间) | 取尽后「共 483 条」 |
| 有词 · 全部档 | 有命中的能力各一块,相邻不混排 | 每块各自「加载更多 · 已显示 5 / 41」,取尽消失 | 活动行按 kind 画 | 动作行(分隔线下);无全局「N results」 |
| 有词 · 单类档 | 一块 | 同上 | 同上 | 「共 N 条」/ 已放宽 / 索引更新中 |
| 打字去抖 / 在飞 | 旧行留屏,列表根 `data-stale`(文字降一档) | 上一把键的那条留着 `aria-busy` | 留着 | 「搜索中…」 |
| 零结果 | 一句「没有和「jira」匹配的结果」+ 与当前片对应的下一步(「搜全部空间」/「去掉范围」/「清除过滤」) | 无 | 「选一条看看」 | 动作行仍在 |
| 翻页在飞 / 失败 | 该块行不动 | 「加载中…」/「没加载出来 · 再试一次」(同一 cursor) | 不动 | 不动 |
| 块级失败 | 该块不占行 | 无 | 不动 | 「消息没搜成 · 重试」 |
| 整发失败 | 旧行留 | 原样 | 原样 | 「没搜成」+ 重试(原话进日志) |
| 索引更新中 / 读者模式 / 索引不可用 / 已放宽 | 不受影响 | 不受影响 | 不受影响 | 各一行:「索引更新中(剩 n)」(跟最近一次答复走)/「由 <host> 维护」/「索引不可用 · 只显示未建索引的结果」/ 放宽三句各说各的 |
| 语义开关开着 | 来自向量路的行右列多一枚「语义」小徽(不是计数徽) | — | — | 「语义召回:下载中 / 建向量中(剩 n)」;运行时缺席一句人话 |
| 预览 loading / 无 / 缺渲染器 / error | — | — | 150ms 内旧内容不换,之后骨架;无预览 = 行放大版(标题 + 出处);缺渲染器 = 同上 + dev warn;error = 「预览不可用」 | — |
| 窄档(< 640px) | 列表至少六成高 | — | 预览成一条封顶的带,各自滚 | — |
| 预览 compare / batch | — | — | 轨够宽才并排,否则上下堆;格头各画一次标题,格内不画 | — |

## 3. 问题总账(139 条归并;编号即附录 A 清单序号)

**用户点名的八条(全部 blocker,附录 A #1–#10、#22–#50)**:①组头 / in total / View all(#3 #10)②零命中占行(#1 #11)③动作冒充结果 + 高亮拆词(#4 #12 #29 #47)④无原地 Load more、组 cursor 被丢、点了滚回顶部(#8 #13 #23 #33 #39 #46)⑤预览标题两遍 + 内部错误串(#2 #14 #15 #21 #25 #30 #34 #40 #48)⑥两态两套(#20 #24 #26 #35 #41)⑧markdown / 截断残片 / 过滤片键值(#5 #6 #7 #9 #16–#19 #27 #28 #31 #32 #36–#38 #42 #43 #49 #50)。

**用户没点名、审出来的 blocker 与 major(要一并改,不分两批)**:

- 键盘与焦点:Tab 被面板根整个劫持(#44)、键盘委托不认来源、行菜单无键盘入口(#45)、行是真按钮 Tab 位(#93)、点行把焦点带离输入框(#102)、无 ARIA 关系(#103)、IME 组字被当列表键(#99)、Esc 不分层(#101)、历史还原后 cursor 被重置(#100)。
- 状态:加载中画成「无结果」(#62 #80 #86 #98)、空态无下一步(#63)、块级失败无处说(#85)、整发失败与无结果同屏(#136)、索引不可用被吞(#65)、放宽三级只说一句(#66)、语义开关无入口(#67)、索引读数只读一次(#68)。
- 行内容:出处列五种语义混装、无时间列(#73 #97)、「New Chat」占位当标题(#74)、后端造英文句上屏(#75)、事实徽掉行(#77)、路径显示(#78)、日期三套(#79)、前缀命中零高亮(#72)、预览与列表高亮两个产地(#56)、静态型 total 是切片数(#53)、PromptTarget 死路(#54)、↵ 打不开也收面(#69 #105)、文件行 ↵ 假开(#70)。
- 控件:两态片语义反(#71 #87)、时间片死选项(#88)、头一行高度不齐(#90)、徽材质同键帽(#91)、选中态三叠(#92)、历史箭头位置与形(#94)、页脚五行各说各(#52 #64 #81 #95)、窄档溢出(#96 #59)、compare 硬并排(#60)、文件预览两段 loading(#61)、预览换行闪三段(#55)、预览区无右键(#57)、fallback 露内部串(#58)、块间无边界(#82)、缺渲染器空徽(#83)、日记快捷行冒充(#84)、枢轴「它的消息」必空(#104)、占位文案过期(#51)。
- minor 34 条(附录 A #106–#139):骨架延迟第二产地、预览可达名、预览轨定宽、四种 kind 檐不一、batch 吞原因、reader 读数空字段、文案不成对、命令行无键帽、Tooltip 缺、发线与圆角三套、去抖对「确定的一步」也等、无键帽提示行、⇧点非范围选、↑↓ 每行发预览请求等 —— 全部随同一批改,不留。

## 4. 改动清单(按文件;「加」= 契约只加不改)

**契约 `packages/shared/ipc/search.ts`(全部只加)**
- `groups[].cursor?: string`、`groups[].relaxed?: 0|1|2|3`(每块原地续页与按块放宽提示)。
- `SearchResponse.actions?: SearchActionDescriptor[]`、`groups[].actions?`;`SearchActionDescriptor` 补 `capability` / `kind` / `payload` / `params?`(标题依赖当前词,用 `labelKey + params`)。
- `SearchResponse.error?: string`(整发失败结构化;原话只进日志)。
- `SearchPreviewResponse.reason?: 'no-preview' | 'gone' | 'unreadable' | 'malformed'`;`SearchPreviewRequest.query?: string`(预览与列表同一份命中区间);各预览载荷加 `ranges`。
- `SearchResult.snippet?: { offset: number; truncatedStart: boolean; truncatedEnd: boolean }`;`SearchResult.source?: 'lexical' | 'vector'`(语义徽)。
- `PromptTarget.payload.promptId: string`。

**后端**
- `runtime/src/search/service.ts`:`allResponse` 投影每组 `cursor` / `relaxed` / `actions`;`singleResponse` 在组 error 时回 `{ success:false, error }`;查询响应带 `index`(已有)。
- `capabilities/prompts.ts` / `daily.ts` / `daily-notes.ts`:「新建」改为页级 `actions`,删 `unshift` 与 `limit - 1`;prompts / actions 基座 `static.ts` 改用 `paginate`(真 total,offset 游标);`PromptTarget` 填 `promptId`;实现 `invoke('create-prompt' / 'insert-prompt' / 'create-daily')`。
- `capabilities/sessions.ts`:浏览支经 `paginate` 产位置 cursor;`recentSessions` 输出 facets(sessionId / spaceId / archived / time)并对 filters 用 core 的 facet 判据;`OnethingSearchSessionMeta` 加 `workspaceId`;占位名「New Chat」经 `canApplyGeneratedSessionTitle` 同一判据归一成空。
- `capabilities/messages.ts`:空词 + `sessionId` facet 时按时间倒序列该会话消息(给枢轴「它的消息」与第二个 browse 能力用);`snippetOf` 按「词元等于查询词或以其为前缀」筛 token(前缀命中有高亮)。
- `core/search/pipeline/snippet.ts` + 新 `text/plain.ts`:带源映射的 `toDisplayText(markdown)`(与 `analyzer/normalize.ts` 的 `perCodePoint` 同形),开窗前剥记号;`chooseWindowStart` 命中前置 1/6 窗宽并对齐到空白 / CJK 边界;窗两端按 `truncatedStart/End` 补「…」并平移区间;窗口边缘的半个命中不标。`index/filters.ts` 加 `plainTextFilter` 进缺省列表(排除 → 纯文本 → 脱敏),脱敏占位交壳画「[已隐去]」。
- 各能力 `preview` 收 `query` 用同一条 `snippetOf` 链算 `ranges`;`files` 自述改 `preview: { mode: 'inline' }`(只给路径,零往返);`session-overview` 载荷加 `spaceLabel`。
- `gate:search-index` 加第九步:全部档拿到的组 cursor 回传同词同片的单类请求,第二页不重不漏。

**壳数据层(附录 B §5–§6)**:新 `src/data/search-listing-source.ts`(三元键、`SearchListing{blocks[]}`、fetcher + 回放、`searchLoadMore` mutation → `patch(appendPage)`、三道闸、五口不导出 family);kernel 加 `FetchContext.previous` 与 `useQueryHeld`;`search-catalog-source.ts` 只留自述 / 状态 / 预览三口,fetcher 带回 `response.index`。

**壳(附录 B §1、§7)**:`SearchPanel` 拆成 `SearchBindings / SearchHead / SearchFilterBar / SearchFailedLine / SearchList / SearchBlockRows / items/{row,more,action} / SearchFooter / SearchRowMenu / SearchPreview`;纯模型 `state.ts / sequence.ts / paging.ts / keys.ts / items/registry.ts`;`search/store.ts`(zustand,照 `expose/store.ts` 体例);新 `src/ui/scroll-memory.ts`(查看器同批改消费);`ui/FilterChip` 加分隔与无动作时的 span 形、两态片改两格选项;`expose/components/Highlight` 零 padding + `--st-mark` token;`SearchPreview` 标题一次、无预览零请求、`useDelayedFlag` + `SKELETON_DELAY_MS`、旧内容叠「过期」态、右键同一张菜单、容器查询决定 compare 并排或堆叠、窄档封顶;行:`role=option` `tabIndex=-1`,右列 = 出处 + 定宽相对时间(`useSessionTime`),徽走 r-full 药丸材质 + Tooltip 全名 + `aria-hidden` 缩写,缺渲染器徽退到自述文案;`GroupHead` 退出消费,五个组头 CSS 类删;头一行输入框 `size="md"`,历史两钮成组进输入框左侧 `size="sm"` 带键帽 Tooltip,窄档档位条换行横滚;页脚合成一行读数 `' · '` 串;i18n:占位从自述生成、放宽三句、空态带词与下一步、「归档 · 含 / 不含」、删 `viewAll` / `allShown*` / `previewUnavailable` / `previewMalformed` / `openedFile`,中英成对。

**门**:附录 B §7 十步各自的门 + 本稿 §1 的 R1–R12;`gate-search-messages.mjs` 断言改读 `[data-readout="block-errors"]`、加两态同形、预览标题一次、翻页四条;`gate:a11y` 扫描屏加检索面;`gate:focus` 加「⌘P 开面焦点进输入框」「Tab 序」「IME 组字」三场景;`search-css.test` 加无组头类;`ui:consume` 基线只减不增。

## 5. 迁移次序

照附录 B §7 的十步:①契约与后端只加(含金样快照不变)→ ②kernel `previous` + `useQueryHeld` → ③`scroll-memory` 基础件 → ④新数据层与旧并存 → ⑤纯模型 → ⑥store + 拆件(像素零差)→ ⑦换心(唯一改行为的一步,门里的新断言就是反证)→ ⑧裁定落地(组头 / 零命中 / 动作行 / 右键菜单 / 索引 error)→ ⑨删旧 → ⑩文档。每步一张 opus 派工单、每步门绿才进下一步、每步 haiku 只 add + commit、编排者合入前核 sha;派工单**必须附本稿 §1 规矩与附录 B 对应表**,交卷**必须按三张表逐格自证**。

## 6. 已定的取舍(编排者定;不同意改这一行)

| 项 | 定为 | 理由 |
| --- | --- | --- |
| 徽的材质 | 留文字徽,换成 r-full 药丸 + `--line-1` 描边 + text-4 + Tooltip 全名;徽文案与档位同词(会话 / 消息 / 笔记 / 文件 / 提示词 / 命令) | 用户说徽「已经说明了一切」,留;只换掉与键帽同款的材质 |
| 面板内那枚放大镜 | 留 | 它是输入框的常规提示,不是标题装饰 |
| 焦点归属 | 恒在输入框;行 `tabIndex=-1` | 与命令面板 / 会话树同形 |
| Esc | 菜单 → 清多选 → 清词 → 让位宿主;范围片由 × 与 ⌘[ 撤 | 与会话总览同形 |
| 两态片 | 改「归档 · 含 / 不含」「推理 · 含 / 不含」两格 | 按下态语义反了,改形根治 |
| 时间「自定」 | 删,等日期件 | 设置极简:不摆死选项 |
| 枢轴「它的消息」 | 后端 messages 支持空词 + sessionId 列表 | 否则必空;也是第二个 browse 能力的雏形 |
| 右列 | 出处 + 定宽相对时间;文件 / 命令时间格留空占位 | 与兄弟列表同形 |
| 无标题会话 | 首条用户消息顶上,没有则「未命名会话」;后端把占位名归空 | 「New Chat」不是标题 |
| 无预览 | 行的放大版(标题 + 出处),零请求,零解释句 | 用户说不露内部串;放大版是最安静的形 |
| 块级失败 | 页脚一行「<能力名>没搜成 · 重试」 | 组头退役后唯一诚实的落点 |
| 动作行进不进 ↑↓ | 进,作末项 | 键盘也要能新建 |
| 收回 Dock 时 | `reset()`(保旧) | 今天如此 |
| 取尽读数 | 保留「共 N 条」 | 门在照 |
| 超量 | 不封顶,行 `content-visibility: auto` | 与会话行同法 |
| 索引推送 | 列表格不自动失效,只更新读数 | 有订阅者的 invalidate 会整份替换 |
| 语义徽 | 来自向量路的行右列一枚「语义」小徽(非计数) | 说实话,不装字面命中 |

## 7. 推翻的旧裁定

| 旧 | 出处 | 今天 |
| --- | --- | --- |
| 「全部档分组总览不混排不分页,每组查看全部进单类 tab」(拍点己 a) | `docs/design/search-index-2026-09.md` §7.2 §0 | 不混排照旧;**不画组头、每块原地续页**,「查看全部」进右键菜单「只看这一类」 |
| 「组头带 total 与查看全部」 | 同 §9 | 删 |
| 「预览算不出画原话」 | 同 §4.5 ⑤ | 画字典句,原话进日志 |
| 「Create prompt 是 prompts 能力的候选」 | S2 包装 | 页级动作 |

---

# 附录 A:问题清单(139 条,归并后;severity / 出处 / 应该 / 改法)

- 1. [blocker] ×6 ② 零命中的种类仍占一行(「Sessions 0 in total View all」) —— 应该:零命中的种类在清单上一个像素都不占。 —— 改法:transitions.ts:227 改成零行一律丢(`if (rows.length === 0) continue`),失败组的处理归上一条的拍点;SearchPanel.tsx:784 的「No results」判据随之简化为 `rows.length === 0`。 —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compone
- 2. [blocker] ×5 ⑤ 没有预览的能力(prompts / actions)被画成「Preview couldn't be built · capability prompts has no preview」,而且每停一行白发一次请求 —— 应该:停在 prompt / action 行时预览窗画「Row 放大版」——标题(带高亮)+ 出处两行,没有任何解释句,一发请求都不出门;error 态只留给「自述说有预览、后端却算不出」的那几种(账本里没这条了 / 读不到文件),那时原话可以画。长远做法是让 prompts 自述 `preview: { mode: 'inline' }` 随候选带正文(kin —— 改法:SearchPanel 算一格 `previewable = manifests.find(m => m.id === previewRows[0]?.capability)?.preview !== undefined`,传给 SearchPreview 一个 `none` 布尔;SearchPreview 在 `none` 时 `lazyItems =  —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compon
- 3. [blocker] ×5 ① 全部档仍画组头、「N in total」与「View all」 —— 应该:清单平铺,不同种类的块相邻但不混排,块之间只靠行首徽区分,没有组头、没有总数读数、没有「View all」。 —— 改法:transitions.ts `sectionsOf` 恒 `head: false`(节结构留着给分块 / 各块 Load more 用);SearchPanel.tsx:796-827 删掉 GroupHead 消费,SearchPanel.module.css 的 `.groupBand` / `.groupAll` / `.groupNote` /  —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compone
- 4. [blocker] ×4 ③ 「Create prompt "jira"」是一条正规结果:占配额、计入 total、计入页脚、被当成命中 —— 应该:清单末尾一条分隔线(role=presentation),线下一行「＋ Create prompt "jira"」,ButtonBase 形、Plus 图标、不计入任何条数、不参与「No results」判据(零真命中时仍画「No results」+ 线下这一行),↑↓ 可走到、↵ 真的新建。 —— 改法:契约只加不改:`SearchResponse.actions?: SearchActionDescriptor[]`(页级),`SearchActionDescriptor` 补 `capability` / `kind` / `payload`;后端 prompts.ts 删 unshift 与 `limit - 1`,在 `search()` 返回页上声 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compon
- 5. [blocker] ×3 ⑧ 摘要与预览正文把 markdown 记号原样露出(** 反引号 # 围栏) —— 应该:列表行正文与预览檐标题是**纯文本**摘要(记号剥掉、代码围栏折成一行、链接取文字);预览体里的命中条与上下文条按聊天正文同一套块渲染(段落 / 列表 / 代码块),命中词仍标亮;笔记片段同样走块渲染,半截语法交给解析器兜底(它对不完整输入本来就要容错)。 —— 改法:后端立一只单产地 `plainTextOf(markdown)`(packages/onething-runtime/src/search/text/plain.ts,或放进 core `pipeline/snippet.ts` 前),messages.ts:180 与 daily.ts:183 的 `snippetOf` 喂剥过的文本(ranges 随之相 —— 文件:apps/desktop-react/src/content/viewer/kinds/markdown.tsx, apps/desktop-react/src/search/preview/kinds/message-context.tsx, apps/desktop-react/src/search/preview
- 6. [blocker] ×3 ⑧ 过滤片写成「Space Current」,键与值并排无分隔 —— 应该:09-05 裁定的「键 · 值」形:片名 text-3、间隔符 `·`、值 text-1,例如「Space · Current」/「空间 · 当前」;两态片(With archived / With reasoning)只有一截,不受影响。 —— 改法:改在库件 `ui/FilterChip` 一处(label 与 selected.label 之间画一个 `·` 分隔 span、label 用 `--text-3`),所有消费者一起变;SearchPanel 不动。 —— 文件:apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/ui/FilterChip.module.css, apps/desktop-react
- 7. [blocker] ×2 ⑧ 单行截断之后行末残留一小块高亮底色 —— 应该:截断处只有省略号,没有任何色块;命中段被裁掉就整段不画背景。 —— 改法:先做 Highlight.module.css 去 padding(同上一条),这是最可能的产地;真机用 gate-search.mjs:549-596 那套量法在多档宽度下截图比对确认。若仍残留,改成命中段不用背景而用 `color: var(--accent-deep)` + 600 字重的一档(`Highlight` 加 `variant='inlin —— 文件:apps/desktop-react/src/expose/components/Highlight.module.css, apps/desktop-react/src/expose/components/Highlight.tsx, apps/desktop-react/src/search/components/
- 8. [blocker] ×2 ④ 「所有」档没有原地 Load more:远端被钉死 exhausted,后端丢了每组的 cursor,浏览态也丢 —— 应该:每一块的末尾一条与浏览态同一件的 item:「Load more · 6 of 154」(zh「加载更多 · 6 / 154」),按下去这一块原地长 20 条,别的块不动;这一块取尽 item 消失(不写「all shown」,块上不写总数)。分页机件只有一套:块级 page 表 + 单类查询带 cursor。 —— 改法:契约 packages/shared/ipc/search.ts:95-101 `groups[]` 加 `cursor?: string` 与 `relaxed?: 0|1|2|3`(只加);service.ts:65-71 `SearchServiceGroup` 同形加格,401-407 的 map 加 `cursor: group.page?.cur —— 文件:apps/desktop-react/scripts/gate-search.mjs, apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n
- 9. [blocker] ×2 ⑧a 「Crea te prompt」:后端对引号里的字算区间,却贴在整句显示文本上 —— 应该:③落地后这一行是动作钮,不高亮。若过渡期仍是结果,区间必须对显示文本算(或不给区间,壳本地 indexOf 会标对引号里的词)。 —— 改法:随③删掉这条候选;过渡期改 prompts.ts:93 为 `matchRangesOf(\`Create prompt "${title}"\`, q)`。壳不动。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, packages/onething-runtime/src/search/capabilities/prompts.ts, packages/onething-runtime/src/search/cap
- 10. [blocker] ×1 ① 有词的「所有」档仍然逐组画组头、「N in total」与「View all」,组头是壳按后端 groups 造的,契约本身不需要它 —— 应该:列表是一张平铺清单,不画任何组头、不画「N in total」、不画「View all」;同一能力的行仍然连续相邻,次序仍按后端 groups 的先后(manifest order),种类只由行首徽说。每组的 total 与「后面还有没有」只在该块末尾那一行「Load more · 6 of 48」/「48 in total」里说(见 ④ 那条)。 —— 改法:契约与后端一字不动(groups[].label 留着给每块的 aria-label 用,groups[].total 留给块底读数用)。壳侧:transitions.ts 的 SearchSection 去掉 head 语义(sectionsOf 不再区分 all / 单类的画法,两者都是「若干块,每块若干行」),SearchPanel.tsx 删 796 —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compone
- 11. [blocker] ×1 ② 零命中的能力在「所有」档照样占一行:后端把空页也投成一组,壳又为有 head 的空节保留节头 —— 应该:零命中的种类在清单上一行都不占。后端 groups[] 里带一个 results 为空、total 为 0 的组仍然是诚实数据,可以继续给,壳不画它。塌了的组(error 在场)怎么说要拍:默认合并进列表顶上已有的那行「Search failed」读数(SearchPanel.tsx:775-780),写成「Messages: timeout」,不在块位置留 —— 改法:契约不动。壳侧 transitions.ts:227 的判据改成「rows 为空且 error 缺席就整节不要」,与 head 无关;error 组按上面的拍点默认合并进顶部 .failed 行(需要 sectionsOf 把 groups[].error 汇总成一张 { capability, error }[] 交给面板),或者(备选)在该块位置画一条  —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, packages/core/search/pipeline/fanout.ts, packages/onethi
- 12. [blocker] ×1 ③ 「Create prompt "jira"」是 prompts 能力 unshift 进候选列表的一条正规结果,计数、占配额、有 target、被壳当行画;契约里根本没有「页级动作」这一格 —— 应该:清单末尾一条分隔线,线下一行「＋ Create prompt "jira"」,它不计入任何 total、不进 rows.length、不进 prompts 的配额;按下去真的建一条提示词(走 search.invoke)。是否进 ↑↓ 轮转序列要拍(默认进,作为末位一项,但 aria 上不是 option)。 —— 改法:只加不改做得到。core:candidate.ts 的 SearchPage 加 actions?: ActionDescriptor[](页级,因为标题依赖当前词,manifest 级放不下);契约:SearchResponse 加 actions?: SearchActionDescriptor[]、groups[] 每组加 actions?,Searc —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/data/search-port.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps
- 13. [blocker] ×1 ④ 每块原地 Load more 做不到:groups[] 没有 cursor / relaxed,allResponse 把 page.cursor 丢了,壳把「所有」档钉死为取尽且整表只有一条 more item;扫描型与静态型基座今天根本不产游标 —— 应该:每块末尾一行与浏览态同一件的 SearchMore:「Load more · 6 of 48」(有 total)或「Load more」(无 total),按下只给这一块追加 20 条,取尽后换「48 in total」;不跳档位。 —— 改法:只加不改做得到。契约:groups[] 加 cursor?: string 与 relaxed?: 0 | 1 | 2 | 3;service.ts 的 SearchServiceGroup 同加两格,allResponse 的 map 里加 cursor: group.page?.cursor 与 relaxed: group.page?.relaxed。 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, pa
- 14. [blocker] ×1 ⑤a 预览栏标题画两遍:预览檐画一次 PreviewPayload.title,session-overview 与 note-excerpt 的 Body 又各画一次 payload.title,后端把两格填成同一个字 —— 应该:标题只在预览檐上出现一次(带当前词高亮);Body 从「消息 / 更新于」两格事实起笔;笔记的 Body 从路径起笔。 —— 改法:壳侧删 session-overview.tsx:46 与 note-excerpt.tsx:40 两行即可,与 registry 的规定对齐;后端与契约一字不动(payload.title 留着,composite 那一形的格头靠它)。preview.test.tsx 若钉了 Body 里的标题文本要同步改。 —— 文件:apps/desktop-react/src/search/__tests__/preview.test.tsx, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/kind
- 15. [blocker] ×1 ⑤b 没有预览的能力被壳白发一次 search.preview,后端抛「capability prompts has no preview」,壳把它当错误画成「Preview couldn't be built」加原话;preview 响应没有结构化的 reason,真错误与「本来就没预览」在线上不可区分 —— 应该:提示词 / 命令行选中时零请求,窗里一句「No preview for this kind」/「这一类还没有预览」(或什么都不画,拍点);真算不出时一句人话(如「这条消息已不在会话里」),内部原话只进等宽小字或不画——设计 §4.5 ⑤ 要「原话」而用户 ⑤ 说「不露内部错误串」,这两句要对齐后写进三张状态表,是一格拍点。 —— 改法:壳侧先做:SearchPanel 按 previewRows[0].capability 查 manifest.preview 是否缺席,缺席就给 SearchPreview 传 available:false,SearchPreview 不建 lazy 格直接走 previewNone。契约只加一格:SearchPreviewResponse 加 reas —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/components/SearchP
- 16. [blocker] ×1 ⑧a 「Crea te prompt」:matchRanges 对着引号里的内部变量算,却贴到 Create prompt "…" 这句显示文本上;chats / daily 的标题路同一种错位(区间相对 120 窗、文本是整个标题) —— 应该:高亮区间永远相对屏上那串字;「Create prompt」行随 ③ 变成动作后不再有高亮,这条错位随之消失。 —— 改法:不做 ③ 也要修:prompts.ts:93 对显示串算(matchRangesOf(`Create prompt "${title}"`, q))或干脆不给。indexed.ts 的 snippetOf 加一格 width 参数透传给 buildSnippet 第三参,chats / daily 的标题路传 Number.POSITIVE_INFINITY —— 文件:packages/onething-runtime/src/search/capabilities/daily.ts, packages/onething-runtime/src/search/capabilities/indexed.ts, packages/onething-runtime/src/search/c
- 17. [blocker] ×1 ⑧b 摘要里 markdown 原样露出:投影器存的是原始正文,索引前只过脱敏,摘要窗直接从存储字段切,壳当纯文本画;脱敏占位符 <redacted:token> 也会一起露出 —— 应该:行上摘要是纯文本(** / __ / 反引号 / 行首 # / 围栏标记去掉,链接只留文字),高亮区间相对这串纯文本;<redacted:*> 占位怎么画要拍(建议壳侧换成「•••」)。 —— 改法:契约不动。在 runtime/src/search/index/filters.ts 加一只 plainTextFilter(DocumentFilter,只改 fields 里 content / title 的 markdown 记号,不动 facets),放进 defaultDocumentFilters 的次序「排除 → 纯文本 → 脱敏」;因为倒排 —— 文件:packages/onething-runtime/src/search/__tests__/golden-snapshot.test.ts, packages/onething-runtime/src/search/capabilities/daily.ts, packages/onething-runtime/sr
- 18. [blocker] ×1 ⑧c 截断后残留高亮小块:后端开 120 码元的窗、命中放在窗的三分之一处,行是单行省略,窗比行宽时尾部 <mark> 被省略号切半;Snippet 的 offset / truncatedStart / truncatedEnd 在 snippetOf 里被丢掉,壳无从画前导「…」 —— 应该:行上摘要从第一个命中前约 20 个字起笔,前面一个「…」,命中整段可见,不出现半个 mark;取尽处仍由省略号说。 —— 改法:壳侧先做(不需契约):transitions.ts 加一只纯函数按 matchRanges 重开窗(起点 = 首个区间 start - 20,钳到 0,前置「…」并平移区间),resultRows 用它造 text / highlight。契约只加一格可选 SearchResult.snippet?: { offset: number; truncatedS —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/transitions.ts, packages/core/search/pipeline/snippet.ts, package
- 19. [blocker] ×1 ⑧d 过滤片写成「Space Current」:FilterChip 把片名与选中值两个 span 直接并排,中间没有任何分隔 —— 应该:「Space · Current」/「空间 · 当前」,分隔符是标点不进字典;两态片(With archived)保持只有片名。 —— 改法:库件 FilterChip.tsx 在 value 前加一个分隔 span(内容「·」)或在 FilterChip.module.css 给 .value::before 加 content: '·' 与左右 sp-1;契约与后端不动。gate-search-messages.mjs:933-1008 读片文案的断言若按 includes 判可不改。 —— 文件:apps/desktop-react/src/ui/FilterChip.module.css, apps/desktop-react/src/ui/FilterChip.tsx
- 20. [blocker] ×1 ⑥ 空词浏览态与查询态是同一段 JSX,但数据不同源:浏览态的 chats 路忽略全部过滤片、不带 facets、不给 total,所以片是假的、徽画不出、底部读不出「20 of 483」 —— 应该:浏览态的行与查询态同一种行、同样的片、同样的徽、同一件 Load more:「Load more · 20 of 483」,空间片切「全部」后别的空间的会话出现并带徽,含归档关掉真的少行。 —— 改法:只加不改做得到。providers.ts 的 OnethingSearchSessionMeta 加 workspaceId?: string(backend/wiring/search 装配处从会话表填);recentSessions 输出 facets { sessionId, spaceId, archived, time } 并对收到的 filter —— 文件:apps/desktop-react/scripts/gate-search.mjs, packages/core/search/index/types.ts, packages/onething-runtime/src/search/__tests__/chats-browse.test.ts, packages/o
- 21. [blocker] ×1 ⑤ 预览标题画了两遍(会话与笔记),连同列表行一起同一个名字上屏三次 —— 应该:预览檐是标题的唯一产地:一行 `--fs-body` 600 text-1、带命中高亮;檐下一行弱色注(`--fs-meta` text-3)说这一类的出处 —— 会话是「N 条消息 · 3 天前」,笔记是相对路径,消息是会话名 · 时间;体从第一行事实起笔,不再有标题。compare / batch 的格头由 composite 画一次,格内不画。列表行、 —— 改法:删掉 session-overview.tsx:46 与 note-excerpt.tsx:40 那两行 `<p className={s.title}>`;Preview.module.css 的 `.title` 只剩 composite 格头一个消费者,保留。后端一个字不改(`payload.title` 留给 composite 格头用)。可选的等价 —— 文件:apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/Preview.module.css, apps/desktop-react/src/search/preview/kind
- 22. [blocker] ×1 ⑧ 「Crea te」:高亮区间对着内部变量算,再加上 <mark> 自带 4px 左右内边距把每个命中词撑开 —— 应该:命中只变底色,不改字距:一个词里的命中前缀与其余字母之间零像素间隙,列表与预览同一条规则。「Create prompt」那一行按裁定③根本不再是结果,也不再带高亮。 —— 改法:Highlight.module.css 的 `.mark` 去掉 `padding`(要呼吸感用 `box-shadow: 0 0 0 1px var(--st-sel)`,不占排版);这一改同时作用于会话列表的 SessionRow,属于列明的规范修正。prompts.ts:93 在裁定③落地前先改成对显示串算 `matchRangesOf(`Creat —— 文件:apps/desktop-react/src/expose/components/Highlight.module.css, packages/onething-runtime/src/search/capabilities/prompts.ts
- 23. [blocker] ×1 ④ 「所有」档没有原地 Load more,只能「View all」跳档;后端 groups[] 不带 cursor —— 应该:每一块末尾是同一件 `.more` item(「Load more · 6 of 48」),按下去只给这一块追加下一页、不跳档、不重排别的块;取尽后那一块不再有 more 行;空词浏览态与查询态用的是同一件、同一段文案。 —— 改法:契约 `groups[]` 加 `cursor?: string`(可顺手 `relaxed?`);service.ts `SearchServiceGroup` 同形加格,`allResponse` 的 map 里 `cursor: group.page?.cursor`;壳 `sectionsOf` 把 cursor 搬到 `SearchSection` —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, pa
- 24. [blocker] ×1 ⑥ 空词浏览态与查询态是同一个行组件,但底部形与分块形不同,不是同一种列表 —— 应该:两态都是「分块平铺 + 每块末尾 Load more」的同一张列表:同样的行、同样的徽、同样的右列、同样的 more 件与读数文案;差别只剩有没有高亮。 —— 改法:随①④落地自然合一:`sectionsOf` 不再区分 head,`remote` 逐节算并删掉 groups 恒 exhausted 那一支,浏览态 `browseFanout` 也把每组 cursor 带出来走同一条逐块翻页路。 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts
- 25. [blocker] ×1 ⑤a 预览栏标题画两遍(檐一遍、Body 再一遍;compare 格里三遍) —— 应该:标题只在檐上出现一次(`--fs-body` 600,带命中高亮);Body 从「消息数 / 更新于」两格起笔;笔记预览 Body 从路径行起笔;compare / batch 每格标题只由格头画。 —— 改法:删 session-overview.tsx:46 与 note-excerpt.tsx:40 两行;composite 不用改(格头是唯一产地了)。后端不动。gate-search-messages.mjs:1010-1052 预览断言加一条「data-preview 内 .title 只有一个」。 —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/kinds/not
- 26. [blocker] ×1 ⑥ 空词浏览态与查询态今天是同一段 JSX,但数据形状让它们看起来是两套(平铺 vs 分组;整表翻页 vs 不能翻页) —— 应该:两种态是同一种列表:同样的行、徽、右列、同样的块级「Load more」;浏览态只是「每个声明 browse 的能力一块」,查询态是「每个有命中的能力一块」,区别只在问谁。 —— 改法:随①②④落地后自然合一:删 SearchPanel.tsx:302-308、326-328 对 `browse` 的特判,`CapabilitySearchAnswer.browse`(search-catalog-source.ts:100-110)退役,浏览态与总览都走块级分页表;transitions.ts 的 `sectionsOf` 对单类档也造带 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts
- 27. [blocker] ×1 ⑧c 截断后残留高亮小块:mark 带左右 padding 与圆角,窗口边缘的半个命中也被钳成一两个字的区间 —— 应该:高亮紧贴字形、没有横向 padding,截断时随字一起被切,不多出色块;摘要窗口两端不出现半个命中——要么整个命中在窗内,要么不标。 —— 改法:Highlight.module.css `.mark` 改 `padding: 0; border-radius: 0; box-decoration-break: clone`(会话总览行同源受益);snippet.ts:72-74 把 `filter(range.end > start && range.start < end)` 改成只留 `rang —— 文件:apps/desktop-react/src/expose/components/Highlight.module.css, packages/core/search/pipeline/snippet.ts
- 28. [blocker] ×1 <mark> 带 4px 横向内边距,任何落在词中间的高亮都会把词撑成两截 —— 应该:高亮只换底色不改字距:`padding: 0`,颜色用一枚专属 token(与选中膜、hover 膜都分得开,在 rest / hover / sel / sel-hover 四种行底上都读得出),圆角可留。 —— 改法:tokens.css 加 `--st-mark`(浅暖色或 accent 低透明,亮暗两套),Highlight.module.css 改成 `background: var(--st-mark); padding: 0; border-radius: var(--r-1)`;这是会话列表也会看到的视觉修正,按等价迁移纪律在交付里逐条列明。 —— 文件:apps/desktop-react/src/expose/components/Highlight.module.css, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/styles/to
- 29. [blocker] ×1 「Create prompt」与「Create today's daily note」是动作冒充结果:占名额、计入条数与组 total、还进预览 —— 应该:按裁定③:动作不计入条数、不冒充命中,放在清单末尾一条分隔线之下,前面一个「＋」,文案「＋ Create prompt "jira"」/「＋ 新建提示词 "jira"」,是一颗可按的动作行(结构件走 ButtonBase,不是 role=option 的结果),不进组 total、不进页脚计数、不进预览、不进多选。日记那条同一规则:「＋ 新建今天的日记」。 —— 改法:契约只加不改:`SearchResponse` 与 `groups[]` 各加一格 `actions?: Array<{ id; kind; labelKey; params?; payload }>`(core `SearchPage` 同形加 `actions`,shared/ipc/search.ts 的 `SearchActionDescriptor —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/se
- 30. [blocker] ×1 预览栏标题画两遍(会话概览 / 笔记摘录 / composite 每格) —— 应该:按裁定⑤:标题只在预览檐出现一次;Body 从标题下方直接开始(会话:消息数 / 更新于 / 预览文;笔记:路径 + 摘录);composite 的格头画一次 `item.title`,格内 Body 不再画。檐上的高亮与行的高亮同一份区间。 —— 改法:删 session-overview.tsx:46 与 note-excerpt.tsx:40 那两行(Preview.module.css 的 `.title` 只留给 composite 格头);SearchPreview 在 `payload.title === row.text` 时把 `row.highlight` 递给檐上的 Highlight, —— 文件:apps/desktop-react/src/search/__tests__/preview.test.tsx, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/Prev
- 31. [blocker] ×1 行上的摘要与出处是原始 markdown:`**`、反引号、`#`、围栏、`<redacted:…>` 占位原样上屏 —— 应该:结果行与出处永远是纯文本:加粗 / 斜体 / 行内代码只留字,标题井号、列表符、链接语法去壳留文,围栏代码块留内容不留围栏,换行折成空格,脱敏占位画成「[已隐去]」这类可读字。预览体里的笔记摘录(note-excerpt)与消息上下文保持素文本是设计既定,但会话概览那 100 字预览文也该是纯文本。 —— 改法:在 core `search/pipeline` 加一只带源映射的 `toDisplayText(source): { text, map }`(与 analyzer/normalize.ts 的 `perCodePoint` 同一种「输出每个码元记来自输入第几个码元」的形),`buildSnippet` 在显示文本上开窗、把源坐标的命中区间经该 map 换 —— 文件:packages/core/search/analyzer/normalize.ts, packages/core/search/pipeline/snippet.ts, packages/onething-runtime/src/search/capabilities/daily.ts, packages/oneth
- 32. [blocker] ×1 截断残片:摘要窗切在词中间且不带省略号,行尾省略号还会把高亮块切掉一半 —— 应该:窗口起点向前对齐到最近的空白 / CJK 边界,窗头窗尾按 `truncatedStart / truncatedEnd` 各加一个「…」(作为文本的一部分,区间随之平移);命中的前导上下文短(约 1/6 窗宽,20 个码元上下),让命中在行首附近、任何宽度下都在省略号之前;高亮永远整块可见或整块不见,不出现半个 mark。 —— 改法:snippet.ts:`chooseWindowStart` 把 `size/3` 改成 `size/6`,起点回退到上一个边界(空白或 CJK 边界),终点同法前伸;`snippetOf`(indexed.ts)据 `truncatedStart/End` 加「…」并把 ranges 平移 +1;messages / daily / sessions 三处 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, packages/core/search/pipeline/snippet.ts, packages/onething-runtime/src/search/capabilities/ind
- 33. [blocker] ×1 「N results · all shown」在全部档说谎,每块又没有原地 Load more —— 应该:按裁定④:每一块末尾自己一行「Load more · 6 of 48」(与浏览态那行同一个件、同一套 moreState),块取尽时那行消失,整张列表底部不再有一句总的「all shown」;不能跳档位。 —— 改法:契约只加:`groups[]` 加 `cursor?` 与 `relaxed?`,`SearchServiceGroup` 同形,`allResponse` 的 map 加 `cursor: group.page?.cursor`;壳 `SearchSection` 带 cursor,分页状态从一个 `page` 变成按能力的 `Map<capability —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, pa
- 34. [blocker] ×1 预览栏标题画两遍(檐一遍、Body 再一遍),会话总览把「New Chat」画成两行 —— 应该:标题只在檐上出现一次(.previewTitle,带高亮),Body 从事实行(消息数 / 更新于)或正文开始;batch 每格标题只在格头一次。 —— 改法:删 session-overview.tsx:46 与 note-excerpt.tsx:40 那两行(payload.title 留着给 composite 的格头用);后端不改。file-excerpt.tsx:77 画的是整条路径、檐是 basename,两者不同字可以保留,但更贴切的是把路径作为檐下的弱色注(.previewNote)。 —— 文件:apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/kinds/composite.tsx, apps/desktop-react/src/search/preview/kin
- 35. [blocker] ×1 空词浏览态与有词全部档是同一段 JSX 却长成两套列表:一边平铺 + Load more,一边组头 + View all + 恒「all shown」 —— 应该:两种态是同一种列表:若干块的行 + 每块自己的 Load more;浏览态只是「只有一块」的特例。同样的行、同样的徽、同样的右列出处、同样的尾行件。 —— 改法:第 1、2、4 条落地后再收口:SearchPanel.tsx:293-316 的 remote 改成逐节计算(每节按自己的 cursor / results.length < 配额 / error 判),删 `browse` 与 `groups` 两条特例;:326-328 窗口改成逐节切(每节自己的已取页数),sectionsWindow 不再按扁平下标 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts
- 36. [blocker] ×1 「Crea te prompt」:高亮区间对着内部变量算、贴到显示文本上;mark 自带左右 padding 又把任何词中高亮撑开成两截 —— 应该:高亮永远落在查询词对应的那几个字上,mark 只给字形上色,不改变字距;动作行(第 3 条落地后)根本不带高亮。 —— 改法:prompts.ts:93 改对显示串算 `matchRangesOf(\`Create prompt \"${title}\"\`, q)`(第 3 条落地后这一行整个删掉);Highlight.module.css:5 改 `padding: 0`(保留 border-radius 与 background);sessions.ts:195 对 titl —— 文件:apps/desktop-react/src/expose/components/Highlight.module.css, packages/onething-runtime/src/search/capabilities/prompts.ts, packages/onething-runtime/src/searc
- 37. [blocker] ×1 消息行摘要把 markdown 记号原样上屏,窗口从中间切、没有省略标记,命中常常被单行截断吃掉 —— 应该:行正文是一句素文本:加粗 / 斜体 / 行内代码 / 标题 / 链接只剩字,围栏只剩内容,表格按格连成句,空白折成一个空格;窗口从命中前约 24 个字符起,truncatedStart 时行首一个「…」;命中落在单行可见区内。预览里的 message-context 按设计仍是素文本原文,可以不动。 —— 改法:在 packages/core/search 加一只带 source map 的 markdown 去记号 Normalizer(与 analyzer/normalize.ts:32-50 的 perCodePoint 同一体例,才能让 ranges 映回原文),`snippetOf`(capabilities/indexed.ts:54-63)在开窗前经它 —— 文件:packages/core/search/pipeline/snippet.ts, packages/onething-runtime/src/search/capabilities/daily.ts, packages/onething-runtime/src/search/capabilities/indexed.
- 38. [blocker] ×1 过滤片把键与值直接并排:「Space Current」「Role Any」「Time Any」读成一句英文 —— 应该:「Space · Current」/「空间 · 当前」:键弱色(text-3)、一个居中点分隔(与行尾出处 originText 用的同一个「·」)、值正色(text-1);两态片(With archived / With reasoning)只有名没有值,保持不变;读屏名字是「Space: Current」。 —— 改法:在库件 FilterChip.tsx:107 前插入 `<span className={s.sep} aria-hidden="true">·</span>`,FilterChip.module.css 加 `.sep { flex: none; color: var(--text-3) }`,ButtonBase 加 `aria-label={selec —— 文件:apps/desktop-react/src/ui/FilterChip.module.css, apps/desktop-react/src/ui/FilterChip.tsx
- 39. [blocker] ×1 「所有」档没有每块原地 Load more,只有「View all」跳档;组游标在契约与两处投影里被丢 —— 应该:09-05 裁定:每块原地 Load more,与空词浏览态那行「Load more · 20 of 483」同一个件(SearchPanel.tsx:902-923 那条 .more ButtonBase),点了只把这一块拉长,不跳档;后端 groups[] 每组带自己的 cursor(顺手带 relaxed)。 —— 改法:契约:packages/shared/ipc/search.ts groups[] 加 `cursor?: string` `relaxed?: number`;service.ts:65-71 SearchServiceGroup 同形加格,allResponse map 里加 `cursor: group.page?.cursor, relaxed: g —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, pa
- 40. [blocker] ×1 预览栏标题画两遍(檐一遍、Body 又一遍),两份同样的标题配方 —— 应该:09-05 裁定:预览栏标题只出现一次——由檐画(带高亮),Body 从第一格事实开始。同一副标题配方只有一个产地。 —— 改法:删 session-overview.tsx:46 与 note-excerpt.tsx:40 两行;Preview.module.css 的 .title 只留给 composite 的格头(composite.tsx:73-75),并把它与 SearchPanel.module.css:321-327 的 .previewTitle 合成一条(建议留 P —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/previ
- 41. [blocker] ×1 空词浏览态与查询态是同一个行组件,但三处材质仍分叉(组头 / 页脚形 / 总数读数) —— 应该:09-05 裁定:两态必须是同一种列表——同样的行、徽、右列、块间隔、每块 Load more、同一条底部读数。①②④ 落地后残差只剩读数那条,按「底部读数」那条一起收口。 —— 改法:随 ①②④ 与读数那条一起改;另在 gate-search.mjs 加一条断言:空词与有词两态下 [role=option] 的三列 DOM 形状、data-row="more" 件、[data-readout] 集合形状逐字相同。 —— 文件:apps/desktop-react/scripts/gate-search.mjs, apps/desktop-react/src/search/components/SearchPanel.tsx
- 42. [blocker] ×1 高亮把单词拆开:后端偏移错位是「Crea te」的产地,<mark> 的 4px 横向内边距是所有正确高亮也被拆开的产地 —— 应该:高亮只换底不换字距:mark 与前后字符零间距,单词视觉上连着;「Create prompt "jira"」高亮引号里的 jira 而不是 Crea。 —— 改法:prompts.ts:93 改成对显示串算 `matchRangesOf(`Create prompt "${title}"`, q)`(或这条不给 matchRanges,壳本地 indexOf 会标对);Highlight.module.css .mark 改 `padding: 0; margin: 0 -1px; padding-inline: 1p —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/expose/components/Highlight.module.css, packages/onething-runtime/src/search/capabil
- 43. [blocker] ×1 截断后残留高亮小块;高亮色与选中行底色是同一个 token,键盘位那行的命中看不见 —— 应该:截断处只有省略号,没有色块;高亮在任何行态(hover / 键盘位 / 挑中)上都读得出。 —— 改法:padding 那半随上一条一起消;为高亮立一枚自己的 token(styles/palette.css 与 theme-bridge.css 各一行,例如 `--mark-bg: rgba(var(--accent-rgb), 0.24)`),Highlight.module.css .mark 读它,不再借 --st-sel;.text 可加 `over —— 文件:apps/desktop-react/src/expose/components/Highlight.module.css, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/styles/pa
- 44. [blocker] ×1 Tab 被面板根整个劫持:键盘永远出不了这块面,档位条、过滤片、历史钮、范围片的 × 一个都走不到,行还各占一个 Tab 位 —— 应该:Tab 序应当是:输入框 → 档位条(Segmented 一个位,组内 ←→)→ 历史后退 / 前进两颗钮 → 范围片的 × → 各颗过滤片(每颗一个位,↵ / Space 开它的 listbox 菜单)→ 走出这块面;结果行不进 Tab 序(tabIndex -1),只由输入框接 ↑↓。「Tab = 换档」这一手只在焦点落在输入框时成立,而且要在面板底部的 —— 改法:SearchPanel.tsx 的 onKeyDown 第一句加来源判据:只有 e.target 是那格 input(照 focus/dispatch.ts:88-91 的 isTypingTarget 或直接比 panelRef.current?.querySelector('input'))时才把 Tab 当「换档」,其余来源一律放行(不 prevent —— 文件:apps/desktop-react/src/focus/dispatch.ts, apps/desktop-react/src/focus/scopes.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/s
- 45. [blocker] ×1 面板根的键盘委托不认事件来源:过滤片菜单、行右键菜单、档位段、历史钮上的 ↵ / ↑↓ / Tab 全被当成列表键 —— 范围片与枢轴用键盘触发不了,用键盘挑一个过滤值会开走一条结果并把整块面收掉,而且行的动作菜单根本没有键盘入口 —— 应该:面板的 ↑↓ / ↵ / Tab 只在焦点落在输入框时是列表语法;菜单、片、段、钮各认各的结构键,不被抢。活动行的动作表要有键盘入口:⇧F10 与平台的 ContextMenu 键(以及一条带修饰的面域局部键,例如 ⌘↵,进 SEARCH_KEYS 并配 labelKey 'search.rowActions')在 cursor 行上开出同一张 Menu,锚 —— 改法:SearchPanel.tsx onKeyDown 开头照 ExposeView 加三句:if (e.defaultPrevented) return;若 e.target 不是那格 input 则 return(输入框以外的控件自己接键);再进现有分支。行菜单加键盘入口:onKeyDown 里识别 ⇧F10 / 'ContextMenu' 键,用 list —— 文件:apps/desktop-react/src/expose/components/ExposeView.tsx, apps/desktop-react/src/focus/scopes.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/
- 46. [blocker] ×1 「Load more」不原地:按下去列表先塌成「无结果」,数据回来后 scrollIntoView 把列表拉回顶部;有词的「所有」档根本没有 Load more,每块也没有自己的 cursor(用户裁定 ④) —— 应该:按 Load more 时旧行一行不动、滚动位置一像素不动,那条 item 原地换成「Loading…」再换回下一页,新行接在它上面;键盘按 ↵ 之后 cursor 落到新一页第一行(下标 = 旧行数),鼠标点则什么都不滚。有词的「所有」档里每一块的尾巴是同一件 item(同一个 ButtonBase、同一份 .more 样式、同一句 search.load —— 改法:壳侧三处:① 分页期间保旧行 —— useCapabilitySearch 在请求键还是 initial 时回退到同一主语(asked + query + filters)已落地的最大 limit 那一格的快照,或在面板里用 ref 记「上一份落地的 rows」,none 只在 phase==='ready' 且 rows 为 0 时画;② 滚动 effec —— 文件:apps/desktop-react/scripts/gate-search.mjs, apps/desktop-react/src/data/kernel/query.ts, apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-reac
- 47. [blocker] ×1 「Create prompt "jira"」是一条冒充命中的候选:占名额、计入条数与 total、排在清单里而不是分隔线之下,而且它的高亮区间贴错了文本,画成「Crea te」(用户裁定 ③ 与 ⑧) —— 应该:清单里只有真命中;所有块之后一条 role="separator" 的分隔线,线下一行「＋ Create prompt "jira"」,它是动作(ButtonBase,行内微型动作形,前缀一个「＋」字形,不带 PROMPT 徽,不做高亮),不计入任何读数;它是 ↑↓ 序列的最后一项(data-row="action:create-prompt"),↵ 真的新 —— 改法:后端:prompts.ts 删 66 的 limit - 1 与 78-95 的 unshift,把「新建」改成页级动作 —— core 的 SearchPage 加 actions?: ActionDescriptor[](或 manifest 级),DTO 的 SearchActionDescriptor 补 kind / payload(package —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/targets/prompt.tsx, apps/desktop-react/src/search/transitions.ts, packag
- 48. [blocker] ×1 预览栏标题画两遍;停在 prompt / action 行时白发一次请求并把「capability prompts has no preview」当错误画出来(用户裁定 ⑤) —— 应该:预览窗里同一个标题只在檐上出现一次;自述没有 preview 的能力选中时不发请求,窗里画这一行本来的两段(标题 + 出处,今天 148-166 那形去掉「This shell can't draw」那句),或一句安静的「这一类没有预览」;后端任何 success:false 都不把原话画到屏上,只进 getLogger('search.preview')  —— 改法:删 session-overview.tsx:46 与 note-excerpt.tsx:40 两行;SearchPanel.tsx 算 previewRows 时查 manifests.find(m => m.id === row.capability)?.preview,缺席就不递 items(递一格 mode='none' 给 SearchPrevie —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/components/SearchP
- 49. [blocker] ×1 过滤片写成「Space Current」键值不分;范围片反过来只有值没有键,而且片身是一颗按了什么都不发生的 aria-pressed 按钮(用户裁定 ⑧ + a11y 第三律) —— 应该:片上文案是「键 · 值」:「空间 · 当前」「角色 · 不挑」「时间 · 7 天」,值那一截照旧是唯一弯腰件;范围片是「会话 · <会话名>」「目录 · <目录>」加 ×;范围片的片身不是按钮(它没有动作),只有 × 是控件,读屏念到的是「会话 · xxx,去掉这个范围 按钮」。 —— 改法:FilterChip.tsx 在 label 与 value 之间画一颗 aria-hidden 的分隔「·」(或 .value::before 写 content),两处都在库件里改一次;当既无 options 也无 onToggle 时片身渲染成 span 而不是 ButtonBase,aria-pressed 只在 onToggle 在场时报;cont —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/continuations.ts, apps/desktop-react/src/search/filters.ts, apps/desktop
- 50. [blocker] ×1 消息行的摘要里 markdown 记号(** 与反引号)原样露出,单行截断后命中高亮只剩半截小块(用户裁定 ⑧) —— 应该:行上是素文本:没有 **、反引号、行首 #、链接语法;命中永远在可见区域里 —— 文本太长时以第一个命中区间为中心开窗,前面用「…」补,省略号只在尾部;Tooltip 给全文(截断须配全名,CLAUDE.md:29)。 —— 改法:后端 snippetOf(capabilities/indexed.ts:54-63)在开窗前多接一段带位置映射的「markdown 记号」归一化(与 packages/core/search/analyzer/normalize.ts 那族同形,perCodePoint 映射保住 ranges),使 snippet.text 是素文本且 ranges 一致 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transit
- 51. [major] ×2 输入框占位说能搜「sections」,而章节自 S4b 起搜不到;笔记 / 提示词 / 命令反而没提 —— 应该:占位从自述生成:「Search sessions, prompts, notes, files, messages, commands…」/「搜会话、提示词、笔记、文件、消息、命令…」,自述还没回来时退到「Search…」/「搜索…」;新能力注册占位自动跟上。 —— 改法:SearchPanel.tsx:692 的 placeholder 改成 `t('search.placeholderWith', { kinds: tabs.slice(1).map(tab => labelTextOf(…)).join(t('search.listJoin')) })`,en.ts / zh.ts 加 `search.placehold —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 52. [major] ×1 「所有」档页脚「N results · all shown」说的是窗口不是语料,顶层 total / relaxed 缺席让「N in total」「Relaxed」两行在这一档无处可画 —— 应该:整表页脚删掉;每块一条与浏览态同一件的读数(「Load more · a of b」/「b in total」),放宽提示按块说(每块的 relaxed)或整表一句(拍点,默认按块)。 —— 改法:随 ④ 一起做:groups[] 加 cursor / relaxed;壳删 924-955 的整表页脚与两条独立读数,读数改由每块的 SearchMore 承担;moreState 输入改成块级 { rows, total, cursor, remote }。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, packages/onething-runtime/src/search/service.ts, package
- 53. [major] ×1 静态型的 total 是切片数不是全集数:prompts / actions 组的「6 in total」在匹配超过 6 条时是假话,「Load more · 6 of N」因此无法诚实 —— 应该:prompts 的 total 是命中的提示词总数,能翻页;actions 表只有六条今天不显,但语义要对。 —— 改法:随 ④:static.ts 改用 paginate(items 为全量 scored,total 为真数,offset 游标),prompts.ts / actions.ts 的 run 不再 slice(create 那格随 ③ 变动作后 limit - 1 也没了);契约不动。 —— 文件:packages/core/search/bases/static.ts, packages/onething-runtime/src/search/capabilities/actions.ts, packages/onething-runtime/src/search/capabilities/prompts.ts
- 54. [major] ×1 PromptTarget 名实不符且落点是死路:壳期望 { promptId, actionId? },后端只给 { actionId },插入与新建只能靠前缀猜,点开只会弹「This action can't be run here」 —— 应该:提示词行按下去把正文填进当前会话的输入框;新建走 ③ 的动作。 —— 改法:契约只加:PromptTarget.payload 加 promptId: string(actionId 留作过渡),prompts.ts:118 填两格;壳 targets/prompt.tsx 按 promptId 走宿主「插入到 composer」的落点(或 search.invoke('insert-prompt') 由 prompts 能力实现  —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/targets/prompt.tsx, packages/onething-runtime/src/search/capabilities/pr
- 55. [major] ×1 ↑↓ 换行时预览窗先清成空白、120ms 后换骨架、再换内容,每按一下闪三段 —— 应该:上一条的预览留在窗里直到新载荷到手;等待超过规范延迟才在旧内容上叠一层「过期」态(降透明,token),没有旧内容(首次)才画骨架;新载荷到手当场替换,零空白帧。 —— 改法:SearchPreview 记一格 `lastReadyRef = { key, payload, row }`;`pending && lastReady` 时照旧画 lastReady 的 ready 树并加 `data-preview="stale"`(CSS `opacity: var(--stale-opacity)` 走 token);骨架只在  —— 文件:apps/desktop-react/src/components/useDelayedFlag.ts, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/S
- 56. [major] ×1 预览里的高亮与列表里的高亮是两个产地:预览用本地整串 indexOf,列表用后端区间 —— 应该:预览里亮的段与行上亮的段是同一套命中(同一分析器、同一放宽级),标题与正文都按后端区间画。 —— 改法:契约只加:`SearchPreviewRequest.query?: string`;各能力 `preview` 收到 query 后用同一条 `snippetOf` / `hitRangesFromTokens` 链在全文上算区间,载荷加 `ranges`(`MessageContextPreview.hit.ranges`、`NoteExcerptPre —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/kinds/me
- 57. [major] ×1 预览区右键没有动作表:「打开」「在此会话内搜」只在列表行上有 —— 应该:在预览区任何位置右键,开出与被预览那一行完全同一张 Menu(Open + 这一类自报的续搜),点锚不跟滚;檐上不长按钮(动作单产地)。compare / batch 时右键开 picked[0] 那一行的表或不开(拍点)。 —— 改法:SearchPanel 把一只 `onContextMenu={(e) => { e.preventDefault(); setRowMenu({ row: previewRows[0], x: e.clientX, y: e.clientY }) }}` 交给 SearchPreview 的根 div(单选时才挂);Menu 那一段不变。SearchPre —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/components/SearchPreview.tsx
- 58. [major] ×1 fallback 与 malformed 两态也露内部串(「This shell can't draw this preview yet: composite」「This preview payload has the wrong shape」) —— 应该:缺渲染器与载荷不成形都退到 Row 放大版(标题 + 出处),屏上没有解释句;排障靠 dev warn 与 `data-preview="fallback"` 属性。 —— 改法:删 SearchPreview.tsx:163 那一行;各 Body 校验失败时返回 null 并 `getLogger('search.preview').warn`(檐上的标题仍在,窗不空);composite 单格缺渲染器只画格头;`search.previewUnavailable` / `search.previewMalformed` 两键退役。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/
- 59. [major] ×1 窄档(容器 < 640px)下预览落到列表下方,但两者都没有高度约束,总高一超就溢出到看不见 —— 应该:窄档 = 列表至少占六成高、预览是一条封顶的带(约四成,token),各自滚、都到得了;滚到底不把滚动传给宿主。 —— 改法:SearchPanel.module.css:`.main { grid-template-rows: minmax(0, 1fr) minmax(0, auto) }`,`.preview { max-height: var(--search-preview-narrow-h); overscroll-behavior: contain }`,在 640  —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/search-css.test.ts, apps/desktop-react/src/styles/toke
- 60. [major] ×1 compare 在 320px 的预览轨里硬并排两格,每格只剩约 140px —— 应该:预览轨窄于两格最小宽之和时 compare 上下堆叠(语义仍是并排比较,格头各自在),够宽时才真并排;两种都不需要第二棵树。 —— 改法:`.preview` 声明 `container: searchPreview / inline-size`;Preview.module.css 里 `.side` 缺省一列,`@container searchPreview (min-width: 360px)` 才 `repeat(2, …)`,字面量与 `--search-preview-cell- —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/search-css.test.ts, apps/desktop-react/src/search/prev
- 61. [major] ×1 文件预览两段 loading(骨架 → 「Reading…」)且第一段那趟往返只带回行上已有的路径 —— 应该:选中文件行只有一种等待形(预览窗那一层的延迟骨架),没有往返;读到之后当场画查看器 peek。 —— 改法:files.ts 自述改 `preview: { mode: 'inline' }`,`scanBackedCapability({ …, preview: result => ({ kind: 'file-excerpt', payload: { path: result.filePath ?? '' }, title: result.title }) } —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/
- 62. [major] ×1 加载中被画成零结果:每换一个词、每次开面板,列表先闪「No results」再出结果 —— 应该:换词期间上一份结果留在屏上(律②),直到新答案落地才替换;从来没有过结果时列表空白、不写任何句子;「No results」只在 `answer.data` 在场、零行、无错误时出现。 —— 改法:SearchPanel 用一格 `useRef` 记「上一份有 data 的 answer」,`sectionsOf(answer.data ?? previous.current, …)`,新 data 落地才更新 ref;列表根加 `data-list-state="loading|empty|ready|error"`;空态判据加 `answer.da —— 文件:apps/desktop-react/scripts/gate-search.mjs, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts
- 63. [major] ×1 零结果时同屏出现「No results」与「0 in total」,空态也不说搜的是什么、不给下一步 —— 应该:零命中只有一句:「No results for “jira”」/「没有和「jira」匹配的结果」;若有非缺省的片,第二行弱字说明「in the current space · last 7 days」并给一个行内微型动作「Search all spaces」/「Clear filters」(ButtonBase,`--fs-meta`);不画「0 in to —— 改法:SearchPanel.tsx:944-950 加 `> 0` 守卫(随「页脚合并」一条最终删除);`search.noResults` 改带变量 'No results for “{query}”' / '没有和「{query}」匹配的结果',新增 `search.noResultsFilters` 与 `search.clearFilters`(zh/e —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/se
- 64. [major] ×1 ⑦ 页脚不说实话:「所有」档恒写「N results · all shown」而 N 只是配额切过的行数;单类档「Load more」与「154 in total」两行说一件事 —— 应该:总览档没有全局页脚(每块自己的「Load more · 6 of 154」已经说完);单类档底部只有一行:未取尽「Load more · 20 of 154」,取尽「154 results · all shown」;后端不给 total 时「Load more」/ 取尽后「20 results · all shown」;不再有独立的「N in total」行 —— 改法:transitions.ts `SearchMoreInput` 加 `remoteTotal?: number`(来自 `answer.data.total`),`more` 形的 total 取 `remoteTotal ?? (exhausted ? total : null)`;删 SearchPanel.tsx:944-950 的 total 读数 —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compone
- 65. [major] ×1 索引不可用 / 超时在单类档被吞成「No results」,在总览档只剩组头一个「Failed」;失败原话是英文机器话 —— 应该:一处产地:列表上方那条 `.failed` 带。整发失败:「Search failed」+ 一句原因;某几类失败:「Messages and Notes couldn't be searched — the index isn't running」(zh「消息、笔记没搜成 —— 索引没在跑」);超时:「Files took too long」;别的块照常。原 —— 改法:契约 packages/shared/ipc/search.ts `SearchResponse` 加 `error?: string`(只加);service.ts:385-395 `singleResponse` 在 `group.error` 在时回 `{ success: false, results: [], error }`;壳 fetcher( —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compon
- 66. [major] ×1 「已放宽:按任一词匹配」对三级放宽只说一句,一二级时是假话;语义召回的命中也被说成「按任一词匹配」 —— 应该:三句各说各的:level 1「Relaxed: words no longer need to be adjacent」/「已放宽:不要求词相邻」;level 2「Relaxed: matching most words」/「已放宽:命中大部分词即可」;level 3「Relaxed: matching any word」/「已放宽:按任一词匹配」;语义召回 —— 改法:en.ts / zh.ts 把 `search.relaxed` 拆成 `search.relaxed1/2/3`;SearchPanel.tsx:951-955 按 `answer.data.relaxed` 选键;每条结果是否来自向量路今天契约里没有(`SearchResult` 无来源格),要区分得在 packages/shared/ipc/searc —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, packages/shared/ipc/search.ts
- 67. [major] ×1 语义开关在 React 壳里没有任何入口,面板也不读 vector / vectorPending / vectorExtension,开了也看不出来、装不上也不说 —— 应该:开关归设置页(极简:一格开关 + 一句说明,不进面板);面板底部读数在 `vector !== 'off'` 时多一行:「Semantic recall: downloading model」/「embedding ({vectorPending} left)」/ ready 时不画;开关开着但 `vectorExtension === 'missing'` —— 改法:capabilities.ts `indexReadoutOf` 加 `vector` / `vectorPending` / `vectorExtension` 三格;SearchPanel.tsx:956-969 那组读数加 `data-readout="vector"` 一行,键 `search.vectorDownloading` / `search —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/capabilities.ts, apps/desktop-react/src/search/components/Se
- 68. [major] ×1 「Index catching up (7 left)」是打开面板那一刻的快照,之后永不更新;查询回执里带的 index 读数被壳丢掉 —— 应该:读数跟着最近一次答复走:`pending > 0` 画「Index catching up ({pending} left)」,归零即消失;`stale` 为真而 pending 为 0(启动校对中)时画「Index checking the ledger」/「索引校对中」。 —— 改法:search-catalog-source.ts:207-214 加 `...(response.index === undefined ? {} : { index: response.index })`,`CapabilitySearchAnswer` 加 `index?`;SearchPanel.tsx:956-962 改读 `answer.data? —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compon
- 69. [major] ×1 ↵ 在提示词 / 命令 / 「新建今天」行上:什么都没发生却收掉面板,并弹一条带内部 id 的通知 —— 应该:没落点就不收面:面板留着、那一行原地不动;通知(若还要)一句人话「Prompts can't be inserted from here yet」/「这里还不能插入提示词」,不带 id;真落点是提示词插进当前会话的输入框(composer 已存在)、命令走命令表——接上之后再收面。 —— 改法:targets/registry.ts 的 `activate` 返回 `boolean`(是否真的落了),SearchPanel.tsx:459-472 只在 true 时 `closeToDock`;`runAction` 改为查动作→落点表(insert-prompt → composer 的插入口,create-prompt → ③的 invoke) —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/ta
- 70. [major] ×1 文件行 ↵ 弹「Opened {file}」却没有打开任何东西,而壳里明明有打开文件的口 —— 应该:文件行与笔记行 ↵ = 在查看器里打开(与文件树同一条路),不弹通知;打不开(路径不存在)时一句「Couldn't open {file}」。 —— 改法:SearchPanel.tsx:437-449 改调 `openFileInCurrentTarget(path)`,成功后再收面;删 `search.openedFile` 键;line 有值时留给查看器的 `currentLine`。 —— 文件:apps/desktop-react/src/content/viewer/open-target.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compon
- 71. [major] ×1 「With archived」两态片的亮灭与语义相反:亮着的时候恰恰是不含归档 —— 应该:片名说的就是亮起时的状态:「Hide archived」/「不看归档」,亮 = 排除;缺省灭 = 含归档(S3b 裁定归档可搜且带徽,缺省不变)。 —— 改法:en.ts:384-385 / zh.ts:449-450 改成 'Hide archived' / '不看归档'、'Hide reasoning' / '不看推理';filters.ts 不动(on 的判据本来就是「不是缺省」)。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/filters.ts
- 72. [major] ×1 前缀命中的消息行零高亮、窗口开在消息开头;空数组区间还堵死了壳的本地兜底 —— 应该:命中什么就标什么:前缀命中标出正文里那个完整词(`search`),窗口开在它周围;后端给不出区间时壳才本地兜底,空数组等于没给。 —— 改法:indexed.ts 的 `snippetOf` 改按「词元等于查询词,或(拉丁词元)以查询词为前缀」筛 token —— 与 FTS 那条前缀子句同一判据;或让 sqlite-index 在 `matched` 里记展开后的真词元。壳侧 transitions.ts:121 改成 `matchRanges !== undefined && matchRan —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, packages/onething-runtime/src/search/capabilities/indexe
- 73. [major] ×1 出处列每种类含义不同,且整张表没有时间 —— 应该:右列只说一件事「它在哪 / 何时」:CHAT → 项目名(无项目留空)+ 相对时间;MSG → 所属会话名 + 相对时间;NOTE → 笔记根标签 + 相对时间;文件 → 上级目录(不含文件名);PROMPT → 标签;CMD → 快捷键键帽。首条用户消息、description、正文 teaser 这些「摘要」只进预览窗,不进行。时间列 56px、tabu —— 改法:目标渲染注册表已经按 kind 分模块:给 `SearchTargetRenderer` 加一格 `origin(row): SearchOrigin`(各 kind 自己答,types.ts 里那四支变体终于有产地),`resultRows` 改为携带 `timestamp` 与 `subtitle` 原料而不是预拼字符串;SearchPanel 的 su —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/targets
- 74. [major] ×1 无标题会话画成字面「New Chat」:浏览态一屏 CHAT 行同名,MSG 行出处一列全是它,预览檐也是它 —— 应该:占位名不当标题:CHAT 行正文用首条用户消息(纯文本,text-2 或斜体)顶上,没有消息时画「未命名会话」/「Untitled session」;MSG 行出处对无标题会话画首条用户消息前若干字或只画时间;预览檐同一规则;两种语言各自成句。 —— 改法:后端把占位名当空:sessions.ts:134/201 与 messages.ts:187/224 交 `session.name` 经 `canApplyGeneratedSessionTitle` 同一判据归一成 `''`(previewText 已经在 subtitle 上,契约不动);壳 targets/chat.tsx 与 message.tsx —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/
- 75. [major] ×1 后端造的英文句子直接上屏,双语纪律在检索面失守 —— 应该:行与预览上出现的每一个字要么是数据(会话名、文件名、路径、标签),要么是壳按键查出来的文案;后端不再发明任何给人看的句子。 —— 改法:随「动作契约」与「预览 reason」两条一起收:动作用 `labelKey + params`,失败用 `reason` 码;subtitle 只装数据(description / tags / 会话名 / 目录),`detail` 那格壳不再画;`'Daily note'`、`'Prompt'` 这类种类名本来就由徽说,删掉。补一条边界用例:`capab —— 文件:apps/desktop-react/src/search/transitions.ts, packages/onething-runtime/src/search/capabilities/daily-notes.ts, packages/onething-runtime/src/search/capabilitie
- 76. [major] ×1 过滤片「键 值」不分:「Space Current」「空间 当前」 —— 应该:按裁定⑧:「空间 · 当前」「角色 · 不挑」「时间 · 7 天」,分隔符是标点不是文案,两态片(「含归档」)照旧只有一个词。 —— 改法:在库件里改(今天只有检索面消费它):FilterChip.tsx 在 label 与 value 之间加一个 `aria-hidden` 的 `<span className={s.sep}>·</span>`,CSS 给它 text-3 与 `flex: none`;可访问名仍是 `label` + 选中项,不受影响。 —— 文件:apps/desktop-react/src/ui/FilterChip.module.css, apps/desktop-react/src/ui/FilterChip.tsx
- 77. [major] ×1 事实徽(Archived / Other space)在 subgrid 里没有指定列,会掉到行的第二排、压在徽列下面(由网格规则推断,需截图确认) —— 应该:事实徽与出处在同一格里、同一行:出处在前弯腰,徽在后 `flex: none`,行仍是单行。 —— 改法:SearchPanel.tsx 把出处与两颗事实徽包进一个 `.aside`(`grid-column: 3; display: inline-flex; gap: var(--sp-1); min-width: 0`),`.origin` 保持弯腰,`.tag` 不弯;顺便满足挤压律一「一行恰有一个弯腰件」。交付时附归档行截图作反证。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPanel.tsx
- 78. [major] ×1 路径显示:文件行出处重复文件名并从尾部省略,预览里画整条 /Users/… 绝对路径 —— 应该:行的出处是上级目录(相对扫描根,如「notebook/52 系统」),不含文件名;预览里的路径把家目录折成 `~`,允许折行(`overflow-wrap: anywhere` 已有)或中段省略;笔记行标题命中时出处是笔记根标签,不是文件名。 —— 改法:files.ts:117 改 `path.dirname(relPath)`(根上的文件只画 dirLabel);壳 search/transitions.ts 加纯函数 `displayPath(path)`(`~` 折叠,家目录由壳的 platform 信息给),两个预览 Body 与 `targetText` 都走它;daily.ts:190 标题命中 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/preview/kinds/file-excerpt.tsx, apps/desktop-react/src/search/pre
- 79. [major] ×1 日期格式三套:预览「9/5」不带年、日记行「Today: 2026-09-05」ISO 英文句、文件详情 toLocaleString —— 应该:行与预览的相对时间用同一只 `useSessionTime`,超过一年时带年(zh「2025年9月5日」、en「9/5/2025」);绝对时刻只在预览的事实格里出现,并与文件详情同一套 `toLocaleString`;日记那一条的标题是笔记文件名本身(`formatDailyDate` 的产物,是数据),不是英文句子。 —— 改法:expose/transitions.ts 的 `relativeTime` 加 `{ kind: 'dateYear', year, month, day }`(年份不同才出),session-time.ts 与 i18n 加 `time.dateYear` 成对 —— 会话列表也会跟着变,交付时列为拍点;daily-notes.ts:272 标题改用 ` —— 文件:apps/desktop-react/src/expose/components/session-time.ts, apps/desktop-react/src/expose/transitions.ts, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/sr
- 80. [major] ×1 首页请求在飞时就画「No results」,而且空态不给下一步 —— 应该:数据没回来之前列表留旧行或留白、不画空态;零命中时一句「没有匹配 “{query}” 的结果」加一行下一步(有非缺省片时点名它:「试试切到全部空间」「去掉『用户』角色」「去掉范围片」),两种语言成句。 —— 改法:判据加 `answer.data !== undefined`;空态文案带 `query` 参数,并按 `filtersAreDefault` / 各片状态拼下一步(动作走 ButtonBase 行内微型文字,点了改 filters);先立 `ui/EmptyState`(缺件表里的那一件)再消费。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/fi
- 81. [major] ×1 页脚「N results · all shown」在全部档说谎,在单类档与「N in total」重复,静态能力的 total ≤ limit 且含动作 —— 应该:全部档没有全局页脚(事实都在各块尾行上);单类档整张列表只有一条页脚:还有更多时是那条 Load more item(「Load more · showing a of b」/「Load more」),取尽且 total 已知时一句读数「N results」,取尽而 total 未知时不画;「已放宽」与「索引更新中」仍各占一行。静态能力的 total 是真匹 —— 改法:SearchPanel.tsx:924-950 合并 end 与 total 两段:取 `answer.data.total ?? rows.length` 只画一句 search.totalCount 形的读数,删 search.allShownOne / allShown 两键(或改成「{total} results」一句);全部档(有 groups)不 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/tr
- 82. [major] ×1 块与块之间没有任何边界,行与行之间没有 2px 缝,选中行叠 hover 没有加深档 —— 应该:行与行隔 2px(同 --expose-row-gap);块与块之间多一格 --sp-2 的空并在非首块第一行上方画一条 --line-1 发线,不写字;键盘位行悬停用 --st-sel-hover。这些都在现有骨架里,不换件。 —— 改法:SearchPanel.module.css .body 加 `row-gap: var(--expose-row-gap)`,新增 `.blockStart { margin-top: var(--sp-2); border-top: var(--bw-1) solid var(--line-1) }`,加 `.rowOn:hover { backgrou —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPanel.tsx
- 83. [major] ×1 缺渲染器的行画空徽 —— 组头一退,插件 / 陌生能力的行就没有任何种类标记 —— 应该:缺渲染器时徽退到自述里的能力名(labelKeyOf 翻得出画译文、翻不出画原文,与 tab 条同一条判据),徽永不为空。 —— 改法:SearchPanel.tsx:138-143 的 badgeText 多收 manifests,renderer 缺席时答 `labelTextOf(labelKeyOf(manifests, row.capability) ?? row.capability, t(...))`;gate-search-messages.mjs:1197-1200 改断言 —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/search/capabilities.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 84. [major] ×1 「Create today's daily note」被一两个字母的查询带出来,戴 NOTE 徽、计入 total、选中即报错 —— 应该:它与「Create prompt」同属清单末尾分隔线下的动作行(「+ Create today's daily note」),只在查询是那几个词的整词前缀(长度 ≥ 2)或今天的 ISO 日期前缀时出现,不计数、不戴徽、不进预览。 —— 改法:daily.ts:222-245 把 isCreateShortcut 那条改进第 3 条新加的 page.actions(已存在的「Today: …」仍是笔记行);daily-notes.ts:209 收紧为 `q.length >= 2 && (WORDS.some(w => w.startsWith(q)) || todayIso.startsWith —— 文件:packages/onething-runtime/src/search/capabilities/daily-notes.ts, packages/onething-runtime/src/search/capabilities/daily.ts
- 85. [major] ×1 某一块失败的「Failed」只有组头一个落点,组头退役后无处可说 —— 应该:列表上方同一条 .failed 行承接:「Messages: failed」(能力名从自述翻,多块用「 · 」连),后端原话不上屏(挂 data-block-error / dev 日志);其余块照常;全部塌且零行时只画这一行,不画「No results」(:784 的判据已经如此)。 —— 改法:SearchPanel.tsx 算 `failedBlocks = sections.filter(s => s.error)`,与 answer.error 一起渲染进 775-780 那段 `<p className={s.failed}>`;transitions.ts sectionsWindow 不再为 error 保留空节(交给第 2 条的过滤) —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.test.tsx, apps/desktop-react/src/sear
- 86. [major] ×1 首载与空态合流:请求还没回来就先画「No results」;空态一句灰字没有下一步 —— 应该:answer.data 还没落地时列表区什么都不画(旧行留着、没有旧行就空着);「No results」只在数据回来之后出现,并带一条与当前状态对应的下一步(空间片是「当前」→「Search all spaces」;有范围片 →「Drop the scope」;有角色 / 时间片 →「Clear filters」),下一步是行内 ButtonBase 文字动 —— 改法:SearchPanel.tsx:784 加 `answer.data !== undefined` 守卫;把 .none 换成一个 title + 动作槽的小块(立 src/ui/EmptyState 或先在面板里做成两行),动作按 filters 状态派生,onClick 走既有 setFilters;i18n 加三句成对文案。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/se
- 87. [major] ×1 两态片「With archived」的按下态是反的:按下去反而排除归档 —— 应该:所有片都是「键 · 值」一种形,没有按下语义歧义:「Archived · included / excluded」「归档 · 含 / 不含」,两格选项,与空间 / 角色 / 时间同一副菜单形;accent 描边仍表示「与缺省不同」。 —— 改法:filters.ts 把 archived / reasoning 两颗改成 options 片(ARCHIVED_OPTIONS = include / exclude,值映射到 boolean),SearchPanel.tsx:745-750 的 onToggle 分支删掉;i18n 补 search.filterArchivedIn / Out 与 r —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/compone
- 88. [major] ×1 时间片的「Custom」是死选项:选了片亮起来,却什么都不筛 —— 应该:设置极简:菜单里只有此刻真能生效的档(Any / Today / 7 days / 30 days);要自定区间时再立 Popover 日期件,不先摆一个空档。 —— 改法:filters.ts 删 custom 选项(保留 SearchFilterState 上的 customFrom/To 与 timeRangeOf 的分支,供将来接日期件),i18n 的 search.filterTimeCustom 一并删;若用户要自定区间,列为拍点:FilterChip 多值片增加「选到某格时开一个 Popover」的口子。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/filters.ts
- 89. [major] ×1 顶栏两个放大镜:宿主檐画一枚,输入框前缀再画一枚(架子里连 Dock 瓦算三枚) —— 应该:一块被宿主托着的面,身份由宿主檐 / tab / Dock 瓦说;面板自己的输入框不再重复那枚图标,靠 placeholder 与 aria-label 说「这是搜索」。 —— 改法:SearchPanel.tsx:691 删 prefix,SearchPanel.module.css:28-31 的 .icon 随之删;这是用户可感知的改动,列为拍点,缺省建议删(理由:宿主三处已画,面板内第二枚只在这块面出现)。若用户要留放大镜,那就是接受全部宿主形态下的重复,不动代码。 —— 文件:apps/desktop-react/src/components/StageOverlay.tsx, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/Se
- 90. [major] ×1 头一行两件控件高度不齐:38px 的 lg 输入框旁边是 ≈34px 的分段器;lg 是壳里唯一一处 —— 应该:同一行的两件控件同高:输入框走 md(32px,--btn-md),与分段器的 ≈34 只差库件自己的 2px(那 2px 是 Segmented 行高没钉死,归库件后续把 .seg 行高钉成 --btn-md 减内边距)。 —— 改法:SearchPanel.tsx:690 改 size="md";可选的库件补丁:Segmented.module.css .seg 加 `line-height: calc(var(--btn-md) - var(--sp-1) * 2 - var(--seg-pad-y) * 2)` 让整组恰好 32px。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/ui/Input.tsx, apps/desktop-react/src/ui/Segmented.module.css
- 91. [major] ×1 行首种类徽的材质与键帽(ui/Kbd)逐字相同,且是全大写缩写,与兄弟面板的「这是什么」画法全不同 —— 应该:两种可选终稿,都不动骨架:A(默认保旧、只换材质)徽仍是字,但脱离键帽配方——r-full、--line-1 描边、text-4、mono --fs-nano,与 QuickLook 药丸同一副;字与 tab 同词(徽键直接复用 search.capability.* 的单数或改 zh 徽为「提示词」/ en 徽为 Session / Message / N —— 改法:A:SearchPanel.module.css:141-156 改 r-full / --line-1 / text-4,SearchPanel.tsx:862-864 外包 <Tooltip content={t(labelKeyOf(manifests,row.capability))}>,i18n 徽键改词(zh/en 同批);gate-search —— 文件:apps/desktop-react/scripts/gate-search.mjs, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/Searc
- 92. [major] ×1 选中态三种手段叠加(底色 + 左缘线 + 挑中膜),缺选中行的 hover 档;左缘线是全壳面板列表里唯一的一处 —— 应该:两条正交通道(ui-system.md:65-91):瞬时态(hover / 键盘位)只上薄膜——hover --st-hover、键盘位 --st-sel、两者叠加 --st-sel-hover;持久态(挑中)走画线 register——左缘 2px accent 线,不换底;挑中 + 键盘位 = 线 + --st-sel;无位移原则照旧(线常态占位透明) —— 改法:SearchPanel.module.css:84-87 删 border-left-color,新增 `.rowOn:hover, .more.rowOn:hover { background: var(--st-sel-hover) }`;379-381 .rowPicked 改成 `border-left-color: var(--accent)` 并 —— 文件:apps/desktop-react/src/expose/components/SessionRow.module.css, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/p
- 93. [major] ×1 每一条命中与「加载更多」都是可聚焦的真按钮 Tab 位,与命令面板 / 会话树的「焦点恒在输入框」形不一致 —— 应该:焦点恒在输入框:行与底部 item 都 tabIndex=-1,listbox 带 aria-activedescendant 指向键盘位行(行 id 稳定),与命令面板同一形。 —— 改法:SearchPanel.tsx 行与 more item 加 tabIndex={-1} 与 id(`search-row-${row.id}`),783 的 listbox 加 aria-activedescendant={onMore ? moreId : rowId(cursor)};输入框加 aria-controls 指向 listbox。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/workspace/components/WorkspacePalette.tsx
- 94. [major] ×1 历史后退 / 前进两颗箭头:尺寸是行内挂件档、位置在片条里、不成组、禁用时无提示,读起来像片条的滚动箭头 —— 应该:两颗箭头是一个控件的两半:包在零间距的一组里,size="sm"(22px,檐上档),放在头一行输入框左侧(浏览器后退 / 前进的位置,①落地后头行不再拥挤),Tooltip 带键帽「回上一条查询 ⌘[」(Tooltip content 里放 ui/Kbd);禁灰而不消失照旧。片条的显隐只看片,不看历史。 —— 改法:SearchPanel.tsx 把 712-727 挪进 .head 的 Input 之前,包一层 `<span className={s.nav}>`(SearchPanel.module.css 新增 `.nav { display: inline-flex; flex: none }`),size 改 sm,Tooltip 内容用 `<>{t('sea —— 文件:apps/desktop-react/src/expose/components/QuickLook.tsx, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/component
- 95. [major] ×1 底部读数最多五行各说各的,「所有」档的「all shown」说的是窗口不是语料,「3 results · all shown」下面再跟一句「3 in total」 —— 应该:一条读数行,片段用 ' · ' 串起来,只说成立的事实且不重复:「共 483 条 · 已显示 25 条」「已放宽」「索引更新中(剩 7)」;每块的 Load more(④)各在自己块末;「所有」档不说「all shown」;shown === total 时只说「共 N 条」。 —— 改法:SearchPanel.tsx 把 924-969 合成一个 `<p className={s.end} data-readout="summary">`,片段表由 moreState + answer.data.total + relaxed + indexReadout 算出后 join(' · ');transitions.ts moreState 的 —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/content/viewer/ViewerStatusBar.tsx, apps/desktop-react/src/i18n/en.ts, apps/desktop-
- 96. [major] ×1 头一行在窄宿主下溢出:七格分段器不能缩、不换行,输入框被挤到几十像素 —— 应该:挤压律四:面板在自己声明的最小宽(架子下限 240)下零重叠——窄档分段器另起一行并可横滚(overflow-x: auto,活动段 scrollIntoView 由 Segmented 的 roving 保证),输入框整行;宽档照旧一行。 —— 改法:SearchPanel.module.css 加 `@container searchPanel (max-width: 560px) { .head { flex-wrap: wrap } .head > [role=radiogroup] { flex: 1 1 100%; overflow-x: auto; scrollbar-width: none  —— 文件:apps/desktop-react/scripts/gate-squeeze.mjs, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/search-cs
- 97. [major] ×1 行尾出处列一格混装五种语义、没有时间列;兄弟列表都是「项目 / 产地 + 定宽时间」两格 —— 应该:右列两格:出处(单行省略)+ 定宽 --expose-time-w 相对时间(useSessionTime,与会话行同一只 hook);没有时间的种类(文件 / 命令)时间格留空但占位,所有行的出处从同一条竖线起笔。这是行内容不是骨架,但用户可感知,列为拍点。 —— 改法:transitions.ts resultRows 把 result.timestamp 带进 origin(kind 'projectTime' 或新增 { path, time } 两格),SearchPanel.tsx:874 分成 .origin + .time 两个 span,SearchPanel.module.css .body 网格加第四列  —— 文件:apps/desktop-react/src/expose/components/SessionRow.module.css, apps/desktop-react/src/expose/components/session-time.ts, apps/desktop-react/src/search/componen
- 98. [major] ×1 每敲一个字、每按一次 Tab、面板刚打开,列表都先清成「无结果」再换成结果 —— 文件头写的「重拉期间旧行留着」对换键并不成立 —— 应该:换词、换档、换片期间旧行原样留在屏上,底部读数走 pending 那一形;「无结果」只在一次真正落地的答案确实为零时出现;首次打开在答案落地前是安静的空列表,不写「无结果」。 —— 改法:SearchPanel.tsx 里判「有没有一次真答案」用 answer.phase === 'ready' 而不是 rows.length;用一格 ref 记上一次 phase 为 ready 的 rows,当前键还是 initial 时画那份旧行(键盘位照旧,但 ↵ 落在旧行也是对的,因为屏上就是它);784 的 none 条件加上 answer.pha —— 文件:apps/desktop-react/src/data/kernel/query.ts, apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 99. [major] ×1 中文输入法组字期间的 ↵ / ↑↓ 被面板当成「打开」与「走行」:选字按回车会开走 cursor 那一行并把检索面收掉 —— 应该:组字期间面板一格都不动:候选框里的 ↑↓ / ↵ / Space 全归 IME;组完字之后的那一下才是列表键。 —— 改法:把 ComposerInput 的 isComposingKey 抽成 src/ui/a11y/composition.ts(基础件先行,两处消费),SearchPanel.tsx onKeyDown 第一句 if (isComposingKey(e)) return。 —— 文件:apps/desktop-react/src/composer/components/ComposerInput.tsx, apps/desktop-react/src/focus/dispatch.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 100. [major] ×1 查询历史的「回到刚才那一行」是死路:↑ / ⌘[ / ⌘] 还原出来的 selected 在同一轮渲染里被重置成 0 —— 应该:退回之后 cursor 与滚动位置都落在离开时那一行,预览随之是那一行。 —— 改法:SearchPanel.tsx 加一格 restoreCursorRef:applyEntry 只写它;268-276 的重置块改成 setCursor(restoreCursorRef.current ?? 0) 然后清空;useListSelection 的 clamp 只在读时夹(list-selection.ts:110-112),所以行还没回来时  —— 文件:apps/desktop-react/scripts/gate-search-messages.mjs, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/history.ts
- 101. [major] ×1 Esc 不先清词就把整块面收掉,与会话总览「有词清词、无词让位」割裂;多选与范围片也没有 Esc 这一层 —— 应该:Esc 一层一层退:行菜单 / 片菜单开着先关它(库件已经如此)→ 有多选先清多选 → 有词先清词 → 都没有才让位给宿主收面。要不要在清词之后再来一下 Esc 撤掉范围片,列为拍点(默认不撤,× 与 ⌘[ 负责)。 —— 改法:SearchPanel.tsx 的 FocusScope 加 onEscape:picked.length > 0 → setPicked([]) 返 true;query.trim() 非空 → setQuery('') 返 true;否则返 false。三件声明之一,不写任何 focus 代码。 —— 文件:apps/desktop-react/src/expose/components/ExposeView.tsx, apps/desktop-react/src/focus/dispatch.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 102. [major] ×1 鼠标点行、右键、⇧/⌘ 多选都把 DOM 焦点带离输入框;行菜单关掉后焦点回到那颗行钮而不是输入框,接着打字全丢 —— 应该:这一族列表焦点恒在输入框:点行、右键行、点底部 item 都不改 activeElement;菜单关掉焦点回输入框;行上永远不出现焦点环(键盘位靠 .rowOn 说)。 —— 改法:结果行、底部 item、将来的动作项都加 onMouseDown={(e) => e.preventDefault()}(contextmenu 事件不受影响照样开菜单);返还自然落回输入框,不需要再写任何 focus 代码。 —— 文件:apps/desktop-react/src/composer/components/DrawerPickList.tsx, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/ui/Menu.tsx
- 103. [major] ×1 输入框与结果 listbox 之间零 ARIA 关系:没有 combobox / aria-activedescendant / aria-controls / aria-multiselectable,多选态对读屏不可见,行首徽被念成「M S G」 —— 应该:输入框 role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls=<listId> aria-activedescendant=<活动项 id>;listbox 有 id、aria-multiselectable="true";行有稳定 id,aria-select —— 改法:SearchPanel.tsx:686-694 与 783-839 加上述属性(id 用 useId 派生);badgeText 那颗 .chip 里的 span 加 aria-hidden,再加一个 .visually-hidden 的全名 span(全局类在 styles/global.css),外包 ui/Tooltip;在取数落地(answer.da —— 文件:apps/desktop-react/src/expose/components/SessionTree.tsx, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/ui/a11y/live-region.t
- 104. [major] ×1 枢轴「它的消息」必然落到「无结果」:它清词切到消息档,而消息能力对空词零命中 —— 应该:「它的消息」应当列出这间会话的消息(按时间倒序,可翻页,同一种行),或者在后端做得到之前不把它摆进菜单。 —— 改法:拍点,两选一:(a) 后端 messages 能力在 filters 带 sessionId 且空词时走一条「按 facet 列最近消息」的路(索引基座加一格空词 + facet 的分支,给 total 与 cursor);(b) chat.tsx 暂时删掉这条枢轴。我建议 (a),它也是浏览态第二个 browse 能力的雏形。壳的 UI 一个字不用改。 —— 文件:apps/desktop-react/src/search/targets/chat.tsx, packages/core/search/bases/indexed.ts, packages/core/search/pipeline/fanout.ts, packages/onething-runtime/src/se
- 105. [major] ×1 ↵ 打开一条提示词 / 命令 / 文件 / 日记行时,壳明知打不开仍把检索面收掉,只留一条「This action can't be run here」通知 —— 应该:打得开的才收面;打不开的留在原地,通知照发,cursor 不动。 —— 改法:targets/registry 的 activate 返回 'opened' | 'unavailable'(或 SearchTargetContext 的 openFile / runAction 返回布尔),SearchPanel.activate 只在 'opened' 时 closeToDock。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/targets/action.tsx, apps/desktop-react/src/search/targets/daily.tsx, app
- 106. [minor] ×3 预览骨架延迟自成产地:120ms 常量 + 自写 setTimeout,而规范是 SKELETON_DELAY_MS(150)+ useDelayedFlag —— 应该:预览骨架与 Quick Look 同一个延迟、同一只 hook;§4.5 ④ 改成引用规范常量。 —— 改法:SearchPreview 改 `const skeleton = useDelayedFlag(pending && !lastReady, SKELETON_DELAY_MS)`,删常量;docs/design/search-index-2026-09.md §4.5 ④ 的「120ms」改为「SKELETON_DELAY_MS」并记一句规范修正。 —— 文件:apps/desktop-react/src/components/motion.ts, apps/desktop-react/src/components/useDelayedFlag.ts, apps/desktop-react/src/search/components/SearchPreview.tsx, do
- 107. [minor] ×1 后端在 SearchResult.timestamp 上给了时间,壳的 resultRows 把它丢了,行上没有时间列,浏览态与会话总览的行尾读法不一致 —— 应该:行尾与会话总览同一只 useSessionTime 的相对时间(56px 定宽右对齐),出处那一格留给会话名 / 路径;两种态一致(⑥)。要不要加时间列是一格拍点,数据已经在线上。 —— 改法:契约不动。resultRows 搬 timestamp 进 SearchRow,SearchPanel 行上加一格时间(与 SessionRow 同 token),CSS 网格加第四列。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transit
- 108. [minor] ×1 查询响应上的 index: { pending, stale } 被壳的 fetcher 丢掉,「Index catching up」读数只在面板挂载那一刻读一次 status,之后不再变 —— 应该:「Index catching up (n left)」跟着最近一次查询的 index.pending 走。 —— 改法:契约不动。CapabilitySearchAnswer 加 index 一格并在 fetcher 转发,indexReadoutOf 优先读最近答案的 index.pending,退回 status。 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/capabilities.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 109. [minor] ×1 键盘位停在「Load more」上时,列表没有 aria-selected 的行,预览却还显示上一行 —— 应该:这是一格拍点:要么预览保留上一行(配合「过期」态标一下),要么回到「Pick a result」;两种都要写进状态表。建议保留上一行并加 `data-preview="stale"`,避免翻页前后闪空。 —— 改法:SearchPanel 把 `onMore` 递给 SearchPreview 作 `stale` 输入;状态表补一行。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/components/SearchPreview.tsx
- 110. [minor] ×1 预览窗没有可达名:无 role / aria-label,读屏不知道右边那块是什么 —— 应该:预览区是一个有名字的 region(「Preview」/「预览」);内容随 ↑↓ 变化不逐条播报(live region 纪律「流式不逐条轰」),错误态可 polite 播一次。 —— 改法:根 div 加 `role="region" aria-label={t('search.previewLabel')}`,zh/en 各加一键;error 态用 `announce()` polite 一次。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/ui/a11y
- 111. [minor] ×1 预览轨定宽 320px,面板越宽列表越空、预览越挤,比例不随宿主变 —— 应该:预览轨按面板宽度取比例并夹在上下限之间(例如 40%,最小 320、最大 480),两侧都读得舒服;骨架(左列表右预览)不换,只调轨宽。是否加 `ui/Splitter` 让用户拖是一格拍点。 —— 改法:SearchPanel.module.css 宽档改 `minmax(var(--search-preview-w), var(--search-preview-share))`,tokens.css 加 `--search-preview-share: 40%`;若拍板可拖,消费 `ui/Splitter` 并把宽度存进 layoutPrefs。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/styles/tokens.css, apps/desktop-react/src/ui/Splitter.tsx
- 112. [minor] ×1 四种 kind 的檐与元信息各画各的:消息预览不画时间与出处,会话预览用 dl 两格,笔记 / 文件用一行路径 —— 应该:檐是统一的三件:标题(高亮)/ 弱色注(出处 · 相对时间,走 useSessionTime)/ 种类徽(与行首徽同字,配 Tooltip 全名);体只装这一类特有的内容(消息的前后条、笔记片段、文件 peek、会话的 previewText)。 —— 改法:SearchPreview 檐改 `ui/Card`(title / note),note 由 SearchPanel 按行算(`originText(row.origin)` + 时间,后端 `SearchResult.timestamp` 今天被 `resultRows` 丢掉,transitions.ts:116-125 要多搬一格);message- —— 文件:apps/desktop-react/src/search/components/SearchPreview.tsx, apps/desktop-react/src/search/preview/kinds/message-context.tsx, apps/desktop-react/src/search/previ
- 113. [minor] ×1 batch 汇总把「这一类没有预览」计成「没画出来」,原因被吞 —— 应该:没有预览的行根本不进 batch 请求,汇总写「5 selected · 2 without preview」;真失败的才算「没画出来」。 —— 改法:随「无预览能力读自述」那条一起:SearchPanel 剔掉无 preview 自述的行再建 items,汇总文案加一格 `noPreview`;后端不动。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/pr
- 114. [minor] ×1 未命名会话在中文界面上显示英文「New Chat」(后端兜底与产品默认名都是英文字面量) —— 应该:没有名字的会话在壳里按当前语言显示「新会话」/「New Chat」;搜索后端不替它编名字。 —— 改法:后端四处兜底改成空串(候选 `title` 允许空,壳侧 `resultRows` 空标题时用 `t('expose.newSession')`);产品默认名是否改成语言相关是另一格产品拍点,不在检索面里改。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts, packages/onething-runtime/src/search/capabilities/messag
- 115. [minor] ×1 读者模式读数读的是一格没人填的字段:真到 reader 会画成「Maintained by 」 —— 应该:reader 那一天由后端把 `owner.host` 填上;在那之前 `readerHost` 为空时这一行不画,不留一句半截话。 —— 改法:capabilities.ts:173-174 改成 `status.owner?.host` 缺席就不给 `readerHost`;service.ts:219-230 搬 `owner: status.owner`(SearchIndexStatus 已有这一格)。 —— 文件:apps/desktop-react/src/search/capabilities.ts, packages/onething-runtime/src/search/service.ts
- 116. [minor] ×1 后端把成品英文 / 中文写死在结果与错误里,界面切语言它不切 —— 应该:后端只交数据或键:无标题会话交空标题、壳画 `t('session.untitled')`;动作行交 `labelKey` + args(③);错误交 reason(⑤b);「今天」那一条交 `{ date, exists }` 由壳拼句子。 —— 改法:随③⑤b落地;另加:sessions.ts / messages.ts 的 `|| 'New Chat'` 改成交空串,壳 transitions.ts `resultRows` 在 `text` 为空时用 `t('search.untitledSession')`(zh「未命名会话」/ en「Untitled session」;SearchPanel 传  —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/transitions.ts, packages/onething-runtime/src/search/capabil
- 117. [minor] ×1 中英文案不成对 / 同义不同词:徽「提示」vs 档「提示词」、「所有」vs「全部」、两种失败同一句、「更新于 不知道」 —— 应该:zh 徽「提示词」;两处 All 统一为「全部」;失败句只留一处(随失败带合并);未知时间画「—」;batch「显示 {shown} 条」;loadMoreCount 'Load more · {shown} of {total}'。 —— 改法:逐键改 zh.ts:374、354、477、478 与 en.ts:349;`groupFailed` 随失败带退役。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts
- 118. [minor] ×1 列表空着时预览栏说「Pick a result to preview」,可根本没有东西可挑 —— 应该:列表为空时预览栏空白(不画框、不写字);有行而未选中这件事在这块面上不存在,`previewEmpty` 键可退役。 —— 改法:SearchPanel 传 `hasRows={rows.length > 0}`,SearchPreview 在 `!hasRows` 时 `return null`;删 `search.previewEmpty`。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/co
- 119. [minor] ×1 会话概览预览在后端不知道消息数时写「Messages 0」 —— 应该:不知道就不画那一格(与「更新于」那格「0 = 后端没给」同一条判据),不写 0。 —— 改法:`SessionOverviewPreview.messageCount` 改可选(preview.ts:66-73),sessions.ts:150 缺席就不给;session-overview.tsx 只在 `typeof messageCount === 'number'` 时画那两行 dt/dd。 —— 文件:apps/desktop-react/src/search/preview/kinds/session-overview.tsx, packages/onething-runtime/src/search/capabilities/preview.ts, packages/onething-runtime/src/se
- 120. [minor] ×1 命令行不画快捷键、消息行不画角色 —— 应该:CMD 行右列是键帽(与命令面板同一件 Kbd),MSG 行的出处形如「会话名 · 用户」(角色走 i18n `search.previewRoleUser/Assistant` 两条已有键)。 —— 改法:随「出处由渲染器答」那条一起:`SearchRow` 带 `shortcut`,action.tsx 的 `origin` 答 `{ kind: 'shortcut', keys }`,SearchPanel 对这一支画 `<Kbd>`;message.tsx 的 `origin` 读 `row.facets.role` 拼进会话名后。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/targets/action.tsx, apps/desktop-react/src/search/targets/message.tsx, a
- 121. [minor] ×1 徽是无上下文缩写且没有 Tooltip;截断的正文与出处也没有全名提示 —— 应该:徽 hover / 焦点时 Tooltip 出该能力的全名(`t(manifest.labelKey)`,即「会话」「消息」「提示词」);正文与出处被截断时 Tooltip 出全文;zh 的 prompts 徽用「提示词」与 tab 名一致。 —— 改法:SearchPanel.tsx 把 `.chip` 包进 `<Tooltip content={t(labelKeyOf(manifests, row.capability))}>`,正文与出处按 `scrollWidth > clientWidth` 的判据挂 Tooltip(先立 `ui/TruncatedText` 一件内置这条判据,再在三处消费);z —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/ui/Toolti
- 122. [minor] ×1 预览檐的标题高亮与行的高亮是两个产地,前缀 / 意图前缀查询下会对不上 —— 应该:檐上的标题与行上同一份区间。 —— 改法:SearchPanel 把 `previewRows[0].highlight` 递给 SearchPreview,檐在 `payload.title === row.text` 时用 `ranges`,否则才退回本地词。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/components/SearchPreview.tsx
- 123. [minor] ×1 会话概览预览的「预览文」与笔记摘录同为原始 markdown,且概览预览缺少「项目 / 空间」这一格 —— 应该:概览预览文是纯文本;概览事实格加「项目」「空间」两行(只在有值时画);笔记摘录去掉围栏与行首记号但保留换行。 —— 改法:sessions.ts:155 走同一只纯文本函数;`SessionOverviewPreview` 加 `projectName?` / `spaceId?`(契约只加),session-overview.tsx 两行 `<dt>/<dd>` 只在有值时画,i18n 加两键;note-excerpt 在 Body 里对每行做去记号(不合并行)。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/preview/kinds/note-excerpt.tsx, apps/desktop-react/src/searc
- 124. [minor] ×1 会话 / 笔记行标题超过 120 码元时,高亮区间相对的是摘要窗而显示的是整个标题,区间错位 —— 应该:区间与显示串永远同一段:标题行要么显示窗文本、要么区间按全串算。 —— 改法:这两处 `title` 改用 `snippet.text`(标题超长时行上就是带「…」的窗,与消息行同一形),或对标题不开窗直接 `hitRangesFromTokens`;二选一,配一条 130 字标题的用例。 —— 文件:packages/onething-runtime/src/search/capabilities/daily.ts, packages/onething-runtime/src/search/capabilities/indexed.ts, packages/onething-runtime/src/search/c
- 125. [minor] ×1 输入框占位仍写「Search files, sections, messages, sessions…」,而章节自 S4b 起已经搜不到 —— 应该:占位只说得出真能搜的东西,或只写「Search…」/「搜索…」把种类交给档位条说。 —— 改法:两份字典把 search.placeholder 改成「Search sessions, messages, notes, files…」/「搜会话、消息、笔记、文件…」,或简化为「Search…」;骨架不动。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts
- 126. [minor] ×1 三条左边线不齐、三条横向发丝线叠着:头 12 / 片条 12 / 行 22 / 预览 12 —— 应该:一条左边线:头 / 片条 / 行 / 预览都从 12px 起笔;头与身之间一条发丝线,片条不再单独加线(片是药丸,自己就与行分得开)。 —— 改法:SearchPanel.module.css .body padding 改 `var(--sp-2) 0`,.row / .more / .end / .groupBand 的 border-left 随选中线那条改法删掉(或保留 2px 时把 padding-left 减去 --search-mark);.filters 删 border-bottom; —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css
- 127. [minor] ×1 相邻两行三种圆角:分段器 r-1 槽、过滤片 r-full 药丸、行首徽与事实徽 r-1;FilterChip 的注释与实现两说 —— 应该:小胶囊一种圆角:徽与事实徽走 r-full,与片条、Quick Look 药丸一个词汇;分段器是库件既定形,不动。FilterChip 文件头改成真话。 —— 改法:SearchPanel.module.css .chip / .tag border-radius 改 var(--r-full)(随「徽材质」那条 A 方案一起);FilterChip.module.css:8-9 注释改为「高度 --filter-chip-h,圆角 r-full」。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/ui/FilterChip.module.css
- 128. [minor] ×1 同一行里两颗描边小牌两种配方:种类徽 mono/nano/16px,事实徽 非 mono/micro/不定高 —— 应该:事实徽与「这是什么」的种类徽读起来是两种东西:事实徽走会话行项目小牌的配方(填 --st-hover、r-1、fs-nano、text-2、无描边),种类徽保持描边。 —— 改法:SearchPanel.module.css .tag 改成 SessionRow.module.css:180-199 那副;长远进缺件表的 Chip 件(ui-consolidation-2026-09.md:16 第 6 件)。 —— 文件:apps/desktop-react/src/expose/components/SessionRow.module.css, apps/desktop-react/src/search/components/SearchPanel.module.css
- 129. [minor] ×1 placeholder 列的种类是过期的:「files, sections, messages, sessions」里没有 sections 这个能力,也漏了笔记 / 提示词 / 命令 —— 应该:placeholder 不枚举种类(种类由档位条枚举,壳里也不该再写一份能力清单):「Search…」/「搜索…」,或按当前档拼「Search {tabLabel}…」。 —— 改法:i18n search.placeholder 改成不带清单的一句(zh/en 同批);若要带档名,SearchPanel.tsx:692 传 t('search.placeholderIn', { scope: 当前 tab 译文 })。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/components/SearchPanel.tsx
- 130. [minor] ×1 同一块面上「全部」有两个词、失败有三句不同的话、徽与档名不同词 —— 应该:一个概念一个词:「全部」;失败只留一句「没搜成」/「Search failed」(组头退役后 groupFailed 不再需要);徽词 = 档名。 —— 改法:zh.ts:354 改「全部」;删 search.groupFailed(随 ①);徽键随「徽材质」那条改词。 —— 文件:apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts
- 131. [minor] ×1 被截断的正文 / 出处 / 徽没有 Tooltip 全名 —— 应该:徽包 Tooltip 全名(随徽那条);出处包 Tooltip 全文;正文截断的全文由预览窗承担,可不包。 —— 改法:SearchPanel.tsx:874 `<Tooltip content={originText(row.origin)}><span className={s.origin}>…</span></Tooltip>`;长远立 TruncatedText 件(缺件表第 7 件)统一「溢出才出提示」。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/ui/Tooltip.tsx
- 132. [minor] ×1 首载 / 去抖期间就画「No results」,空态与加载态不分 —— 应该:pending 且没有行 → 什么都不画(150ms 后可画三条骨架线,useDelayedFlag + SKELETON_DELAY_MS);真的零行才「No results」。 —— 改法:SearchPanel.tsx:784 判据加 `remote !== 'pending'`;骨架走 components/useDelayedFlag,样式抄 QuickLook.module.css:232-240 的 .line。 —— 文件:apps/desktop-react/src/components/useDelayedFlag.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/transitions.ts
- 133. [minor] ×1 预览骨架:自定 120ms 与自写 setTimeout,形是一块 72px 色板;Quick Look 是 150ms + useDelayedFlag + 三条线 —— 应该:同一个「多久算久」(SKELETON_DELAY_MS)与同一种骨架形(三条线)。 —— 改法:SearchPreview.tsx 改 `const skeleton = useDelayedFlag(pending, SKELETON_DELAY_MS)`,删 54 与 101-108;.previewSkeleton 改成三条 .line;tokens.css:988 与设计文档 §4.5 ④ 的「120ms」改写。 —— 文件:apps/desktop-react/src/components/motion.ts, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/components/SearchPre
- 134. [minor] ×1 整发失败那一行的形与总览的错误行不同:带发丝下线 + 等宽原话 vs 图标 + 一句话 —— 应该:同一副错误行:AlertCircle 图标 + 一句人话,不画边线;后端原话进日志,屏上只在 Tooltip 里给。 —— 改法:SearchPanel.tsx:775-780 改成 Overview 的形(图标 + 文案),.failedDetail 改为 Tooltip content;删 .failed 的 border-bottom。 —— 文件:apps/desktop-react/src/expose/components/Overview.module.css, apps/desktop-react/src/search/components/SearchPanel.module.css, apps/desktop-react/src/search/com
- 135. [minor] ×1 Tab 换档、按片、按范围片这些「确定的一步」也要等 220ms 去抖,只有翻页当场发 —— 应该:只有输入框文本变化才去抖;档、片、范围片、历史退回一变就发。 —— 改法:副作用里记一格 lastQuery ref,query 没变(只是 asked / wire 变了)就 run() 不等窗口。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx
- 136. [minor] ×1 整发失败时「没搜成」与「无结果」同屏,自己文件头说的「失败与空结果是两件事」没做到 —— 应该:失败时列表区安静(或留旧行),只有顶部那行红字。 —— 改法:784 的条件加 answer.error === undefined。 —— 文件:apps/desktop-react/src/search/components/SearchPanel.tsx
- 137. [minor] ×1 键盘位行被 hover 时没有 --st-sel-hover 叠态;列表容器没有 overscroll-behavior: contain,滚到底把滚动传给宿主 —— 应该:与兄弟面板同一套配方:hover --st-hover、键盘位 --st-sel、叠加 --st-sel-hover;滚动容器 contain。 —— 改法:.rowOn:hover { background: var(--st-sel-hover) } 与 .body { overscroll-behavior: contain } 两行;长远归 ui-consolidation 缺件表里的 ListRow / ScrollArea。 —— 文件:apps/desktop-react/src/expose/components/SessionRow.module.css, apps/desktop-react/src/search/components/SearchPanel.module.css
- 138. [minor] ×1 没有键帽提示行:Tab 换档、⌘[ ⌘] 历史、↑ 回上一条都不可发现;占位符说「章节」可搜是假话;历史两条文案不对称 —— 应该:列表底部(或输入框右侧)一行 Kbd 提示:「↑↓ 选择 · ↵ 打开 · Tab 换档 · ⌘[ ⌘] 历史 · esc 清词」,键面走 shortcut.* 字典;占位符只列真能搜的种类或写「搜索…」;历史两句成对为「回上一条查询 / 回下一条查询」。 —— 改法:SearchPanel.tsx 底部加一格 footer 消费 ui/Kbd(照 QuickLook.tsx:236-247 的形),文案键 zh/en 成对新增;改 search.placeholder 与 zh search.historyForward。 —— 文件:apps/desktop-react/src/expose/components/QuickLook.tsx, apps/desktop-react/src/i18n/en.ts, apps/desktop-react/src/i18n/zh.ts, apps/desktop-react/src/search/comp
- 139. [minor] ×1 ⇧点是单条切换而不是范围选;↑↓ 每走一行就对 lazy 类发一次预览请求 —— 应该:⇧点 = 从键盘位到点击行的连续范围,⌘点 = 单条切换;预览请求在走行停顿之后再发(一帧或几十毫秒的延迟),中途经过的行不发。 —— 改法:onRowClick 按修饰分两支(⇧ 用 cursor 到 index 的区间填 picked);previewItems 经 useDeferredValue 或一只短去抖再交给 SearchPreview,骨架延迟那格顺带改吃 SKELETON_DELAY_MS + useDelayedFlag。 —— 文件:apps/desktop-react/src/data/search-catalog-source.ts, apps/desktop-react/src/search/components/SearchPanel.tsx, apps/desktop-react/src/search/components/SearchP

# 附录 B:组件设计与三张状态表(合成稿)


# 检索面组件设计(合成稿)——以「数据流优先」为底,嫁接两路评审点名的接点

> 落点:`apps/desktop-react/src/search/**` + `src/data/search-listing-source.ts`(新)+ `src/data/kernel/{query,react}.ts` 两格小改 + `src/ui/scroll-memory.ts`(新)。设计正本 `docs/design/search-index-2026-09.md` §9 的「三张状态表随 S4 交卷」由本稿第 2/3/4 节兑现。

## 0. 三句话定骨架

1. **一把键 = 一张列表的主语**:`[ask, query.trim(), filters]` 三元组,`limit` / 页码 / cursor 一律不进键。今天 `src/data/search-catalog-source.ts:121-128` 的四元键把 `limit` 编进去,`SearchPanel.tsx:278-280` 又用 `pageWindow(page)` 造 `limit`,于是「页码 +1 = 换键 = 新格 `data===undefined` = 列表清空 = 容器高度归零」;kernel 律②(`src/data/kernel/index.ts:19-20`、`laws.test.ts:29-54`)只对同一把键成立,翻页换键就把自己踢出了律②的定义域。翻页改成**对同一格 `patch` 追加**(`query.ts:265-287`),律②于是对翻页是**结构性质**,不是组件自律。
2. **每个主语只有一个产地**:三层各持一种事实——kernel 格持行集 / 每块 cursor / 忙态;`src/search/store.ts`(zustand,与 `src/expose/store.ts:158` 同体例)持词 / 档 / 片 / 历史 / 活动项 / 多选 / 滚动记忆;组件只持组件寿命的瞬态(右键菜单锚点,照 `src/expose/components/SessionTree.tsx:92`)。`SearchPanel.tsx:154-175` 那八格 `useState` 全部退役。
3. **序列项是开放注册表,不是闭合联合**:行 / 块尾 Load more / 动作行三种键盘序列项各是一个模块 `src/search/items/<kind>.tsx` + 一行注册,`sequence.ts` 只负责拼接,⏎ 只调 `item.activate()`——仓根 CLAUDE.md 09-02「凡按能力枚举的地方改成能力自述、别人读表」在组件尺度上的落地,也是两路评审都点名的那一处 switch。

---

## 1. 组件树与职责

```
SearchPanel                         骨架(≤120 行,零业务状态)
├─ SearchBindings                   渲染 null 的叶:去抖取数 / placed 上升沿 activate / 卸载时若形态已回 dock 则 reset
├─ SearchHead                       ui/Input + ui/Segmented
├─ SearchFilterBar                  ui/IconButton ×2(历史)+ ui/FilterChip
├─ SearchFailedLine                 整发塌了那一行(列表上方,滚动容器外)
├─ .main
│  ├─ SearchList                    滚动容器 + useScrollMemory;里面两个兄弟:
│  │  ├─ [role=listbox]             SearchBlockRows ×块 → items 注册表画每一项
│  │  │   ├─ SearchRow ×n           kind 'row'
│  │  │   ├─ SearchMoreItem ×块      kind 'more'
│  │  │   └─ SearchActionRows       kind 'action'(role=separator 之后)
│  │  └─ SearchFooter               [data-readout] 读数,listbox 的**兄弟**不是孩子
│  └─ SearchPreview                 既有,改两处
└─ SearchRowMenu                    ui/Menu(点锚不跟滚)
```

| 组件 / 模块 | 目录 | 拥有的状态 | 只消费什么 | 对外暴露 | 依据 |
| --- | --- | --- | --- | --- | --- |
| `SearchPanel` | `src/search/components/SearchPanel.tsx` | `panelRef` 一个 ref,**零业务状态** | `FocusScope`(`scope="search"`、`restingTarget`=输入框、`keyHandlers` 来自 `useSearchKeys`、**不声明 `onEscape`**、**不用 `activateOnMount`**);`useSearchKeys` 交出的 `onKeyDown` 挂作用域根(事件委托,今天 `SearchPanel.tsx:680-684` 的判词保留) | 默认导出给 `src/content/index.tsx:44` 那张表 | 三件声明(`CLAUDE.md` 验收轴 2);`focus/scopes.ts:128` 的 `search` 是 `region`,`keys` 正本在 `:78-91` |
| `SearchBindings` | `src/search/components/SearchBindings.tsx` | 无(三条副作用) | `useStageStore` 的 `formOf(st,'search')`、`useFocusScope().activate`、`usePanelVisibility().visible`、store 的 `subjectKey / committedKey` | 无 | ①`placed` 由假翻真且 `live` → `activate('placement')`,**逐字照** `src/expose/components/Overview.tsx:39-70` 的 `AutoFocusSearch`(指针点 Dock 瓦开出也送焦点——今天 `activateOnMount` 无条件送,行为不变;`focus-follow.ts:25` 那句「指针留瓦上」说的是 focus-follow 自己不跟,把这一格留给面板);②去抖取数(见 §5);③**卸载时**现问一次形态,是 `dock` 才 `store.reset()`(默认保旧,拍点 G)。**落地改口**:原写「`placed` 由真翻假」,而那条下降沿在组件里**等不到** —— 面与形态同生共死,收回 Dock 那一刻它当场从树上摘掉,下一次渲染不会发生(⑦ 真机门抓到:`gate:search` 第 5 步进会话再开面板还是上一个词)。换宿主也是卸载,所以判据只能是「此刻它还在不在某棵树里」 |
| `SearchHead` | `src/search/components/SearchHead.tsx` | 无 | `ui/Input`(`data-search-input`)、`ui/Segmented`(`options = tabsOf(manifests)`,`capabilities.ts:54-60`);store 的 `query / scope` | 无 | `Segmented` 是封闭集合走数据表(`CLAUDE.md` 库件 API 两种风格);点段后焦点留在段上,**不**调 `activate()`(`FocusScope.tsx:96`「指针操作不要调」;两路评审都点名) |
| `SearchFilterBar` | `src/search/components/SearchFilterBar.tsx` | 无 | `ui/IconButton`(⌘[ ⌘] 两钮,`disabled={!canGoBack}` 禁灰不消失,今天 `SearchPanel.tsx:710-726`)、`ui/FilterChip`(范围片 `onRemove`、两态 `onToggle`、多值 `options/onSelect`);store 的 `filters / history` | 无 | 今天 `SearchPanel.tsx:700-770` 搬出 |
| `SearchFailedLine` | `src/search/components/SearchFailedLine.tsx` | 无 | `held.error` | `data-readout="failed"` | 今天 `SearchPanel.tsx:775-780`;**保留后端原话并陈**(用户裁定只说预览栏不露原话;列表这一行是既有行为,改它是拍点 A′) |
| `SearchList` | `src/search/components/SearchList.tsx` | `listRef`(**落地改口**:右键菜单锚点 `rowMenu` 留在 `SearchPanel` 那一格 `useState` 里 —— 开菜单要 `rowModelOf` / `available` / `runContinuation` 三样,它们都在面板手上;搬进列表等于把三条口再穿一遍) | `useSearchListing()`、store 的 `selection / picked`、`useScrollMemory(listRef, held.shownKey, {read, write})`、items 注册表 | 滚动容器 `data-testid="search-list"`;里面 `role="listbox"` 与 `SearchFooter` 是兄弟 | listbox 只装 option/separator(APG;今天 `SearchPanel.tsx:783-970` 把 `<p>` 读数塞在 listbox 里是既有 a11y 债,顺手修) |
| `SearchBlockRows` | `src/search/components/SearchBlockRows.tsx` | 无 | 一块的 `rows` + 该块的 `more` 项;**不画组头**;`rows.length===0 && error===undefined` 的块整块不渲染 | 无 | 用户裁定「全部档不画组头、零命中不占行」 |
| `SearchRow`(memo) | `src/search/items/row.tsx` | 无 | `ui/ButtonBase`(结构件③)、`expose/components/Highlight`、`resolveTargetRenderer(kind).badge`(`targets/registry.ts:56`) | `role="option"` `data-row=<index>` `data-item-id=<id>` `data-target-kind` `data-capability` `data-tag` | `gate-search-messages.mjs:345` 按 `data-row` 取件,`:435` 按 `data-row="<at>"` 点行——保留下标属性(只是属性,不影响 key = id) |
| `SearchMoreItem` | `src/search/items/more.tsx` | 无 | `ui/ButtonBase`;`moreStateOf(block, pending, inflight)`(`paging.ts`);`useAsyncPending(searchLoadMore, \`${key}#${cap}\`)`(`kernel/react.ts:37-42`) | `role="option"` `data-row="more"` `data-block=<cap>` `data-more-state` `aria-busy` | 加载中**不 `disabled`**(`gate-a11y.mjs:534/560/568` 会把 disabled 项剔出可达集;今天 `SearchPanel.tsx:334` 「加载中也留在轮转序列里」的判例保留);文字反馈,**无 Spinner**(它是 item,不是按钮) |
| `SearchActionRows` | `src/search/items/action.tsx` | 无 | `ui/ButtonBase`;`role="separator"` 一条 + 每条动作行 `role="option"` | `data-row="action"` `data-item-id` | 用户裁定「Create prompt 是动作:分隔线下、不计数」;它在 listbox 里才能承接 `aria-selected` 与 ↓ 到末位(评审「`ui/Button` 进不了 listbox 语义」) |
| `SearchFooter` | `src/search/components/SearchFooter.tsx` | 无 | `held.data.total / relaxed`、`indexReadoutOf(status)`、`blocks.filter(error)`、块级失败的「重试」微型文字动作(`ButtonBase`,①/③ 边界判例) | `[data-readout=total|relaxed|index-pending|index-reader|block-errors|end]` | 今天 `SearchPanel.tsx:924-969` 搬出;`gate-search-messages.mjs:348-350` 契约不变 |
| `SearchRowMenu` | `src/search/components/SearchRowMenu.tsx` | 无(锚点由 `SearchList` 递) | `ui/Menu` / `MenuItem`:「打开」+ 渲染器 `continuations` + 「只看这一类」(`setScope(row.capability)`,不含字面量) | 无 | 动作单产地 = 右键菜单;`menu` 是 `modal` 档(`scopes.ts:175`);「查看全部」从组头搬到这里 |
| `SearchPreview` | `src/search/components/SearchPreview.tsx`(既有) | 无(骨架延时改走 `components/useDelayedFlag` + `motion.ts:33` `SKELETON_DELAY_MS`,删 `PREVIEW_SKELETON_DELAY_MS`) | `useSearchPreview`、`resolvePreviewRenderer` | 既有 props | 标题只在檐画一次(`SearchPreview.tsx:168-178` 已画;删 `preview/kinds/session-overview.tsx:46`、`note-excerpt.tsx:40` 里的第二次;`composite.tsx:73-74` 是格子头,合规);error 只画字典句,原话进 `getLogger('search.preview')` + `data-preview-error` |
| `useSearchListing` | `src/search/hooks/useSearchListing.ts` | 无 | `useQueryHeld(searchListingQuery.get(committedKey))`、`sequenceOf`、`blocksOf`;**唯一允许依赖序列的 effect**:`useLayoutEffect([sequence]) → store.reconcile(sequence)`(只落 activeId,不滚动) | `{ held, blocks, sequence, byId }` | 评审「`activeAfterGrowth` 的调用方没有归属」 |
| `useSearchKeys` | `src/search/hooks/useSearchKeys.ts` | 无 | `useListSelection`(`count = sequence.length`,`active = indexOf(sequence, selection.id)`,`onActiveChange = i => store.setActive(sequence[i].id,'keyboard')`,`loop:false`,`homeEnd:false`,`scrollBlock:null`);`search/keys.ts` 的意图表;items 注册表的 `activate` | `onKeyDown` + 身份稳定的 `keyHandlers`(`useMemo([])` + ref,今天 `SearchPanel.tsx:582-587` 手法) | 走位算术**只有** `selection.handleKey` 一处(`CLAUDE.md:32` 唯一原语);`kbd-select-handwritten`(`ui-consume-check.mjs:131-150`)按文件判 import,`keys.ts` 与 `useSearchKeys.ts` 都 import `a11y/list-selection` |

### 纯模型(不认识 React,各有单测)

| 文件 | 职责 |
| --- | --- |
| `src/search/state.ts` | store 的纯 reducer:`setQuery / setScope / setFilters / commitKey / resetForListing(key) / pushCommit / stepHistory / runContinuation / setActive(id, by) / pick / clearPicks / reconcile(sequence) / reset`。体例照 `src/expose/transitions.ts`(store 每个 action 一句 `set(T.f)`,`expose/store.ts:136-138`) |
| `src/search/sequence.ts` | `SearchListing → SearchItem[]`:逐块 `rows → more(仅 moreState 是 item 时)` → 下一块 → 动作项。**一次 flatten**,照 `src/expose/list-model.ts:6-13`「`rowIds` 与 `sections` 同一次产出」。项形 `{ id, kind, block?, rowId? }`,不认前缀 |
| `src/search/items/registry.ts` | `SearchItemKind = { kind, Render, activate(item, ctx), survivesGrowth(item, next) }` 注册表;`row` / `more` / `action` 三个模块各一行 `registerItemKind`。`reconcile` 与 ⏎ 只读表 |
| `src/search/paging.ts` | `moreStateOf(block, pending, inflight)`;`appendPage(prev, cap, fromCursor, page)`(按 cursor 幂等 + 按 id 去重 + 零新增即取尽);`markPageError` |
| `src/search/keys.ts` | `searchIntentOf(key)`:键名 → 意图(`tab-next / tab-prev / enter / space / history-recall-or-up / move`),照 `src/expose/keys.ts:1-15` 键名字面量单产地;方向键意图交回 `selection.handleKey` |
| `src/search/transitions.ts` | 保留 `resultRows / itemRefOf / originText / targetText / splitHighlight`;**删** `sectionsOf`(:184-205)/ `flatRows`(:208)/ `sectionsWindow`(:220-231)/ `pageWindow`(:258-266)/ `remoteSide`(:278-306)/ `moreState`(:364-375)及 :233-255 那段「递增 limit 重查」的注释 |

### 既有件消费 / 新建

| 件 | 结论 | 理由 |
| --- | --- | --- |
| `ui/Input` `ui/Segmented` `ui/FilterChip` `ui/IconButton` `ui/ButtonBase` `ui/Menu` `ui/a11y/list-selection` `ui/a11y/live-region`(翻页落地 `announce`) `components/useDelayedFlag` | 直接消费 | 都在库里 |
| `ui/GroupHead` | 退出消费 | 用户裁定无组头;`SearchPanel.tsx:796-827` 与 `.groupBand/.groupNote/.groupTotal/.groupFailed/.groupAll`(`SearchPanel.module.css:221-245, 355-370`)删 |
| `ui/Spinner` `ui/Reveal` `ui/Tabs` `ui/Button`(列表内) | 不消费 | Spinner 只许按钮内 / 状态栏;增长不许有进场动效;档位是封闭集合走 Segmented;列表内动作走 ButtonBase option |
| **新建 `src/ui/scroll-memory.ts`** | `useScrollMemory(ref, key, { read, write })`:`useLayoutEffect` 挂载还原、滚动节流写回、`useLayoutEffect` **cleanup** 写回(`useEffect` cleanup 时 DOM 已摘,读回 0)、`key` 换即归零 | 「基础件先行」有则必须消费——查看器 `src/content/viewer/useViewerScroll.ts:64-76` 已手写一份,**同批**改成消费者(`scrolls[path]` 作 read/write);检索面 read/write 指向 `store.scrollByKey` |
| **kernel `useQueryHeld`**(`src/data/kernel/react.ts`) | 律②′:换键在飞期间上一把键的答案留在屏上 | 见 §6 |
| **kernel `FetchContext.previous`**(`src/data/kernel/query.ts:41-50`) | 回放链读格自己的已翻页数 | 见 §5.2,删掉「`pagesWanted` 旁表」 |

**陌生能力演练**:加一种结果行 = `targets/<kind>.tsx` + 一行注册;加一种预览 = `preview/kinds/<kind>.tsx` + 一行注册;加一种序列项(例如「块级失败可重试读数项」)= `items/<kind>.tsx` + 一行注册;后端多答一组 = 屏上多一块。骨架五件(顶栏 / 输入框 / 档位条 / 过滤片行 / 左列表右预览)一个字不改;`src/search/__tests__/no-capability-literals.test.ts` 的扫描范围自动覆盖新目录。

---

## 2. 生命周期表

宿主事实(每一行都指向这些):检索面是 `RENDERERS` 的一格(`src/content/index.tsx:44`),`PanelInstance` 按 `[id]` memo(`:105-113`);它在哪棵树里由 `src/stage/residency.ts:31-36` 投影,舞台是瞬态不在树里,**舞台 → 架子 = React 子树换爹 = 真重挂**;叶内非活动 tab 是 keep-alive(`PaneLeaf.tsx:251-256`),隐藏层 `content-visibility: hidden` + `pointer-events: none`(`PaneLeaf.module.css:101-104`)+ 双份 `inert`(`PaneLeaf.tsx:396-408, 463-471`);同一片叶内换序 / 二合一 / 拆开是 holder 同一 DOM 节点搬家(`PaneLeaf.tsx:167-212, 430-449`);收回 Dock = 不在任何树里 = 卸载。检索瓦 `singleton: true`(`src/content/kinds/panel.tsx:29`)。

| 时机 | 数据格 | 选中与滚动 | 焦点 | 历史 |
| --- | --- | --- | --- | --- |
| **首次挂载**(store 出厂) | `ensureSearchCatalog()` 一次(`search-catalog-source.ts:287-292`,幂等);主语 = `all` + 空词 + 缺省片 = 浏览态,`SearchBindings` 判「不是打字」当场 `ensureSearchListing(key)`;格 `phase='initial'` | `selection = { id: null, by: 'reconcile' }`;首发落地 `reconcile` 落到序列首项(`by: 'reconcile'` → 不滚);`scrollByKey` 无值 = 0 | `SearchBindings`:`placed` 由假翻真且 `live` → `activate('placement')`,落点 = `restingTarget` 输入框。指针 / 键盘两条开面路都落进输入框(今天 `activateOnMount` 的行为);键盘路由 `summon.ts:88` `requestFocusOnOpen` 再点一次名,两次都落同一处,无害 | `EMPTY_HISTORY` |
| **从 Dock 再召唤**(默认档:收回时已 `reset()`) | 同首次挂载;若上一把键的格仍在 LRU(24 键,`search-catalog-source.ts:151-162` 的账搬到新文件)则命中零请求 | 同上 | 同上 | 同上(拍点 G 若拍「保留」:store 原样,`activeId` 经 `reconcile` 校验,`scrollByKey[key]` 还原) |
| **已开着再召唤**(`summon.ts:34-40` 表) | 不动 | 不动 | 看得见且焦点不在里面 → `activateScope('search')`;焦点在里面 → 收起 | 不动 |
| **换宿主:舞台 → 浮窗 / 钉边 / 换边**(真重挂) | **不动**:格与键与宿主无关;去抖计时器随旧实例 cleanup 清掉,新实例 `committedKey === subjectKey` 时是恒等变换,不发 | 旧实例 `useScrollMemory` 的 layout cleanup 写 `scrollByKey[shownKey]`;新实例 layout effect 还原(格已 ready 且行数 ≥ 记忆时行数才还原,否则归零不猜);`selection` 在 store 里一格没动,`reconcile` 对新序列校验一次 | **面板不写一行**:`stage/focus-follow.ts:23-27` 表第二行「A → B = 跟」在提交之后 `activateScope(层, { owner })`,落点仍是输入框;`SearchBindings` 因 `placed` 无上升沿不动 | 不动 |
| **叶内换序 / 二合一 / 拆开**(holder 同节点) | 不动 | DOM 没动,浏览器保住 `scrollTop`;`useScrollMemory` 不触发 | focus-follow 处理 | 不动 |
| **架子收起 / 叶内切到别的 tab / 被全屏盖住**(keep-alive) | 不动;`SearchBindings` 的去抖 effect 依赖 `visible`(`content/visibility.ts:10`,「在不在屏幕上」那一格),翻假时 cleanup 清计时器、`committedKey` 不换;翻页 mutation 若在飞照常 `settle` 进格 | DOM 留着,`content-visibility: hidden` 保住 `scrollTop`;`selection` 不动;选中滚入 effect 因 `selection` 没变不跑 | 层 `inert`,树在这里截断,Esc 候选都轮不到它(`PaneLeaf.tsx:396-401`) | 不动 |
| **重开(切回 tab / 展开架子)** | `visible` 翻真那一帧若 `committedKey !== subjectKey` 当场 `ensure`(补发被清掉的那一发);索引推送若在隐藏期间把格标了脏且有订阅者,kernel 已后台补拉(`query.ts:288-293`),旧行未曾清空 | 原样(节点没动过) | 宿主 `activate()`(focus-follow 架子分支) | 不动 |
| **收回 Dock(卸载)** | 格留着 = 缓存;`resetSearchListing()` 与 HMR dispose 是仅有两口退役 | layout cleanup 写回 `scrollByKey`;随后 `SearchBindings` 的**卸载 cleanup** 现问一次形态,是 `dock` 才 `store.reset()`(默认档;**落地改口**,见 §1 那一行的判词:下降沿等不到) | 树按 `returnTo` 结构归还(响应链规则 5),面板零焦点代码 | 默认档随 `reset()` 清空(与今天 `SearchPanel.tsx:104`「卸载本地状态全没了」逐字相同);拍点 G |
| **会话切换**(`useSessionCwd()` 变 → 只有摆得出 `dir` facet 的档键才变,`filters.ts` `filtersOf`) | 键变 → 新格;`useQueryHeld` 把上一把键的行留在屏上直到新格落地 | `resetForListing(key)`:`activeId=null`(落地后 `reconcile` 到首项)、`picked=[]`;`scrollByKey` 的 key 换了 → 新格 ready 那一帧 `scrollTop=0` | 不动 | **不入栈**(不是用户在这块面上走的一步) |
| **空间切换**(`currentSpaceId()` 变且 `filters.space==='current'`) | 同上 | 同上 | 不动 | 不入栈 |
| **能力注销 / 注册**(自述重拉) | `resolveTab`(`capabilities.ts:147-149`)把停在被注销档上的 `scope` 退回 `all` → 键变 | 同「键变」 | 不动 | 不入栈 |
| **索引状态到达**(今天只在挂载问一次,`search-catalog-source.ts:76-83`;推送是留账) | 只更新状态格 → 页脚读数;**列表格不自动 `invalidate`**(有订阅者的 `invalidate` 会后台重拉并整份替换,`laws.test.ts:315-323`);拍点 E | 不动 | 不动 | 不动 |
| **HMR** | `search-listing-source.ts` 与 `search/store.ts` 各自 `import.meta.hot.dispose` 复用自己的 `reset()`(`CLAUDE.md` 模块级副作用律);`resetSearchCatalog()` 顺带调 `resetSearchListing()` | 归零 | 由树重建 | 归零 |

---

## 3. UI 生命状态表

名字:`held` = `useQueryHeld(...)` 交出的 `{ data, phase, inflight, error, stale, shownKey }`(`phase` 如实是新格的相位;`stale` = 屏上这份是上一把键的);`block.pending` = `searchLoadMore.isPending(\`${key}#${cap}\`)`(`mutation.ts:34` 的 `key`);`status` = `searchStatusQuery.data`;骨架五区不换,下表只说每区画什么。

| 状态 | 判据(全是可读字段) | 列表 | 块尾 Load more 项 | 预览栏 | 页脚 | 旧内容留不留 |
| --- | --- | --- | --- | --- | --- | --- |
| idle(自述未回) | `capabilities.phase==='initial'` | 空,不画骨架 | 不画 | 「选一条看看」 | 不画 | 无旧内容 |
| 浏览态 | `query.trim()===''` ∧ `scope===all` ∧ `browseCapabilitiesOf(manifests).length>0`(`capabilities.ts:97-103`)∧ `held.phase==='ready'` | 各 browse 能力一块,块相邻不混排,**无组头**;与查询态同一只 `SearchList` | 每块各自一条(`cursor` 在才画) | 活动行 inline 预览 | 取尽后块尾 `end` 读数「共 N 条」(**落地改口**:拍点 J 的「· 已全部显示」那半句删了 —— 「共 N 条」已经把话说完,后半句是同一件事说两遍;样例为准) | — |
| 打字去抖中 | `store.query.trim() !== parse(committedKey).query`(去抖窗口未到,订阅键未换) | **一格不动**(订的还是旧键) | 不动 | 不动 | 不动 | 留(根本没换) |
| 已提交、未起飞 | `committedKey` 已换 ∧ 新格 `phase==='initial'` ∧ `!inflight`(`useSearchListing` 建格与 `ensure` 之间的一帧) | 同下一行 | 同下一行 | 同下一行 | 同下一行 | 留(`stale`) |
| 查询在飞(首发,无任何旧答案) | `held.data===undefined` ∧ `!held.stale` ∧ (`inflight` ∨ 未起飞) | **空**,不画「无结果」(今天 `SearchPanel.tsx:784` 在首发期间就画「无结果」,是谎话——修正,报备) | 不画 | 「选一条看看」 | 一行「搜索中…」(文字,`data-readout="searching"`) | 无 |
| 查询在飞(换词,有上一把键) | `held.stale===true` | 上一把键的行**留着**,列表根 `data-stale`(一档 `--st-muted` 文字色,不换底);`Highlight` 用格里带的 `query`,不用输入框新词 | 上一把键的那条留着,`aria-busy`,按下无效(判据 `held.stale`) | 活动行预览留着 | 「搜索中…」 | **留**(律②′) |
| 有结果 | `!stale` ∧ `held.data` ∧ `blocks.some(rows.length>0)` | 按块画行(只画有行的块) | 逐块 `moreStateOf` | 活动行 / 多选 | `total`(后端给才画)/ `relaxed` / 索引两行 | — |
| 零结果 | `!stale` ∧ `held.data` ∧ 所有块 `rows.length===0` ∧ 无块 `error` ∧ `!inflight` | 一句「无结果」(空是答案) | 不画 | 「选一条看看」 | 动作行仍在分隔线下(它是动作不是结果) | 不留 |
| 翻页在飞 | `block.pending===true` | 该块行**一个像素不动** | 该块那条「加载中…」+ `aria-busy`,仍在序列里,再按无效 | 不动 | 不动 | 留 |
| 头页重拉在飞(重试 / 重新搜索) | `held.inflight && held.phase==='ready' && !stale` | 行不动(律②) | 各块那条 `aria-busy`(在飞时不许翻页,见 §5.3 闸①) | 不动 | 「更新中…」 | 留 |
| 翻页失败 | `block.pageError!==undefined ∧ !block.pending` | 行不动 | 「没加载出来 · 再试一次」`data-more-state="error"`,可按(重发**同一 cursor**) | 不动 | 不动 | 留 |
| 组 error(某块头页塌了) | `block.error!==undefined ∧ block.rows.length===0` | 该块不占行 | 不画 | 不动 | 一行「<能力名> 没搜成 · 重试」(`data-readout="block-errors"`,拍点 A) | 别的块留 |
| 组 error(重试后塌了但有行) | `block.error!==undefined ∧ rows.length>0` | 行留着 | 「没加载出来 · 再试一次」 | 不动 | 同上一行 | 留 |
| 整发塌了(单类档 fetcher 抛) | `held.error!==undefined` | 旧行留着(`query.ts:233-236`) | 原样 | 原样 | `SearchFailedLine`「没搜成」+ 后端原话(既有,`SearchPanel.tsx:775-780`;拍点 A′)+「重试」= `refetch()` | 留 |
| 索引更新中 | `indexReadoutOf(status).pending>0`(`capabilities.ts:169-177`) | 不受影响 | 不受影响 | 不受影响 | 「索引更新中(剩 n)」 | — |
| 读者模式 | `readerHost!==undefined` | 不受影响 | 不受影响 | 不受影响 | 「由 … 维护」 | — |
| 索引不可用 | `status.mode==='error'`(**只认这一格**;今天 `indexReadoutOf` 把它吞了,`capabilities.ts:171-172`,加一格 `unavailable: true`) | 旧行留(能扫的能力照答) | 不画 | 原样 | 一句人话「索引不可用 · 只显示未建索引的结果」,无重试 | 留 |
| 已放宽 | `held.data.relaxed>0` | 行照画 | 照旧 | 照旧 | 「已放宽匹配」 | — |
| 预览 loading | `preview.data===undefined ∧ preview.error===undefined ∧ !inline ∧ useDelayedFlag(pending, SKELETON_DELAY_MS)` | 不受影响 | 不受影响 | 150ms 内什么都不换,之后骨架 | 不受影响 | 上一条在 150ms 内留着 |
| 预览 ready | `payload!==undefined ∧ renderer!==undefined` | — | — | 檐画一次 `payload.title`(`Highlight`),`Body` 不画标题(测试钉死) | — | — |
| 预览无 | **自述里明说没有 `preview` 那一格**(零请求)∨ 发出去了但成功而 `preview===undefined` | — | — | 行的放大版(标题 + 出处),零解释句 | — | — |
| | **落地改口**:判据分成两条,而且「查不到那份自述」**不算明说** —— 全部档的行归在 `all` 名下而 `all` 不是一个能力,拿「我没查到」当「它没有」会让全部档整档丢预览(⑦ 施工时真撞上过) | | | | | |
| 预览缺渲染器 | `resolvePreviewRenderer(kind)===undefined`(`preview/registry.ts:72-79`) | — | — | Row 放大版 + dev warn 一次 | — | — |
| 预览 error | `answer.data?.error ?? answer.error` | 不受影响 | 不受影响 | 字典句「预览不可用」;原话进 `getLogger('search.preview').warn` + `data-preview-error` | — | 列表不受影响 |
| 预览动作在飞 | `invokeMutation.isPending(key)` | 不动 | 不动 | 那颗 `ui/AsyncButton` 自己 disabled + 换字;`danger` 先 `ui/Dialog` | 不动 | — |
| 超量 | `rows.length` 大 | 列表自己滚;行 `content-visibility: auto` + `contain-intrinsic-size`(`SessionRow` W6-p 先例);**不封顶**(拍点 H) | 尾行常在末位 | 窗自己滚(`search-css.test.ts:133`) | — | 留 |

---

## 4. 交互状态表

约定:焦点**恒在输入框**(`restingTarget`),列表是屏上的候选,活动项由 `store.selection = { id, by }` 说话(`by ∈ keyboard | pointer | history | reconcile`);滚动**只有一条产地**——`SearchList` 的 effect 依赖 `[selection]`,`by==='reconcile'` 时不滚;hover 纯 CSS 不进 JS(`CLAUDE.md:32-35`);历史只在「确定的一步」入栈(`history.ts:63-69`)——**与今天逐字相同**:续搜与「只看这一类」入栈,打字 / 换档 / 拨片 / 打开一行不入栈。

| 动作 | 前置 | 后置(转移) | 屏上变化 | 焦点 | 滚动 | 历史 |
| --- | --- | --- | --- | --- | --- | --- |
| 打字 | 任意 | `setQuery`;220ms 后 `commitKey(subjectKey)` → `ensure` | 去抖内旧行原样;在飞期间旧行 `data-stale`;落地后按新格重画(行 key = id,共同行不重挂) | 输入框 | 不动;新格落地那一帧 `scrollTop=0`(`useScrollMemory` 的 key = `held.shownKey` 换了——**不是**请求键换了)。**落地一条血的教训**:`shownKey` 是 kernel 交出来的**格全名**(带族名前缀 `search.listing:…`),它只配当身份串;拿它去 `searchListingQuery.get()` 会建出一格崭新的空格,`patch` 打在那上面等于什么都没发生(⑦ 撞到过,读数是「APPEND prev=undefined」)。翻页 / 重拉要的是**族里那把键**,hook 交的是 `listing.key`(= `store.committedKey`) | 否 |
| 清空(⌫ 到空 / ×) | `query!==''` | `setQuery('')` → 浏览态那把键(命中则零请求) | 换成浏览态 | 输入框 | 落地归零 | 否 |
| 换档(点 Segmented) | 自述已回 | `setScope` → 键变(确定的一步,不等去抖);`resetForListing` | 档位换;旧行留到新格 ready | **留在那一段上**(`Segmented.tsx:80-101` roving radio,APG 既定;不调 `activate()`,保旧) | 落地归零 | 否(保旧) |
| Tab / ⇧Tab | 焦点在面内 | `setScope(nextTab(tabs, scope, ±1))`(`capabilities.ts:135-141`),`preventDefault` | 同换档 | 输入框(`SearchPanel.tsx:594-598` 判例,Tab 是换范围) | 落地归零 | 否 |
| 点过滤片 / 范围片 × | 片画得出 | `setFilters` → 键变;`dir` 片 × 回到缺省 cwd(`filters.ts` `DIR_FACET`) | 片态换;旧行留到新格 ready | 输入框(片是普通钮,点完树归还) | 落地归零 | 否 |
| ↓ | 序列非空 | `selection.handleKey('ArrowDown')` → `onActiveChange(i)` → `setActive(sequence[i].id,'keyboard')`;到末位停(`loop:false`);序列 = 行 → 该块 more 项 → 下一块首行 → … → 动作项 | 活动项换 `--st-sel`;若是行,预览锚跟着换;停在 more 项上预览**不闪**(锚不变) | 输入框 | `scrollIntoView({block:'nearest'})` 到 `[data-item-id]`(`SessionTree.tsx:198-202` 同法) | 否 |
| ↑ | 同上 | **输入框空 ∧ activeId 是序列首项 ∧ `canGoBack`** → `stepHistory('back')`(今天 `SearchPanel.tsx:602-614` 三条合取保留);否则 `handleKey('ArrowUp')` | 同上 / 四格还原 | 输入框 | 同上 / 历史:`by:'history'` 滚到还原的项 | 走历史挪指针,不 push |
| ⏎ | `activeId` 在 | `itemKindOf(item).activate(item, ctx)`:`row` → `renderer.activate(row, ctx)` + `closeToDock('search')`(拍点 F);`more` → `searchLoadMore.run({key, cap, cursor})`(`pending ∨ held.inflight ∨ stale` 时当没按);`action` → 同 `row`(`targets/prompt.tsx:29-33` 走 `runAction`) | 打开 / 该块尾转圈 / 动作 | 打开:目标接管(进会话 → `expose/store.ts:243` `activateScope('composer')`);翻页:不动 | 打开:面收回;翻页:**不动** | 否(保旧:打开不入栈) |
| 空格 | 焦点在输入框 | 输入一个空格 | 输入框 | 输入框 | 无 | 否(拍点 B:默认保旧,不赋列表语义) |
| Esc | 焦点在面内 | **不声明 `onEscape`**(今天 `SearchPanel.tsx:589-591`「一个字不写」,`region` 缺省不认领)→ 宿主退层;右键菜单开着时 `menu` 缺省 `onEscape` 关自己 | 面收回 / 菜单关 | 树按 `returnTo` 归还 | 无 | 否(拍点 D:候选「先清词」照 `ExposeView.tsx:140-149`) |
| 点 Load more(指针) | `moreState.kind ∈ {more, error}` | `setActive('more:<cap>','pointer')`(显式点击是改 active 的第二产地)+ 同 ⏎ more | 那条转圈;落地新行追加在**该块末尾**;有 cursor 则 more 项留末尾,取尽则消失;`reconcile`:活动项若是消失的 more 项 → **本次追加的首行**(`by:'reconcile'`,它就在旧 more 项的位置) | 输入框(`ButtonBase` 行的 `onMouseDown` `preventDefault` 写在 **items/more.tsx 与 row.tsx 行级**,不在面板根;`DrawerModelPicker.tsx:227` 同法) | **零滚动**:行集增长不在任何滚动 effect 依赖里;`by:'reconcile'` 不滚 | 否 |
| 点块尾重试 | `block.pageError` 在 | 同 more,`run` 带同一 `cursor` | 回「加载中…」 | 输入框 | 无 | 否 |
| 点页脚「重试」/ 块级失败「重试」 | `held.error` ∨ 块 `error` | `searchListingQuery.get(key).refetch()`(kernel 折叠强制,`query.ts:214-225`) | 旧行留到新答复;`reconcile` 近邻 | 输入框 | **不滚**(同一把键) | 否 |
| 右键菜单「在此会话内搜」 | 渲染器自报 `scope` 续搜 | `runContinuation`:先 `pushCommit(entryNow)` 再 `filters.scope=chip`,再 push 新步(今天 `:507-516` 次序) | 片条多一颗范围片;列表换 | 菜单关 → 归还输入框 | 落地归零 | **入栈两格** |
| 右键菜单「提到它的消息」(枢轴) | 渲染器自报 `pivot` | 同上,三格一起换(`:517-531` 搬进 `state.runContinuation`) | 档 / 词 / 片换 | 同上 | 落地归零 | 入栈两格 |
| 右键菜单「只看这一类」 | 行在 | `pushCommit(entryNow)` + `setScope(row.capability)`(原组头「查看全部」,`:817-820`) | 换档 | 同上 | 落地归零 | 入栈 |
| ⌘[ / ⌘] | `canGoBack / canGoForward` | `keyHandlers['history.back'/'history.forward']`(`scopes.ts:78-91` 正本)→ `stepHistory` → `applyEntry`:四格还原,`selection = { id: entry.activeId, by: 'history' }`(`history.ts:34` 的 `selected: number` 改 `activeId: string \| null`) | 四格还原;格命中则零请求 | 输入框 | `by:'history'` → `nearest` 滚到还原项 | 挪指针 |
| ⇧点 / ⌘点行 | 行在 | `setActive(id,'pointer')` + `pick(id)` toggle(今天 `:656-660`,拍点 C 保旧) | `data-picked`;预览基数按 `picked.length` 与 kind 切 single / compare / batch | 输入框 | `nearest` | 否 |
| 素点行 | 行在 | `setActive(id,'pointer')` + `clearPicks` + activate | 同 ⏎ row | 目标接管 | 面收回 | 否 |
| 右键行 | 行在 | `setActive(id,'pointer')`;**`SearchPanel` 的** `rowMenu={row,x,y}`(落地改口,见 §1) | `ui/Menu` 点锚开出(不跟滚) | `menu` modal 接管;关后归还输入框 | `nearest` | 否 |
| 点预览动作 | `payload.actions` 非空 | `invoke` mutation;`danger` 先 `ui/Dialog` | `AsyncButton` 自己变字 + disabled;成功 `previewQuery.invalidate()` | Dialog modal;关后归还 | 无 | 否 |
| 鼠标掠过行 | — | **零转移**(`:hover` 画 `--st-hover`) | — | 不动 | 无 | 否 |
| 点组头 | — | **无此动作**(无组头) | — | — | — | — |
| Home / End | — | 不接(`homeEnd:false`,`:347`;输入框里是光标移动) | — | — | — | — |

---

## 5. 分页状态机

### 5.1 键与格

```ts
// src/data/search-listing-source.ts
export function searchListingKey(ask: SearchAsk, query: string, filters?: SearchFilters): string {
  return JSON.stringify([normalizeAsk(ask), query.trim(), filters ?? {}])   // 三元;limit / page / cursor 不进键
}

interface SearchBlock {
  capability: string; labelKey: string
  rows: readonly SearchResult[]      // 累加,按 id 去重,旧行对象引用不换
  actions: readonly SearchResult[]   // role:'action' 的行(不进 rows、不计数)
  cursor?: string                    // 缺席 = 取尽(§7.3 契约原话,壳只认这一条)
  total?: number                     // 缺席 = 不知道
  error?: string                     // 头页塌了
  pageError?: string                 // 最近一次翻页塌了,rows 留着
  pages: number                      // 已落地几页(回放链读它)
}
interface SearchListing { mode: 'browse'|'overview'|'single'; query: string; blocks: readonly SearchBlock[]; relaxed?: number; total?: number }
```

三种档一台机,差别只在首页怎么来:单类 = `port.query(q, cap, PAGE, filters)` 一块,`cursor` 来自 `response.cursor`;全部档(有词)= `port.query(q,'all',…)` 的 `groups[]`,每块 `cursor` 来自**新增的 `groups[].cursor`**;浏览态 = `browseFanout` 逐能力一发(`search-catalog-source.ts:231-258` 保留,**把 `response.cursor` 带回**——今天拿到了却丢掉)。`CapabilitySearchAnswer.browse` 那个靠形状区分分页语义的布尔(`:100-110`)消失:分页语义**逐块**由 `block.cursor` 说。`equals` 比各块 `(pages, cursor, error, pageError)` 与 `dataRev`,不深比行(`kernel/index.ts:55`)。

### 5.2 翻页 = 一只 mutation,落点是 `patch`

```ts
export const searchLoadMore = createMutation<{ key: string; capability: string; cursor: string }, SearchPage>('search.loadMore', {
  key: ({ key, capability }) => `${key}#${capability}`,                     // 律③:忙态逐块
  run: ({ key, capability, cursor }) => port.query(parse(key).query, capability, PAGE_SIZE, parse(key).filters, cursor),
  settle: (page, { key, capability, cursor }) =>
    searchListingQuery.get(key).patch(prev => appendPage(prev, capability, cursor, page)),   // 见下三道闸
  onError: (err, { key, capability }) =>
    searchListingQuery.get(key).patch(prev => markPageError(prev, capability, err.message)),
})
```

**没有 `optimistic`**:`mutation.ts:123-127` 失败时**先** `rollback()` 再 `onError`,而 `query.ts:279-286` 的回滚是整格快照还原——块 A 的重试若带乐观补丁,失败时会把块 B 刚追加的一页整批抹掉(两路评审都点名)。清 `pageError` 放在 `appendPage` / 起跑那一句里,不经 `optimistic`。

**三道闸(结构保证,不是纪律)**:
① `cursor` 在起跑时捕获进 input,`appendPage` 只在 `prev.blocks[cap].cursor === fromCursor` 时追加,否则丢弃——治 `mutation.ts:109-133` 不折叠同键并发(`laws.test.ts:446-464`)的同游标双发,也治「头页 `refetch` 在翻页飞行期间落地」;
② `moreStateOf(block, pending, inflight)`:格 `inflight`(头页重拉 / 回放链在飞)或 `held.stale` 时尾行 `aria-busy`、按下无效——回放链与 `loadMore` 永不重叠;
③ 追加后**零新 id** → `cursor` 置空按取尽处理 + `getLogger('search.listing').warn`——后端 `readOffsetCursor`(`packages/core/search/pipeline/page.ts:60-75`)对指纹不匹配**静默归零**返回第一页,不抛;没有这一道,去重会把它藏成「按了永远没反应」。

**回放链(`invalidate` 之后不缩行集)**:kernel 加一格 `FetchContext.previous?: T`(`query.ts:41-50`,`start()` 在 `:231` 传 `state.data`);fetcher 拉头页后读 `previous?.blocks[cap].pages ?? 1`,顺着 cursor 再走 `pages-1` 步再整份交回。「`pagesWanted` 旁表」整个不立(评审:同一件事两个产地)。`equals` 内容比较,逐字相同 `dataRev` 不动(律④,`laws.test.ts:244-260`)。

### 5.3 块尾项的四态 + 一条读数

```ts
type MoreState = { kind:'more'; shown:number; total:number|null } | { kind:'loading' } | { kind:'error' } | { kind:'end'; total:number } | { kind:'none' }
export function moreStateOf(b: SearchBlock, pending: boolean, inflight: boolean): MoreState {
  if (b.rows.length === 0) return { kind: 'none' }                       // 零命中块不占行
  if (pending || inflight) return { kind: 'loading' }                     // 闸②
  if (b.pageError !== undefined) return { kind: 'error' }
  if (b.cursor === undefined) return { kind: 'end', total: b.total ?? b.rows.length }   // 取尽 = 读数,不是 item
  return { kind: 'more', shown: b.rows.length, total: b.total ?? null }
}
```

| 态 | 屏上 | 是不是 item / 在不在序列 | 可按 |
| --- | --- | --- | --- |
| `more` | 「加载更多」/ total 已知「已显示 a / 共 b」 | item,在 | 是 |
| `loading` | 「加载中…」+ `aria-busy` | item,**在**(免得焦点途中蒸发,`SearchPanel.tsx:334`) | 按下无效,不 `disabled` |
| `error` | 「没加载出来 · 再试一次」 | item,在 | 是(同一 cursor) |
| `end` | 「共 N 条」(拍点 J 落地时去掉后半句;`gate-search.mjs` 照过 —— 门读的是数,不是那半句话) | `role="presentation"` 读数,不在 | — |
| `none` | 不画 | 不在;`reconcile` 把停在 `more:<cap>` 上的活动位挪到本次追加首行 | — |

给不出 cursor 的能力**按取尽画**;要浏览态可翻页是让 `chats` 的 `recentSessions`(`capabilities/sessions.ts:118-140`)经 `paginate` 产位置 cursor——填的是既有 `SearchResponse.cursor`,不是契约新格。`transitions.ts:244-248` 「回来的 < 要的」那条退路删除。

### 5.4 行集增长绝不触发滚动——四条不变量

1. 键不变 → 同一格 → `data` 永不 `undefined` → 容器高度永不归零(病根一,`SearchPanel.tsx:268-280`)。
2. 活动位按 **id**(`row:<cap>:<id>` / `more:<cap>` / `action:<id>`),不按下标;追加只在块末尾。
3. 滚动 effect 依赖 `[selection]` 且 `by==='reconcile'` 不滚(病根二,`SearchPanel.tsx:396-401` 依赖 `visibleRows`);`useListSelection` 传 `scrollBlock: null`(`list-selection.ts:158-163` 那条依赖 `count` 的 effect 因此不跑)。`reconcile` 落点唯一答案:more 项消失 → **本次追加的第一行**;行消失 → 按旧下标夹到最近幸存项;都没了 → 序列首项。
4. 行 `memo` + key = id;门断言:翻页前后 `[data-row="0"]` 同一 DOM 节点、`.body.scrollTop` 差 0(在 more 项完全可见前提下)、`activeElement` 仍是输入框。

### 5.5 滚动位怎么保住

| 场景 | 机制 | 出处 |
| --- | --- | --- |
| 叶内换序 / 二合一 / 拆开 | holder 同节点,浏览器保住 | `PaneLeaf.tsx:167-212, 430-449` |
| 架子收起 / 切 tab / 全屏盖住 | `content-visibility: hidden` + `inert` | `PaneLeaf.module.css:101-104`,`PaneLeaf.tsx:463-471` |
| 舞台 → 浮窗 / 钉边(真重挂)、收回再开 | `useScrollMemory(listRef, held.shownKey, {read: k => store.scrollByKey[k], write})`:layout cleanup 写、layout effect 还原(行数 ≥ 记忆时行数才还原) | 新 `src/ui/scroll-memory.ts`;查看器 `useViewerScroll.ts:64-76` 同批改消费 |
| 键变 | key = **屏上那份数据的键**(`held.shownKey`),换即归零;`stale` 期间旧 key 不动,所以旧列表不会先跳顶 | 评审「key 写错产地」 |

### 5.6 与 kernel 律的关系

| 律 | 今天 | 新设计 |
| --- | --- | --- |
| ② 重拉旧内容保留 | 只对同键成立,翻页换键 | 翻页不换键;换词跨键由 `useQueryHeld` 持有(`stale`) |
| ① 写就地更新 | 无 | `loadMore` 走 `patch`,不 `invalidate` |
| ③ 反馈长在发起控件上 | `moreState` 从 `page>1 && pending` 猜(`transitions.ts:364-375`) | `isPending(\`${key}#${cap}\`)` 逐块 |
| ④ 身份稳定 | `equals` 缺省,每次重拉换引用 | `equals` 内容比较;行 key = id |
| 禁 `useState` 管 pending / 禁 catch 清 data / 禁成功后整份 set 回 | `page / onMore` 两格 state | 全删;`onError` 只 `patch(markPageError)`;对账走 `previous` 回放 |

### 5.7 后端契约只加的几格

| 处 | 加什么 | 理由 |
| --- | --- | --- |
| `packages/shared/ipc/search.ts:95-101` `groups[]` | `cursor?: string` | 全部档每块原地翻页的唯一入口(用户裁定的那一格) |
| `packages/onething-runtime/src/search/service.ts:401-407` `allResponse` | 投影 `cursor: group.page?.cursor` | `fanout.ts:85, 104-110` 每能力本来就按 `{limit, cursor}` 跑、`page.ts:33-58` 给满即产 cursor——**只缺投影**,不给 `all` 档加 `page:{limit}`(那会覆盖各组配额) |
| `packages/shared/ipc/search.ts:41-80` `SearchResult` | `role?: 'result' \| 'action'`(缺省 result) | 「Create prompt」由能力自报是动作,壳按 `role` 分区,零 id 前缀;`prompts.ts:83-95` 标 `action` 且不计入 `total` / 页项。**这是用户「一格」之外的第二格,拍点 I**(`type:'action'` 是命令能力的旧六字面量,不能挪用) |
| `apps/desktop-react/src/data/search-port.ts:96-106` | `query()` 透传 `cursor` | `SearchRequest.cursor` 契约早在(`search.ts:36-37`),壳的口没递 |
| `capabilities/sessions.ts` 浏览支 | 经 `paginate` 产位置 cursor | 填既有字段,非契约 |
| `SearchStatusResponse` | 不加;壳 `indexReadoutOf` 认 `mode==='error'` | 拒绝字符串匹配报错文案 |
| `gate:search-index` | 加第九步:`all` 档拿到的组 cursor 回传同词同片的单类请求,第二页不重不漏 | `indexed.ts:145-151` 指纹是 `{raw,intent,filters,level,generation}`,不含 limit / 档位;两条路的阶梯 `level` 是否一致要门跑出来 |

---

## 6. 壳数据层改动

`src/data/search-catalog-source.ts` 拆两半:自述 / 索引状态 / 预览三条口(`:66-83, 372-407`)原地不动;查询那一族(`:85-320`)搬到新文件 `src/data/search-listing-source.ts`,迁移末批删旧口不留转发壳(`kernel/index.ts:39-40`)。

| 项 | 今天 | 改成 | 律 / 法 |
| --- | --- | --- | --- |
| 键 | `searchCatalogKey(cap, q, limit, filters)`(`:121-128`) | `searchListingKey(ask, q, filters)` | 律②只对一把键成立 |
| 格值 | `CapabilitySearchAnswer`(`:86-111`),`browse` / `groups` 两形 | `SearchListing{blocks[]}` 一形,逐块 `cursor` | 「缺席 = 取尽」;`SearchPanel.tsx:293-316` 三分支 `remote` 合成器删 |
| fetcher | 按 `capabilities.length>1` 分 fanout / 单发(`:197-216`) | `mode` 三分;头页落地后按 `ctx.previous` 回放 | 律②/④ |
| 翻页 | 换键 `ensure(newKey)`(`SearchPanel.tsx:356-375, 479-486`) | `searchLoadMore` → `patch(appendPage)`;失败 `patch(markPageError)` | 律①③ |
| 重试 | `refetchCapabilitySearch` 整格(`:274-284`) | 块级 = 同 cursor 重发;头页 = `refetch()` | 律② |
| `ensure` 的位置 | 面板 effect 带去抖(`:355-375`) | `SearchBindings`:`subjectKey` 变 → 打字等 220ms、确定的一步当场 → `commitKey` + `ensure`;翻页 / 重试不经去抖 | 判例保留 |
| 读法 | `useCapabilitySearch(ask,q,limit,filters)`(`:309-320`) | `useQueryHeld(searchListingQuery.get(committedKey))` | 新 hook |
| LRU | `CACHE_KEYS=24`(`:151-162`) | 不变;`drop` 一格连累加页一起走,⌘[ 回来只有第一页(如实) | 内存优先 |
| 退役 | `resetSearchCatalog()` + HMR(`:410-428`) | 各自 `reset()`;`resetSearchCatalog()` 顺带调 `resetSearchListing()` | 模块级副作用律 |
| **`invalidate` 调用方** | — | `search-listing-source.ts` **不导出 family 本身**,只导出 `ensure / refetch / loadMore / useListing / reset` 五口——「零 `invalidate` 调用方」从 grep 纪律变成结构保证;索引推送对不在屏上的格用 `drop` | 评审 13 |

### `useQueryHeld`(`src/data/kernel/react.ts`)

```ts
export interface HeldSnapshot<T> extends QuerySnapshot<T> { readonly stale: boolean; readonly shownKey: string }
export function useQueryHeld<T>(query: Query<T>): HeldSnapshot<T>
```

语义:`useQuery(query)` 原样透传 `phase / inflight / error`(**`phase` 如实**,不造第二种语义);当 `query.key` 换了且新格 `data===undefined && error===undefined`,`data` 是上一把键最后一次 ready 的值、`stale:true`、`shownKey` = 上一把键;新格**有了自己的 `data`** 即放手。**落地改口**:原写「成或败即放手」,而 `error` 那一支不放手 —— 与律②同格里「错误与旧答案共存」逐字一致(错误不抹掉旧答案,如实并陈),放手会让一次失败把屏幕清空。骨架判据改为 `phase==='initial' && !stale`。实现用「渲染期派生 state」而不是 `useRef`(并发渲染下 ref 不保证),单读者(`useSearchListing`);测试进新开的 `src/data/kernel/react.test.tsx`(`laws.test.ts:1-25` 是零 React 的 deferred 剧本,hook 用例不该混进去),正反两条:`useQueryHeld` 换键在飞 `data` 是旧值 ∧ `stale`;裸 `useQuery` 同一帧读到 `undefined`。

### 组件订阅面

`useSearchListing()` 交出 `held`(`data / inflight / error / stale / shownKey`)、`blocks`、`sequence`、`byId`;除此之外组件从数据层一个字不读;忙态只从 `useAsyncPending(searchLoadMore, key)` / `held.inflight` 读(`ui-consume-check.mjs:317` `async-busy-boolean`)。

---

## 7. 迁移步骤与每步的门

原则:先并存再替换再删除;唯一红→绿是第 7 步;每步单独提交(派 haiku 只 add+commit,前后核 sha);真机门先问时机。门:`bunx vitest run apps/desktop-react/src/search apps/desktop-react/src/data apps/desktop-react/src/ui`、`npm run ui:consume`、`gate:search`、`gate:search-messages`、`gate:a11y`、`gate:focus`、`squeeze-gate`、仓根 `typecheck` / `boundary:gate`、`gate:search-index`。

| 步 | 做什么 | 改哪些测试 / 门 | 为什么绿 | 反证 |
| --- | --- | --- | --- | --- |
| 1 契约 | `groups[].cursor?`、`SearchResult.role?`;`allResponse` 投影 cursor;`prompts.ts` 标 `action` 且不计数;`sessions.ts` 浏览支产 cursor;`search-port.ts` 透传 cursor;`gate:search-index` 第九步 | runtime `search/__tests__` 加「all 每组带 cursor」「all 组 cursor 回传单类不重不漏」;`golden-snapshot` 命中集不变 | 全是可选字段,旧壳不读 | 删投影那一行 → 第九步红 落地 `ae9cbcde` |
| 2 kernel | `FetchContext.previous`;`useQueryHeld` + `react.test.tsx` | 新增;`laws.test.ts` 不动 | 纯新增 | `useQueryHeld` 换回 `useQuery` → 律②′ 红 落地 `43fcf0a2` |
| 3 基础件 | `src/ui/scroll-memory.ts` + `ui/__tests__/scroll-memory.test.tsx`(挂载还原 / key 换归零 / layout cleanup 写回);`useViewerScroll.ts:64-76` 改消费 | `ui:consume` 基线不增;查看器既有用例照跑 | 等价替换 | cleanup 改 `useEffect` → 写回 0 那条红 落地 `054e70a3` |
| 4 数据层 | `src/data/search-listing-source.ts`(键 / 格 / fetcher+回放 / `searchLoadMore` / 五口 / reset / HMR);旧族原样留 | 新 `search-listing-source.test.ts`:键无 limit、追加去重、cursor 幂等、零新增取尽、`pageError` 留行、`invalidate` 回放不缩行、`equals` 不换引用、飞行期 refetch 落地后旧 cursor 的 settle 被丢弃 | 旧路未动 | 去掉闸① → 双发用例红 落地 `e3ae05c1` |
| 5 纯模型 | `state.ts / sequence.ts / paging.ts / keys.ts / items/registry.ts` + 三个 item 模块;`history.ts` `selected → activeId` | 各自单测;`transitions.test.ts:88-221` 五个 describe 移到 `paging.test.ts` / `sequence.test.ts`;`history.test.ts` 改一格 | 无消费者 | `reconcile` 改 tick → 「不滚」用例红 落地 `36b1d554` |
| 6 store + 拆件(等价) | `search/store.ts`(照 `expose/store.ts` 体例 + HMR);从 `SearchPanel.tsx` 抽 Head / FilterBar / FailedLine / Row / RowMenu / Footer,props 原样,**仍吃旧数据路** | `SearchPanel.test.tsx` 42 例不改(按 role / data-row / testid 认);逐态截图对照(rest/hover/focus/pending/empty/error/超量) | 像素零差 | — 落地 `10f97cc9` |
| 7 换心 | `SearchPanel` 改吃 store + `useSearchListing` + `useSearchKeys`;`SearchBindings` 替 `activateOnMount`;`SearchList` / `SearchBlockRows` / `SearchMoreItem` 接上;删 `page/cursor/onMore/picked/history/query/scope/filters` 八格 state;删 `transitions.ts` 五函数;页脚移出 listbox;`SearchPreview` 标题一次 + 不露原话 + `useDelayedFlag` | `SearchPanel.test.tsx`:删 `pageWindow`(`:30/:66/:695`),`seed` 按三元键;`:208-218` 翻页例改「按 more 后首行同节点、`scrollTop` 不变、新行追加块尾」;`:482-495` 历史按 `activeId`;`preview.test.tsx` 加「Body 不含 title」「error 不含原话」;`gate-search.mjs:487-503` 加三条断言(同节点 / `scrollTop` 差 0 / `activeElement` 输入框)+「全部档有词点某块 more 只该块增长」;`gate:focus` 场景 10 与「⌘P 开面焦点进输入框」必跑 | 唯一改行为的一步;门里的新断言就是反证 | 滚动 effect 依赖改回 `[activeId, rows]` → `scrollTop` 断言红 落地 `e6986e06` |
| 8 裁定落地 | 删组头(GroupHead 退出、五个 CSS 类删)、零命中不占行、动作行分隔线下、「只看这一类」进右键菜单、索引 `error` 档上屏一句 | `SearchPanel.test.tsx:263-333` 组头四例改「无组头、块相邻、零命中不占行、动作行不计数」;`gate-search-messages.mjs:361-368` `data-group*` 改读 `[data-readout="block-errors"]`;`search-css.test.ts` 加「无 `.groupBand`」;`gate:a11y` 扫描屏加 `[data-testid=search-panel]`(今天不扫,补账) | 每条是用户 09-05 裁定,改断言不改产品 | — 落地 `e6986e06` |
| 9 删旧 | 删 `search-catalog-source.ts` 的查询族(`CapabilitySearchAnswer` / 四元键 `searchCatalogKey` / `capabilitySearchQuery` / `browseFanout` / `ensure` / `refetch` / `useCapabilitySearch` / LRU 账,只留自述 · 状态 · 预览三口)、两份同名 `SearchAsk` 归一、`resetSearchCatalog()` 顺带调 `resetSearchListing()`;删 `transitions.ts` 的分节与分页两台机(`SearchSection` / `sectionsOf` / `flatRows` / `sectionsWindow` / `SEARCH_FIRST_PAGE` / `SEARCH_PAGE_SIZE` / `pageWindow` / `remoteSide` / `SearchMore` / `moreState` + 「递增 limit 重查」那段注释),`paging.test` / `sequence.test` 里搬来的旧两组随之删;i18n 删 `search.viewAll` / `allShownOne` / `allShown` / `shownCount`(zh · en 成对)+ `i18n.test` 的单复数对;补一条 jsdom 用例 `SearchList.scroll.test.tsx`(⑦ 留账:滚动 effect 的反证没咬住) | `i18n.test` 键集合相等 + 单复数表;整壳 vitest;typecheck(缺键在这里就红) | 无消费者 | 删 `search.viewAll` 后故意留一处引用 → tsc 红;`SearchList` 的 `by==='reconcile'` 早退去掉 → 新 jsdom 用例红 | 落地 **本批** |
| 10 文档 | `docs/design/search-index-2026-09.md`:§9(壳)按落地改写成事实、§12 加三条「拆掉的旧裁定」(§7.2 不分页 / §9 组头带 total 与查看全部 / §4.5 ⑤ 预览原话)、§7.2 与 §4.5 ⑤ 就地划掉指过去、§0 拍点己改口、文首加落地记录;本稿附录 B §1 / §2 / §3 / §4 / §5.3 / §6 六处按落地改成事实、§7 十步表逐行盖 sha、§8 落差表逐行标「已落」、§9 未决删已解决的加本批留账;`apps/desktop-react/CLAUDE.md` 加检索面两行(正本指针 + 分页四条不变量) | — | 纯文档 | — | 落地 **本批** |

---

## 8. 与今天代码的落差总账

> **2026-09-06:35 行全部已落**,末列括号里是落在第几步(十步表见 §7,每步带 sha)。
> 「今天怎样」那一列说的是 09-05 立稿那天的代码,留着是为了让人看得出改的是什么;它已经不是现状。

| # | 文件 | 立稿那天怎样 | 改成怎样 |
| --- | --- | --- | --- |
| 1 | `src/data/search-catalog-source.ts:121-128` | 键四元含 `limit` | 三元键,搬到 `search-listing-source.ts` **已落(④)** |
| 2 | `src/search/components/SearchPanel.tsx:278-280` | `limit = pageWindow(page)` 建格,翻页换键 | `useQueryHeld(listing.get(committedKey))`,翻页 `patch` **已落(⑦)** |
| 3 | `SearchPanel.tsx:396-401` | `useEffect([cursor,onMore,visibleRows])` scrollIntoView | 依赖 `[selection]`,`by==='reconcile'` 不滚 **已落(⑦)** |
| 4 | `SearchPanel.tsx:154-175` | 八格 `useState`(词/档/cursor/page/onMore/filters/history/picked)+ rowMenu | 前八格进 `search/store.ts`;`rowMenu` 留 `SearchList` 组件态 **已落(⑥⑦)** —— **改口**:`rowMenu` 留在 `SearchPanel`(开菜单要 `rowModelOf` / `available` / `runContinuation` 三样,都在面板手上) |
| 5 | `SearchPanel.tsx:161,165,616-628` | 下标 `cursor` + `onMore` 布尔 | `selection = { id, by }`,more 项是序列里的一个 id **已落(⑤⑦)** |
| 6 | `SearchPanel.tsx:293-316, 326-328` | 三分支 `remote` 合成 + 「窗口 × 组数」放大器 | 逐块 `block.cursor`;删 **已落(④⑦)** |
| 7 | `SearchPanel.tsx:355-375` | 去抖 effect 在面板,一敲字就换订阅键 | `SearchBindings`;`committedKey` 去抖到点才换,打字期间旧列表原样 **已落(⑦)** |
| 8 | `SearchPanel.tsx:386-388` | `moreIsItem` 变假就 `setOnMore(false)` | `reconcile(sequence)` 单一落位规则 **已落(⑤⑦)** |
| 9 | `SearchPanel.tsx:479-486` | Load more = `setPage(p+1)` | `searchLoadMore.run({key,cap,cursor})` **已落(④⑦)** |
| 10 | `SearchPanel.tsx:672-678` | `activateOnMount` | `SearchBindings` 的 `placed` 上升沿(照 `Overview.tsx:39-70`);行为不变 **已落(⑦)** |
| 11 | `SearchPanel.tsx:783-970` | 读数 `<p>` 在 `role=listbox` 里 | `SearchFooter` 是 listbox 兄弟 **已落(⑦)** |
| 12 | `SearchPanel.tsx:796-827` + `SearchPanel.module.css:221-245,355-370` | `GroupHead` 组头(total / 没搜成 / 查看全部) | 删;「查看全部」→ 右键「只看这一类」;组失败 → 页脚 `block-errors`;total → 块尾 `end` 读数 **已落(⑧)** |
| 13 | `SearchPanel.tsx:902-923` | more 项按 `page>1 && pending` 猜忙态 | `useAsyncPending(searchLoadMore, key#cap)`;`aria-busy` 不 `disabled` **已落(⑦)** |
| 14 | `SearchPanel.tsx:924-938` | `end` / `count` 两条读数 | `end` 保留(逐块);`count` 删(首发在飞不再画「已显示 N 条」,画「搜索中…」) **已落(⑦⑧)** |
| 15 | `SearchPanel.tsx:784` | 首发在飞画「无结果」 | 首发在飞列表空、页脚「搜索中…」 **已落(⑦)** |
| 16 | `SearchPanel.tsx:93-119` | 文件头三张表「loading:旧行留在屏上」与代码不符 | 删,正本在 `docs/search-panel-2026-09.md` **已落(⑦)** |
| 17 | `src/search/transitions.ts:184-231, 258-306, 364-375` | `sectionsOf / flatRows / sectionsWindow / pageWindow / remoteSide / moreState` | 删;`paging.ts` / `sequence.ts` 接替 **已落(⑨)** |
| 18 | `src/search/history.ts:34` | `selected: number` | `activeId: string \| null` **已落(⑤)** |
| 19 | `src/search/capabilities.ts:171-172` | `mode==='error'` 被吞 | `unavailable: true` 一格,页脚一句人话 **已落(⑦⑧)** |
| 20 | `src/search/components/SearchPreview.tsx:53-54` | 自己的 `PREVIEW_SKELETON_DELAY_MS=120` + `useState` 计时 | `useDelayedFlag(pending, SKELETON_DELAY_MS)`(`motion.ts:33`) **已落(⑦)** |
| 21 | `SearchPreview.tsx` error 态 | 画后端原话 | 字典句 + logger + `data-preview-error` **已落(⑦)** |
| 22 | `src/search/preview/kinds/session-overview.tsx:46`、`note-excerpt.tsx:40` | Body 里第二次画 title | 删(`preview/registry.ts:28-37` 契约钉成测试) **已落(⑦)** |
| 23 | `src/data/kernel/query.ts:41-50` | `FetchContext{key, force}` | 加 `previous?: T` **已落(②)** |
| 24 | `src/data/kernel/react.ts` | 三个 hook | 加 `useQueryHeld` **已落(②)** |
| 25 | `src/content/viewer/useViewerScroll.ts:64-76` | 手写还原 / 写回 | 消费 `ui/scroll-memory` **已落(③)** |
| 26 | `src/data/search-port.ts:96-106` | `query` 不递 cursor | 透传 **已落(①)** |
| 27 | `packages/shared/ipc/search.ts:95-101` | `groups[]` 无 cursor | 加 `cursor?` **已落(①)** |
| 28 | `packages/shared/ipc/search.ts:41-80` | 无 `role` | 加 `role?`(拍点 I) **已落(①)** —— **改口**:契约上没有加 `SearchResult.role`,页级 `actions` 那一格已经把「动作不是结果」说完了 —— 结果里根本不放动作,不需要第二格去标记它 |
| 29 | `service.ts:401-407` | 丢 `page.cursor` | 投影 **已落(①)** |
| 30 | `prompts.ts:83-95` | Create prompt 是普通结果行 | `role:'action'`,不计数 **已落(①)** |
| 31 | `capabilities/sessions.ts:118-140` | 浏览支无 cursor | 经 `paginate` 产 **已落(①)** |
| 32 | `scripts/gate-search.mjs:487-503` | 拉到底点 more,不断言 `scrollTop` | 加三条断言 + 逐块增长 **已落(⑦)** |
| 33 | `scripts/gate-a11y.mjs` | 不扫检索面 | 加扫描屏 **已落(⑦⑧)** |
| 34 | `src/i18n/zh.ts:425` / `en.ts:364` | `search.viewAll` | 删;`allShown*` 保留 **已落(⑨)** —— `allShownOne` / `allShown` / `shownCount` 一并删(取尽读数只剩「共 N 条」) |
| 35 | `SearchPanel.test.tsx:30,66,208-218,263-333,482-495,695` | 依赖 `pageWindow` / 组头 / 下标 | 按第 7、8 步改 **已落(⑦⑧)** |

---

## 9. 未决与风险

> **2026-09-06 收账**:十步全部入库(§7 逐行带 sha)。下表的「本稿默认」那一列**已经全部落地**,
> 所以它不再是「待拍」而是「已生效的裁定」——三处落地时改了口,逐条写在末列。
> 真正还开着的东西,搬到本节末尾的「本批留账」。

**拍点(全部已落地;末列 = 落地时与本稿默认的出入)**

| # | 拍点 | 立稿那天 | 本稿默认 | 落地 |
| --- | --- | --- | --- | --- |
| A | 块级失败(某类头页塌)画在哪 | 组头一句「没搜成」 | (a) 页脚一行「<能力名> 没搜成 · 重试」 | **照做**(`[data-readout="block-errors"]`,`gate:search-messages` 照着) |
| A′ | 整发失败那行露不露后端原话 | 露 | 保旧 | **照做**(`SearchFailedLine`) |
| B | 空格语义 | 输入空格 | 保旧 | **照做** |
| C | ⇧ 点行 | 与 ⌘ 同,单条 toggle | 保旧 | **照做** |
| D | Esc | 不认领,宿主退层 | 保旧 | **照做**(面板不声明 `onEscape`) |
| E | 索引变了列表怎么办 | 挂载问一次状态,不推送 | (a) 只标脏 + 页脚文字动作 | **只做了半条**:查询回执里的 `index` 带回来了(读数跟着最近一次答复走),推送与「索引已更新 · 重新搜索」那句文字动作没做 → 见「本批留账」 |
| F | ⏎ 进入后收面 | 恒 `closeToDock` | 保旧;建议采 08-30 裁定 | **照做保旧**(建议那半条没做,是一次可感知的行为裁定,要用户点头)|
| G | 收回 Dock 再开,词 / 档 / 片 / 历史 / 选中 | 全没了 | 保旧 | **照做,但判据换了**:不是 `placed` 下降沿(等不到),是**卸载时现问一次形态是不是 `dock`**(⑦ 真机门抓出来的,见附录 B §1 / §2) |
| H | 每块行数封顶 | 无 | 无 | **照做**(不封顶;行 `content-visibility: auto`)|
| I | 第二格契约 `SearchResult.role` | 无 | 加 | **没加,而且不需要**:页级 `actions` 那一格把「动作不是结果」说完了 —— 结果里根本不放动作,不必再加一格去标记「这条结果其实不是结果」 |
| J | 取尽读数「共 N 条 · 已全部显示」 | 有 | 保留(逐块) | **保留,但去掉后半句**:块尾读数是「共 N 条」——「已全部显示」与它是同一件事说两遍(样例为准) |
| K | 首发在飞画「无结果」 | 画 | 修正为不画(它是谎话) | **照做**:首发在飞列表空、页脚「搜索中…」 |

**风险与取舍**

| # | 风险 | 处置 | 今天 |
| --- | --- | --- | --- |
| 1 | keep-alive + 累加页常驻内存 | LRU 24 键不变;拍点 H;行 `content-visibility: auto` | 照做;`gate:perf` 那条 heap 读数没加 → 留账 |
| 2 | 回放链代价:`invalidate` 一次 = 首页 + 已翻页数次请求 | family 不导出,只有 `refetch`(用户显式)会触发 | 照做(五口 + 不导出 family,结构保证) |
| 3 | cursor 过期:两页之间索引变了 | `appendPage` 按 id 去重;`generation` 进指纹 → 闸③ 取尽 + warn | 照做 |
| 4 | `all` 首页与第二页出自两张预算策略,放宽 `level` 若不同则第 21 行有缝 | 第 ① 步 `gate:search-index` 第九步先跑;不匹配由闸③ 兜住不死循环 | 第九步绿(第二页非空 / 不重 / 两页合起来不漏);两条路共用同一阶梯的事**没做**,留账 |
| 5 | `useQueryHeld` stale 行用旧词高亮、点它打开的是旧结果 | 格里带 `query`;`data-stale` 降一档文字色 | 照做(`SearchListing.query`,列表根 `data-stale`) |
| 6 | `useQueryHeld` 进 kernel 公共面,「上一把键」按 hook 实例记 | 单读者;将来多读者改成 store `shownKey` | 照做,单读者仍是 `useSearchListing` |
| 7 | abort 缺席:换词快时多发请求 | transport 收 `AbortSignal` 是跨包一批 | **仍然如此** → 留账 |
| 8 | 历史与多选耦合:条目记 `activeId` 不记 `picked` | 有意 | 照做 |
| 9 | LRU `drop` 掉的格 ⌘[ 回来只有第一页 | 如实 | 照做 |
| 10 | 同一能力同一 id 出现两次让两行共用键 | 能力内 id 唯一是契约义务 | 照做;`golden-snapshot` 那条断言**没加** → 留账 |
| 11 | Tab = 换档与 `region` 档「Tab 走得出去」的张力 | 既有行为保留 | 照做;`gate:a11y` 补扫之后没有裁「必须走得出去」,张力仍在 |
| 12 | more 项当 `role="option"` 在 APG 上是可选项不是动作 | 既有裁定保留 | 照做(`gate:a11y` 检索面那一屏零违例) |
| 13 | `SearchBindings` 的 `placed` 上升沿与键盘路 `requestFocusOnOpen` 同帧两次 `activate` | 都落输入框,无害 | 照做;`gate:focus` 场景 3 判的是「最终焦点在输入框」 |
| 14 | `data-row` 保留下标属性,行 memo 在下标变时重渲 | 只有追加行的下标是新的 | 照做 |
| 15 | store 模块级 = 一台一份 | 检索瓦 `singleton:true` | 照做 |
| 16 | 与设计正本三处出入(§7.2 不分页 / §9 组头 / §4.5 ⑤ 原话) | 第 ⑩ 步记进 §12,不留两份真相 | **已结**(`docs/design/search-index-2026-09.md` §12 三行 + §7.2 / §4.5 就地划掉) |
| 17 | 组件行数上限只在表里没有门 | 留账;若漂则加棘轮 | 仍然只有表,没有门 → 留账 |

**本批留账(2026-09-06,十步走完之后还开着的)**

| # | 事 | 现状 | 下一步 |
| --- | --- | --- | --- |
| 1 | 拍点 E 的另一半:索引推送 | 查询回执的 `index` 已经带回来,读数跟着最近一次答复走;**推送没有**,页脚也没有「索引已更新 · 重新搜索」那句文字动作 | 一次可感知的行为裁定(会不会在用户翻到第 5 页时改行集),要用户点头再做 |
| 2 | 拍点 F 的建议半条:钉边常驻不收 | ⏎ 之后恒 `closeToDock('search')` | 同上,是行为裁定 |
| 3 | abort | 换词快时多发请求,靠「上一发落在它自己那一格」不上屏 | `@onething/client` 的 http Transport 收 `AbortSignal`,跨包一批 |
| 4 | 语义召回设置开关不热生效 | `settings.search.semantic.enabled` 在装配时读一次;页脚现在会说「下载中 / 建向量中(剩 n)」,但改开关要等下一次 core 启动 | 归检索方案 §13 留账(后端的事) |
| 5 | `gate:perf` 的「20 页累加后 heap 增量」读数 | 没加(风险 1 里许过) | 归 perf 线 |
| 6 | `golden-snapshot` 的「能力内 id 唯一」断言 | 没加(风险 10 里许过) | 一行断言,归后端 |
| 7 | 组件行数上限没有门 | 附录 B §1 的「≤120 行骨架」只在表里 | 若漂再加 `assembly-gate` 式棘轮 |
| 8 | 全部档两条预算路共用同一放宽阶梯 | 第九步门证明了「第二页不重不漏」,但两条路的 `level` 仍可能不同 | 后端让两条路共用一张阶梯,归检索方案 |
| 9 | `search.placeholder` 那句兜底 | 自述还没回来时画「搜索…」;真机上这一帧短到看不见 | 无 |
