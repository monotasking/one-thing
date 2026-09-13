# 「改动」面:Dock 的 diff 瓦从 mock 变成一族真内容(2026-09-13)

上游:`dock-scope-2026-09.md` §2.2 `diff` 那一行与拍点 8(用户 09-09 追加「diff 多实例」);
`session-continuity-2026-09.md` §3(伴随面;C3 留账「`diff` 单例瓦留口」就是本单还的);
`desktop-os-2026-09.md` §1(文档身份 `diff:<repo>`);`docs/design/atom-2026-09.md`(资源三动词)。

## 0. 一句话

今天 Dock 上「改动」瓦点开是一块写死五行代码的 `DiffMock`。本单把它做成**与「目录」瓦逐字同一条路**:
瓦降格成**启动瓦**,内容是**一族** `diff:<workdir>`(一个工作目录一份改动面,多开、伴随会话),
数据来自后端一个新的 `git:` 资源(`status` / `diff` 两条**读法**,零做法),
渲染复用聊天正文里已有的 diff 块(`content/blocks/kinds/diff/`)。

## 1. 对象模型(面向对象审核)

| 对象 | 住哪 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| `GitResourceProvider`(装配层)+ `gitResourceSpec`(产品层) | `packages/backend/wiring/resource/git-provider.ts` + `packages/onething-runtime/src/files/git-resource-spec.ts` | 「一个工作树此刻改了什么」这件事实的**唯一产地**。`status` 读整表,`diff` 读一个文件的统一 diff | 不 stage / 不 commit / 不 discard(写面另单,拍点见 §8);不 watch |
| `diff` 内容种类(壳) | `content/kinds/diff.tsx` + `content/kinds/diff-ref.ts` | `{kind:'diff', key:<workdir>}` 的自述:标题 / 图标 / 渲染 / 焦点落点 / 伴随面 seed | 不知道 git;不知道 Dock |
| `diff` 启动瓦(壳) | `content/diff-launcher.tsx` | 点瓦 = 开环境会话 workdir 那一份;右键 = 最近目录;拖 = `diff:<cwd>` | 不渲染 |
| `ChangesPanel`(壳) | `content/changes/ChangesPanel.tsx` + 子件 | 一份改动面的整面:檐 / 文件列 / diff 体,六态 | 不自己发请求(经数据层) |
| `changes-source`(壳数据层) | `data/changes-source.ts` + `data/git-port.ts` | `statusQuery(root)` / `diffQuery(root,path)` 两个 query family;刷新语义 | 不存第二份真相(真相在后端那一读) |

**陌生能力演练**(仓根 CLAUDE.md 立法):拿「将来按文件 `diff:<workdir>#<file>`」或「`git:` 加一条 `log` 读法」来问,
要改的文件是:能力自己的模块(spec + provider / kind + panel)+ 一行登记(`mountBuiltinResources` 已有的一行不变;
`content/kinds/index.ts` 一行)。`workbench/*`、`stage/*`、`resources` RPC、`catalog-sync` **零改动**。骨架不动。

## 2. 后端:`git:` 资源

### 2.1 自述(产品层,零脊柱依赖,照 `files/resource-spec.ts` 的体例)

```
scheme: 'git'      title: 'Git working trees'
地址:git:<绝对路径>  —— 仓库里的任何一个目录都行,provider 自己 rev-parse 出根
reads:
  status  query {}   →  { repo: false }
                       | { repo: true, root, branch?: string, head?: string,   // head = 短 sha
                           files: [{ path, status, staged, unstaged,
                                     add?: number, del?: number, binary?: boolean, oldPath?: string }],
                           stat: { add, del, files } }
          status ∈ 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'typechange'
          path 是**仓库根相对**路径(与 git 自己说的一样);renamed 带 oldPath
  diff    query { path: string }  →  { path, text: string, binary: boolean, truncated: boolean }
          text 是 `git diff HEAD -- <path>` 的原文(暂存 + 未暂存合在一起,即「相对最近一次提交改了什么」);
          untracked 文件走 `git diff --no-index -- /dev/null <path>`(退出码 1 = 有差异,是成功不是失败);
          超过 1 MiB 截断并 `truncated: true`(数字入 spec 常量,不散)
ops: {}   —— 本单**零做法**。写面是另一张拍点表(§8)
```

`README`-级的描述文案照 `dirResourceSpec` 的语气写给模型看(它会自动成为 `git` 工具的说明)。

### 2.2 实现(装配层,`git-provider.ts`)

