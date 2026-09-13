# Hand-off:composer 的 `@` 面「来源注册表」重构(2026-09-12 立账)

> 这是一笔**在册的结构债**,不是报障。起因:B3-b(`65ec160f`)要把「把这一页交给对话」挂进
> composer 的 `@` 抽屉时,发现抽屉只认「文件」「命令」两种来源,种类写死在五处,挂第三种来源就得
> 同时改这五处 —— 正是仓根 CLAUDE.md 那条法点名的「按能力枚举」。B3-b 因此绕开抽屉,把动作放进
> 浏览器叶自己的动作菜单(⋯ / 右键「把这一页交给对话」),没有动骨架。**下一个要往 `@` 里挂新来源
> 的人(网页 / 会话 / 笔记 / 任意插件)先做这一单,再挂自己的。**

## 1. 今天的形(五处枚举点,全部 file:line 已核)

| # | 位置 | 枚举的形 |
| --- | --- | --- |
| ① | `apps/desktop-react/src/composer/types.ts:12` | `export type DrawerKind = 'files' \| 'commands' \| 'model' \| 'status' \| null` —— 闭合联合 |
| ② | 同文件 `:131` `TokenHit.kind` | 只有 `'files' \| 'commands'` 两格子集 |
| ③ | `apps/desktop-react/src/composer/transitions.ts:29-39` `parseToken` | `@` → `{kind:'files'}`、`/` → `{kind:'commands'}` 两条正则写死 |
| ④ | `apps/desktop-react/src/composer/usePickDrawer.ts` `:117 :141 :163 :173 :185 :193 :218 :232 :240` | 九处 `drawerKind === 'files' / 'commands'` 分支:候选怎么算(`matchFiles` / `matchCommands` + `groupCommands`)、长度、关抽屉、选中落什么(`insert('files', label, {token: createFileToken(path)})` / `insert('commands', name, {argHint})`) |
| ⑤ | `apps/desktop-react/src/composer/components/DrawerPickList.tsx` `:79 :118 :119 :129 :145 :149 :192` + `components/ComposerInput.tsx:38` `insert(kind: 'files' \| 'commands', …)` | 列表按 kind 画两种行、两种表头、两种空态;输入面的 `insert` 签名也只认两种 |

`model` / `status` 两种 `DrawerKind` 不是「来源」(它们是选模型 / 看读数的抽屉),重构时**留在原位**,只把「拿一个 token 换一枚 chip」这一族抽出来。

## 2. 目标形(能力自述、别人读表)

一个来源 = 一份自述 + 一行登记,与 `workbench/kinds.ts` 的 `registerContentKind`、`stage/launchers.ts` 的
`registerStageLauncher`、`packages/core/search/capability.ts` 的 `CapabilityRegistry` 同一体例:

```ts
// apps/desktop-react/src/composer/sources/registry.ts(新)
export interface MentionSource<Hit = unknown> {
  id: string                                  // 'files' | 'commands' | 'pages' | …
  trigger: { char: '@' | '/'; where?: 'line-start' }  // ③ 的正则由表生成,不再手写
  query(q: string, ctx: MentionContext): Hit[] | Promise<Hit[]>   // ④ 的候选计算
  group?(hits: Hit[]): MentionGroup<Hit>[]    // 命令那种分组;缺席 = 一组
  row(hit: Hit): MentionRow                   // ⑤ 画一行:主文 / 副文 / 图标(数据,不是 JSX)
  head?: MessageKey; empty?: MessageKey       // ⑤ 表头与空态文案键
  pick(hit: Hit): { label: string; token?: string; argHint?: string }   // ④ 选中落什么(`insert` 只收这一份)
}
export function registerMentionSource(source: MentionSource, hot?: LauncherHot): void
```

- `DrawerKind` 的「来源」半边收成 `'source:<id>'`(或直接 `{ kind: 'source', id }`),`TokenHit.kind` 变 `string`;
  `parseToken` 遍历注册表按 `trigger` 生成匹配,不再枚举。
