# Composer `@` 文件搜索:从「子串必须逐字命中」到「像 ⌘P 那样找文件」(2026-09-26 方案)

> 起因:用户反馈 `@` 文件搜索「有些不好用,必须要严格符合」。本文先把「严格」到底严在哪几处核到 file:line,
> 再给一份分三单的改法。**方案阶段,未动手。**

## 0. 现状(已核)

`@` 的候选是一条两段路:壳把光标前那一截 token 交给后端 `files.list`(`data/file-mentions-source.ts`),
后端起一条 `rg --files` 逐条比对,壳拿回候选后在去抖窗口里再本地收窄一次(`references/kinds/file.ts:80`)。
「严格」一共严在五处,五处都不是设计,是各自为政攒出来的:

| # | 位置 | 今天的行为 | 用户看到的 |
| --- | --- | --- | --- |
| ① | `apps/desktop-react/src/composer/transitions.ts:73` `matchFiles` | `label.includes(query)`,**区分大小写** | 打 `@button` 永远找不到 `Button.tsx`:后端已经按小写命中把它发下来了,壳这一层又把它筛掉。必须打 `@Button` |
| ② | `apps/desktop-react/src/references/registry.ts:160` + `kinds/file.ts:178` | token 字符类是 `[\w.-]`,**没有 `/`、没有非 ASCII** | 打到 `@src/` 的那一下 `/`,抽屉直接关掉(实测 `parseToken("hi @src/comp")` → null);`@笔记` 一个字都进不去 |
| ③ | `packages/onething-runtime/src/files/file-search.ts:193` / `:248` | 整个 query 当**一段连续子串**在相对路径里 `includes` | `@compbtn`、`@cmpbutton` 这类漏字 / 缩写一律零结果;必须逐字连着打 |
| ④ | 同文件 `:207` / `:251` | 命中够 `limit`(50)条就停止枚举,**没有排序**,顺序 = rg 遍历顺序 | 打 `@button` 出来的是遍历顺序上前 50 条含 button 的路径,`ui/Button.tsx` 本人排在第三,再多几条就根本不在屏上 |
| ⑤ | `packages/backend/rpc/domains/files.ts:225` | `noIgnore: true`,不看 `.gitignore` | 本仓实测枚举 **79 155** 条(含 node_modules)对 4 960 条,每次击键 200ms 对 24ms;候选里混着 node_modules 里的同名文件。检索面板那一路 09-07 事故后已改成尊重 `.gitignore`(`search/capabilities/files.ts:128`),`@` 这一路漏掉了 |

另有一处死码:`packages/backend/utils/fuzzy.ts` 是一份模糊打分器,全仓零调用者。它在装配层,产品层的
`file-search.ts` 吃不到它;下面的方案不复活它,写一份新的、放在能同时被后端与壳吃到的地方,它随之删除。

## 1. 目标

敲 `@` 之后打几个字,就能拿到心里那个文件,规矩与 VS Code ⌘P / fzf 一致:

- 大小写无关;
- 字母**按序出现即可**,不必连着(`compbtn` → `composer/…/Button.tsx`);
- `/` 是路径分隔:`comp/but` 表示「某段叫 comp… 的目录下某个 but… 开头的东西」;
- 中文 / 任意 Unicode 文件名可以打;
- 结果**按像不像排序**,最像的在第一行:文件名命中 > 目录名命中,词首命中 > 词中命中,连续命中 > 断开命中,浅路径 > 深路径;
- 尊重 `.gitignore`,node_modules / 构建产物不进候选。

**不做**:`@` 里打空格(`@a b` 在一句话里歧义,`/` 与子序列已覆盖多词的需要);搜文件内容(那是检索面板 S8 的事)。

## 2. 方案

### 2.1 匹配器只有一份:`packages/onething-runtime/src/files/file-match.ts`(新,纯函数,零 node 依赖)

```ts
export interface FileMatch {
  /** 越大越像。空 query 恒 0(全命中,排序交给调用方)。 */
  score: number
  /** 命中的字符区间,按 relPath 的下标;壳按它加亮。 */
  ranges: ReadonlyArray<readonly [start: number, end: number]>
}
/** 不命中 → null。query / path 都先小写;query 里的 `/` 切成段,段按序落在路径段上。 */
export function matchFilePath(query: string, relPath: string): FileMatch | null
```

打分表(fzf 那一套,数字先按 fzf 缺省起,golden 用例表定稿时再调):

| 事件 | 分 |
| --- | --- |
| 文件名(最后一段)整段等于 query | +100 |
| 文件名以 query 段开头 | +60 |
| 命中落在文件名段内(而不是目录段) | 每字符 +3 |
| 命中在词首(段首、`-`/`_`/`.`/空格之后、camelCase 大写处) | 每字符 +8 |
| 与上一个命中相邻 | 每字符 +5 |
| 两个命中之间隔了 n 个字符 | −min(n, 10) |
| 路径每深一段 | −1 |

不写 node 依赖是硬约束:壳(浏览器)与后端(node)吃同一份。basename / 分段自己按 `/` 切。
「一条判据只写一处」是 `transitions.ts:58` 与 `file-mentions-source.ts` 文件头反复强调的既有律,
这一份就是那处;`matchFiles` 与 `entryMatchesQuery` 都改成调它。

### 2.2 后端 `files.list`:全枚举 → 打分 → 取前 N

`file-search.ts` 的两条枚举循环(老口径 `listOnethingFileSearchEntries` 与点名根 `listPickedRootEntries`)改成:

