# Composer 引用种类注册表(2026-09-12 立,正本)

> 起因:09-12 用户连报五条 composer 使用问题,三批修完(9013cf67 / a00e1728 / 9b0d160d)之后用户问
> 「以后加什么东西,渲染是不是可以扩展的,你有没有做这方面的设计」。答:**没有**。今天「一种引用」
> 的知识散在三处各自枚举 —— 拾取端(`@` / `/` 抽屉)五处、落稿端(`ComposerInput.insert(kind)`)一处、
> 呈现端(`content/user-message.tsx` 按文本切段一张 switch + 按 `contentParts` 部件一张 switch)两处。
> 本正本把 `docs/handoff-composer-mention-sources-2026-09.md`(浏览器批立的、只管抽屉的注册表)扩成
> **整条链**,并吸收对它的三处修正(§4)。法条:仓根 CLAUDE.md「加功能不许改骨架 / 能力自述、别人读表」。

## 1. 一种引用的生命周期(五个环节)

| 环节 | 今天在哪枚举 | 一种引用要回答的事 |
| --- | --- | --- |
| 拾取 | `composer/types.ts` `DrawerKind` / `TokenHit.kind`;`transitions.ts` `parseToken` 两条正则;`usePickDrawer.ts` 8 处分支;`DrawerPickList.tsx` 6 处分支 | 哪个触发字符下出现、候选怎么查、一行画什么、怎么分组、表头 / 空态 / 取数状态 |
| 落稿 | `ComposerInput.insert(kind: 'files' \| 'commands')` | 选中后 chip 写什么、草稿里的 token 长什么样、出站时 token 展开成什么句子 |
| 认出 | `user-message.tsx` `segmentUserMessage`(文本)+ `segmentUserParts`(部件) | 从出站句子 / 从 `contentParts` 部件里怎么认出它 |
| 呈现 | 同上两张 switch 的每个 case | 图标、标签、Tooltip 文案键、是不是可点(数据,不是 JSX) |
| 打开 | `RefChip` / `SkillChip` 各自的 onClick | 点了做什么:查看器 / 目录面板 / 浏览器 / 无 |

「发出去的东西」今天的五种(正本表在 `user-message.tsx` 文件头):文件、目录、技能、命令、网页;提示词是第六种但壳里还没有能打开它的面。

## 2. 目标形:一种引用 = 一份自述 + 一行登记

```ts
// apps/desktop-react/src/references/kind.ts(新)
export interface ReferenceKind<Hit = unknown, Ref = unknown> {
  id: string                                   // 'file' | 'dir' | 'skill' | 'command' | 'page' | 'session' | …

  /** 拾取:缺席 = 这种引用不从抽屉进(比如网页今天从浏览器叶的 ⋯ 菜单进)。 */
  source?: {
    trigger: '@' | '/'                         // 触发字符;同一字符下可以有多种(文件 + 网页 + 会话都在 @ 下)
    where?: 'anywhere' | 'line-start'          // 命令只认句首
    query(q: string, ctx: PickContext): PickResult<Hit>   // {hits, status:'ready'|'loading'|'error'} —— 取数状态进契约
    row(hit: Hit): RowSpec                     // {primary, secondary?, meta?, icon} 数据,不是 JSX
    group?: MessageKey                         // 这种引用在抽屉里的组头;同一触发字符下按种类分组,分组只许一次
    empty?: MessageKey
  }

  /** 落稿:选中之后。 */
  draft: {
    chip(hit: Hit): { label: string; icon: IconName }
    token(hit: Hit): string                    // 写进草稿的位置记号,如 {{file:/abs}}、/skill:name
    expand?(token: string): string             // 出站时记号 → 句子;缺席 = 记号本身就是句子(/skill:name)
    argHint?(hit: Hit): string | undefined     // 命令那种的参数占位
  }

  /** 认出:两条产地,各自可缺席。 */
  parse: {
    text?: { pattern: RegExp; toRef(match: RegExpExecArray): Ref | null }   // 出站句子里,如 (^|\s)@(/…)
    part?: { type: string; toRef(part: unknown): Ref | null }                // contentParts 里,如 'skill-ref'
  }

  /** 呈现:数据,不是 JSX。 */
  render(ref: Ref): ChipSpec                   // {icon, label, tooltipKey, tooltipArgs, clickable}

  /** 打开:缺席 = 只是个记号,不可点。 */
  open?(ref: Ref): Promise<boolean>
}

export function registerReferenceKind(kind: ReferenceKind, hot?: ImportMetaHot): void
```

