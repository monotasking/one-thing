# 引用标签 `<ref/>`:一条写法,所有出口

2026-09-20 立。用户原话:「定义一种 xml 规则,把规则在提示词里面做一个说明,来让模型在涉及到文件时使用该格式…
在聊天内容(ai message, user message)中渲染该 xml…可以具体到行数,可以具体到 symbol,点击后跳转…
可以扩展更多的类型;此次实现中需要把架构落地,并实现文件、skill、command、reference;并把文件 reference 统一,
使用此次制定的规则,包括 composer、user message。」

## 0. 今天的病

同一件事(「这句话里指着一个东西」)今天有四种写法、四个认它的人,彼此不认识:

| 出口 | 写法 | 谁认 |
| --- | --- | --- |
| composer 草稿 → 线上 | `{{file:/abs}}` → `@/abs/path` | `references/kinds/path-ref.ts` 一条正则 |
| 引擎(喂模型) | `@/abs/path` → 内联 `<file>` 块 | `core/engine/file-mentions.ts` **另一条**正则(尾标点规则与壳不同) |
| 提示词(教模型怎么写) | 裸绝对路径 + `:12` / `#L12` | `prompts/content/references.md` —— **React 壳里没有任何人认它**(认它的是已删除的 Vue 渲染层),这段提示词今天是一句空头支票 |
| 助手消息 | 无 | `InlineRun` 连 markdown 链接都不可点 |

「裸路径 + 正则猜」这条路的上限已经到了:带空格的路径认不出、尾标点要两套规则、symbol 没处写、加一种类型就是加一条会互相误伤的正则。

## 1. 规则

**一个标签,自闭合,属性即数据:**

```xml
<ref type="file" path="/Users/me/proj/src/a.ts" line="12-30" symbol="parseToken"/>
<ref type="dir" path="/Users/me/proj/src/"/>
<ref type="skill" name="onething-self-evolution"/>
<ref type="command" name="compact"/>
<ref type="reference" href="https://example.com/spec" title="RFC 9110 §15"/>
```

语法(编解码器只认这些,一个类型名都不认):

- 标签名恒为 `ref`;`type` 必填,`[a-z][a-z0-9-]*`;其余属性 `name="value"`,**只许双引号**,值里的 `& < > "` 写成 `&amp; &lt; &gt; &quot;`。属性顺序无关,未知属性**保留不报错**(向前兼容:新版本加属性,旧壳照画)。
- **正形是自闭合** `<ref …/>`。通用可选属性 `label`:屏幕上那几个字;缺席由那一种自己算(文件 = basename)。
- **宽容形**:`<ref …>文字</ref>` 也认,文字当 `label`(模型爱这么写,认下来比教它改便宜)。不许嵌套,不许跨行。
- 一个标签**不跨行**。这是流式那一半的地基(见 §4.3):「一个没闭合的 `<ref` 尾巴最多扣到行尾」。
- 代码围栏与行内码里的 `<ref` **是字面量**(markdown 解析器天然保证,不另写判据)。
- 认不出的 `type`:助手消息里画成一枚**不可点的中性 chip**(显示 `label` ▷ 第一个属性值);用户消息与线上文本里原样留着。**永远不吞字**。

五种首发类型:

| type | 必填 | 可选 | 点击 |
| --- | --- | --- | --- |
| `file` | `path`(绝对或 `~/`) | `line`(`12` / `12-30`)、`col`、`symbol` | 打开文件;有 `line` 落到行;有 `symbol` 在文件里定位(给了 `line` 取离它最近的那一处);两个都没命中就只打开 |
| `dir` | `path` | — | 现有目录打开路(`content/dir-open`) |
| `skill` | `name` | — | 现有技能打开路(`content/skill-open`) |
| `command` | `name`(不带 `/`) | `args` | 把 `/name args` **填进这条会话的输入框,不发送**(发不发是人的事) |
| `reference` | `href` | `title` | http(s) → 内置浏览器开一格;其余 scheme 交系统 |

`reference` 是「一处出处」:网页、文档、规范条目。它不是文件 —— 文件有 `file`。

## 2. 架构:一个编解码器、两张自述表、每个出口一个投影

