# 压缩折痕 + 上下文更新 chip + 读数环动效(2026-09-08)

起因:09-08 事故里,压缩失败落在会话里的是一条 system 消息的原始 JSON;压缩进行中、
压完之后、`<context-update>` 尾块变了,壳上都没有任何元素或动效。引擎侧的修法在
`docs/design/context-compact-budget-and-cards-2026-09.md`,这里是壳的那一半。
样例页:`compact-seam-proposal-2026-09-08.html`(同目录)。

## 1. 三句话

1. **压缩不是一件物件,是流里的一道折痕。** 它说的是「这条线以上已经折进摘要」,所以画成一条贯穿整行的细线加一枚居中的标签,不画成一张卡(错误卡那种物件档留给「一件东西」)。
2. **动效只在线上走,不转圈。** 进行中是一束光沿折痕来回扫;多块时线本身按 k/N 填色。壳的禁令「Spinner 只许出现在按钮内或状态栏」在这里成立。
3. **读数环是 context 更新唯一的动效落点。** 环弧从今天的「跳变」改成「滑到新值」;压缩进行中环弧脉动;压完那一下环弧肉眼可见地缩回去。这就是「context 更新在页面上看得到」。

## 2. 组件树

```
ChatStream
└─ MessageRow(role=system)
   └─ assembleMessage → segment { kind:'compact', marker }     ← 装配管线按内容自述分类,MessageRow 不加分支
      └─ SegmentView case 'compact'
         └─ CompactSeam                                          content/CompactSeam.tsx
            └─ Seam(data-state=running|settled|danger)          content/seam/Seam.tsx(09-09 抽的 content 级基座)
               ├─ SeamLine(progress fill via --seam-fill)       running:光扫 + 填色;settled:实线;danger:danger 线
               ├─ SeamLabel                                     文字 + SeamCount(k/N | 前→后)| SeamSentence(失败句)
               │  └─ 重试(ButtonBase ③ 行内微型动作,仅失败态)  骑 commandsPort.compactContext
               ├─ SeamBody(仅完成态,折叠的摘要正文)            ui/Fold 的 body 皮肤
               └─ SeamFoot「收起摘要」
└─ MessageRow(role=user)
   └─ .user 气泡
└─ article[data-context-of=<用户消息 id>]  ← 独立一行,不在 MessageRow 里(09-09 推翻)
   └─ ContextDeltaSeam(有 turnContext delta 才出这一行)        content/ContextDeltaSeam.tsx
      └─ Seam(data-state="settled")                            content/seam/Seam.tsx
         ├─ SeamLine / SeamLabel(FoldTrigger)「上下文更新 · 变量 2 · 待办 1」+ chevron / SeamLine
         ├─ SeamBody → 每块一行:块名 · set/removed · 正文
         └─ SeamFoot「收起」
Composer
└─ ContextRing                                                   composer/components/MeterCard.tsx
   ├─ 弧:transition stroke-dasharray --dur-release             每次 context 更新都滑
   └─ [data-compacting] 弧脉动 --kf-tool-pulse                  读 selectCompacting(ledger)
```

数据零新协议:折痕三态与 k/N 全在 marker 正文里(后端每块完成就刷一次占位消息的 content);
环的「压缩中」= 账本上最新一条 context-compact system 消息 status 为 compacting,是个 selector,
不订阅 `context:compact-*` 事件。唯一后端补一行:completed marker 加 `contextSizeBefore`,
不然「前 → 后」那格只有后。

## 3. 三张状态表

### 3.1 CompactSeam

| 态 | 判据(marker) | 线 | 标签 | 交互 |
| --- | --- | --- | --- | --- |
| compacting · 单块 | `status:'compacting'` 且无 `progress` | 光束沿线来回扫(`--kf-seam-sweep`,`--dur-seam-sweep` 1.6s,无限) | 「正在压缩上下文」 | 无 |
| compacting · 多块 | `status:'compacting'` 有 `progress {chunk,totalChunks}` | 光扫 + `--seam-fill: chunk/total` 从左填 accent | 「正在压缩上下文 · 2 / 5」 | 无 |
| completed | `status:'completed'` | 实线 `--line-1`,进入时 `--kf-settle` | 「已压缩 42 条 · 701k → 96k」+ chevron | 点标签展开摘要(ui/Fold,默认折);Enter/Space 同 |
| completed · 无 before | 同上但 marker 缺 `contextSizeBefore` | 同上 | 「已压缩 42 条 · 剩 96k」 | 同上 |
| failed | `status:'failed'` | `--danger` 细线,`--tint-danger` 标签底 | 「压缩失败」+ provider 那句原文(不改写)+「重试」 | 重试 → compactContext;引擎忙时钮 disabled(同 09-08 重试钮判例) |
| stale(卡死超时改判) | `timeline.ts` 纯函数改判后的 failed | 同 failed | 「压缩中断」+ 那句固定文案 | 同 failed |