- `usePickDrawer` 只剩一条通路:`source.query` → `source.group` → 键盘位 / `applyPick` 走扁平序(既有判例:
  「一条列表不许有两种序」`transitions.ts:155`)→ `source.pick` → `inputRef.insert(sourceId, label, extra)`。
- `DrawerPickList` 按 `source.row(hit)` 画,表头 / 空态读 `source.head / empty`;`ComposerInput.insert` 的第一个
  参数改成 `string`(chip 的 `data-kind` 照旧记它)。
- 文件与命令两种**先迁成两份自述**(`sources/files.ts`、`sources/commands.ts`),行为逐字不变(壳 CLAUDE.md
  「迁移 = 等价替换」:前后真机逐态截图零像素差,`Composer.test.tsx` / `usePickDrawer` 既有用例一条不改就得绿)。
- 第三份 `sources/pages.ts`:trigger `@`(与文件同一个字符,靠 `query` 各自出候选、`group` 分「文件 / 打开的网页」
  两组),`pick` 落 `createPageToken(tabId)`(契约在 `packages/onething-runtime/src/prompts/prompt-references.ts:55`,
  B3-b 已把消费者接回来:`data/chat-port.ts` 发送时 `expandFileTokens` 先、`materializePageReferences` 后,
  正文进 `attachments` 不进 `content` —— **这两条判据是闸,不是风格**,重构不许碰)。B3-b 的 ⋯ 菜单入口保留,
  两条路落同一枚 chip。

### 陌生能力演练(法条要求,交卷前必答)
「@ 一条会话」:`sources/sessions.ts` 一份自述 + `sources/index.ts` 一行登记;`parseToken` / `usePickDrawer` /
`DrawerPickList` / `ComposerInput` / `types.ts` 一字不动。答不出这句就是骨架没抽到位,打回。

## 3. 判例与禁令(施工前读)

- 壳 CLAUDE.md「hover ≠ active 两态纪律」:候选列表用 `ui/a11y/list-selection`,mouseenter 不写 active。
- 「基础件先行」:行的形已有 `DrawerPickList` 的行组件,`row()` 只交数据,不交 JSX。
- 「计数禁令」:组头不挂计数徽。
- 「分页四条不变量」:候选超量(文件树几千条)时按既有 `matchFiles` 的截断口径,不引入第二套。
- 第 5 轴:`@` 键入到抽屉出候选 ≤ 16ms 首帧、候选刷新零 ≥50ms 长帧(`matchFiles` 在 `useMemo` 里同步跑,
  文件多时是长帧产地 —— 若量出超线,改成 `query` 可异步 + 上一批候选留屏);夹具用真店规模目录。
- HMR:注册表照 `registerContentKind` 的 `import.meta.hot` 体例。

## 4. 验收

- 壳 vitest 既有用例零改动全绿(等价迁移的硬证);新增:注册表(登记 / 重复 id 拒 / HMR 退役)、
  `parseToken` 由表生成、三份自述各自的 `query/pick`、演练「第四种来源只加两处」的结构测试
  (`grep` 五处旧枚举点为零)。
- `gate:a11y` composer 屏不红;`gate:focus` 不红;`ui:consume` 32 基线 + 硬闸 0。
- 真机门 `gate:browser` ⑰(⋯ → chip → 发送 → 请求体无正文有附件)照旧绿;新加一条:`@` 抽屉里选一条
  「打开的网页」落同一枚 chip、发送请求体同形。
- 反证:把 `sources/index.ts` 里 `pages` 那一行拆掉 → `@` 里没有网页组、门红;把 `parseToken` 改回手写正则 →
  结构测试红。

## 5. 不做

- 不动 `model` / `status` 两种抽屉。
- 不改 token 语法(`{{file:}}` / `{{page:}}`)与 `chat-port` 的展开次序。
- 不给插件开口(`api.registerMentionSource`)—— 插件宿主在 React 壳上还没跑(app-intents §9.3),等它。

派工:Fable 拆分审查 / opus 执行 / haiku 提交;交卷带三张状态表(抽屉:关 / 开无候选 / 开有候选 / 超量;
行:rest / hover / active / focus)与第 5 轴读数。
