# 思考段分块流式(2026-09-14)

## 0. 病(真机量的,会话 cd4351d3「Lenovo-scripts 需求整理」)

- 该会话流式字符 95.6% 是思考:1,247,359 字思考 vs 57,315 字正文,最大四条各 14–20 万字。
- `ThinkingSegment` 把整段思考放进**一个** `<p class=thoughtBody>`(`white-space: pre-wrap; overflow-wrap: anywhere; -webkit-line-clamp: 1`)。流式时每帧换一次完整文本,浏览器把整段重排一遍。line-clamp 只裁显示不省排版,`overflow-wrap: anywhere` 让每个字都是断行点。
- 用同样式同宽度在真桌面上量:2,000 字一次重排 0.7ms;163,775 字一次重排 71–136ms(五次 135.5 / 87.3 / 101.3 / 71.3 / 80.6)。这就是 PerfHud 里流式期间每帧 style+layout 100–136ms、render 150–340ms 的产地。
- 排除项:数据链路便宜(解析 10342 条事件 67ms、折叠 22ms、物化 11ms、每条 delta 增量物化 0.03ms、50 条消息装配 47ms、分页 RPC 2.27MB 21–60ms);停靠池里 175 段共 104 万字收起的旧思考因 content-visibility 只差 ~1ms。**只有正在流的那一段是负担**。

## 1. 原则(与 stream-render §6 同一条法)

思考不是一个字符串,是**一串块**。正文那边 R4 立的「稳定前缀 + 活动尾」搬过来:切点之前的块冻住(同 key、同实例,DOM 不再碰),每帧只换活动尾那一小块。正文的切点判据是 markdown 语法,思考是纯文本,切点判据退化成一条:**换行**。

代价上限由数字钉死:活动尾无论如何不超过 4,000 字 —— 一次重排 ≤ 1.5ms。

## 2. 骨架:一个机制,思考只是第一个消费者(陌生能力演练)

新件 `content/text/text-stream.ts`:`TextStream`(与 `markdown/incremental.ts` 的 `MarkdownStream` 同形同寿命),把「一段不断追加的纯文本」变成「冻住的块 + 活动尾」。它不认识思考、不认识 UI。