reduced-motion:光扫与脉动关闭,填色与 settle 保留(它们是状态,不是装饰)。

### 3.2 ContextDeltaSeam(U3 时叫 ContextDeltaChip)

**09-09 推翻**:不挂气泡下,改为**用户消息与下一条之间的一道折痕行**
(`article[data-context-of]`,`content/ContextDeltaSeam.tsx`)。理由 = `turnContext` 是
**宿主在这一回合开始时补给模型的上下文**,是**回合**的事、不是用户说的话;数据照旧
存在用户消息上(账本不动),只有呈现改族 —— 它与压缩折痕同属「系统在两回合之间做的事」。
下表的「呈现」一列原文不删,读的时候按这一行改判。
出场那一下走 `--kf-settle`(报障:回合一开始它凭空冒出来、把用户那行顶高);**根治不在壳** ——
它在引擎写 `turnContext` 的时机(`buildPrompt` 之后),壳只能让它出现得不突兀。

| 态 | 判据 | 呈现 | 交互 |
| --- | --- | --- | --- |
| 无 delta | `message.turnContext` 缺或 set/removed 皆空 | 不出 | — |
| 折叠 | 有 delta | ~~气泡下一行 fs-micro,右对齐随气泡~~ → 09-09 推翻:折痕行,居中标签:「上下文更新 · 变量 2 · 待办 1」(块名按 set 的键分组计数;removed 单列「移除 1」)+ chevron | 点/Enter 展开 |
| 展开 | 用户点开 | ui/Fold 内每块一行:块名 + 正文(pre-wrap,最多 `--block-clamp-h` 后 clamp,走 BlockShell 的展开);removed 行划线 | 再点收回;选区非空不切换(同 ThinkingSegment) |
| 流式中 | 该用户消息的回合还在跑 | 与折叠态同,不动效 | 同上 |

计数是文字读数,不是徽标(计数禁令只禁 tab/列表/组头挂徽)。

### 3.3 ContextRing

| 态 | 判据 | 弧 | Tooltip 卡 |
| --- | --- | --- | --- |
| 未知 | contextMax 或 used 为 null | 点线底圈,无弧(现状) | 「上下文用量 未知」(现状) |
| 静态 | 有读数,无压缩 | 实弧,`stroke-dasharray` 过渡 `--dur-release` —— 每轮 run/end 读数变化时弧滑到新值 | 现状四行 |
| 压缩中 | `selectCompacting` 为真 | 弧脉动 `--kf-tool-pulse`(opacity 0.35↔1,`--dur-tool-pulse`,alternate 无限) | 多一行「正在压缩 · 2 / 5」(单块无 k/N) |
| 压完 | compacting → 完成,`session/compacted` 触发重拉 | 脉动停,弧从旧值滑到新值(同一条过渡,肉眼可见地缩) | 回到四行 |
| 压失败 | compacting → failed | 脉动停,弧不动 | 回到四行;失败在折痕上说,环不重复播报 |

## 4. 候选与取舍

- **折痕 vs 物件卡**:样例页两种并排。推荐折痕;物件卡放着做对照,不建议选——它把「折了 42 条」说成「多了一件东西」。
- **光扫 vs 三点跳**:光扫是这条线自己的动作;三点跳(`--kf-dots`)是文字的动作,会把标签变成一个在说话的东西。选光扫。
- **摘要默认折**:压完那一刻用户在等回复,不在读摘要;要看时点开。与 ThinkingSegment「想完就折回去」同一口径。
- **失败不飞 toast**:它已经落在会话里且带重试,再飞是双重播报(09-08 判例)。

## 5. 施工顺序与门