- **沙箱与目录资源同一把尺子、同一序**:`resolveReadable(ref.path, ctx.sandbox, ctx.sessionId)`——把 `dir-provider.ts` 里那只
  `resolveReadable` 与 `DirOutsideSandboxError` **抽到同目录一只 `path-guard.ts`**(两只 provider 共用,判词搬过去;
  `dir-provider` 改成 import,行为零变),不许复制一份。
- 读根判的是**地址那个目录**;`rev-parse --show-toplevel` 出来的根**也要过一遍读根**(地址在界内、根在界外 = 拒,
  否则一个接入的子目录会把整个上级仓库的改动交出去)。
- 跑 git:`node:child_process.execFile('git', [...], { cwd, maxBuffer, signal: ctx.signal, env: {...process.env, GIT_OPTIONAL_LOCKS:'0', LC_ALL:'C'} })`,
  公共参数 `-c core.quotepath=false --no-optional-locks`。`status` = `status --porcelain=v2 -z --branch` +
  `diff HEAD --numstat -z`(HEAD 不存在的空仓 → 退回 `diff --cached --numstat -z`);untracked 的行数由 provider 自己数
  (读文件数 `\n`,>1 MiB 或含 NUL 视为 binary 不数)。
- 三只具名错:`GitUnavailableError`(spawn ENOENT:这台机器没有 git)、`GitOperationFailedError`(非零退出,stderr 原样带出)、
  地址缺席 `GitRefRequiredError`。**「不是仓库」不是错,是 `{repo:false}`**——面板与模型都要拿它当一种状态。
- `attach(hub)` 收着但本单**不发事件**(没有 watch,发不出真话)。
- `read-guard`:`createLocalOnlyReadGuard.schemes` 加 `GIT_RESOURCE_SCHEME`(与 `dir` 同一条「非本机可信一律拒」)。
- 挂载:`mountBuiltinResources` 里 `kernel.mount(new GitResourceProvider())` 一行,**不分 tier**(读法零效果,server / CLI 也该答得出)。
- 副作用要说清:挂上即自动多一只 `git` 工具(`catalog-sync`)。它只有两条读法,模型用它比 `bash git status` 拿到的是结构化表。
  `spec.visibleIn` 不写(到处成立,与 `dir` 一致)。

### 2.3 后端测试(vitest,`wiring/resource/__tests__/git-provider.test.ts`,照 `dir-provider.test.ts` 的夹具法)

真 git:`mkdtemp` → `git init` → 提交一版 → 造出 modified / added(staged)/ deleted / renamed / untracked / binary(PNG 字节)
六种;断言 `status` 六行的 `status / staged / unstaged / add / del / binary`、`stat` 合计;`diff` 对 modified 文件的 text
含 `@@`、对 untracked 的 text 含 `+++ b/`、对 binary 的 `binary: true` 且 text 为空;子目录地址 rev-parse 到根;非仓库目录
`{repo:false}`;越界拒 `DirOutsideSandboxError`(共用那只);`PATH=''` 下 `GitUnavailableError`;`truncated` 用一只 2 MiB 文件
证。read-guard 用例:非本机可信 → deny。spec 过 `validateResourceSpec`(与 `dir` 的契约用例同一句)。

## 3. 壳:一族 `diff:<workdir>`

### 3.1 种类自述(`content/kinds/diff.tsx`,逐字对着 `dir.tsx`)

```
id: DIFF_KIND('diff')  singleton: false  level 缺省(space)
title: { text: disambiguatedDirName(key) || baseNameOf(key), tip: key }   —— 与目录 tab 同名,靠图标分辨
icon: 'GitCompare'
render: <ChangesPanel root={ref.key} />
focusInto: 'diff'      —— focus/scopes.ts 加一行 diff 作用域(restingTarget = 文件列第一行;onEscape 不认)
companion: { seed: env => env.workdir ? diffRef(env.workdir) : null }   —— C3 留口在此还清
```

`diff-ref.ts` = `terminal-ref.ts` 的形(`DIFF_KIND` / `diffRef(workdir)` / `diffWorkdirOf(ref)`)。
`content/kinds/index.ts` 加 `import './diff'`。

### 3.2 启动瓦(`content/diff-launcher.tsx`,逐字对着 `files-launcher.tsx` / `terminal-launcher.tsx`)

- `open()`:`sessionDirOf()` 有 → `placeRef(diffRef(cwd), regionForLauncher(ref))`;没有 → 交 `residentKind: DIFF_KIND` 那条退路
  (屏上已有别的改动面就激活它);连那也没有 → `notify({ level:'info', ... t('diff.noWorkdir') })`。**不退到 `~`**:
  主目录不是仓库,给人开一格「不是 git 仓库」是一次没人要过的打开(与 `dir.companion.seed` 那句判词同源)。
