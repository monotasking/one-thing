# markdown 图片渲染与资产块扩展路线(2026-09-13)

正本。上游设计:`docs/design/react-shell-content-blocks-2026-08.md`(块词汇 §1、注册表 §3、动作组 §4.2、流式契约 §6)、`apps/desktop-react/docs/stream-render-2026-09.md` §五(内容模型扩展性:part 有型 + 注册表分发 + 管线不认识型)与 §六 第 11 条(远程图片默认阻断)。

## 0. 现状与真店读数

今天 `![alt](url)` 在正文里**原样当文字摆出来**(`markdown/to-inline.ts` 的 default 支:词汇表里没有 image,P1 时记为拍板件)。另一路,账本里的图片 part(附件 / 生图流)在装配管线里已经产出 `image` 段,但 `SegmentView` 的 `image` 支返回 `null` —— 生成的图在 React 壳上一张都不显示。

真店(`~/.onething/sessions`,493 会话,只读扫描 2026-09-13):

| 读数 | 值 |
| --- | --- |
| 带 markdown 图片的会话 / 事件 / 图片数 | 36 / 118 / 247 |
| 独占一行 vs 夹在文字里 | 77 vs 170 |
| 地址形状:相对路径 / http(s) / `/…` 网站式路径 | 183 / 51 / 13 |
| 产地:`message/imported` / `tool/result`(read 笔记)/ `assistant/chunks` | 76 / 23 / 14 |

三个结论决定方案:①**相对路径是大头**(Obsidian 笔记里的 `../../90-99 Resources/91 Attachments/x.png`,经 `read` 工具或查看器进来),解析必须知道「相对谁」;②http 图片有,但都是模型编的占位图,远程图片默认阻断(§六 11)不会伤到真实用法;③`/uploads/…` 这种网站式绝对路径不是本机文件,按本机路径解析一定失败 —— 失败态必须诚实(显出地址),不能画一个破图标。

## 1. 词汇(一次拍板,渲染器逐期补)

```ts
// model/inline.ts
| { type: 'image'; ref: ImageRef; alt: string; title?: string }
// model/blocks.ts
| { kind: 'image'; ref: ImageRef; alt: string; title?: string }
/** 图从哪来。今天只有作者写下的地址;P2 加 `{ kind: 'blob'; blob: BlobRef }`(账本 part)。 */
export type ImageRef = { kind: 'url'; url: string }
```

- **独占一段的图是物件,夹在字里的图是行内词**:mdast 里 image 永远是行内节点(phrasing),翻译表把「段落只装一张图(前后只有空白)」提升成 `image` 块;其余留在段落里作行内 `image` 节点。判据落在 `to-blocks.ts` 一处。
- `ref` 从第一天就是联合而不是一根字符串:P2 的账本图片走 `blob`,不改这一格就是改骨架。
- `inlineText` 对行内图返回 `alt`(复制正文得到替代文字,与 GitHub 同)。
- `imageReference`(`![alt][id]` 引用式)与 Obsidian 的 `![[x.png]]` 不进本批:前者仍走 default 支原文可见;后者不是 CommonMark,是**新生产者**(§3),见 §6 路线。

## 2. 地址解析 = 资产层的第二张表(`blocks/asset/`)

「一个地址怎么变成 `<img src>`」不是图片的私事:视频、文件、将来任何资产块都要答同一个问题。所以它住在 `src/content/blocks/asset/` 而不是 `kinds/image/` 里,图片块只是它的第一个消费者。

`asset/resolve.ts`:`resolveAssetRef(ref, ctx): AssetResolution`(同步、纯,按 `url` 的 scheme 分派):