```ts
interface TextBlock { readonly id: string; readonly text: string }   // id = `${frameId}#${index}`,冻住后永不变
interface TextFrame { readonly blocks: readonly TextBlock[]; readonly cut: number; readonly tail: string }
class TextStream {
  frame(id: string, text: string, live: boolean): TextFrame   // 同 id 连续调用 = 增量;前缀块实例复用
  forget(id: string): void
}
```

切点规则(`stableTextCut(text, prevCut)`,纯函数):
1. 只在 `prevCut` 之后往前找,从不回退(冻住的块永不重切 —— 与 stable-cut 同一条不对称:切少了只是多算一点,切错了屏幕会变)。
2. 候选 = 最后一个 `\n` 的后一位;活动尾长度 = `text.length − cut`。
3. 活动尾 > 4,000 字且其中没有 `\n`:在 2,000 字之后第一个空白处强切;没有空白(整段无空格的长 token)就在 4,000 字硬切。
4. `live === false`:全部冻住,`tail = ''`。

演练:下一个要流长纯文本的段(这条会话里 tool-input 就有 124,794 字)= 它自己的段模块 + `SegmentView` 里自己那一个 case,`TextStream` 一行不改;`ChatStream` / `assemble` 的骨架不出现「思考」两个字。

## 3. 装配层(`assemble/index.ts` 的 `reasoning` case)

与 `text` case 同形:`textToFrame(\`${message.id}#${segments.length}\`, node.text, live)`,段模型改成

```ts
| { kind: 'thinking'; blocks: readonly TextBlock[]; tail: string; live: boolean; preview: string }
```

`preview` = 第一块前 240 字(收起时唯一挂载的东西,见 §4)。装配缓存(`content/assemble` 的 WeakMap)照旧:消息实例没换就整段复用。

## 4. 渲染层(`ThinkingSegment`)

| 态 | 挂载什么 | 每帧代价 |
| --- | --- | --- |
| 收起(默认,含流式中用户手动收起) | `FoldTrigger` 内一行 `preview`,line-clamp 1 | 0(preview 不随 delta 变) |
| 展开·流式中 | 冻住块各一个 `<p key=block.id>`(memo,props 不变不渲染)+ 活动尾一个 `<p>` | 只重排活动尾 ≤ 4,000 字,≤ 1.5ms |
| 展开·已完成 | 全部块,无活动尾 | 0 |

- 收起态**不挂载正文**:停靠池里 104 万字的旧思考从 DOM 消失,只剩每段 ≤ 240 字预览。
- 块之间零外边距,块文本保留自己的换行(pre-wrap 照排),所以视觉与今天单段逐像素一致 —— 这一条由 §6 的对照门证,不由人眼证。
- `Fold` 的 API 不动;`live → expanded` 的自动开合逻辑不动;`useNoteUserExpand` 不动。
- CSS:`.thoughtBody` 拆成 `.thoughtPreview`(今天的 clamp 那一份)与 `.thoughtBlock`(pre-wrap / anywhere / 零边距);`.thoughtOpen` 的语义不变。

### 状态先行三表

表 1 · `TextStream` 条目的生命周期(寿命 = 这一条消息这一段思考)

| 事件 | 变化 |
| --- | --- |
| 第一帧 `frame(id, text, true)` | 建条目:`cut=0`,按规则切,冻住块 0..n-1,尾 = 余下 |
| 后续帧 | 只在旧 `cut` 之后找新切点;新冻块追加,旧块实例原样 |
| `frame(id, text, false)` | 全冻,尾清空 |
| 消息实例换掉 / 会话卸载 | `forget(id)`(与 `MarkdownStream.forget` 同一处调用) |

表 2 · UI 生命状态:见上面那张挂载表。

表 3 · 交互:只有「展开 / 收起」一个动作,归 `Fold`;本单不加交互。

## 5. 分期

| 期 | 内容 | 门 |
| --- | --- | --- |
| T1 | `TextStream` + `stableTextCut` + 段模型 + 装配 case;不碰 UI | 单测:前缀块实例跨帧全等;切点单调不回退;尾 ≤ 4,000 字恒成立(随机追加 fuzz);`live=false` 全冻;`forget` 后重来从 0 起 |
| T2 | `ThinkingSegment` 分块渲染 + 收起只挂预览;CSS 拆分 | vitest DOM 对照:分块渲染与单段渲染 `textContent` 逐字相等;收起态 DOM 字符 ≤ 260/段;真机门(见 T3 的 ①②) |
| T3 | `gate:thought`(挂进 `gate:perf` 家族,用它现成的 headless 夹具与 LoAF 探针) | ① 用 20 万字思考的夹具流式 60s:思考阶段 long frame = 0、style+layout p95 < 8ms、活动尾 `<p>` 字数 ≤ 4,000;② 分块与单段两种渲染在 3 个窗宽下 `offsetHeight` 相等(视觉等价);③ 停靠 5 条思考型会话后,收起思考的 DOM 总字符 < 5,000 |

反证(交卷时附):把 §2 规则 3 的强切拆掉 → ① 的活动尾断言红;把块的 memo 拆掉 → ① 的 long frame 断言红;把收起态改回挂全文 → ③ 红。

预期:流式思考每帧排版从 71–136ms 降到 ≤ 1.5ms;收起思考的常驻 DOM 从 104 万字降到 ~4 万字。

## 6. 不在本单里、记账

- 切会话时的四处强制布局(录到的 192ms):`ui/Tabs.tsx` `clippedTabIds` 逐 tab 读 clientWidth 86ms、`ChatStream.tsx:370` clientHeight 60ms、`content/kinds/session.tsx:110` 19ms、`files/useRowWindow.ts:10` 17ms。另开一单,量法同上(cpuprofile 按 forced-layout 叶子聚合调用链)。
- 一个拍点,缺省照旧:收起态的预览今天取**开头**一行;流式中用户手动收起时,是否改成显示**最新**一行。本单按缺省(开头)做。

## 7. 施工账:T1+T2(09-14,opus 执行,Fable 审)

四条门:vitest `src/content` 96 文件 1489 例全过(新增 15 + 4);tsc 0;eslint 0;`ui:consume` 31 条在基线内、三条硬闸 0。

与 §2–§4 的出入,审后全部接受:
1. `stableTextCut` 只走一格,循环在 `frame` 里 —— 块边界必须等于切点,一帧连跳三格只能得到三个块,不能得到一个三格宽的块。
2. 规则 ③ 的「且其中没有 `\n`」不再判:规则 ② 落刀在最后一个换行之后,活动尾结构上无 `\n`。
3. `forget` 排在 `frame(…, false)` 之后(markdown 那边是之前):收尾帧要接着流式的块冻,否则已画好的块集体换 id。推论:从未在本进程流过的历史思考冻出来是**一块**;块边界是「帧怎么到的」的影子,不是文本的性质。
4. `preview` 一块未冻出来时取活动尾(都是开头 240 字)。

反证:拆规则 ③ 强切 → 4 条红;收起挂全文 → `200006 ≤ 260` 红;冻块每帧重建 → 3 条红;活动尾带随内容变的 key → DOM 同实例断言红;**拆 `ThoughtBlock` 的 memo → jsdom 里仍全绿**(React 重渲但宿主发现文本相同不写 DOM),这一格只能由 T3 ① 的长帧读数守。fuzz 第一版是绿的谎话(换行太密从没走到强切),改成成段不换行并自证出现过 > 4,000 字无换行后缀后才真的能红。

记账:
- **强切边界 = 一个原文没有的换行**(两个块级 `<p>` 之间必然断行;把块改成行内元素会回到同一个行内格式化上下文、代价回到 O(n))。真数据(该会话 166 段思考、144,136 行)最长无换行段 968 字,规则 ③ 在真店里从未触发;T3 ② 的高度等价只对自然切点断言,>4,000 字无换行的情况按本条记为允许的偏差。
- `gate-stream-structure.mjs` 用 `[data-testid="chat-thought"]` 当祖先滤,思考内新增的 `<p>` 被 `closest` 排除,结构不受影响;真机门归 T3 跑。

## 7.1 施工账:T3(09-14,opus 执行,Fable 审)

真机门**不另起一道脚本**,做成 `gate:perf` 的**场景⑥**(`scripts/gate-perf.mjs`,+718 行):
它自带的假 provider、离屏窗、CDP trace、LoAF 第二路读数、`assertScenario` 全部照用。
同一批加了一条 `--only=<场景>[,…]` 的闸(键 = 场景表上的编号),**种子跟着闸走** ——
不点 ④ 就不种那条 6MB 的大会话,不点 ①② 就只种一条会话,否则「只跑一格」照样要等
十分钟的种子。`node scripts/gate-perf.mjs --only=6` 单跑约 3 分半。

编号与 §5 不一致一处:**这道门里 ⑤ 已经被「常规档切会话」占着**,所以 T3 这一格是 **⑥**,
§5 T3 的三条判据对应 ⑥a / ⑥b / ⑥c。

### 夹具

假 provider 多一支(记号 `@@perf6@@` / `@@perf6seed@@`):吐 `delta.reasoning_content`。
量的那一条 **200,000 字**思考,成段、每段 300–900 字、`\n\n` 分段、中英混排,节奏
**16ms 一帧 / 每帧 60–120 字**(与 `SessionStreamCoalescer` 的 16ms 合批同拍),实测
provider 净吐 **37.6–38.2s / 2,210–2,237 片**,屏幕上的思考阶段 36.8–37.3s。停靠池那一支
5 条会话 × 3 段 × 30,000 字,种子不讲节拍。设置里 `deepseek-chat` 的 `reasoning` 从
`false` 改 `true` —— **从种子那一刻起就开着**(开在场景自己那一段里会让种子那 15 段落在
关着的世界里,⑥c 于是拿一个空盘子答「< 5,000 字」)。读回来那一侧其实不看这一格:
`openai-chat-wire` 的 `thinking.decode()` 无条件跑,`deepseek-inferred` 只认
`reasoning_content`;写出去那一侧对非 reasoner 型号也一个思考字段都不发。

### 读数(dev 构建 = `npm run app:build` 的产物,与 `gate:perf` 其余场景同一档)

| | 本批 | 拆掉之后(反证 A2) |
| --- | --- | --- |
| 每帧 style+layout p95 | **1.63ms** | 18.63ms |
| 每帧 style+layout 最长 | 17.48ms | 43.65ms |
| **一次重排**(单个 `Layout`/`UpdateLayoutTree`)p95 | **0.71ms** | 30.31ms |
| 一次重排最长 | 6.36ms | 49.07ms |
| 活动尾最长(每 500ms 一采,75 采) | **850 字** | 199,245 字 |
| 思考里 `<p>` 条数 | 4 → 336 单调不减 | 恒 1 |
| 思考阶段 >50ms 长帧 | **0 条** | 1 条 |
| 主线程 toplevel 任务 | 30,853 段 / 最长 53ms | 72,054 段 / 最长 59ms |

「一次重排」那一行与 §0 那把尺子是同一个东西:**0.71ms**(p95)对着 §0 里
「2,000 字 0.7ms」那一格,而拆掉之后的 **30.31ms** 落在 §0「163,775 字 71–136ms」
那一档的路上 —— §1 预期的「71–136ms → ≤1.5ms」成立。

⑥b 视觉等价:**三个窗宽下分块与单段的 `offsetHeight` 逐像素相等**
(900px 窗 → 思考段宽 448px,76,455 / 76,455;1280 与 1600 → 704px,51,962 / 51,962;
340 块 / 200,010 字)。§4「块之间零外边距、块文本保留自己的换行,所以与单段逐像素一致」
这句话由此**证了**,不再是推论。附带一条实测事实:**正文栏有上限(704px)**,1280 与
1600 落在同一个数上,所以三个窗宽只换出两种折行几何 —— 门把这一条单独断言并打印出来,
免得「三次量了同一个宽度」被读成三次。

⑥c:开 5 条,屏幕上挂着 **12 段**收起的思考(停靠上限 `SESSION_VIEW_PARK_LIMIT = 3`
加活动那一条 = 4 条会话 × 3 段),常驻 DOM **2,880 字** < 5,000;种进账本的是 450,000 字。
§5 T3 ③ 写的是「5 条 … 进停靠池」,而**一片叶只停靠 3 条** —— 门首跑就红在
「画出了 12 段 ≥ 15 段」上,那不是产品少画了,是判据不认识停靠池自己的上限;数改成从
`content/session-park.ts` 读回来(与 `readBudget` 同一手,不抄第二份)。

### 量法上的四条,每条都是首跑当场挖出来的

1. **`styleAndLayoutMs` 不能问 LoAF**。浏览器只报 ≥50ms 的帧,于是「长帧 0 条」绿的
   那一刻 p95 一个样本都没有,`p95 of []` = 0 —— 一句**绿的谎话**。改问 trace 里
   `AnimationFrame::StyleAndLayout` 的 `b`/`e` 对(每帧都有,3,851–3,957 帧)。
   门因此额外断言「有排版的帧 > 0」:0 帧是窗口圈错了,不是「没排版」。
2. **窄分类下 toplevel 任务不叫 `RunTask`**。`disabled-by-default-devtools.timeline`
   才给那个光秃秃的名字;只开 `devtools.timeline,toplevel,blink.user_timing` 时它是
   `ThreadControllerImpl::RunTask`。首跑因此报「主线程任务 0 段」。场景⑥自己数两个名字,
   **不动 `mainThreadTaskDurations`** —— 让它同时认两个名字会在默认分类下把同一段任务
   数两遍。窄分类是必须的:这一格要录 38s,全表一趟 99MB / 400k 事件。
3. **指纹要由产地钉死**。两份夹具文本的随机种子不同,但第一段都有 60% 的概率从同一句
   中文起笔 —— 首跑时 30 字的指纹匹配到了停靠池里那一段,⑥a 整趟盯着一段**收起着的**
   3 万字采样(活动尾恒 240、`<p>` 恒 1),四条判据全绿,而它们一条都没量到那条真在流的
   思考。现在两份文本各自以 `PERF6LIVE ` / `PERF6POOL ` 起笔,并有一句夹具自证。
4. **窗口的右沿是「它折回去那一刻」,不是「provider 吐完」**。第一版一路采到收尾之后,
   最后三采读到的是收起态(1 个 `<p>`、240 字),`<p>` 条数 342 → 1,「单调不减」当场红
   —— 而那不是回退,是思考段收尾自动折叠。判据改用 `aria-expanded`(`Fold` 自己报的),
   收尾那几帧(20 万字离开 DOM、正文上屏)留在窗口外面。每一采自己打一枚
   `perf6:tick:<n>`,窗口两沿 = 第一采与**最后一采还展开着**的那一枚。

### 反证(每条都真跑过,跑完还原;还原用备份文件,不 `git checkout`)

| 拆掉什么 | 结果 |
| --- | --- |
| **A2** `stableTextCut` 的规则 ②(永不落刀)+ `TAIL_LIMIT` 400,000 = 完全不切 | **3 条红**:活动尾 199,245 字、style+layout p95 18.63ms、长帧 1 条。这就是 T1 之前那条病本身 |
| **A** 只拆规则 ②(强切仍在 4,000) | **2 条红**:长帧 1 条;**⑥b 高度不等**(448 档 77,338 vs 76,455;704 档 53,056 vs 51,962)—— 强切边界等于一个原文没有的换行,§7 记的那条留账由此**量出来了**,偏差是每次强切多一行 |
| **B** 收起态改回挂全文 | ⑥c 红:常驻 DOM **360,120 字** < 5,000 |
| **C** 拆 `ThoughtBlock` 的 `memo` | 长帧 1 条,红;但 **style+layout p95 一动不动(1.63ms)**、一次重排 p95 0.70ms —— 与 T2 记的那条一致:memo 省的是 React 的调和,不是排版。主线程 toplevel 最长 53 → 66ms。**这一格只有一帧的余量**,它守得住但守得很紧 |
| **(不成立)** 只把 `TAIL_LIMIT` 改成 400,000 | **全绿** —— 规则 ② 在最后一个换行之后落刀,而这份夹具(与真数据一样)段长 ≤ 900,活动尾**结构上**到不了 4,000,规则 ③ 从不触发。§5 原写的这条反证在成段的文本上不可能红;能红的是「不切」,不是「切得晚」。这正是 §7 那条留账(真数据最长无换行段 968 字)的另一面 |

### 留账

- **⑥a 的长帧那一格只有一帧余量**:清跑两趟都是 0 条,而三种拆法各只多出 1 条。它今天
  守得住,但它守的是「有没有一帧超过 50ms」这句话的边缘;真要让「memo 拆了当场红」有
  厚余量,得再加一条**每帧调和耗时**的读数(trace 里 `FunctionCall` 按 React 归因),
  本单没做。
- **⑥ 跑在 ②③④ 留下的现场上**(右架子三块面板 keep-alive + 一条 6MB 大会话),这是
  刻意的 —— 那正是用户报障时的屏幕;单独起一间干净屋子量出来的「零长帧」证不了它。
  代价是 `--only=6` 与全跑的读数不完全同源(单跑时屏幕上只有停靠池那几条)。
- `gate:perf` 全跑(八格)本单**没跑完**,只跑了 `--only=6`;②③④⑤ 那几格与本批无关
  (场景⑥ 排在最后,且不改任何共享状态 —— 视口覆写在自己那一段里 `clear` 掉)。
- 正本 §6 那个拍点(流式中手动收起时预览显示开头还是最新)与本单无关,照旧记着。

### 合入前全门实测(09-14,Fable)
`gate:perf` 全八格在本单 worktree 跑,⑤「常规档切会话」在 `[4/9]` 超时(`切到 PERF5SESS-… 超时`,60s 内聊天区前三个节点没出现记号)。隔离:HEAD 版门脚本 + T1+T2 构建同样超时;**main d46af6b04 原样代码、独立 worktree 自建 dist** 也同样超时 → ⑤ 今天在 main 上就是红的。同法证得 ②(Dock 瓦 `diff` 右键菜单里没有「钉到边 ▸ 右边」,夹具取件口落后于 main)与 ④(core 进程 CPU 中位:main 基线 120%、本单 111%、本单 `reasoning:false` 75%,预算 40%)在 main 上同红;① 冷开 64 / 72 / 78 / 120ms 四趟三绿一红,随机器负载(当时 swap 20.1/21.5GB、load 8)抖。本单能跑的 ③ 与 ⑥ 各两趟独立全绿(⑥ 第二趟:活动尾最长 758、p95 1.68ms、三窗宽高度相等)。②④⑤ 归 `gate:perf` 自己另开一单修夹具与预算,不在本单。
