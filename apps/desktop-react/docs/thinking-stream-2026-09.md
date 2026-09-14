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