- `dragRef()`:cwd ? `diffRef(cwd)` : null。
- 右键:`MenuSection(files.recentDirs)` + `recentRoots` 每行开 `diffRef(root)`(复用同一本「最近目录」账,不另起一本);
  没有「打开目录…」那一行(选一个目录看改动是目录瓦的事,点开后从檐上跳过来——本单不做跳转,留账)。
- `regionForLauncher`:`memory ?? defaultPlacement ?? CENTER`。瓦表那一行**不加 `defaultPlacement`**:改动面要的宽度与一段对话一样,
  天生落中央(与浏览器瓦同一句判词);存量记忆压过它。
- `stage/items.ts` 的 `diff` 行 id / titleKey / icon **一个字不改**(位置记忆按 id 记),只在它头上把「与终端那一行逐字同一条路」写上。
- `content/index.tsx`:删 `diff: DiffMock` 那一行,注释照 `files` / `terminal` 两段的体例写「撤了」。
- 删 `content/DiffMock.tsx`;`mocks.module.css` 里 `.diff*` 五条删;`dev/Gallery.tsx` 那一行图标示例留(它只是图标表)。
- **存量档案**:`panel:diff` 的 tab 在旧档案里会剩下来。找 T1 / W6-a 处理 `panel:terminal` / `panel:files` 的那一处迁移
  (`workbench` persist 的 `sanitize` 或版本迁移),照同一条把 `panel:diff` 清掉——**不加新机制**,找到那一条抄。

### 3.3 数据层(`data/git-port.ts` + `data/changes-source.ts`)

- `git-port.ts` = `browser-port.ts` 去掉 nativeView:`read(ref, name, query)` + `configureGitPort()` 测试注入口。
- `changes-source.ts`:`statusQuery = createQueryFamily<GitStatusView>(root => port.read(gitRef(root),'status'))`;
  `diffQuery = createQueryFamily<GitDiffView>(key(root,path) => port.read(gitRef(root),'diff',{path}))`。
  `ResourceReadView` 四支折成 query 的 error(`denied` / `failed` / `invalid` 各带原话,**不发明文案**)。
- **刷新语义**(四律:重拉旧内容留屏、骨架只首载):① 面板首次可见 `ensure()`;② 檐上一颗刷新钮 `refetch()`;
  ③ **环境会话一轮跑完**——`run/end` 到达时(`chat-source` 已经在处理它,找那一处挂一个订阅口;若那一处没有现成的外部订阅口,
  加一口 `onRunEnded(sessionId, cb)`,别在面板里 poll)对所有**在场**的 `diff:` 面 `refetch()`,不在场的 `invalidate()`。
  没有 fs watch,与目录面同一条留账(`files-port.ts`)。
- `diffQuery` 拉到的 `text` 经 `parseUnifiedDiff` 成块;解析不动(binary / 空)走对应态,不画空卡。

### 3.4 面板(`content/changes/`)

组件树:

```
ChangesPanel(root)                          FocusScope 'diff'
├─ ChangesHeader     檐:仓库根名(≠root 时 tip 写根)· 分支 · 合计 +a −d · 刷新钮 · 拖把手(useContentDrag,拖出 diff:<root>)
├─ Splitter(左右;useSplitPrefs 新 id CHANGES_SPLIT_ID,缺省 0.32)
│  ├─ ChangeList      文件列:状态字母(M/A/D/R/?/!)上色只上字不换底 · 路径(目录淡、文件名实)· ±数字;
│  │                  roving list(src/ui/a11y/list-selection),↑↓ 选,Enter/双击 = 用 openFileInCurrentTarget 开那个文件
│  └─ ChangeBody      选中文件的 diff:<Diff model={parsed}/>(块本体原样复用,檐不复用——面板自己的檐已写文件名与 ±)
```

**三张状态表**(派工必带,交卷附勾选):

面板整面:

| 态 | 触发 | 画什么 |
| --- | --- | --- |
| initial | 首载在飞 | 骨架三行(仅 `phase==='initial'`) |
| not-a-repo | `{repo:false}` | 一行提示 + 路径,无按钮(接入 git 不是这块面的事) |
| clean | `files.length===0` | 「没有未提交的改动」+ 分支名 |
| ready | 有行 | 列 + 体;首次 ready 自动选第一行 |
| error | denied/failed/invalid | 通知行(TriangleAlert)+ 原话 + 重试钮(AsyncButton 走 mutation.pending) |
| refetching | 有旧数据在飞 | 旧屏不动,刷新钮自身 pending |
| 超量 | 2 000 行文件 / 单文件 20 000 行 diff | 列表窗口化(复用 `useRowWindow`);diff 体 `content-visibility: auto` 逐 hunk;首帧 ≤16ms(第五轴) |

