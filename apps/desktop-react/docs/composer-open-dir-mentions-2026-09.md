# 打开的目录可以被 @(2026-09-18 立,正本)

> 用户 09-18:「打开的一个 dir,如果不是 workdir,那么 composer 可以 @」。
> 权限一格用户拍「放行」(本会话放行读,写照旧问);随后用户令「这块能力也需要从可维护性、
> 可扩展性出发」—— §2.5 的授权设计因此从 v1(一条专用的读根通道)重做成 v2(呈现事实 + 资源自述 +
> 既有授权表),v1 的病历留在 §2.5.1。
> 上游正本:`composer-references-2026-09.md`(引用种类注册表)。本单**不加引用种类**。

## 0. 现状(已核)

- 文件 / 目录两种引用的记号都是**绝对路径**(`{{file:/abs}}`),落稿 / 展开 / 认出 / 呈现 / 打开五环
  对任何绝对路径都已成立。**缺的只有候选的产地。**
- 候选只有一个根:`PickContext.cwd`(`src/references/kind.ts`);`toFileMentions` 用 `ownedByCwd`
  把 cwd 以外的结果筛掉(`src/data/file-mentions-source.ts`,那段注留账「后端开出只搜这个根的口,这一筛退役」)。
- 后端 `listOnethingFileSearchEntries` 按根**顺序填满** 50 条就停
  (`packages/onething-runtime/src/files/file-search.ts:127`)—— 多给几个根,工作目录一个就能吃光名额。
- 打开的目录 = 工作台里一格 `dir` 内容,`ref.key` 即绝对路径(`src/content/kinds/dir.tsx`)。
- **授权表已经存在**:`packages/core/permission/permission-grants.ts` 的 `PermissionGrant`
  `{scope: 'session'|'workspace', type: <效果类>, pattern, createdFrom, metadata, revokedAt}`,
  `Authorizer` 经 `matchGrant` 查它;`permission-grants` RPC 域能列、能撤会话级授权,设置页
  `content/settings/PermissionGrants.tsx` 是它的面。**会话级授权今天只在内存里**(`sessionGrants` 一张 Map),重启即失。
- 读越界 = 工具报 `external_directory` 效果(`toolkit/families/file.ts` `readEffects`,资源粒度是所在目录 `dir/*`),
  它与 `file_write` / `file_edit` / `sensitive_file_read` / `bash` **是各自独立的效果类**,各自过策略。
- 资源那条路(`dir:` 提供者)判读不走效果,走 `SandboxPolicy.readable`(读根表)——
  `backend/wiring/toolkit/runner.ts` `createSandboxPolicy`。
- 引擎落账前会把 `@文件` 内联成 `<file>` 块,所以**文件引用本来就不需要模型再读**;授权真正起作用的是
  目录引用与之后的追读。

## 1. 名词

- **可引用的根**(`PickRoot`):`@` 候选从这些目录里找。第一个是会话工作目录,其余由打开的内容**自述**。
- **呈现**(presentation):「用户这一轮把某个资源摆在了助手面前」这件**事实** —— 引用了它,或它此刻开着。
  用资源地址说(`dir:/abs`),由壳报、随发送命令进来。
- **呈现授权**:后端对一次呈现的**裁决** —— 该资源的提供者自述「被呈现时解锁哪些效果」,落成一条普通的
  `PermissionGrant`(`metadata.issuer = 'presentation'`)。

## 2. 目标形

### 2.1 根由内容自述(骨架一次性开口)

`workbench/kinds.ts` `ContentKind` 加一格可选:

```ts
/** 这份内容开着时,提供一个可被 @ 的目录根。缺席 = 不提供。 */
referenceRoot?(ref: ContentRef): string | null
```

`content/kinds/dir.tsx` 加一行 `referenceRoot: (ref) => ref.key`。工作台核心只遍历当前 space 里开着的
每一格问这一句,**不认识 `dir`**。

### 2.2 `src/references/roots.ts`(新)—— 根的唯一产地