- 注册表 `references/registry.ts`,体例照 `workbench/kinds.ts` 的 `registerContentKind`(重复 id 拒、`import.meta.hot` 退役)。
- **抽屉按触发字符开**(`DrawerKind` 的来源半边收成 `{kind:'pick', trigger:'@'|'/'}`),抽屉把该字符下所有种类的 `query` 并起来、按种类分组、扁平序走键盘位;`parseToken` 由表里的 `trigger` / `where` 生成。这是对 handoff 文档的修正 ①:它把抽屉的种写成 `'source:<id>'`,第一个共用 `@` 的种类就得再改骨架。
- **取数状态进契约**(修正 ②):`query` 回 `{hits, status}`,抽屉的「正在找 / 旧候选留屏 / 失败并陈 / 真无匹配」四态从表读,不再按种类特判。
- **落稿的展开在草稿出口**(修正 ③,a00e1728 之后的事实):`ComposerInput.readDraft` 读到 chip 的 `data-kind` + `data-token`,查表 `expand`;`chat-port` 不再展开任何记号(它只做 `{{page:}}` 的发送时物化,那是附件不是句子)。handoff 文档写的「chat-port 展开顺序是闸」已过时,施工按当前树。
- `user-message.tsx` 的两张 switch 收成一条通路:`contentParts` 有就按 `parse.part` 表认、text 部件再按 `parse.text` 表切;都认不出的照旧当文字;画一律走 `render`,点一律走 `open`。核心文件里不出现任何一种引用的名字。
- `model` / `status` 两位抽屉住户不是引用,留在原位。

## 3. 陌生能力演练(交卷前必答)

「@ 一条会话」:`references/kinds/session.ts` 一份自述(trigger `@`、`query` 走 `sessions-source`、token `{{session:id}}`、
`expand` 成 `@session:<id>`、`parse.text` 认它、`render` 画会话图标 + 标题、`open` = `enterSession`)+ `references/index.ts`
一行登记。`composer/**`、`content/user-message.tsx`、`content/ChatStream.tsx` **一字不动**。答不出这句 = 骨架没抽到位,打回。

## 4. 与 handoff 文档的关系

handoff 的 §1 诊断(五处枚举)与 §3 判例照收;§2 的 `MentionSource` 被本正本的 `ReferenceKind.source` 半边取代,三处修正见 §2;
§5「不做」照旧(不动 model / status、不改 token 语法、不给插件开口)。做完本正本,handoff 文档归档。

## 5. 施工序与门

1. 先落 09-12 抽屉即显那单(固定尺寸、绝对定位、不计入 `--composer-h`),视觉形定了再迁 —— 等价迁移的截图对照只做一次。
2. 立 `references/`:kind.ts / registry.ts / kinds/{file,dir,skill,command,page}.ts / index.ts;五种先迁,行为逐字不变
   (壳 CLAUDE.md「迁移 = 等价替换」:`Composer.test.tsx` / `user-message.test.tsx` / `usePickDrawer` 既有用例**一条不改**就得绿;
   真机逐态截图零像素差)。
3. 结构测试:五处旧枚举点 grep 为零;注册表登记 / 重复拒 / HMR 退役;`parseToken` 由表生成;演练「第六种只加两处」。
4. 门:`ui:consume` 32 基线 + 硬闸 0;`gate:composer-drawer` 全绿;`gate:a11y` composer 屏不红;第 5 轴:`@` 键入到抽屉出候选首帧 ≤ 16ms、
   候选刷新零 ≥50ms 长帧(文件多时 `query` 可异步 + 上一批候选留屏)。
5. 反证:拆掉 `kinds/page.ts` 那一行登记 → `@` 里没有网页组、门红;`parseToken` 改回手写正则 → 结构测试红;`user-message` 改回 switch → 结构测试红。

派工:Fable 拆分审查 / opus 执行 / haiku 提交;交卷带三张状态表与第 5 轴读数。