文件行:rest / hover / selected / focus(全局 :focus-visible 环)/ renamed(两段路径 `old → new`)/ binary(±换成「binary」字)。

diff 体:parsed / binary(一行「二进制文件,不展示」)/ truncated(块尾一行「已截断,前 1 MiB」)/ empty(选中文件在两次刷新间被撤销改动 → 回 clean 判据)。

Token 纪律:零字面色值 / px / ms;状态色只上字母与图标;`tokens.css` 已有 diff 红绿(块用的那两条)直接复用。

### 3.5 i18n

`diff.noWorkdir` / `diff.notRepo` / `diff.clean` / `diff.refresh` / `diff.binary` / `diff.truncated` / `diff.filesSection` /
`diff.statusM|A|D|R|U|C` 的 aria 名,zh / en 成对;`i18n.test.ts` 单边检查照过。

## 4. 测试与门

- 壳 vitest:`kinds/__tests__/diff-kind.test.tsx`(自述四格 + seed 有 / 无 workdir)、`__tests__/ref-syntax` 自动覆盖新种类、
  `changes-source.test.ts`(假 port:四支折错、run/end 刷新在场 vs 不在场)、`changes-panel.test.tsx`(六态各一例 + 选行开文件 +
  超量 2 000 行不重挂)、`diff-launcher.test.ts`(有 cwd 开、无 cwd 退 resident、都没有 toast、右键最近目录)、
  companions 既有用例加「离场开着改动面 → 进场 seed 出 `diff:<b-workdir>`」。
- 根 vitest:§2.3 那组。
- 真机门 `gate:changes`(新 `scripts/gate-changes.mjs`,照 `gate-files.mjs` 的骨架,server 宿主起得来——`git:` 不挑宿主):
  ① 临时仓 + 一处修改 → 会话绑它 → 点「改动」瓦 → 面板在中央区、列 1 行、diff 体含那一行 `+`;② 再改一文件、点刷新 → 列 2 行,
  **旧行 DOM 节点不变**(零重挂);③ 第二条会话绑另一临时仓 → 切会话 → seed 开出第二份、第一份收进账;切回 → 第一份回来;
  ④ 无 workdir 会话 → 点瓦 → toast,零新标签;⑤ axe 一屏(第二轴:这一屏在 server 宿主等得到,进 `gate-a11y.mjs` 而不是自留);
  ⑥ 第五轴读数:2 000 行改动的仓,点瓦到首帧可见 ≤16ms、列上屏 ≤100ms,dev / prod 各一列,`BUDGET` 表照 `gate-terminal` 体例,
  达不到的写进 `TRANSITIONAL` 并写退场判据。
- 静态:壳 `npm run verify` 全套;根 `boundary:gate` / `transport:gate`(ipcMain 仍 2、IPC_CHANNELS 不长)/ `assembly:gate`
  (provider 零模块级 `let`)/ `log:gate`(零 `console.*`)。

## 5. 交卷格式

diff + 三张状态表勾选 + 读数(dev / prod)+ 反证(至少四条:拆 `resolveReadable` 根检查 → 越界用例红;`seed` 恒 null →
companions 用例红;`run/end` 订阅拆掉 → source 用例红;`{repo:false}` 改成抛 → 面板 not-a-repo 态用例红)+ 留账。
不派 review(Fable 亲自读 diff);不提交(haiku 提交,信息文件 chmod 444)。

## 6. 施工纪律

- 在独立 worktree 上做(主检出上跑着桌面,HMR 会把半改的 persist 迁移回写用户存档——09-13 判例)。
- `node_modules` 逐项符号链接农场(`@onething/*` 五条指 worktree 自己的 `packages/*`;`apps/desktop-react/node_modules` 同样)。
- 混合文件(i18n 两只、`content/index.tsx`)只提交本单那几行。

## 7. 拍点(用户可感知;缺省 = 本单已按缺省做)