- `interface PickRoot { path: string; primary: boolean }`
- 纯函数 `collectReferenceRoots(workdir, regions, kindOf)`:
  1. 工作目录第一(`primary: true`),不论它是否开成面板;
  2. 其余按工作台树序(区域序 → 叶序 → tab 序);**在树上即算**,后台 tab 算,**被藏起来的不算**;
  3. 与前面某根相同、或被前面某根包含 → 丢;包含工作目录的(如开了 `~`)**留**,条目层按路径去重、
     工作目录的结果在前。
- hook `usePickRoots(workdir)`:读 `regions`,答案按值稳定(值相同就交回上一个数组),切标签不让候选重取。

### 2.3 契约:`PickContext` 加 `roots: readonly PickRoot[]`(`cwd` 留着)

抽屉填 `roots`;`kinds/file.ts` 的 `useQuery` 改读它。`draft` / `parse` / `render` / `open` 一行不动。
施工时改正一处:`cwd` **不删** —— 技能按工作目录发现(`kinds/skill.ts`),那是另一个问题。

施工时补的两件(09-18):
- 抽屉行的 React 键从 `种类:主文` 改成 `种类:主文:副文` —— 两个根下同名的相对路径(都叫
  `README.md`)只靠副文那格根名分得开。
- `toFileMentions` 在点名根那一档里,条目没报 `root`(一个还不认 `roots` 的老宿主,比如没重启的
  桌面 core)就按路径认领,哪个根都不落的丢掉 —— 不然老宿主照老口径发下来的笔记根 / 下载目录会漏进来。

### 2.4 后端:只搜给定的根 + 每根保底

- `@shared/ipc/files.ts`:`FilesListRequest.roots?: string[]`;`FileSearchEntry.root?: string`(命中归哪个根)。
- `file-search.ts`:给了 `roots` = **只搜它们**(不并笔记 / 下载 / 接入目录);每根先保底
  `floor(limit / n)` 条,余额按根序补。不给 `roots` 时 `cwd` 老路径逐字节不变。
- `backend/rpc/domains/files.ts` 透传。壳侧 `ownedByCwd` **退役**,标签按条目自己的 `root` 算相对路径。
- 退路:一个根都没有 → 不传 `roots`,今天的行为原样。无工作目录但开着目录 → 只搜开着的那几个(小行为变化,记明)。

### 2.5 放行:呈现 → 授权(v2)—— **本期只留入口,鉴权暂缓**

> 09-18 用户令:「先不做和鉴权相关的事情,但是留好入口」。本期因此只落 §2.5.2 的**事实层**
> 与后端**一个可选端口**;裁决层(`onPresented` / `PresentationGrantIssuer`)、`readable` 问授权表、
> 会话授权进账本三件**全部不做**。本期上线后,模型读 @ 进来的外部目录**照旧弹权限卡**(今天的行为)。

#### 2.5.0 本期落的入口

| 入口 | 本期做到哪 | 将来谁接 |
| --- | --- | --- |
| `ContentKind.presents?` / `ReferenceKind.presents?` | 两格自述 + `dir` 内容 / `dir` 引用各填一行 | 新能力各加一行 |
| `references/presented.ts` `collectPresented` | 实装(纯函数,读两张表) | 不动 |
| `SendMessageCommand.presented?: PresentedResource[]` | 契约 + 壳发送时带上 | 不动 |
| 后端呈现入口 `packages/backend/session/presentation.ts` | `session-command` 域在分传输之前 `takePresented` 摘下、信封校验(形状 / 去重 / ≤ 32 条),只对 `send-message` 调 `deliverPresentation(presented, { sessionId, messageId, locallyTrusted })`,**等处理者做完**再进总线;处理者表(`registerPresentationHandler`,交回退役函数给 `backend.own()`)今天是**空的** = 这件能力不存在。处理者失败只记日志、不挡发送。现场**不给传输种类**(`transport:gate` 禁域里按 transport 分叉),信不信只看 `locallyTrusted` | 鉴权批登记一位处理者:`PresentationGrantIssuer` |