## 6. 所见即所发(2026-09-14 立;样例 `composer-wysiwyg-proposal-2026-09-13.html`,用户拍「可以,注意可扩展性和维护性」)

**一条法**:用户在输入框里看见什么,发出去的气泡就是什么,从按下回车那一刻起一个字不变。

### 6.1 今天为什么闪

发送一条 `@文件` 这一路今天有**三份形**:composer 里的 chip(`ComposerInput.insert` 用 `document.createElement` 画,标签是 `@相对路径`)、在飞的乐观气泡(`ChatStream.tsx:1301` 画 `{entry.text}` 纯文本 = `@/绝对路径`)、落账后的气泡(`user-message.tsx` 按 `contentParts` 切段 → `ReferenceChip`,标签是 basename)。三份形三个产地,所以用户看见「chip → 整串路径 → 另一种 chip」两次切换。8ca51365 / f34c573f 治的是「第二条气泡不消失」,没治「同一条气泡换了三次形」。

### 6.2 目标形:段是真相,文本是投影,一个渲染器三个宿主

```
composer 草稿 ──读出──▶ ResolvedSegment[] ──投影──▶ 线上文本(各家 draft.token / expand)
                              │
                              ├──原样──▶ 在飞乐观气泡(PendingSend.segments)
                              │
账本 contentParts ──切段──▶ ResolvedSegment[] ──▶ 落账气泡
                              │
                       同一个 <SegmentsView>(= 今天 user-message 的 SegmentView + ReferenceChip)
```

- **`ResolvedSegment[]`(`references/segment.ts` 已有)是三处共用的唯一数据形**:`{kindId:'text', value:{text}}` 或 `{kindId:<种类>, value:<Ref>}`。它不是新形,是今天落账气泡已经在用的那份。
- **composer 的草稿读法加一口 `segments()`**,`text()` 改成它的投影(逐段:文字原样,引用格问该种类 `draft.token(ref)` 再 `expand`)。今天 `readDraft` 走的是「chip 节点 → `data-token` → 展开」,改成「chip 节点 → `data-kind` + `data-ref`(Ref 的 JSON)→ 段」,文本由段算出来。**草稿存的 `html()` 不变**(chip 节点自带这两格属性,存草稿 / 铺回去照旧)。
- **`PendingSend` 加 `segments`**:`chat-source.send` 那一刻把 composer 交出的段整份放进乐观 entry(与 `messageId` 同一次 `set`);`text` 留着当线上形与文本兜底。在飞气泡画 `<SegmentsView segments>`,**不再画 `entry.text`**。
- **composer 里的 chip 也由 `ReferenceChip` 画**:chip 宿主节点只是一个 `contenteditable=false` 的空 span(带 `data-kind` / `data-ref` / `data-token`),`ComposerInput` 用 `createPortal` 把 `<ReferenceChip kindId value>` 画进去(每个宿主节点一个 portal,节点表由 `insert` / `restore` / 退格删除三处维护)。于是 composer chip、在飞 chip、落账 chip 是**同一个 React 组件同一份 `render(ref)`**,连 hover / tooltip / 可点都一样。`ReferenceDraft.chip(hit): ChipDraft` 这一格退役,换成 `toRef(hit): Ref` —— chip 上写什么由 `render(ref)` 一处说了算,不再有「草稿里一种写法、气泡里另一种写法」。
- **落账不换节点**:乐观行与账本行今天分两处画(账本 `messages.map` 之后再 `overlay.map`)。改成**一张有序表**:`rows = 账本行 ∪ 未认领的乐观行`,乐观行的 key 用 `messageId`,账本行的 key 用 `message.id`,两者是同一个字符串,元素类型同为 `<UserBubble>` —— React 在同一个父数组里按 key 对上,DOM 节点保留,落账那一拍只改 `data-pending` / opacity。这就是样例页「屏上读数:气泡 DOM 前后逐字相同」在真壳里的实现。没有 `messageId` 的旧形 entry(steering 降级)仍是自己的 key,落账时换节点 —— 留账,那条路要根治得改 `steerMessage` 签名。
- **第二个进入 composer 的口也走段**:`insertComposerReference` 从 `{label, token, tip}` 改收 `{kindId, ref}`(网页那份自述补 `render`;`BrowserActionsMenu` 只改这一处调用,是别批的地,单独一笔)。