| # | 变化 | 本单取法 | 另一条路 |
| --- | --- | --- | --- |
| 1 | 「改动」瓦点开落哪 | 中央区(记忆压过) | 左架子(与目录并排) |
| 2 | 会话没 workdir 时点瓦 | toast,不开 | 开 `~`(目录瓦的做法;但 `~` 不是仓库) |
| 3 | diff 口径 | 相对 HEAD(暂存 + 未暂存合并) | 分「已暂存 / 未暂存」两段(需 index 那一读,写面到来时再分) |
| 4 | 模型多一只 `git` 工具(两条读法) | 接受(挂载即得,零效果) | `visibleIn` 隐藏它 |
| 5 | 檐上「打开目录」跳转 / 从目录面跳到改动面 | 不做 | 留账 |

## 8. 留账

- 写面(stage / unstage / discard / commit)= `git:` 的 ops,效果类要新开一行(`git_write`?)并过效果表;另单。
- 没有 fs watch;刷新三条路见 §3.3。
- 按文件 `diff:<workdir>#<file>`:形状留着(key 里带 `#`),本单不做。
- 两片会话叶并排时伴随面只跟环境会话(既有裁定)。

## 9. 施工记录(2026-09-13,后端 / 壳两位 opus 并行,Fable 三轮亲审)

审出来并改回去的,按轮次:

- **后端一轮**:`diff` 读法的目标文件没过沙箱三关(`.env` 的 diff 会原文交给模型,而 `read` 工具对同一文件是拒的)→ `path.join(root,target)` 再过一遍 `resolveReadable`;`status` 缺 `-uall`(未跟踪的新目录列成 `dir/` 一行,面板点它就炸);`execFile` 4 MiB `maxBuffer` 改 `spawn` 流式截断(超限先判、`diff` 允许 overflow、元数据三条 16 MiB 仍是失败);gitconfig 钉三格 `-c`(`diff.noprefix=false` / `diff.mnemonicPrefix=false` / `color.ui=never`)+ `diff` 子命令 `--no-ext-diff`(**`-c diff.external=` 是错的**:git 会拿空串去 exec,整条读法死);未跟踪计数 32 MiB 总预算,且**敏感文件不打开**(`add` 缺席不是零,与「不给看」同一条判词)。
- **后端二轮(真机门卡住的根因)**:资源沙箱的读根**漏了发起会话的工作目录**——工具那条路(`toolkit/families/file.ts` 的 `sandboxRoots`)拿会话 workdir 当读根,资源这条路 `createSandboxPolicy()` 没传;同一个会话、同一个仓,`read` 工具读得到而 `dir:` / `git:` 答「outside the sandbox root」。修在 `createSandboxPolicy(cwd, { workingDirectoryRootsFor })` + `wiring/resource/index.ts` 按 `scope`(= `ctx.sessionId`)查 `store.getSession(scope).workingDirectory`;**资源读根 = 工具读根,同一张表**。同批:仓根在读根之外时(会话 workdir 是仓的子目录)`status` 用 **pathspec** 按地址范围列,结果多一格 `scope`(`''` = 整仓;缺席 = 没说范围),`diff` 的范围仍由第三关判;`root` 照旧给真仓根。
- **壳一轮**:`changes-source` 的模块级订阅改成在场账 `onFirst` / `onLast`(import 零副作用);在场账 `Set` → 引用计数(同根两份、关一份另一份仍在场);可见的 diff 也 `refetch`(`useDiffLive` 报到),其余 `invalidate`;`git-port.read` 带**发起坐标** `sessionId` = `envSessionId`(这是后端按会话工作目录判读根的钥匙);占位 query 照 `file-peek-source` 的空串先例并显式跳过;`run/end` 广播加 `hydrated` 门(实测冷载两条路都不经 `feedLedger`,这一格是把顺带成立的性质写成结构,用例当看守)。

留账(本单不做,写在这里不写在代码注释里):

- 沙箱三关是**词法**判据(`resolveCoreToolPath` 无 realpath),仓内指向沙箱外的符号链接判不出;今天挡住内容外泄的是 git 自己不跟随符号链接。补它要动产品层那两只共用函数,`read` 工具 / `dir` 资源同病。
- `--no-textconv` 未加(`.gitattributes` 的 textconv 是仓库作者为了让文件读得懂才配的)。
- 范围外重命名进范围内的文件,numstat 一半在范围外,`add` / `del` 可能缺席;`path.relative` 那道保险(两边真实路径不同源就抛原拒绝)只有逻辑没有用例。
- 面板不画 `scope`(会话 workdir 是仓子目录时,列的是那一段);要画是檐上一格。
- 单文件 diff 超 1 MiB 截断(`GIT_DIFF_MAX_BYTES`),元数据三条 16 MiB 上限。
