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