将来接鉴权 = 登记那位处理者 + `ResourceProvider.onPresented` + `readable` 问授权表(§2.5.2 原文),
**契约、壳、发送路径、域的调用点一行不改**。端口缺席时 `presented` 只经过校验就被丢弃 ——
没有读者的事实不落账、不进总线,免得出现「写了没人读」的第二真相。

#### 2.5.1 v1 为什么打回(病历)

v1 是:发送命令加 `readGrants: string[]` → 用户消息加 `readGrants` → 专用折叠 → 并进两张读根表。拿它做
陌生能力演练就露馅:

| 演练 | v1 要改哪 |
| --- | --- |
| 把一页网页交给对话后,模型对这一页 reload 不再问(`browser_navigate`) | 命令再加一格、消息再加一格、再写一只折叠、再找一个读者 |
| 开着的 git 仓面板 → `git:` 读不再问 | 同上,第三遍 |

三条结构病:①**第二套授权系统** —— 与既有 `PermissionGrant` 平行,列不出、撤不掉、审计看不见;
②**按能力枚举** —— 字段名里写死了「读」「路径」;③**裁决在渲染层** —— 解锁什么由壳的 `turnReadGrants`
算,而安全裁决不该交给一个客户端。另有一条副作用:把目录塞进**读根表**等于说「它是沙箱的一部分」,
审计里那次读从此不再是 `external`,「为什么没问」这件事就没了出处。

#### 2.5.2 v2 的形:壳报事实,资源自述后果,授权走既有那张表

**三层分工**:

| 层 | 回答 | 产地 |
| --- | --- | --- |
| 事实 | 这一轮用户把哪些资源摆在了助手面前 | 壳:内容种类 / 引用种类各自**自述** `presents` |
| 裁决 | 被呈现的这种资源,解锁哪些效果 | 后端:资源提供者**自述** `onPresented` |
| 落地 | 授权存哪、怎么匹配、怎么撤、怎么审计 | 既有 `PermissionGrant`(scope `session`) |

**① 事实(壳)**

- `ContentKind` 与 `ReferenceKind` 各加一格可选 `presents?(ref): string | null` —— 回资源地址。
  `dir` 内容种类答 `dir:${ref.key}`;`dir` 引用种类答 `dir:${ref.path}`;文件引用**不答**(内容已被引擎内联,
  没有要解锁的读)。
- `src/references/presented.ts`(新)纯函数 `collectPresented(openRefs, draftRefs)` → `PresentedResource[]`
  `{ uri, via: 'open' | 'reference' }`,去重;只读两张表的 `presents` 格,**一个种类名、一个 scheme 都不认识**。
- 发送那一拍由 `composer/sink.ts` 现读(`presentedNow(segments)`),跟着乐观 entry 走(重试递同一份),
  经 `chat-port` 放进 `SendMessageCommand.presented?: PresentedResource[]`
  (`packages/shared/events/session-commands.ts`,注释写明「这是事实不是授权;解锁什么由后端定」)。

**② 裁决(后端)**

- `core/resource/provider.ts` `ResourceProvider` 加一格可选:

  ```ts
  /** 这一个资源被用户摆到助手面前时,解锁哪些效果。缺席 = 呈现不解锁任何东西。 */
  onPresented?(address: string, ctx: PresentationContext): readonly GrantProposal[]
  // GrantProposal = { type: EffectClass; pattern: string | string[] }  —— PermissionGrantInput 的子集
  ```

- `dir` 提供者(`backend/wiring/resource/dir-provider.ts`)答:该路径已在本会话读根内 → `[]`;
  否则 `[{ type: 'external_directory', pattern: '<path>/*' }]`;路径是 `/` → `[]`。