1. 每根 `rg --files` **枚举到底**(仍受 `--max-depth 8` 与 3s 预算两条 09-07 边界;预算到了交已有的并标 partial,与检索面板同一种结局);
2. 每条 `matchFilePath(query, relPath)`,null 的丢;
3. 每根内按 score 降序、同分按路径深度再按字典序(**同分序必须稳定**,`transitions.ts:83` 的判例:看不见的分数不许让同一句话在两次击键之间跳);
4. 点名根的「每根保底 quota 再补位」一字不动,只是每根那份从「前 quota 条」变成「分最高的 quota 条」。

`rpc/domains/files.ts:225` 的 `noIgnore: true` 改 `false`。响应 `entries[]` 加两格 `score?` / `matchRanges?`
(`@shared/ipc/files.ts` 契约同步),老宿主缺席这两格照旧能画。

代价:今天也是每次击键起一条 rg,只是命中 50 条就早退;改后要读完。本仓尊重 `.gitignore` 后 4 960 条 / 24ms,
打分 5k 条子序列在主进程量级是个位数毫秒。**预算线:从 query 到候选回到壳 ≤ 50ms(本仓)、≤ 150ms(真店规模目录)**,
量出超线才做 2.5。

### 2.3 壳侧三处

- **token 字符类**(`registry.ts:160/171`):`\w` 换成 Unicode 类 `[\p{L}\p{N}_]`(正则加 `u`),`kinds/file.ts:178`
  `tokenChars: '.-'` 加 `/`。两条正则都是从表生成的,改表不改 `parseToken`。`insert` 摘 token 用的
  `tokenTail` 同一张表,自动跟上。
- **本地收窄**(`transitions.ts:69` `matchFiles`):改成 `matchFilePath` 过滤 + 按 score 排序,去抖窗口里的收窄从此与
  后端同一判据、同一顺序(今天是壳大小写敏感、后端不敏感,两层各说各话)。既有测试
  `transitions.test.ts:43` 的断言(`'ex'` 命中 `codex.ts` 不命中 `model-capability.ts`)在子序列下要改:
  `model-capability.ts` 里 e…x 按序也出现,它会命中但排在后面;测试改成断言**顺序**而不是集合。
- **行加亮**:`ReferenceSource.row()` 返回值加可选 `ranges`,`DrawerPickList` 的行按区间把命中字符画成强调色。
  一行的形状不变(仍是一条相对路径 + 出处副文),只加亮,不换成两段式布局。

### 2.4 空词候选(可选,第三单)

今天刚敲下 `@` 那一拍出的是 rg 顺序前 50 条,没有意义。改成:**本会话 AI 读 / 写过的文件 + 这条会话里之前 `@` 过的**
在前(按最近一次在前),其余按路径浅→深。「读写过的文件」产地是 `events.jsonl` 里的 `tool/audit`(改动面板已经在读它),
壳侧不另记账;「之前 `@` 过的」是壳侧每会话一张 20 条的 LRU,不落盘。这是用户可感知的行为变化,单列拍点。

### 2.5 每根文件表缓存(只在 2.2 量出超线才做)

`packages/backend/wiring/files/list-cache.ts`:键 = 根路径,值 = 相对路径表 + 建表时间,TTL 30s,
抽屉首开那一发空词就是预热,此后击键只打分不起 rg。桌面的 `files.watch` 是投影桩(`domains/files.ts` 文件头第 3 条),
所以不靠监视失效,靠 TTL。**不先做**:它是一格新的进程级状态,`assembly:gate` 要求它挂在实例上并 `own()`,
没量出需要之前不该多这一格。

## 3. 陌生能力演练(法条,交卷前必答)

「`@` 一条会话」:`sources/sessions.ts`(按 hand-off 单的注册表形)一份自述,`query` 里对每条会话标题调
`matchFilePath(q, title)` —— 标题里没有 `/`,分段退化成一段,打分表原样适用。`file-match.ts` / `registry.ts` /
`DrawerPickList` 一字不动。匹配器不认识「文件」这个词,它只认识「一段文本 + 可选的 `/` 分段」,所以答得出。

## 4. 施工序与门

| 单 | 内容 | 门 |
| --- | --- | --- |
| 1 止血(半天) | ①大小写归一 ②token 字符类加 `/` 与 Unicode ⑤`noIgnore:false` | `transitions.test.ts` / `registry` 测试各加一条:`@button` 命中 `Button.tsx`、`parseToken("@src/comp")` 得 `src/comp`、`@笔记` 得 `笔记`;`file-search.test.ts` 断言 `listFiles` 收到的 `noIgnore` 为 false |
| 2 匹配器 + 排序 + 加亮(一天) | 2.1 / 2.2 / 2.3 | **golden 用例表**(`file-match.test.ts`,以本仓路径为夹具):`button` → `apps/desktop-react/src/ui/Button.tsx` 第一;`compbtn` → composer 下的 Button 在前;`src/comp` 只出 `src/composer/…`;`Comp.tsx` 大小写无关;真机门 `gate:composer-drawer` 加一步「敲 `@button`,第一行是 `ui/Button.tsx`,击键→候选 ≤ 50ms」 |
| 3 空词最近优先(可选,半天) | 2.4 | `gate:composer-drawer` 加一步:AI 读过 a.ts 后敲 `@`,a.ts 在第一行 |

真机量法按壳 CLAUDE.md 第 5 轴:夹具用真店规模目录,不拿本仓 5k 条当上限。`packages/backend/utils/fuzzy.ts` 随单 2 删除。

## 5. 拍点(推荐已标)

1. **`@` 里要不要允许空格** —— 推荐不允许(`/` + 子序列够用,句中歧义大)。
2. **空词是否「最近优先」**(2.4)—— 推荐做,但它改变刚敲 `@` 那一拍的候选,归用户拍。
3. **行加亮 vs 两段式**(文件名一行、目录一行)—— 推荐只加亮不改布局;两段式是另一次视觉改动,与本单无关。