| 单 | 内容 | 门 |
| --- | --- | --- |
| U1 | `ui/Fold` 基础件 + ThinkingSegment 迁上去(行为字节不变) | Fold 单测;ThinkingSegment 既有测试原样绿;`ui:consume` 基线内 |
| U2 | 装配管线 `compact` 段 + `CompactSeam` 三态 + i18n + motion.css 加 `seamSweep` 与 `--dur-seam-sweep` | `assemble` 单测(system 非 compact 正文仍走 rich-text);jsdom 六态;`motion-gate` 0 新增手写 keyframes |
| U3 | `ContextDeltaChip` | jsdom 四态;无后端改动 |
| U5 | 折痕抽成 content 级基座 `content/seam/`(`Seam` 族,状态词通用化 running/settled/danger)+ `ContextDeltaChip` → `ContextDeltaSeam` 折痕行 | `compact-seam.test.tsx` 原样绿(只有 `data-state` 三个词跟着基座改);`context-delta-seam.test.tsx` 加落点两条(折痕行紧跟用户行、用户行里没有它);`ui:consume` / `motion-gate`(0 新 keyframes)/ `squeeze-gate` |
| U4 | 环:dasharray 过渡 + `[data-compacting]` 脉动 + Tooltip 行;后端 marker 加 `contextSizeBefore` | MeterCard 测试 +3;`gate:a11y` 加一屏「折痕 + 环」 |

留账:折痕以上的消息不变灰(先看真机,变灰是第二步);摘要正文里的文件清单不做可点(消息引用那条线另有单);
`context:compact-progress` 事件在 React 壳仍无消费者(折痕读 marker 就够,事件留给状态栏类消费方)。

2026-09-12(报障两条,都落在上下文更新折痕上,`src/content/__tests__/expand-hold.test.tsx` 钉着):
**① 出场软着陆**——从前只淡入而高度与 `.column` 那格 32px 行距瞬间到位,淡入盖不住位移;
改成「事后出现的那一行」整行三量(高度 / 行距 / 不透明度)一起过渡,落点是
`ChatStream.module.css` 的 `.rowLate`(行距是 `.column` 的 gap,负 margin 必须与它同产地;
类名里不出现折痕的名字,第三种事后出现的行拼上它就够),起手那一格由**顶层 `@starting-style`**
给——挂载那一刻没有「改前」高度可量,FLIP 不成立,而一条会话几百道折痕不该各挂一只 RO。
**② 正文自上向下展开**——`Seam.module.css` 的 `.seamBody` 从整块 `--kf-settle` 淡入改成
`@starting-style` 起手的高度过渡(`padding-block` 也从 0 起,否则起手就有一格空盒子撑着);
收起仍是瞬间的,`display: none` 当拍生效、没有中间态可过渡。
**③ 点开的东西不许把人推到底**——展开与流式 delta 在几何上逐字相同(都让 gap 变大、
`scrollTop` 不动),所以由动手的那一方自述:新通道 `content/expand-intent.ts`(四个消费者:
两道折痕 / 思考段 / 工具卡,只在「打开」那一下报),窗长 `EXPAND_HOLD_MS = 220`
(= max(`--dur-release`, `--dur-card-flip`) + 40ms 余量),窗口内 `ChatStream` 那只 ResizeObserver
位置一动不动、按此刻离底多远重新判档。真机门 `gate:chat-follow` 加了 ⑨(贴底时点开视口里
一件收起着的可展开物,`scrollTop` 与它的上缘都一像素不动);反证实测:拆掉那一格,
`scrollTop` 10618.5 → 11216、那一行的上缘 553.2 → **−44.3**(被推出视口顶)。
**④ 顺手治了一条从没被量过的旧竞态**(真机页内探针,2026-09-12):浏览器一帧里先跑滚动
事件、后跑 ResizeObserver,于是内容一帧一帧长的时候,RO 贴的底会被**下一帧才派出去的**
滚动事件读成「离底 4.5px > `AT_BOTTOM_EPS`(2)」→ 判成人往上翻、跟底从此丢掉
(实测此后每条新消息离底 38 → 263 → 431 → … 逐条累加)。它不是容差调小了,而是**任何跨帧
的高度过渡每帧长 2–6px**,容差挡不住 —— `.rowLate` 一落地就撞上它。修法仍然只用位置、
零标志位:**人往上翻 = `scrollTop` 变小**;位置没往回走就不是人干的(判词在
`ChatStream` 的 `onScrollWithFollow`,`follow.ts` 文件头补了一行指路)。