| 地址 | 结果 |
| --- | --- |
| `data:` | `ready`,原样 |
| `http(s):` | 宿主未放行 → `gated { host }`;放行 → `ready` |
| `file:` | `ready`,原样(只在 file:// 起源的页面成立,与查看器 image 型同一条限制) |
| `/绝对路径` | `ready`,`fileUrlOf(path)` |
| 相对路径 | `ctx.baseDir` 在 → `ready`,`fileUrlOf(join(baseDir, decodeURIComponent(rel)))`;不在 → `unresolvable { reason: 'no-base' }` |
| 其余 scheme(`javascript:` 等) | `unresolvable { reason: 'scheme' }` —— §六 11 的 scheme 白名单 |

`asset/remote-policy.ts`:`REMOTE_ASSET_POLICY = 'gate'`(一行常量,翻它 = 改成 `'load'`),`allowHost(host)` / `isHostAllowed(host)` 是本次运行内的放行表(模块级 Set,配 HMR dispose,不落盘 —— 落盘是设置件,见 §6)。

`asset/dimensions.ts`:`rememberSize(src, w, h)` / `knownSize(src)` —— 一张图加载过一次就记住内在尺寸;再次上屏(重折 / 切回会话 / 冷载)按 `aspect-ratio` 先占位,**第二次起零位移**。这是 §五 4「元数据先行」在没有元数据产地时的兑现:第一次加载仍有一次位移(占位是固定最小高),记在留账。

`BlockCtx` 加一格 `baseDir?: string`(可缺席 = 「这里没有文档位置」):查看器 markdown 型传文件所在目录;聊天今天不传(会话 workdir 是 P3 的事)。

## 3. 图片块(`kinds/image/`)

注册:`presentation: 'object'`,`stream: { midway: 'hold', settled: 'swap', failure: 'honest', identity: 'origin', geometry: 'reserve' }`。

- `hold` / `swap`:`![alt](https://exam` 半截时 micromark 把它当文字,段落照 `grow`;右括号到了那一刻段落原位换装成图块(换 kind = 换身份号 = 重挂,正是 `swap` 的语义)。图块在合上之前不出现,由段落代画 —— 与 figure 由 `code(closed:false)` 代画同构。
- `identity: 'origin'` 而不是 `'ref'`:`ref` 那一档今天没有消费者,而同一张图在一条消息里出现两次按内容哈希发号会撞键;账本图片(P2)再谈。
- `failure: 'honest'`:图块自己就是失败态的归宿(§4),不落 source-fallback —— 它的「源码」只有一行。
- `geometry: 'reserve'`:壳给 `scrollbar-gutter`;真正的占位由块自己的 `aspect-ratio` 盒完成(§2 尺寸表)。

檐:`id` = `image`;`meta` = 宿主名(远程)或文件名(本地)。动作:`zoom`(檐上唯一露出,`frontActions: 1`)+ `view-source`。`download` 本批不接:执行器只认 SVG→PNG,位图下载是 §6 的一格。

`zoom` 动作与浮层各加一格:`{ verb: 'zoom'; svg?: SvgSource; image?: () => { src: string; alt: string } | undefined }`,`ZoomOverlay` 收 `{ svg } | { image }`;`isBlockActionRunnable` 判「两个取件口有其一」。词表**没有**新动词。

`blockSourceText` 加 image 一支:重组成 `![alt](url "title")` —— 「查看源码」看到的是作者写的那一行,不是一段 JSON。

### 3.1 状态表(交卷随报勾选)

生命周期:挂载(解析地址 → 读尺寸表)/ 流式换装(段落→图块,重挂一次)/ 换宿主(聊天 / 查看器 / 列表项 / 引用内,同一个组件)/ 卸载(无订阅要退)。

UI 生命状态:

| 态 | 形 |
| --- | --- |
| gated(远程未放行) | 占位卡:图形字 + alt + 宿主名 + `ui/Button`「加载图片」;点了放行该宿主并转 loading |
| unresolvable | 一行诚实态(text-3):alt + 地址(mono,`overflow-wrap: anywhere`),**不挂 `<img>`** |
| loading | 占位盒:尺寸表命中按 `aspect-ratio`,未命中按 `--img-placeholder-h`;`<img>` 已挂,`data-state="loading"` |
| ready | 图居中,`max-width: 100%`,自然尺寸不放大,`onLoad` 写尺寸表 |
| error(`onError`) | 一行诚实态「这张图没加载出来」+ 地址 mono,与 figure 失败行同形(`text-3`,不是 danger) |
| 超量 | 一条消息几十张图:每张各自 gated / 占位,不预取、不并发解码(浏览器自己排);同宿主只放行一次 |

交互:rest / hover(檐动作显出,壳的既有配方)/ focus(「加载图片」钮走全局环)/ pending(点了放行到 onLoad 之间是 loading 占位)。

## 4. 行内图 = 一颗芯片,不是一张小图

`InlineRun` 的 `image` 支画 `InlineImage`:图形字 + alt(alt 空则地址末段),`ui/Tooltip` 显地址;非交互(`<span>`)。理由:段落是「纸上的一段字」,行内塞一件会长高的物件破坏 `pre-wrap` 行律;而行内图的真实用法是徽章与笔记里顺手嵌的图 —— 芯片说清「这里有一张图」,要看就把它写成独占一段(模型与人都这么写,真店 77 处)。点芯片放大是留账(§6),不是本批。

## 5. 陌生能力演练

**加 `video` 块**:`model/blocks.ts` 加一行词汇;`kinds/video/{index,Video}.tsx` + `index.ts` barrel 加一行;地址解析、远程放行表、尺寸表**一个字不改**(它们在 `asset/`,不认识 image);`to-blocks.ts` 不改(markdown 没有视频语法,产地是 P2 的 part)。答案是「能力自己的模块 + 注册一行」,骨架抽到位。

**加 `blob` 地址(P2)**:`ImageRef` 加一员;`asset/resolve.ts` 加 `blob` 一支(异步:`readBlob` → objectURL,缓存 + bump,与 figure 缓存同手);`SegmentView` 的 `image` 支改画 `BlockView({ kind: 'image', ref: { kind: 'blob', blob } })`。图片组件不改。

## 6. 分期总览

| 期 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 本文 §1–§4:词汇 + 翻译 + `asset/` 三件 + 图块 + 行内芯片 + zoom 扩格 + 查看器传 `baseDir` | 本批 |
| P2 | 账本图片走同一个块:`ImageRef.blob` + 异步解析 + `SegmentView.image` 通电(生图流、附件缩略) | 待派 |
| P3 | 聊天里的相对路径:`baseDir` 取会话 workdir(`ctx.sessionId` → 会话档);Obsidian `![[x.png]]` 作**新生产者**接进翻译(micromark 扩展一格,不进核心) | 待拍 |
| P4 | 位图下载(`download` 执行器加 `href` 取件口)、行内芯片点击放大、多图一段的画法 | 待拍 |
| P5 | `video` / `file` 块(§5 演练路径)、远程放行落盘为设置(若用户要「永远加载」) | 待拍 |

## 7. 留账

- 首次加载有一次位移(无尺寸元数据);第二次起零位移。P2 的账本图片若带宽高则第一次也零位移。
- 远程放行只记一次运行;`REMOTE_ASSET_POLICY` 一行可翻,是否做成设置待用户拍(设置极简原则,默认不加格)。
- `file://` 图只在打包壳成立,dev / 浏览器面落 error 诚实态 —— 与查看器 image 型同一条限制,根治是核心加一条字节路由(P3 一并看)。
- 行内 `imageReference` 与多图一段仍原文可见 / 芯片化,无一处白屏。
- 流式一帧闪烁(审查实测,`MarkdownBlockStream` 零违例):`![a](x.png)` 的右括号到了那一帧段落换装成图块,若**同一行后面还来字**,下一帧再退回段落 —— 中间那一帧远程是一张放行卡、本地是一次被当场撤掉的 `<img>` 加载。真店里「图后同行跟字」极少(行内图多半是字在前),不为它加机制;要治是让活尾巴上的段落不提升(块流知道尾巴,翻译表不知道),记为 P4 顺手件。