### 6.3 契约改动(只动自述,核心零种类名)

| 格 | 今天 | 改后 |
| --- | --- | --- |
| `ReferenceDraft.chip(hit)` | 交 `{label, tone}`,composer 自己画 | **退役** |
| `ReferenceDraft.toRef(hit)` | 无 | 新:抽屉选中的候选 → Ref |
| `ReferenceDraft.token(ref)` | 收 hit | 改收 Ref(线上记号由 Ref 算) |
| `ReferenceKind.render(ref)` | 只给气泡 | 三个宿主都读它 |
| `ReferencePartParse.typed` | f34c573f 加的 | 不动 |

`kinds/{file,dir,command,skill,plugin,prompt,page}.ts` 各自补 `toRef`、`token` 改签名、页面那份补 `render`;`ComposerInput` / `chat-source` / `ChatStream` / `user-message` 里仍然一个种类名都没有。

### 6.4 陌生能力演练

「@ 一条会话」:`kinds/session.ts` 一份自述(`source` 拾取、`draft.toRef/token/expand`、`parse.text/part(+typed)`、`render`、`open`)+ `index.ts` 一行 → 抽屉里选得到、composer 里画成会话 chip、按回车在飞气泡里就是同一枚 chip、落账后还是它、点它进会话。`ComposerInput` / `chat-source` / `chat-fold` / `ChatStream` / `user-message` **一字不动**。结构测试 §5 第 3 条扩到「在飞气泡也画得出」。

### 6.5 门与验收

- `gate:composer-send` 加两条:发送后**每 16ms 采一次**那条用户气泡的 `innerText` 与 chip 数,从乐观到落账到 AI 回完**逐样本相同**;落账前后那条气泡是**同一个 DOM 节点**(CDP `DOM.resolveNode` 的 objectId 相同,或页内 `WeakRef` 探针)。改前红(今天中间那一段是整串路径)、改后绿。
- 等价迁移:composer chip 的形从 `@相对路径` 变成 `render(ref)` 的形(图标 + basename,Tooltip 全路径)—— **这是本单唯一可感知的形变**,是「所见即所发」的直接后果(三处必须同一形,气泡那形已经定了两天);其余截图对照零像素差。
- 单测:`ComposerInput` 的 `segments()` / `text()` 互为投影(`text() === project(segments())`)、`restore(html())` 往返段不变、退格整枚删 portal 表同步;`chat-fold` 认领后行 key 不变;`ChatStream` 同 key 节点保留(`toBe` 同一引用)。
- `ui:consume` 32 + 硬闸 0;`gate:composer-drawer` / `gate:a11y` composer 屏不红;施工进 worktree(`ChatStream.tsx` 是活树上别批的热文件)。

### 6.6 留账

steering 降级路无 id 落账换节点;`ComposerInput` 从「唯一动 DOM 的地方」变成「唯一动 DOM + 挂 portal 的地方」,判词写进它文件头;`page` 自述的 `render` 与 `BrowserActionsMenu` 改调用归浏览器批。

### 6.7 皮:B 链接(2026-09-14 用户拍,比稿 `reference-chip-proposal-2026-09-14.html`)

三种皮(A 暖纸 / B 链接 / C 药丸)用户选 **B**:引用 chip 没有盒子,是**正文里的一个词** —— 真图标(lucide 线形:文件 / 文件夹 / 技能星 / 命令提示符)+ 强调色文字 + 1px 细下划线(`text-underline-offset .2em`,静止 35% 透明、悬停实色),与正文同字体同字号,字重 500;技能用 `--skill` 绿那一对;命令**不是链接**:墨色 mono 小字 + 5% 墨底 + 5px 圆角(它是已发生的事的记号,不可点)。三处宿主(输入框 / 在飞气泡 / 落账气泡 / AI 回复行内)同一份样式,住在 `references/ReferenceChip.module.css`;输入框里那枚多一句 `user-select: all`(退格整枚删的手感靠 `contenteditable=false` 保住,不靠盒子)。旧 `content/user-message.module.css` 的 `.ref/.skillChip/.command/.prompt` 与 `Composer.module.css` 的 `.chip/.cmdTok` 随本单退役。