- `backend/wiring/permission/presentation-grants.ts`(新)`class PresentationGrantIssuer`,依赖注入
  (资源注册表查找、`addGrant`、`listSessionGrants`、可信判据),一个方法
  `issue(sessionId, presented, origin): PermissionGrant[]`:
  1. 信封:条数 ≤ 32、地址可解析;只认**本地可信宿主**(`isHostLocallyTrusted()`)上**用户本人**发出的命令 ——
     网关 / 插件 / 跨会话投递带来的 `presented` 一律丢弃(授权只能由坐在这台机器前的人给);
  2. 按 scheme 找提供者 → `onPresented`;认不出的 scheme / 没有这一格 → 不授权、不报错;
  3. 过 `isGrantableType`(`never-grantable` 的效果类永远落不进来,这一闸是现成的);
  4. 与本会话已有授权同 `type + pattern` → 跳过(幂等,重发不堆条目);
  5. `addGrant({ scope: 'session', …, createdFrom: { messageId, title: '在消息里引用' },
     metadata: { issuer: 'presentation', via, uri } })`。
- 调用点:`backend/rpc/domains/session-command.ts` 在 `sanitizeRendererCommand` 之后、命令进总线之前 ——
  **授权必须先于这一轮的第一次工具调用存在**;会话忙时降级成 steering 的那条消息同样发授权。
  核心(`issuer` / `session-command` / `permission`)里**不出现 `dir`、不出现 `external_directory`**。

**③ 落地(既有授权表,补两处缺口)**

- **两把尺子同一张表**:`createSandboxPolicy` 的 `readable(target, scope)` 除了读根表,再问一句
  `matchGrant({ type: 'external_directory', pattern: '<dirname>/*', sessionId: scope })`。这样模型经 `read`
  工具读、与经 `dir:` 资源列,认的是同一批授权 —— 守 09-13 判例。这是一处**通用**修补:从此
  用户在权限卡上点「本会话允许」的外部目录,`dir:` 资源也认,不只是呈现来的。
- **会话级授权进账本**(独立一批,见 §5 批零):`permission/granted` / `permission/revoked` 两种会话事件落
  `events.jsonl`,会话水合时折回 `sessionGrants`。它修的是授权表本身的缺口 —— 今天权限卡上点
  「本会话允许」重启也会丢;呈现授权只是第二个受益者。**不做这一批时**,呈现授权与既有会话授权同寿命
  (进程内),重启后下一次读照旧问 —— 退化得干净,不是错。

**仍然要问的(结构上成立,不靠特判)**:写 / 编辑各带自己的 `file_write` / `file_edit` 效果,过自己的策略;
`auto-accept-edits` 只放行 `external !== true` 的写,而写效果自己带着 `external` 位;敏感文件是
`sensitive_file_read`;`bash` 是 `bash`。授权只落 `external_directory` 一类,别的效果一个都碰不到。

**寿命与撤销**:授权跟会话走,关掉目录面板不收回。撤销走既有的 `permission-grants` 域 / 设置页
「权限授权」,条目上以 `metadata.issuer` 标出「在消息里引用」。审计:那次读的 `tool/audit` 照旧记
`external_directory`,并带命中的授权 id —— 「为什么没问」有出处。

## 3. 呈现

- `@` 下仍只有一组「文件」(守「分组只许一次」)。
- `primary` = 相对**它所在根**的路径;非工作目录的条目 `secondary` = 根的目录名,同名走
  `disambiguatedDirName`(`docs · a`)。工作目录条目在前,与今天逐像素相同。
- 授权本身不在输入面上画(它是发送的副产物);在设置页「权限授权」里可见可撤。

## 4. 陌生能力演练(法条,交卷前必答)

| 新能力 | 要改的 |
| --- | --- |
| 终端当前目录也能 @、也放行读 | 终端内容种类加 `referenceRoot` 与 `presents` 两行。其余零改动 |
| 把网页交给对话后,模型 reload 这一页不再问 | 网页引用种类加 `presents: ref => 'browser:tab/<id>'`;`browser:` 提供者加 `onPresented` 答 `browser_navigate`。命令、签发器、授权表零改动 |
| 开着的 git 仓面板 → `git:` 读不再问 | 改动面板那一种加 `presents`;`git:` 提供者加 `onPresented`。同上 |
| 插件的资源也想被呈现授权 | 插件资源提供者自带 `onPresented`,同一条路 |