```
packages/core/references/ref-tag.ts          编解码器(零依赖纯函数;一个类型名都没有)
        ▲                    ▲
        │                    │
packages/onething-runtime/   apps/desktop-react/src/
  src/references/              references/kinds/<x>.ts
  types/<x>.ts  ─ 线上自述       ─ 壳自述(在既有五格上加 tag 一格)
  registry.ts                  registry.ts
        │                    │
  ┌─────┴──────┐        ┌────┴───────────────┬──────────────┐
  提示词片段    引擎内联   助手消息(markdown)   用户气泡        composer 出站
  (读表生成)   (file 一格) InlineNode 'ref'    segment 扫描    draft.tag → 线上
        │
  网关/CLI 纯文本投影(IM 里不能露 XML)
```

### 2.1 编解码器 `packages/core/references/ref-tag.ts`

```ts
export interface RefTag {
  type: string
  attrs: Readonly<Record<string, string>>   // 不含 type;label 在这里面
}
export interface RefTagHit { tag: RefTag; start: number; end: number }

export function formatRefTag(tag: RefTag): string          // 正形;属性顺序 = 插入序(决定性,账本字节稳定)
export function parseRefTag(source: string): RefTag | null // 整串恰是一个标签(自闭合或宽容形)
export function scanRefTags(text: string): RefTagHit[]      // 全文扫描,两种形都认
export function parseRefOpenTag(source: string): { tag: RefTag; selfClosing: boolean } | null
export function isRefCloseTag(source: string): boolean
export function splitIncompleteRefTail(text: string): { head: string; tail: string }
export function projectRefTagsToPlainText(text: string, describe?: (tag: RefTag) => string | null): string
```

- `splitIncompleteRefTail`:文本尾部若是一个**还没闭合**的 ref(`<`、`<r`、`<re`、`<ref`、`<ref ty…`、宽容形的 `<ref …>文字` 未见 `</ref>`)且**其间没有换行**,把它切进 `tail`。有换行 / 超过 512 字符 = 放弃,原样留在 `head`(那就是字面量)。
- `projectRefTagsToPlainText`:缺省投影 = `label` ▷ `path[:line]` ▷ `href` ▷ `name`;`describe` 让上层按类型覆盖。
- `formatRefTag(parseRefTag(s))` 对正形是恒等 —— 单测钉。

core 加一条 exports 键 `./references/*`(若既有通配已覆盖则不加)。

### 2.2 线上自述 `packages/onething-runtime/src/references/`

```ts
export interface RefTypeSpec {
  type: string
  /** 提示词里那一行:什么时候写它。 */
  summary: string
  attrs: readonly { name: string; required?: boolean; description: string }[]
  example: RefTag
  /** 纯文本投影(IM / CLI)。缺席 = 编解码器的缺省投影。 */
  plainText?(tag: RefTag): string | null
}
export class RefTypeRegistry { register(spec): () => void; list(): readonly RefTypeSpec[]; get(type) }
export const refTypes = new RefTypeRegistry()      // 进程内一份;types/index.ts 逐行登记
```

`types/{file,dir,skill,command,reference}.ts` 各一份自述 + `types/index.ts` 各一行。

**提示词**:`references/prompt-source.ts` 交一只 `PromptSource`(或就地替换 builtin 表 `references` 那一行的 `content`,两者取改动小的那个 —— 但文本**必须由 `refTypes.list()` 生成**,builder / composer 里不许出现类型名)。`prompts/content/references.md` 改写为总则(下文),类型表那一段由代码接在后面。`channel: 'system'`(跨会话逐字相同,缓存前缀不破)。

总则要说清的事(英文,祈使句 —— 用户 08-19 裁定过这段要指令式):

1. 提到任何文件 / 目录 / 技能 / 斜杠命令 / 出处时,用 `<ref/>`,不要写裸路径、不要用 markdown 链接指文件;
2. `path` 必须绝对;知道行就带 `line`,指的是函数 / 类 / 变量就带 `symbol`(两个都给最好);
3. 标签写在正文里,**不要放进代码块或行内码**;一个标签一行内写完;
4. 用户消息里出现的 `<ref/>` 是同一种东西:用户指给你看的对象;
5. 类型表(生成)。

golden 测试与 `_budget.json` 随之重盖;预算涨幅在交卷里报数。

### 2.3 引擎内联 `core/engine/file-mentions.ts`

在既有 `@/abs` 之外再认 `<ref type="file" path="…"/>`(用 `scanRefTags`,只看 `type === 'file'` —— 这是「文件内联」这项能力自己的模块,点名 `file` 合法)。规则:

- **标签留着,`<file>` 块紧跟其后**(标签带着 `line` / `symbol`,模型要知道用户指的是哪一处);
- 信任通道闸、单文件 / 单消息上限、同路径只内联一次 —— 逐字沿用;`~/` 不展开(今天也不);
- `@/abs` 那条旧路**保留**:网关 / CLI / 旧客户端仍这么写。快速早退条件改成「不含 `@/` 且不含 `<ref`」。

### 2.4 壳自述:在 `ReferenceKind` 上加 `tag` 一格

```ts
// references/kind.ts
export interface ReferenceTagCodec<Ref> {
  /** 线上 type。全表唯一(重复登记抛)。 */
  type: string
  /** 标签 → 这一种的 Ref。答 null = 属性不合法,按「认不出」处理。 */
  toRef(tag: RefTag): Ref | null
  /** Ref → 标签。有它,这一种在线上就写成 `<ref/>`(压过 `draft.expand`)。 */
  toTag(ref: Ref): RefTag
}
interface ReferenceKind { …; tag?: ReferenceTagCodec<Ref> }
```

结构闸(`registry.registerReferenceKind`):**有 `tag` 就必须有 `render`**(与 `parse` 同一条理由)。

注册表新口:`resolveReferenceTag(tag) → { kindId, value } | null`、`referenceTagOf(kindId, ref) → RefTag | undefined`。

- **出站**(`segment.projectSegmentsToText`):引用段先问 `referenceTagOf`,有就 `formatRefTag`;没有才走旧的 `token → expand`。于是 `file` / `dir` 一登记 `tag`,composer 出站、乐观气泡、`reconcileOverlay` 的文本兜底**同时**换形,不改第二处。
- **认出**(`segment.appendText`):`scanRefTags` 命中且 `resolveReferenceTag` 非 null 的,作为一名与各家正则**平级**的扫描者参加「最早命中者赢」。`@/abs` 旧正则**留着只读**(旧账本里的消息要照画)。
- `command` / `skill` 在 composer 里**线上形不变**(`/x`、`/skill:x` 是一句话的主语,引擎按它执行,不是「指着一个东西」);它们只登记 `tag.toRef`,用于**认出**助手写的 `<ref type="command"/>`。为此 `toTag` 在这两种上仍要给(往返性单测要),但出站优先级加一格判据:**`draft` 存在且自述 `wire: 'token'` 的,出站走 token**(`ReferenceDraft.wire?: 'tag' | 'token'`,缺席 = 有 `tag` 走 tag)。
- 新种类 `references/kinds/link.ts`(id `reference`):只有 `tag` / `render` / `open` 三格,无拾取无落稿。

### 2.5 助手消息:markdown 行内词汇加一格

- `content/model/inline.ts`:`{ type: 'ref'; tag: RefTag }` —— **纯数据**(行内树要深比,不放 kindId 之外的解析结果;解析在画的那一拍问注册表)。
- `markdown/to-inline.ts`:`html` 节点 → `parseRefOpenTag`。自闭合 → 一格 `ref`;开标签 → 向后找同级的 `</ref>` html 节点,中间的文字并成 `label`;找不到闭合 = 原文照抄(既有纪律)。
- `markdown/to-blocks.ts`:一行只有标签时 CommonMark 判成 **html 块**(今天落 `source-fallback`)。html 块的 `value` 若**整段只由 ref 标签与空白组成** → 翻成一段 `paragraph`,行内是那几格 `ref`。块身份键 `${源偏移}:${kind}` 的 kind 取 `paragraph`。
- `blocks/inline/InlineRun.tsx`:`case 'ref'` → `<ReferenceTagChip tag/>`(住 `references/`):`resolveReferenceTag` 命中 → 既有 `<ReferenceChip kindId value/>`;没命中 → 中性不可点 chip。**InlineRun 里不出现类型名**。

### 2.6 流式(「渲染要求实时」)

病:标签逐 token 到达,`<ref type="file" pa` 这半截会被 markdown 当文字画出来,闭合那一拍再整段换成 chip —— 一次肉眼可见的闪。

修:喂给 markdown 解析器之前,**仍在流式中的那一段**过一次 `splitIncompleteRefTail`,`tail` 扣住不画;标签一闭合,下一帧直接是 chip。落点是流式文本进 `block-stream` / `incremental` 的那一个入口(单点;`stable-cut` 的切点不许落在一个未闭合 ref 内 —— 若现有切点只在块边界,这一条天然成立,交卷里写明验证过)。流结束(`done`)时不再扣:没闭合的就是字面量。