每一行都是「能力自己的模块 + 一格自述」,`references/presented.ts`、`PresentationGrantIssuer`、
`session-command` 域、`permission-grants` 核心一字不动。

## 5. 施工序与门

> **本期范围(09-18)**:批一只做「检索」与「放行」里 §2.5.0 表上那一行端口 + 契约;批二只做根、呈现事实
> 与发送。批零、`onPresented`、签发器、`readable` 改动、放行相关的四步真机门与反证**全部暂缓**,
> 下面原文保留作将来的施工单。

**批零(暂缓)**:会话级授权进账本 —— `permission/granted` / `permission/revoked` 事件 +
水合折回 + 投影一致性(refold 门 `sessions:shadow-battery` 加一个授权场景)。

**批一(后端)**:
- 检索:shared 契约两处 + `file-search.ts` 的 `roots` 模式与保底 + files 域透传。
- 放行:`ResourceProvider.onPresented` + `dir` 提供者一格 + `PresentationGrantIssuer` + `SendMessageCommand.presented`
  契约 + `session-command` 域调用点 + `readable` 问授权表。

**批二(壳)**:`ContentKind.referenceRoot` / `presents` + `ReferenceKind.presents` + dir 两处自述 +
`references/roots.ts` + `references/presented.ts` + `PickContext.roots` + `file-mentions-source` 改签名、
`ownedByCwd` 退役 + 行上显示根名 + 发送带 `presented`。

**门**:
- 单测:`collectReferenceRoots`(去重 / 包含 / 包含工作目录 / 树序 / 被藏不算);保底名额;`collectPresented`;
  `PresentationGrantIssuer`(不可信来源丢弃、未知 scheme 不授权、`never-grantable` 拦下、幂等、上限);
  `dir.onPresented`(根内 `[]`、`/` 为 `[]`);`readable` 与 `read` 工具对同一路径同一授权答同一个结果。
- 结构测试:`references/roots.ts`、`references/presented.ts`、`presentation-grants.ts`、`session-command.ts`
  与工作台核心里 grep 不到 `dir` 种类名与 `external_directory`。
- 反证:删 dir 内容种类的 `referenceRoot` → 候选里没有外部目录、门红;删 `dir` 提供者的 `onPresented` →
  模型列外部目录弹权限卡、真机门红;`readable` 不问授权表 → 两把尺子测试红。
- 真机 `gate:composer-drawer` 加四步:开一个工作目录以外的目录面板 → `@` 出它的文件并带根名 → 选中 → 发送;
  模型列这个目录**不出权限卡**;模型写这个目录**出权限卡**;设置页「权限授权」里出现这一条、撤掉后再读**出权限卡**。
- 第 5 轴:`@` 到候选首帧 ≤ 16ms;候选刷新零 ≥ 50ms 长帧;发送路径因 `presented` 增加的耗时 < 1ms(纯函数)。

派工:Fable 拆分审查 / opus 执行 / haiku 提交;交卷带三张状态表(根表:无根 / 只工作目录 / 多根;
抽屉:关 / 开无候选 / 开有候选 / 超量;授权:无 / 签发 / 已存在幂等 / 撤销 / 重启后)与第 5 轴读数。

## 6. 留账

- `bash` 读外部目录仍按 `bash` 效果定性,不吃呈现授权;要不要让只读命令也认 `external_directory` 授权,单独拍。
- 「呈现」这一格今天只喂授权。它同时是一份好的提示词上下文(「用户此刻开着这几个目录」),要不要进
  `turn` 通道尾块,单独拍 —— 事实已经在命令上了,加的只会是一个读者。