预算:扣尾是 O(尾部 512 字符) 的一次 lastIndexOf,不进第 5 轴的长帧;`gate:chat-layout` 流式项照跑。

### 2.7 文件定位 `content/viewer/`

`openFileInCurrentTarget(path, line?)` → `openFileAt(path, loc?: FileLocation)`,`FileLocation = { line?, endLine?, col?, symbol? }`(旧签名留一个薄转发或全量迁调用点,取小的)。

`symbol` 的解析是一只策略对象,今天只有一个实现:

```ts
export interface SymbolLocator { locate(text: string, symbol: string, nearLine?: number): number | null }
export const textSymbolLocator: SymbolLocator   // 定义形优先(function/class/const/let/var/def/fn/type/interface/struct/enum + 名字、`名字(`、`名字 =`、`名字:`),其次整词首现;给了 nearLine 取最近
```

读完文件那一拍(今天落行的同一处)问它。将来有符号索引 / LSP,换实现,调用方不动。找不到 = 退到 `line`,再退到只打开;**不报错**(模型给的 symbol 可能已经被改名,这不是用户的错)。

### 2.8 非壳出口

网关出站(微信 / Telegram)与 CLI 的人读输出过 `projectRefTagsToPlainText` —— IM 里露 XML 是事故。落点是各出口既有的「markdown-safe」那一道;流式分片若会把标签劈开,用 `splitIncompleteRefTail` 扣尾。找不到单点就在交卷里报清楚现状,不硬塞。

## 3. 陌生能力演练(仓根 09-02 法)

**「加一种 `session` 引用:`<ref type="session" id="…" message="…"/>`,点了跳到那条会话的那条消息」** 要改的文件:

1. `packages/onething-runtime/src/references/types/session.ts`(新)+ `types/index.ts` 一行 —— 提示词自动多一行、纯文本投影自动有;
2. `apps/desktop-react/src/references/kinds/session.ts`(新,`tag` + `render` + `open`)+ `references/index.ts` 一行 —— 助手消息、用户气泡自动认;若它还要能从 `@` 拾取,是同一只文件里再写 `source` / `draft`。

编解码器、提示词 builder、`to-inline` / `to-blocks` / `InlineRun`、`segment.ts`、`file-mentions.ts`、网关:**零改动**。答案 =「能力自己的模块 + 它的壳渲染模块 + 各一行注册」,骨架抽到位。

守卫:壳侧 `references/__tests__/structure.test.ts` 加一条 —— 在测试里现登记一份假 `tag` 自述,断言 markdown 行内与用户气泡都画得出它,**不碰任何生产文件**;runtime 侧同款(现登记一份假 `RefTypeSpec`,断言提示词文本里出现它那一行)。

## 4. 兼容

- 旧账本:用户消息里的 `@/abs` 照旧认(只读正则留着);助手消息里的裸路径今天本来就不可点,不回填。
- 旧引擎 + 新壳(用户桌面没重启):新壳发出的 `<ref type="file"/>` 旧引擎不内联 —— 模型仍看得见路径、可以自己 read,功能降级不失效。**交付时提醒用户重启桌面**(改了引擎,HMR 只热更渲染层)。
- 草稿持久化里的 `{{file:…}}` 记号不动(它是草稿内部的位置记号,不是线上形)。

## 5. 分批

| 批 | 范围 | 门 |
| --- | --- | --- |
| **B1** | core 编解码器 + runtime 类型表 + 提示词 + 引擎内联 + 网关/CLI 投影 | 新单测;`prompts` golden 重盖;`bun run typecheck` / `boundary:gate` / `log:gate` / `session:gate`;相关 vitest |
| **B2** | 壳:`tag` 一格 + 注册表 + segment + markdown 行内/块 + 流式扣尾 + `ReferenceTagChip` + 文件定位(行 / symbol)+ 五种 kind + composer 出站统一 | 新单测 + 两条演练守卫;既有 `references` / `composer` / `markdown` 测试全绿;`npm run ui:consume` / `squeeze-gate` / `motion-gate`;typecheck;`gate:composer-send` |

超量格(第 5 轴):一条含 **500 个 `<ref/>`** 的助手消息(夹具现造)——解析 + 首次上屏无 ≥50ms 长帧增量(对照同长度无标签消息);`ReferenceTagChip` 必须 memo,注册表查询 O(1)(`Map<type, kind>`)。
