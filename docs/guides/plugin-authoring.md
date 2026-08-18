# onething 插件作者指南

面向插件作者的全流程契约:从三件套到发布上架,每条规则都注明**为什么**
以及**违反时宿主会做什么**(大多不是警告,是拒装/回滚)。

市场仓库:[`github.com/monotasking/plugin`](https://github.com/monotasking/plugin)
(仓库机制详见其 README;本文是作者视角的完整契约)。

## 三分钟上手

```bash
# 1. 克隆市场仓库,在 packages/ 下建你的插件(三件套)
mkdir packages/my-plugin
#    packages/my-plugin/plugin.json      —— 声明(manifest)
#    packages/my-plugin/plugin-entry.ts  —— 唯一源码入口
#    packages/my-plugin/package.json     —— 账(name/version)

# 2. 构建(根目录先 npm install 一次,装 esbuild)
node scripts/build-plugin.mjs packages/my-plugin
#    → packages/my-plugin/dist/ 是一个完整的零依赖 npm 包

# 3. 本地装(file: 开发通道,软链秒装秒卸)
#    onething 设置页 → Plugins → Install Plugin:
#      包名  @onething-plugins/my-plugin
#      路径  <仓库>/packages/my-plugin/dist
```

## manifest(plugin.json)字段表

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 显示名;建议与目录名(= pluginId)一致 |
| `version` | ✅ | **版本单源铁规**,见下 |
| `description` | 推荐 | 市场卡片与已装列表都显示 |
| `author` | 推荐 | 市场卡片显示 `by <author>` |
| `entry` | 否 | 入口文件名,缺省 `plugin-entry.js`(指 dist 里的产物名) |
| `minAppVersion` | 否 | 宿主版本不足时:市场 Install 置灰、装了也一行不跑(加载闸) |
| `contributes` | 否 | **声明先于代码**的全部贡献点,见下 |

`contributes` 子字段(装前确认页展示的就是这份声明,不是营销文案):

| 子字段 | 形状 | 宿主行为 |
|---|---|---|
| `commands` | `string[]` | 斜杠命令声明 |
| `panels` | `[{id,label,view?,entry?}]` | 工作区面板。缺省 `view: "descriptor"`(描述树,UI 不执行插件代码);`view: "webview"` + `entry` 走逃生舱,见下 |
| `webviewRoot` | `string` | webview 面板的静态资源根,**相对包目录**,缺省 `webview` |
| `uiSlots` | `[{anchor,id,label,lifetime?,drawer?}]` | UI 锚点(常显块或触发式,**由锚点决定**,见下);未知锚点按"此版本不支持"呈现。`lifetime: "persistent"` 是**消息态落盘的闸门**(见下),缺省 `"ephemeral"`;`drawer: true` 开抽屉三态(**仅 `composer.above`**,别处声明被忽略,见下) |
| `theme` | `{overrides?:{token:color}, background?:{image,darkImage?,opacity?,blur?,fit?}}` | 主题 token 覆盖 + 背景图(见下);装前确认页列出被改的 token 与"会铺背景图" |
| `settings` | `{schema}` | JSON Schema 子集,宿主渲染并校验设置表单 |
| `permissions` | `string[]` | 装前确认页如实列出(已登记的枚举翻成人话)。**被消费的**:`sessions:peek` / `sessions:post` / `sessions:trigger`(见「跨会话信使」)、`input:intercept` / `toolcall:intercept` / `toolresult:intercept`、`llm:complete`、`deeplink:handle`、`search:provide`、`storage:external-root`(见「受管文件树」);未登记的名字原样显示、不参与判定 |
| `activationEvents` | `string[]` | 激活事件声明 |

## 打包铁规(每条都有宿主侧硬闸)

1. **零运行时依赖**。依赖尽管写进 `package.json` 的 `dependencies` ——
   构建时 esbuild 全部 bundle 进单文件 `plugin-entry.js`,dist 的
   package.json 会被剥光。宿主安装时再校验一次:**有运行时依赖 = 拒装
   并回滚**(bundle 规则)。
2. **版本单源**:`plugin.json` 的 `version` 必须等于 `package.json` 的
   `version`。索引版本来自 tag(= package.json),而宿主的更新通道拿
   运行时 manifest 版本(plugin.json)去比 —— 漂移 = 更新徽标永不灭。
   build-plugin.mjs 硬校验,过不了构建。
3. **不要依赖 install 脚本**。宿主一律 `npm install --ignore-scripts`
   安装,你的 postinstall **永远不会被执行**。构建期(bundle)能做的
   事不要推到安装期。
4. **命名契约**:包名必须 `@onething-plugins/<id>`(v1 单一 scope),
   目录名必须等于 `<id>`;**pluginId = 包名去 scope**。id 撞上宿主内置
   插件(当前 `log-monitor`、`note-skills`)会被**装前拒绝**。
5. **tarball 即全部**。宿主从 GitHub Releases 的 tarball URL 安装,
   只认 `https://`;索引的 sha512-SRI 与 package-lock 条目逐字符比对,
   不符拒装并回滚。

## 发布流

```bash
# 1. bump 两处 version(plugin.json + package.json,保持一致)
# 2. 提交,打标签 —— 标签名是唯一的发布动作:
git tag my-plugin-v1.1.0 && git push origin main --tags
# 3. CI:版本一致性校验 → bundle → npm pack → Release 挂 tarball →
#    重生成 index.json(SRI 对 asset 实体现算)→ 提交回 main
```

- 市场卡片的事实(描述/contributes/minAppVersion)取自**那个 tag** 上的
  plugin.json,不是 HEAD —— 用户装前看到的就是他将装的那一份。
- 发布后索引可能有秒级延迟(CI 重试兜底),手动核对:
  `node scripts/regen-index.mjs --expect-tag=my-plugin-v1.1.0`。

## 更新通道语义(作者需要理解的)

- 用户侧的"有更新"= 索引版本 > 该插件**运行时 manifest 版本**
  (plugin.json 的 version)。所以版本漂移的后果是用户永远看到更新徽标。
- 更新 = 安装新 tarball URL(不走 `npm update`);装后宿主会重校
  minAppVersion,不够则**自动回退旧版**并告知用户。
- 数据不随更新动:config/KV/storage 住在家目录(见下),npm 只碰
  node_modules。

## 工具(api.registerTool)

```js
api.registerTool({
  name: 'peek_index',
  description: '读一份只读索引',
  parameters: z.object({ key: z.string() }),
  executionMode: 'parallel',        // 可选,见下
  prompt: {                         // 可选:随工具进出的提示词,见下
    guidelines: ['查索引前先 peek_index,别用 bash 去 grep 索引文件'],
  },
  async execute(args, ctx) {
    return { title: 'peek', output: '…', metadata: {} }
  },
})
```

工具 id 由宿主加命名空间:`plugin:<你的插件 id>:<name>`。
`permissionGuard` **不由你决定** —— 插件工具一律 `permission-gated`
(填别的值只会收到一条警告,判定不变)。

`ctx` 携带 `sessionId` / `messageId` / `toolCallId` / `workingDirectory` /
`abortSignal` / `agentId`。

### `ctx.agentId`:这一回合是谁的

`agentId` 是**回合入口一次解析出来的身份归属**,三个地方给你的是同一个值:
工具 `ctx`、promptContext provider 的 `context.agentId`、
`afterAssistantResponse` 钩子的 `ctx.agentId`。缺省 `undefined` = 这条会话没绑
agent(要按 agent 分作用域时就只剩 global,那是正确的降级)。

- **别自己去反查会话的 agentId**:群聊房里那个字段由协调器逐次翻面,现查等于
  每处各算各的,而你会安静地读到另一个 agent 的数据。
- **它不是权限凭据**。权限的主体是宿主内部的 principal(有被证明过的来路),
  `agentId` 只用来分作用域。

### `executionMode`:这个工具能不能和兄弟并发

模型可以在**同一条回复里**一次开出多个 tool_use。宿主的调度器按每个工具的
声明决定它们怎么排:

| 声明 | 调度行为 |
| --- | --- |
| `'parallel'` | 与同批**其它同样声明 parallel 的**兄弟重叠执行 |
| `'sequential'` | **执行屏障**:等前面所有调用落定,并挡住后面的,全程独占 |
| 不声明(缺省) | 同 `'sequential'` |

缺省就是屏障 —— 不写这个字段,你的工具行为与今天**一字不差**。
`'sequential'` 与不声明在调度上等价,写出来的意义是:**这是我的判断,
不是我忘了**。

**什么时候必须声明 `sequential`**:工具内部抓着一份**跨调用共享的可变
状态** —— 一个游标 / 偏移量、一个连接的读写位置、一份边读边改的缓存、
一个只能有一个 owner 的外部会话。两个并发的调用会互相踩,而症状是间歇性
的错数据,不是异常。(这是 pi 的原始判例:多个调用抢同一个共享游标。)

**什么时候可以声明 `parallel`**:纯函数、纯读取、每次调用自带全部状态、
对外部只做幂等查询。收益是几个慢查询能重叠,一次回合少等几秒。

**拼错就装不上**:`executionMode` 只接受这两个字面量。写成 `'paralell'`
或 `true`,**这一个工具**会被拒绝注册(插件其余的命令 / 面板 / 事件照常
工作),日志里有一条点名的错误。宿主刻意不做"未知值默默当 sequential"
的降级 —— 降级是安全的,但你永远不会知道自己拼错了,只会觉得"我的工具
好像没并发起来"。

### `prompt`:工具自带的提示词(随工具面进出)

一个工具常常需要一段**怎么用它**的说明,而不只是 description。把它写在工具上,
宿主会在**这个工具进入回合的工具面时**把它拼进 system prompt,不在时一字不留 ——
用户在设置里禁用它、agent 白名单没给它、场景把它摘掉、插件被禁用/卸载,四种
"不在"一视同仁,不用你另注册、也不用你自己撤。

```js
prompt: {
  guidelines: ['…'],        // 进 system 段的 `Tool Guidelines:` 列表,一条一个 bullet
  workspaceRules: ['…'],    // 进 `# Work Directory` 的 `## Tool Workspace Rules`(有工作目录时才渲染)
  sections: [               // 独立段落(有自己的名字;缺省名 = 工具 id)
    { id: 'peek-index', content: '# Index\n…' },
  ],
}
```

三条语义:

- **静态**。这里写的是"这个工具是什么、怎么用",与回合无关;会变的事实(状态、
  进度)走 `<context-update>` 或工具结果,不写进 prompt。
- **只跟工具面走**。同名的 bullet 只说一次(两个工具声明同一句话不会重复);
  段落排在产品段之后、其它插件的 promptContext 之前。
- **形状不对就装不上**:与 `executionMode` 同一条规则 —— 非法的 `prompt` 拒绝
  **这一个工具**,日志点名,插件其余的面照常。

`prompt` 与 `api.registerPromptContextProvider` 的分工:前者是"工具的说明书",
随工具面;后者是"每回合现算的上下文"(能读会话、能查外部),随插件生命周期。
一段话如果只在你的工具在场时才成立,写在工具上;否则才用 provider。

**provider 的输出落在哪(2026-08-18,`docs/design/prompt-channels-2026-08.md`)**:
不在 system 前缀里,而在**最新一条 user 消息尾部**的 `<context-update>` 块里,
块名是 `plugin:<你的插件 id>/<providerId>`。宿主按块逐字去重:**你返回的文本
与上次相同就不重发**,变了才发一次,一直不返回就发一条撤销标记。对你的写法有
两条实际影响:

- 值稳定的东西尽量渲染成稳定的字节(别每回合插入时间戳、随机 id、无序遍历的
  Map),否则每回合都会重发一整块;
- 不要在文案里写"如上/见上文"这类指向 system 段的话 —— 你的块在对话尾部,
  与 system 段之间隔着整段历史。

`prompt`(工具的说明书)仍然是静态的、在 system 前缀里,两者不要混用。

## 事件订阅(api.on)

`api.on(type, handler)` 订阅宿主事件面(`stream:start`、`stream:complete`、
`stream:aborted`、`stream:error`、`step:updated` …)。handler 收到的是**信封**:

```js
api.on('stream:start', (env) => {
  env.sessionId   // 事件所属会话(顶层字段)
  env.sequence    // 会话内单调序号
  env.timestamp   // 提交时间戳
  env.event       // 事件本体 —— 不是 env.payload!
  env.event.type        // 如 'stream:start'
  env.event.messageId   // stream:start 携带;stream:complete 不携
  env.event.data        // stream:complete/error 的业务载荷(usage 在 data.usage)
})
```

> 教训实录:`env.payload` 不存在,用它取字段会得到一串静默 undefined
> (tps-meter / plan-status 1.0.0 都咬过)。跨事件关联靠 `env.sessionId` +
> 自己记账(stream:complete 无 messageId,需拿最近一次 stream:start 归属)。

## 数据落盘约定

- 插件家目录 = `~/.onething/plugins/<id>/`:`config.json`(宿主写,
  设置表单)、`kv.json`(`api.storage` KV)、`storage/`(自留地)、
  `message-state/`(消息作用域状态,见下)。
- **`node_modules/` 是代码区,任何数据永不许写进去** —— npm 每次
  update/uninstall 整目录抹掉重建,写进去等于丢。
- 卸载 = 家目录整体归档到 `plugins/legacy-backup/<id>-<date>/`
  (可恢复;目录名是纯归档名,与已退役的"legacy 目录插件"无关),
  代码从账与 node_modules 拆除。

### 受管文件树(`api.storage.files`)

`api.storage` 的 KV 是平面 JSON:整份读出来、整份写回去。要**追加写的日志**
(`candidates/*.jsonl`)或**目录树**(`wiki/**/*.md`)就用 files 面 ——
它读写的就是家目录里那个 `storage/`(与 `storage:` 寻址、`api.storage.dir()`
同一个目录,不是第二个地盘)。

```js
api.storage.files.writeText('wiki/topics/cls.md', '# CLS\n')  // 原子替换(tmp+rename)
api.storage.files.appendText('candidates/2026-08.jsonl', line) // O_APPEND,追加一行
api.storage.files.readText('wiki/topics/cls.md')               // 不存在 → undefined
api.storage.files.list('candidates')                           // 列一层:{path,name,kind,size,modifiedAt}[]
api.storage.files.exists('candidates/2026-08.jsonl')
api.storage.files.remove('wiki/old.md')                        // 幂等;目录只删空的
api.storage.files.usage()                                      // { bytes, quotaBytes }
```

要点与坑:

- **`appendText` 是真追加**(内核 O_APPEND),不是读-改-写:别人在两次追加之间
  写进去的行不会被你吃掉。**你自己也别**用 `readText` + `writeText` 去模拟追加 ——
  那正是丢行的写法。
- 路径是**相对根的相对路径**,逐段校验:`..`、绝对路径、反斜杠、`%2e%2e`、
  Windows 保留设备名、指向根外的软链一律抛 `PluginStorageError('invalid-name')`。
- 配额:整棵 `storage/` 树默认 **50MB**,单文件 8MB。到 **9 成**宿主发一条
  `plugin:<你的 id>:storage:quota-warning` 事件(payload `{bytes, quotaBytes}`)——
  **订上它并自己 GC**(老 candidates 归档压缩),别等写满:写满是抛 `quota`,
  而一条采集写失败 = 记忆断流且无感。
- **宿主刻意不给 watch / 锁 / 多写者协调**。单一写者是你的架构纪律:同一棵树
  只该有一个写者,否则追加语义与配额记账同时失去定义。
- 值语义、无句柄:所有方法收字符串回字符串/结构体(为将来的进程隔离留的路)。

#### 第二根:用户指定的目录(`storage:external-root`)

要把产物放进**用户自己的目录**(比如他的笔记库,他会亲手编辑、git 提交),
走第二根:

```jsonc
{ "contributes": {
  "permissions": ["storage:external-root"],
  "settings": { "schema": { "type": "object", "properties": {
    "wikiRoot": { "type": "string", "format": "directory-pick", "title": "Wiki 目录" }
  } } }
} }
```

```js
api.storage.files.writeText('topics/cls.md', md, { root: 'external' })
api.storage.files.list('topics', { root: 'external' })
```

- 目录**由用户在插件设置里选**;你不能声明 default,也拿不到"当前是哪个目录"
  以外的任何磁盘信息。没声明权限 → `PluginStorageError('not-declared')`;
  声明了但用户还没选 → `'not-configured'`。两个都是结构化拒绝,**不会假装成功**。
- 外部根**不吃配额**(那是用户的目录),但路径判据一模一样。
- **卸载绝不动外部根里的内容** —— 那是用户的文件,只清你对它的授权。
- 家目录与外部根互不串门:缺省 `root` 永远是家目录。

### 消息作用域状态(`api.storage.message`)

要给**某一条消息**记东西(徽标、注解、评分),不要在自己的 KV 里按
messageId 记账 —— 那样消息删了你不知道,数据变孤儿。用消息态:

```js
// 写:坐标随调用递交,一条消息一个 blob(JSON 对象,内键你自己管)
api.storage.message(sessionId, messageId).writeJson({ v: 1, tps: 34.2 })
// 读:render 时按坐标现取;没有就是没有
const rec = api.storage.message(ctx.sessionId, ctx.messageId).readJson()
api.storage.message(sessionId, messageId).exists()
```

```jsonc
// 落盘要在 manifest 开闸(声明是闸门,不是装饰):
{ "contributes": { "uiSlots": [
  { "anchor": "message.footer", "id": "tps", "label": "TPS",
    "lifetime": "persistent" }   // 缺省 "ephemeral" = 纯内存,重启即丢
] } }
```

分工照抄这张表(**坐标是宿主的,内容是你的**):

| 归你 | 归宿主 |
|---|---|
| 记什么、何时记、形状怎么迁(建议带 `v` 字段) | 放哪(`plugins/<id>/message-state/<sid>/<mid>.json`) |
| 显示什么、何时 `ctx.refresh()` | 落不落盘(lifetime 闸门)、启动水合 |
| 读不懂的旧/新形状怎么办 | 消息删→删该条;会话删→删整个会话;卸载→随家目录归档 |
| —— | 每插件 5MB 硬顶(写超抛 `quota`)、损坏记录隔离 |

要点与坑:

- **有任一 slot 声明 `persistent`,这个插件的消息态就全部落盘**(存储分不清
  一次写服务哪个槽);全都不声明 = 纯内存。装前确认页会就那条 slot 告诉
  用户"会在消息上留下持久内容" —— 这是它该被声明出来的原因。
- 写面**会抛**(配额超、值不可 JSON 序列化、插件已拆除)。别 catch 掉当
  没事:抛了就是没存住,宿主同时记熔断账。
- 没有键枚举 API,也**不需要**自建索引:render 时你手里就有
  `ctx.sessionId` / `ctx.messageId`(消息级锚点的 ctx 携带),按坐标现取。
- 插件不在场时发生的流没有记录,装上之后也不会追认 —— 老消息就是空的。

## 设置 schema:宿主替你画配置表单

`contributes.settings.schema` 是一段 **JSON Schema 子集**,也是你这个插件配置的
**唯一事实源** —— 没有运行期 `registerSettings`。宿主只读清单就能渲染配置区、
校验、填默认值,**一行你的代码都不执行**,于是**未启用的插件也能配**。

读值用 `api.settings.get()`(快照,深冻结),跟变化用
`api.settings.onChange(cb)`(用户按 Save 之后推)。

支持的属性形状 —— **子集 = 设置页画得出来的控件集**,这两件事必须是同一份清单:

| 属性 schema | 控件 | 存的值 |
| --- | --- | --- |
| `{"type":"boolean"}` | 开关 | boolean |
| `{"type":"string"}` | 文本框 | string |
| `{"type":"number"｜"integer", "minimum"?, "maximum"?}` | 数字框 | number |
| `{"enum":["a","b"]}`(仅字符串枚举) | 下拉 | string |
| `{"type":"array","items":{"type":"string"}}` | 逗号分隔文本 | string[] |
| `{"type":"string","format":"file-import","accept"?,"maxBytes"?}` | **选择文件**按钮 + 当前值 | string(`storage:` 地址) |
| `{"type":"string","format":"directory-pick"}` | **选择目录**按钮 + 当前值 | string(绝对路径;空串 = 还没选) |

`title` / `description` 变标签与说明;`required` 只是**呈现**上的星号(每个字段
都有默认值,"缺失"这个状态不存在);`contributes.settings.ui[key]` 可以覆盖
`label` / `hint` / `control`,但**覆盖不许改变值的类型契约**。

超出子集(嵌套对象、数字枚举、非字符串数组…)→ 配置区整块显示"schema 不受
支持"并**逐条**列出原因,插件照常加载。修一条报一条太慢,所以一次全报。

### `format: "file-import"`:让用户选一个文件(配置类)

```jsonc
{ "contributes": { "settings": {
  "title": "外观",
  "schema": {
    "type": "object",
    "properties": {
      "wallpaper": {
        "type": "string",
        "format": "file-import",
        "title": "壁纸",
        "accept": ["png", "jpg", "webp"],   // 可选:宿主白名单的**子集**
        "maxBytes": 5242880                  // 可选:宿主硬顶 10MB
      }
    }
  }
} } }
```

```js
export default function (api) {
  const apply = () => {
    const { wallpaper } = api.settings.get()
    // 三态,不是两态:有值 = 换成这张;**空值 = 撤回**(回落 manifest 缺省图)。
    // 写成 `if (wallpaper) …` 会让"清空"变成一次静默的空操作 —— 用户点了 ×、
    // 存了盘,屏幕上还是那张旧图。
    api.theme.updateBackground({ image: wallpaper || null })
  }
  apply()                       // ← 启动时读一次(运行期背景不持久,持久归你)
  api.settings.onChange(apply)  // ← 用户换了图/清空了就跟着变(同一条链)
}
```

- 值非空时控件旁边有一个 **×** 清空钮,点了把这个字段置成空串,和选文件走
  **同一条** Save 路径。清空只撤引用,**不删**已经拷进你数据目录的那个文件 ——
  那份字节的归宿是卸载时的归档语义,不是设置页的一次点击(你可能还把这个地址
  存在自己的 `api.store` 里)。
- 存进去的值是**地址**(`storage:imports/<name>`),不是用户磁盘上的路径。
  **字节不过你的手**:宿主拉原生对话框、宿主校验、宿主拷进**你的**数据目录,
  回给你的只有那个地址 —— 所以"让用户换张壁纸"不需要给插件开任何读文件权限。
- `accept` **只能收窄**宿主白名单(`png` `jpg` `jpeg` `webp` `svg` `gif`);
  写一个不在里面的扩展名,配置区显示"schema 不受支持"(插件照常加载)。
  省略 = 全白名单。
- `maxBytes` 是唯一被**钳**的旋钮:写得比 10MB 大按 10MB 算(不报错);
  写一个非正数则这份 schema 被判不受支持。
- `format` 只能挂在 `type: "string"` 上,且不能与 `enum` 同用。
  **宿主不认识的 `format` 一律忽略**(JSON Schema 的规矩)——
  写 `"format":"uri"` 得到的是一个普通文本框,不是一个错误。
- 只在 Electron 桌面宿主可用(方案 A)。web 端按钮置灰,点了会说一句
  "仅桌面可用",不是静默无反应。

### 该用哪一个:schema `file-import` vs 描述树 `file-pick`

两者共用同一条托管导入链、同一份 accept/maxBytes 判据,**差别只在家在哪**:

| 你要的是 | 用 | 家 |
| --- | --- | --- |
| 选一次、长期生效的偏好(壁纸、模板文件、字体) | 设置 schema `format: "file-import"` | 设置页的配置区 |
| 面板里**现场**的一次导入(批量处理、临时预览) | 描述树 `file-pick` 节点(见下文) | 你的面板 / 锚点块 |

**判例(2026-08-10,用户批评驱动):配置类交互归设置页,面板留活内容。**
在此之前宿主的 schema 子集里没有文件控件,于是"选一张壁纸"只能借 `file-pick`
节点落进工作台面板 —— 那不是作者选错了地方,是**能力缺口把 UX 拽错了位置**。
现在两个家都在,按上表选。

## 跨会话信使:让一个会话给另一个会话发消息(N1)

`api.steer` / `api.followUp` 是**纯入队**:空闲的会话不会因为它们醒过来。要把
一个外部事件(另一个会话的一句话、一封邮件、一次定时)变成**一轮对话**,用
`api.sendMessage`。它是插件第一个能自发花掉用户 token 的口,所以它有声明门和
循环闸。

### 先声明(不声明就调不动)

```jsonc
{ "contributes": { "permissions": [
  "sessions:peek",     // 读别人的会话快照
  "sessions:post",     // 往会话里投递(不起轮)
  "sessions:trigger"   // 可以**起一轮**(花 token) —— 单独一档
] } }
```

装前确认页会把它们念成人话("can start a model turn on its own (spends tokens)")。
未声明就调:宿主拒绝并回 `{ok:false, reason:'not-declared'}`,记一条 error 日志,
**不计熔断**(那是 manifest 写错了,不该连坐插件其余能力)。

### 三态投递矩阵(照抄矩阵,不是布尔)

```js
// 目标空闲 → 起一轮;目标在忙 → 自动降级为 steer(插进它正在跑的那轮)
await api.sendMessage(id, text, { triggerTurn: true })

// 只落盘 + 显示,不起轮(缺省档 —— 不声明就不花 token)
await api.sendMessage(id, text, { triggerTurn: false })

// 显式选既有队列。nextTurn 诚实映射到 follow-up(引擎没有第三条队列)
await api.sendMessage(id, text, { deliverAs: 'steer' })
await api.sendMessage(id, text, { deliverAs: 'followUp' })
```

它**从不抛错**,回一份结构化结果:

```ts
{ ok, delivered?: 'triggered'|'steered'|'followed-up'|'posted',
  targetWasBusy?, hop?,
  reason?: 'not-declared'|'empty-content'|'unknown-session'
         | 'hop-limit'|'rate-limited'|'unsupported'|'error', detail? }
```

`delivered` **如实**说明走了哪一格 —— 你要求起轮而对面在忙时它是 `'steered'`,
把这句话原样写进工具结果,模型才知道对面会不会当场回你。

### 感知快照:先看它在干什么

```js
const peek = await api.sessions.peek(id)
// { sessionId, title, state, currentTool?, lastMessage?{role,preview,at},
//   contextPercent?, updatedAt }
// state: 'idle' | 'generating' | 'tool-running' | 'awaiting-permission'
//   判定优先序:awaiting-permission > tool-running > generating > idle
//   (挂着没人点的审批卡时,活跃流还在,但这轮一步也不会动)

const all = await api.sessions.list()   // peek-lite:无 lastMessage / contextPercent
const free = await api.isIdle(id)       // 读不到会话 = false
```

`preview` 硬截 120 字符、换行折成空格 —— 正文永不整条出境。`list()` 是拿来
**找到那个会话**的;找到之后再 `peek` 一次拿细节。

### 循环闸(为什么你的第 9 条被拒了)

两个会话互相"回个话"天然是一条不收敛的链。宿主兜两道:

1. **跳数**:由插件投递引发的回合所产生的再投递 hop+1,**上限 8**,超限
   `reason:'hop-limit'`。口径是保守上界(取此刻所有在飞的插件链里最深的那一跳
   +1)—— 它不需要你配合,也因此规避不了;并发时可能偏保守。
2. **频率**:每 `(插件, 目标会话)` 对 **10 次 / 分钟**,超限 `reason:'rate-limited'`。

被拒了就**停下**并把原因写进工具结果,别重试 —— 那正是闸要挡的行为。

### 提示词即控制流

"收到别的会话来的消息要不要回"不该是一段插件代码,而是**工具描述里的一句
礼仪**:回话本身就是再调一次你的发送工具。样板见市场仓
`packages/session-link`(`message_session` / `list_sessions`)。

### 两个必须知道的语义

- 注入的消息带 `origin.source = 'plugin:<你的 id>'` 与 `origin.plugin = {id, hop}`
  —— 它**不冒充用户**。因为它算"系统驱动的回合",这一轮里的权限提示 120s 无人
  应答会自动降级(而不是永远挂着)。
- **协作房 / agent 执行会话不接受插件投递**(它们由协调者独占驱动),回
  `reason:'unsupported'`。

## 锚点清单与两种形态(常显块 / 触发式)

宿主认识的锚点是**编译期常量**,你不能发明。今天有七个:

| anchor | 形态 | 在哪 | ctx 带什么 | 容量 |
|---|---|---|---|---|
| `composer.above` | 常显块(**可选抽屉**) | 输入框上方横条 | `sessionId`(抽屉块另带 `drawerState`) | 3 块 / 32px,展开档 240px |
| `chat.status-bar` | 常显块 | 聊天面底部状态带(穿 chip 壳) | `sessionId` | 8 块 / 24px |
| `message.footer` | 常显块 | 每条 assistant 消息尾部 | `sessionId` + `messageId` | 6 块 / 24px |
| `message.actions` | **触发式** | 每条 assistant 消息的 ⋯ 菜单 | `sessionId` + `messageId` | 3 项,超出折叠 |
| `composer.actions` | **触发式** | 输入框工具条(附件按钮之前) | `sessionId` | 3 项,超出折叠 |
| `composer.aside` | 常显块(**分侧**) | 输入框左右两翼(边距空间) | `sessionId` | **每侧 1 块** / 宽 ≤ 48px、高 ≤ 输入框 |
| `composer.below` | 常显块 | 输入框正下方(后勤带) | `sessionId` | 2 块 / 每块 ≤ 24px,宽随输入框 |

- **`composer.aside`(两翼)**:容量是**每侧 1 块**,用 `"side": "left" \| "right"`
  点名(缺省 `right`);同侧的第二条声明按容量截断,设置页会说"锚点已满"。
  **降级**:窄窗(≤768px)整侧隐藏 —— 边距摆不下 48px 的翼时它第一个让路。
  **语义**:只放**辅助性内容**(一枚指示、一个计数);核心功能只住这里 =
  窄窗下这个功能对用户就是消失了。
- **`composer.below`(后勤带)**:**没有降级**,纵向恒在。**语义**:与
  `composer.above` 上下分工 —— above 放"这一轮带着什么"(草稿上下文),
  below 放"发出去之后会怎样"(提示、配额、状态)。

**形态由宿主的锚点表决定,不是你声明的** —— 声明形状两种一字不差:

```jsonc
{ "contributes": { "uiSlots": [
  { "anchor": "message.footer",  "id": "tps",       "label": "TPS" },
  { "anchor": "message.actions", "id": "tps-usage", "label": "Token usage" },
  // 分侧锚点上多一个可选字段;别的锚点上写了它会被忽略(不拒载)。
  { "anchor": "composer.aside",  "id": "tps-wing",  "label": "TPS", "side": "left" },
  { "anchor": "composer.below",  "id": "tps-hint",  "label": "TPS hint" }
] } }
```

### 触发式锚点(trigger)

平时**只有宿主画的入口**:`message.actions` 上是一行菜单项、
`composer.actions` 上是一枚图标钮 —— 文案就是你 manifest 里的 `label`
(v1 静态,没有动态徽标)。用户点它,宿主才开一层弹层,**这时才调你的
`render`**;关弹层即销毁,没有常驻实例。

时序是唯一的差别,协议一个字都没变:

```js
api.registerUiSlot({
  anchor: 'message.actions',
  id: 'tps-usage',                 // 必须与 manifest 里同 anchor 的某条 id 一致
  render(ctx) {
    // ctx.anchor === 'message.actions'
    // ctx.sessionId / ctx.messageId —— 与 message.footer 同款坐标
    const rec = api.storage.message(ctx.sessionId, ctx.messageId).readJson()
    if (!rec) return { version: 2, body: { type: 'empty-state', title: '没有记录' } }
    return { version: 2, body: { type: 'stack', gap: 'small', children: [
      { type: 'table',
        columns: [{ key: 'k', label: '指标' }, { key: 'v', label: '值' }],
        rows: [{ key: 'tps', cells: { k: '生成速度', v: `${rec.tps.toFixed(1)} tok/s` } }] },
    ] } }
  },
  onAction(input, ctx) { /* 与常显块同规,走 ui:action:* */ },
})
```

选形态只有一条判据(**per-item 铁律**):按条目繁殖的位置上(今天是消息级),
常显形态必须**极小且一行装得下**;表格、明细、长清单这类"重"内容只能走
触发式 —— 入口按消息繁殖没问题(一行文案),内容按需只渲染一份。
tps-meter 就是标准姿势:footer 一枚 24px 徽标常显,⋯ 菜单里一张明细表按需。

坑与语义:

- **弹层内容不开 webview**(与常显块同规,声明了拒载);它只画描述树。
- **`refreshIntervalMs` 在弹层里照常生效**,而且关掉弹层轮询自动停 ——
  按需时序自带省电,你不用自己管。
- **render 连败被降级闸关掉后,入口置灰但不消失**:用户点得进去,看到
  降级态并可以"再试一次"。失败的入口不占容量。
- 超出容量(3 项)的入口被折叠掉,只在菜单/工具条上报个数;详情在设置页。
- 一个插件可以同时住常显块与触发式(tps-meter / plan-status 都是),
  两条声明各写各的 `id`。

### 抽屉块(drawer,只在 `composer.above`)

常显块的老问题:它**一直挂着**。一条永远在输入框上方的状态行,大多数时候
没有信息量,却一直占着高度。抽屉是这条的解法 —— 加一个字段,你的块就有了
三态:

```jsonc
{ "contributes": { "uiSlots": [
  { "anchor": "composer.above", "id": "plan-status", "label": "Plan 执行状态", "drawer": true }
] } }
```

| 档 | 用户看到 | 你要返回什么 |
|---|---|---|
| **展开** `expanded` | 整块内容,高度预算 240px,超出块内滚动 | 一棵完整的树(stack:状态行 + 清单) |
| **半收** `peek`(默认) | 单行摘要(就是没有抽屉时的老形态) | 一行装得下的树(row) |
| **全收** `collapsed` | 块完全离场,S 状态带上剩一枚 chip(拼图 + 你的 label) | **什么都不用返回** —— 宿主不会调你的 render |

**三态是宿主的,不是你的**:开合钮由宿主画在块壳右侧(`⌄/⌃` 展开⇄半收、
`✕` 全收),用户选的档由宿主记住(按 `(插件, 锚点, id)`,重启还在)。
你唯一的感知是 render ctx 上多的一个字段:

```js
api.registerUiSlot({
  anchor: 'composer.above',
  id: 'plan-status',
  render(ctx) {
    // ctx.drawerState === 'expanded' | 'peek'(老宿主上是 undefined)
    if (ctx.drawerState === 'expanded') {
      return { version: 2, body: { type: 'stack', gap: 'small', children: [
        { type: 'row', children: [{ type: 'badge', text: '执行中', tone: 'accent' }] },
        { type: 'list', items: recentSteps(ctx.sessionId) },
      ] } }
    }
    // 半收 = 一行摘要。**默认档是它** —— 不判 drawerState 的老代码原样能跑。
    return { version: 2, body: { type: 'row', children: [
      { type: 'badge', text: '执行中' }, { type: 'markdown', text: '步骤 3/5' },
    ] } }
  },
})
```

坑与语义:

- **`drawer` 只在 `composer.above` 上算数**。写在别的锚点上不会拒载,
  但那个字段会被**忽略**(设置页能看到它被忽略了)。
- **不声明 = 一个字节都不变**:没有壳、没有钮、payload 里没有 `drawerState`。
- **切档 = 一次新的 render**(宿主重拉),不是你自己 poll 出来的;
  `onAction` 的 ctx 同样带当前档 —— 在展开档点按钮后别返回一行的树,
  块会当场塌回去。
- **全收档不会调你的 render**,所以取值域里没有 `'collapsed'`;
  未知值(未来新档)在老宿主上读成 `undefined` = 半收,向后兼容白送。
- 全收的块**不占** `composer.above` 的 3 块容量 —— 你收起来,别人顶上来。

## 布局动词:开合侧栏、打开工作台(手势锚定)

两个动词,都在 `api.ui` 上:

```js
await api.ui.toggleSidebar()          // 开合左栏
await api.ui.openWorkbench()          // 只展开右工作台
await api.ui.openWorkbench('logs')    // 展开 + 聚焦你自己的这个面板 tab
```

**它们没有 manifest 权限**,治理走的是另一条路 —— **手势锚定**:

> 布局动词只在**你的某个 ui slot 刚刚被用户点过**之后的 **5 秒**内有效。

理由:一句"我要能开合侧栏"申报在 manifest 里,用户读不出它会在**什么时候**
动;而"你刚点了它、它才动得了"是用户当场就能验证的因果。所以授权从一次性的
申报,挪到了每一次的互动。

- **窗内**(在 `registerUiSlot` 的 `onAction` 里调,或它触发的异步收尾里):照常生效。
- **窗外**(定时器里、事件订阅里、启动时):回
  `{ ok: false, error: 'gesture-required' }`。
- **没有窗口的宿主**(CLI daemon、headless server):回
  `{ ok: false, error: 'unsupported' }`。

两种错误码**都是规则拒绝,不是你的插件故障** —— 它们不计熔断、不会让你被
自动停用,而且**从不抛错**:动词永远回一份结果,你得自己看 `ok`。

```js
api.registerUiSlot({
  anchor: 'composer.above',
  id: 'plan',
  render: () => ({ /* … */ }),
  async onAction({ actionId }) {
    if (actionId !== 'open-details') return
    const result = await api.ui.openWorkbench('plan-details')
    if (!result.ok) api.ui.notify(`打不开:${result.error}`, 'warn')
  },
})
```

两条容易踩的:

- **`render` 不算手势**。宿主重画你的块不等于用户点了它 —— 否则每次重拉都
  等于开一次门。只有 `ui:action`(块里的按钮、trigger 弹层里的操作)记账。
- **`openWorkbench(panelId)` 只认你自己的面板**,而且那个面板必须在
  `contributes.panels[].placements` 里声明了 `'workbench'`。传别人的 id 不会
  报错,只是什么也不会发生(右栏仍然展开)。

## 样式与动画:你能改颜色,不能写动画

**默认就跟随主题**:描述树的每个节点都用宿主的 `--ui-*` 变量画,用户切深色
模式你的块自动变深色 —— 什么都不用做。这是绝大多数插件的正确选择。

真要品牌色,只有一条路:`contributes.theme`。

```jsonc
{ "contributes": { "theme": { "overrides": {
  "primary": "#ff4d00",
  "bg.app": "oklch(0.2 0.02 250)"
} } } }
```

规矩(每条都有硬闸):

- **只能覆盖既有 token,不能新增**。键必须是宿主主题表里的 token 路径
  (`packages/onething-runtime/src/themes/css-mapper.ts` 的 `CSS_VAR_MAP` 键)。
  不认识的键会被**丢掉**,插件照常加载,设置页卡片写明"dropped — not a theme token"。
- **值只能是颜色字面量**:`#hex`(3/4/6/8 位)、`rgb()/rgba()`、`hsl()/hsla()`、
  `oklch()/oklab()`、CSS 标准命名色。`url(...)`、`var(...)`、带 `;`/`}` 的串、
  空串、超过 128 字符一律丢弃(同样不拒载,卡片写明
  "dropped — not an allowed color value")。
- **一个插件最多 32 条**;超了是形状错,插件进 error 态。
- **覆盖是全局的**。两个插件覆盖同一个 token 时,按 pluginId 字典序**后者胜**;
  被压的那条在卡片上标 `theme "<token>" overridden by "<pluginId>"`。
- 覆盖是**参数,不是贴纸**:它在主题算色之前落位,所以 `--ui-*` 语义层、
  `-rgb` 变体、primary 色阶(hover/bg/border/text)会一起按你的颜色重算 ——
  覆盖一个 `primary` 就能把界面真的换个色系,不必逐条列几十个 token。
  同理:覆盖只写 `primary` 时,`accent`/`accentMain` 跟随它(与主题作者写
  `primary` 时同规);想让强调色跟主色分开,就把 `accent` 也显式写出来。
- 覆盖跟着**用户当前主题**每次重算,主题/明暗切换时保留;停用/卸载即刻撤除,
  `:root` 逐字回到主题原值。
- 装前确认页会写 `overrides theme colors (<token 清单>)` —— 用户在装之前就知道
  你要动他的配色。

#### 同一张表里的第二种地址:表面旋钮(`--ot-*`)

颜色管"什么色",**旋钮**管"多浓 / 多糊"。它们住在同一个 `overrides` 里,靠键名
区分:主题 token 路径长这样 `bg.app` / `syntax.keyword`,旋钮**以 `--ot-` 开头**。

```jsonc
{ "contributes": { "theme": { "overrides": {
  "primary": "#ff4d00",      // 主题 token —— 颜色
  "--ot-frost-alpha": "40%", // 旋钮 —— 浮层磨砂底的浓度
  "--ot-frost-blur": "10px", // 旋钮 —— 磨砂半径
  "--ot-surface-alpha": "30%"// 旋钮 —— 区域面纱的浓度
} } } }
```

规矩:

- **没有旋钮清单可查,前缀本身就是 API**。宿主不维护"开放了哪几枚旋钮"的名单 ——
  组件在 CSS 里立了哪些 `--ot-*` 旋钮,你就能拨哪些。今天在用的六枚见
  `packages/renderer/styles/wallpaper.css` 的"调法"一节(浓度四枚 + 磨砂两枚)。
- **值按类型校验,类型看后缀**:`-alpha` 收百分比(`"45%"`),`-blur` 收像素
  (`"6px"`)。后缀不在类型表里的 `--ot-*` 键会被丢弃(宿主没法校验一个自己不知道
  类型的串),卡片写明原因。
- **越界会被钳到边界,不是丢弃**。你的意图方向留着,只是被拉回可读性区间:
  alpha 钳进 `[18%, 100%]`(18% 是宿主自己验过的"字压在插画上仍读得出"的下沿),
  blur 钳进 `[0px, 14px]`(14px 是真机判过"糊到看不出壁纸"的那一档,兼作性能闸)。
  被钳过的条目仍然生效,卡片上会写你原本写的是多少。
- **不成形的值才丢弃**:`"40"`(缺单位)、`"var(--x)"`、`"calc(…)"`、带 `;` 的串、
  负数 —— 一律丢该条,插件照常加载。
- 冲突、拆除、装前确认与颜色覆盖**同一套**:pluginId 字典序后者胜,停用/卸载即撤。
- **旋钮不是壁纸专属的**。壁纸只是宿主自己的一次拨动;你拨的数压过宿主的缺省档,
  用户没开壁纸时同样生效。所以别把它当"壁纸皮肤"用,它是全局观感。

判据在 `packages/onething-runtime/src/themes/knobs.ts`(类型表 + 钳制区间),
那里也写清了为什么颜色不走旋钮侧(颜色有正门:token 路径会让 `--ui-*` 语义层与
色阶一起重算,从旋钮侧塞颜色只盖得住一枚原始变量)。

### 背景图:`contributes.theme.background`

颜色之外唯一开出来的外观能力(L2.5)。图必须是**包内资产** —— 路径相对
`contributes.webviewRoot`(缺省 `webview/`),由 `onething-plugin://` 协议服务,
和 webview 面板同一条协议、同一批闸。**没有远程 URL 这个选项**。

```jsonc
{ "contributes": {
  "webviewRoot": "webview",
  "theme": { "background": {
    "image": "bg.svg",          // 必填,相对静态根
    "darkImage": "bg-dark.svg", // 可选;不写就深浅共用一张
    "opacity": 0.35,            // 0–1,缺省 1
    "blur": 0,                  // 0–40 px,缺省 0
    "fit": "cover"              // cover | contain | tile,缺省 cover
  } }
} }
```

规矩:

- **扩展名白名单**:png / jpg / jpeg / webp / svg / gif。相对路径、不许 `..`、
  不许 scheme、不许百分号编码 —— 判据与 webview entry 逐字相同。
- **越界即丢弃**:`opacity` 不在 0–1、`blur` 不在 0–40、`fit` 不在三选一里,
  整条 background 被丢掉,插件照常加载,设置页卡片写明
  `background dropped — <原因>`。声明是你写死的常量,宿主宁可说出来。
- **全局只有一块**。两个插件都声明时按 pluginId 字典序**后者胜**,被压的那条
  在卡片上标 `background overridden by "<pluginId>"`。停用/卸载即刻撤层。
- 背景铺的是**主内容区**(聊天 + 工作台),左栏与右侧工作台保留自己的底色。
- 装前确认页会写 `sets an app background image`。

### 皮肤包:`contributes.theme.skin`(H3)

`overrides` 管**色**,`skin` 管**形** —— 圆角、密度这类 token 表达不了、
而主题系统又**故意不许主题定义**的东西(主题 JSON 里没有 radius 字段,
将来也不会有)。

两者的安全模型完全不同,这决定了你怎么写:

| | `overrides` | `skin` |
| --- | --- | --- |
| 你写的是 | 颜色**字面量**(`#ff4d00`) | 档位**名**(`round`) |
| 谁定 CSS 值 | 你 | **宿主**(查表) |
| 因此需要 | 一整套颜色白名单挡注入 | 什么都不需要 —— 你的字符串永远不进 CSS |

```jsonc
{ "contributes": { "theme": { "skin": {
  "bubbleRadius": "round"
} } } }
```

#### 第一批旋钮

| 旋钮 | 档位 | 作用面 |
| --- | --- | --- |
| `bubbleRadius` | `sharp` / `standard` / `soft` / `round` | 用户气泡 + 群聊里的 agent 框 |

`standard` 是**缺省档**,它的语义是"保持应用现状" —— 宿主为它**不写任何变量**,
让组件自己的值透出来。所以"不声明"和"声明 `standard`"产出逐字节相同;应用哪天
调整了自己的默认圆角,选 `standard` 的插件自动跟着走,不会把旧值钉死。

其余档位的具体像素值**故意不写在这里**:它们是宿主的实现细节,唯一事实源是
`packages/onething-runtime/src/themes/skin.ts` 的 `SKIN_TIER_VALUES`。你选的是
"锐利 / 柔和 / 圆润"这个**意图**,不是一个数字。

#### 规矩(与 `overrides` 一字不差)

- **只能拧既有旋钮,不能新增**。不认识的旋钮名被**丢掉**,插件照常加载,
  设置页卡片写明 `skin "<旋钮>" dropped — not a skin option`。
- **档位必须在枚举内**。写 `"bubbleRadius": "24px"` 不会变成 24px,而是被丢掉,
  卡片写明 `skin "bubbleRadius" dropped — "24px" is not one of its presets`。
  这不是限制你,而是让"应用改了默认值"这件事不会把你的插件变成祖传硬编码。
- **一个插件最多 16 条**;超了是形状错,插件进 error 态。
- **皮肤是全局的**。两个插件拧同一个旋钮时,按 pluginId 字典序**后者胜**;
  被压的那条在卡片上标 `skin "<旋钮>" overridden by "<pluginId>"`。
- 皮肤跟着**每次算主题**重新递进去,主题/明暗切换时保留;停用/卸载即刻撤除,
  界面逐字回到应用自己的值。
- 装前确认页会写 `changes UI shape (bubble corners: round)` —— 与"改配色"**分两句
  说**,因为用户对这两件事的容忍度不是一回事。

#### 为什么没有"代码高亮主题"这个旋钮

它被**并回 L2** 了,不是被砍了:代码块的每一种颜色本来就是主题 token,
按"颜色归 `overrides`、形归 `skin`"的分工,它属于前者。

#### 代码色的合同(`overrides` 里的代码色键)

```jsonc
{ "contributes": { "theme": { "overrides": {
  "syntax.keyword":     "#c678dd",
  "syntax.string":      "#98c379",
  "syntax.comment":     "#5c6370",
  "syntax.plain":       "#abb2bf"
} } } }
```

- **权威族是 `syntax.*`** —— 写它。它就是高亮层的 token 名,与 `--hg-syntax-*-fg`
  一一对应。可用的键:`plain` `comment` `keyword` `atom` `string` `number`
  `function` `definition` `variable` `property` `type` `tag` `operator`
  `punctuation` `invalid` `inserted` `deleted` `heading` `link` `emphasis` `strong`。
- **`text.code.*` 是合法别名,但不推荐** —— `text.code.keyword` 等价于
  `syntax.keyword`,解析期会归一过去,设置页把它显示成 "alias of syntax.keyword"。
  两个特例:`text.code.inline` 与 `text.code.block` **都**归到 `syntax.plain`
  (高亮层只有一个"正文码色"),所以写其中任意一个,行内码与块内正文会一起变。
- **同时写两族会吞掉一条** —— 同一个插件里 `syntax.keyword` 与
  `text.code.keyword` 都给了值时,**权威族胜**(与书写顺序无关),被吞的那条在
  设置页标 `shadowed`。不要靠这个行为写"回退值",直接只写权威族。
- **对比度护栏会改写你给的颜色** —— 代码色落地前要过 `ensureHighlightContrast`:
  与代码块底色对比度不够的颜色会被朝可读方向重算(实测 `#ff00ff` 落地成
  `#F661F0`)。这不是 bug,主题自己写的代码色走的是同一道护栏。想要**一模一样**
  的色号就选一个对比度本来就够的颜色。
- 一次覆盖会同时写到这批变量上(三条渲染路共用):`--hg-syntax-<token>-fg`
  (正主)、`--text-code-*` / `--hljs-*`(聊天代码块)、`--syntax-*`(diff UI)。
- 覆盖不需要"跟着主题走" —— 它是每次算主题都递进去的参数,换主题/明暗自动保留,
  停用或卸载即刻撤除,代码块逐字回到主题原色。

历史:2026-08-10 之前这两族键是**死键**(声明得到 `active`、屏幕上什么都不变),
根因与修法见 `docs/design/plugin-ui/plugin-ui-rollout-2026-08.md` §6.6。

**让用户能调透明度** —— 走 R3 设置 schema + 运行期 `api.theme.updateBackground`:

```jsonc
// plugin.json
{ "contributes": { "settings": { "schema": {
  "type": "object",
  "properties": { "opacity": { "type": "number", "default": 0.35, "minimum": 0, "maximum": 1 } }
} } } }
```

```js
// index.js
export default function (api) {
  const apply = () => {
    const { opacity } = api.settings.get()
    if (typeof opacity === 'number') api.theme.updateBackground({ opacity })
  }
  apply()                      // ← 启动时读一次:持久化归你自己
  api.settings.onChange(apply) // ← 用户在设置页改了就跟着变
}
```

`updateBackground` 收 `opacity` / `blur` / `fit`(钳制:越界钳进区间,坏类型
忽略)与 `image`(见下一节 —— **仅 `storage:` 寻址**,包内换图仍然等于发新
版本)。**它不持久**:重启后回 manifest 缺省,所以上面那句"启动时读一次"
是必须的,不是可选的。没在 manifest 里声明 background 就调它,是一条 error
日志 + 拒绝(不熔断)。

**`image` 有三格值域,不是两格**(恢复默认闭环,2026-08-10):

| 你传的 | 意思 |
| --- | --- |
| 不传(`undefined`) | 这次不动 image —— 半条补丁,与 `opacity` 同规 |
| `'storage:<rel>'` | 换成用户导进来的那张 |
| `null` | **撤回**:背景回落 manifest 声明的缺省图,`darkImage` 一并恢复 |

`null` 不进图源校验(没有图可判)、不记 error、也不计熔断。它是"恢复默认"的
唯一出口 —— 在此之前,把运行期图撤回缺省的办法只有重启宿主。

两条容易写错的地方:

- **`undefined` 与 `null` 不能合流。** 一个漏写的可选字段传成 `undefined` 只是
  "这次不提",传成 `null` 就是把用户选的壁纸撤掉了。
- **撤回撤的只是 image,不是三个旋钮。** `updateBackground({ image: null })` 之后
  opacity / blur / fit 还是你上次调到的那个值。

### 让用户换成自己的图:`file-pick` 节点 + `storage:` 寻址

> 先看一眼「设置 schema」那节的**该用哪一个**:壁纸这种"选一次、长期生效"的
> 偏好,家在**设置页**(`format: "file-import"`),不在面板。本节的 `file-pick`
> 节点是面板里**现场**导入用的那一个 —— 两者共用同一条托管链,只是家不同。

核心裁决先说清楚:**字节不过你的手**。你声明一个按钮,宿主拉原生文件对话框、
宿主校验、宿主把文件拷进**你的**数据目录,回给你的只有一个地址。你拿不到
用户磁盘上的路径,也拿不到文件内容 —— 于是"让用户换张壁纸"这件事不需要给
插件开任何读文件的权限。

**第一步:在你的描述树里放一个 `file-pick` 节点**(面板或锚点块都行):

```js
{ type: 'file-pick',
  label: '选择壁纸',
  accept: ['png', 'jpg', 'webp'],  // 可选:宿主白名单的**子集**
  maxBytes: 5 * 1024 * 1024,       // 可选:宿主硬顶 10MB
  actionId: 'wallpaper-picked' }
```

- `accept` **只能收窄**。宿主白名单是 `png` `jpg` `jpeg` `webp` `svg` `gif`;
  写一个不在里面的扩展名(`exe`、`bmp`),**整棵树被拒**(面板变错误态)——
  这不是降级,是当场说出来。省略 = 全白名单。
- `maxBytes` 是这里唯一被**钳**的旋钮:写得比 10MB 大按 10MB 算(不报错);
  写一个非正数则整棵树被拒。
- `actionId` 与 `button` 同规:靠 id 寻址,不是塞闭包。

**第二步:在 `onAction` 里接住那个地址**:

```js
api.registerWorkspacePanel({
  id: 'wallpaper',
  render: () => ({ version: 2, body: { type: 'file-pick', label: '选择壁纸', actionId: 'wallpaper-picked' } }),
  onAction: ({ actionId, payload }) => {
    if (actionId !== 'wallpaper-picked') return
    // payload = { path: 'storage:imports/<name>', name, size }
    api.theme.updateBackground({ image: payload.path })
    api.store.set('wallpaper', payload.path)   // ← 持久化归你自己
    return { notice: `换成了 ${payload.name}` }
  },
})
```

三条出口,写代码时按这个心智模型:

| 用户做了什么 | 你会收到 |
| --- | --- |
| 选中一个合法文件 | 一次 `onAction`,payload 是 `{ path, name, size }` |
| 按了取消 | **什么也没有** —— 你根本不会被叫醒 |
| 选了超限 / 类型不符的文件 | **什么也没有** —— 宿主 toast 一句人话,不计你的熔断账 |

`name` 是**清洗后的落盘名**(只留 `[a-zA-Z0-9._-]`,中文名会回落成
`import.png`),不是用户磁盘上的原名。同名不覆盖:第二张 `paper.png` 落成
`paper-2.png`。

**第三步:`storage:` 寻址**。`updateBackground({ image })` 只接受
`storage:<相对路径>`,解析到你的 `plugins/<你的 id>/storage/<相对路径>` ——
也就是 `api.storage` 那个目录(导入的文件落在它的 `imports/` 子目录里,
你自己也能 `api.storage` 列出来)。

- **包内的图换不了**:`updateBackground({ image: 'bg/paper.png' })` 会被拒。
  manifest 里那张 `contributes.theme.background.image` 是**缺省**,换它 = 发版本。
- 非法寻址(穿越、绝对路径、非图片扩展名)或**文件不存在** → **这一次调用
  整条被拒**,背景保持原样,记一条 error 日志,不计熔断。不是"忽略 image
  字段、只改透明度" —— 半条命令比不执行更难解释。
- 运行期换的图会压过 manifest 缺省图,并且**同时接管深色**:用户挑的是
  "这一张",不是"浅色这一张",所以不会在切主题时换成包里的 `darkImage`。
  撤回(`updateBackground({ image: null })`)把这一步**对称地**还回去:图回落
  manifest 缺省,`darkImage` 一并恢复 —— 接管是成对的,撤销也成对。
- 与别的运行期参数一样**不持久**:重启回 manifest 缺省。想记住用户选的那张,
  自己 `api.store.set` / `api.settings`,在 entry 启动时读一次再调一次。

**`file-pick` 只在 Electron 桌面宿主能用**(方案 A:插件只在桌面执行)。
web 端点下去会得到一句"仅桌面可用",而不是静默无反应。

**动画:描述树里没有,也不会有。** 描述树是纯数据,动画是"执行"的一种,
按宪法第 1 条划给宿主。宿主自带一小撮受限动效,你只声明状态:

- `progress` 的 `indeterminate: true` → 宿主的循环进度动画;
- `list` 项增删 → 宿主的进出场过渡;
- `tabs` 切换 → 宿主的页签与内容过渡;
- `badge` 的 `tone` 变化 → 宿主的颜色过渡。

**完全自定义动画 = webview(见下一章)**,没有第二条路。别在描述树里找
`style` / `className` / `transition` 字段 —— 它们不存在,而且是明确不做的红线
(节点级内联样式 = 半开的 CSS 注入)。

## webview 面板:逃生舱(C 期,L3)

图表、编辑器、拖拽、画布、任意动画 —— 描述树做不了的东西走这里。
**只有工作区面板能用**;锚点(`uiSlots`)永远不开 webview —— 常显块是
32px 单行(塞 iframe 没有正经场景),触发式的弹层同样只画描述树;
声明了会**拒载**。

### 声明

```jsonc
{
  "contributes": {
    "webviewRoot": "webview",              // 可省,缺省就是 "webview"
    "panels": [
      { "id": "chart", "label": "Revenue", "view": "webview", "entry": "index.html" }
    ]
  }
}
```

`entry` 的硬规矩(违反 = **这一条面板被丢弃**,插件其余能力照常,设置页卡片
写明 `panel "<label>" dropped — <原因>`):相对路径、不含 `..`、不含 `:`(所以
`javascript:x.html` 这类当场出局)、不含 `%`(编码变体)、不含反斜杠,
以 `.html` 结尾。

静态资源要跟着**包**走(`webviewRoot` 是相对包目录的),不是家目录 ——
家目录 `plugins/<id>/` 是数据区(`config.json` / `kv.json` / `storage/`),
协议一个字节都不服务那里。

### 页面跑在什么环境里

- **独立 origin**:`onething-plugin://<pluginId>/…`,协议只服务你的静态根内、
  白名单扩展名(html/js/css/json/svg/png/jpg/jpeg/webp/gif/woff2)的文件。
  别的扩展名回 415,穿越/软链逃逸回 404。
- **sandbox iframe**:`sandbox="allow-scripts"`,**没有** `allow-same-origin` ——
  你的页面是 opaque origin:没有 cookie、没有 localStorage、
  `document.domain` 无意义。要存东西用 `api.storage`(main 进程侧)。
- **CSP 钉死**:`default-src 'none'; script-src 'self' onething-plugin://<你的 id>;
  style-src … 'unsafe-inline'; img-src … data:; connect-src 'none'`。
  **`connect-src 'none'` = 页面不能出网**:没有 fetch、没有 XHR、没有 WebSocket。
  要联网在 main 进程侧做(你的插件代码在那里),结果经 `invoke` 递进来。
- **没有宿主对象**:`window.electronAPI`、`require`、`process` 一个都没有。
  与宿主之间只有 postMessage。

### 通信协议(全部内容)

宿主 → 页面:

| 消息 | 何时 | 形状 |
|---|---|---|
| `init` | 页面 `load` 之后的第一帧 | `{ type:'init', token, data }` |
| `refresh` | 你在 main 侧调了 `ctx.refresh()`,宿主重拉初始化数据之后 | `{ type:'refresh', token, data }` |
| `result` | 你的 `invoke` 的回帖 | `{ type:'result', token, requestId, result }` 或 `{ …, error }` |

页面 → 宿主(**每一条都必须带 `token`**,否则静默丢弃):

| 消息 | 形状 |
|---|---|
| `ready` | `{ token, type:'ready' }` |
| `invoke` | `{ token, type:'invoke', requestId, actionId, payload }` |

`invoke` 走的是既有的 `panel:action:<panelId>` 请求通道 —— 30s 预算、abort、
熔断账、`payload` 的可序列化守卫全部照常继承。它落到你在 main 侧写的
`onAction({ actionId, payload }, ctx)`。

**握手是必须的。** 宿主读不到 opaque origin 的 document,判断"这一页起来了没有"
的唯一信号就是你回的那条带 token 的消息。**10 秒内不回,面板显示加载失败**
(附一个 Reload 按钮)。协议 404 会渲染一张宿主的纯文本错误页 —— 它不会回握手,
于是"entry 写错了"也走同一条错误态。

### 一段可以直接拷走的 vanilla JS

```html
<!doctype html>
<meta charset="utf-8">
<div id="app">Loading…</div>
<script>
  let token = null
  let seq = 0
  const pending = new Map()

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'init') {
      token = msg.token
      // 握手确认:回一条,宿主的看门狗就撤了。
      parent.postMessage({ token, type: 'ready' }, '*')
      render(msg.data)
      return
    }
    // init 之后的消息校验 token —— 宿主也在校验你,两边对称。
    if (!token || msg.token !== token) return
    if (msg.type === 'refresh') render(msg.data)
    if (msg.type === 'result') {
      const waiter = pending.get(msg.requestId)
      if (!waiter) return
      pending.delete(msg.requestId)
      msg.error ? waiter.reject(new Error(msg.error)) : waiter.resolve(msg.result)
    }
  })

  /** 调一个 main 侧的 action;返回 onAction 的返回值。 */
  function invoke(actionId, payload) {
    const requestId = 'r' + (++seq)
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      parent.postMessage({ token, type: 'invoke', requestId, actionId, payload }, '*')
    })
  }

  function render(data) {
    document.getElementById('app').textContent = JSON.stringify(data)
  }
</script>
```

main 侧(可选 —— 纯静态面板完全合法):

```js
export default function (api) {
  api.registerWorkspacePanel({
    id: 'chart',
    // webview 面板的 render 返回的是**初始化数据**,不是描述树。
    // 宿主不解释它,原样 postMessage 给页面(必须 JSON-可序列化)。
    render: () => ({ series: loadSeries() }),
    onAction: async ({ actionId, payload }, ctx) => {
      if (actionId === 'export') await exportCsv(payload)
      // 想让页面拿到新数据:调 refresh,宿主重拉 render 再推一条 refresh。
      ctx.refresh()
    },
  })
}
```

### 披露与降级

- 装前确认页与已装卡片都会写 **`runs sandboxed UI code`** —— 用户在装之前就
  知道你会在应用里跑自己的界面代码。
- iframe 加载失败(entry 不存在、握手超时)是**宿主/文件问题**,不计你的熔断账;
  `onAction` 连败照常计账,达阈之后这个面板被降级(`panel:<id>` surface),
  插件的工具/命令/提示词照常。
- 停用或卸载之后,`onething-plugin://<你的 id>/…` 立刻 404。

## 氛围层(ambient):全窗动画覆盖层 + 地标词表

webview 的第三个住址(前两个是工作区/工作台面板)。声明:

```json
{ "contributes": { "webviewRoot": "webview", "ambient": { "entry": "ambient.html" } } }
```

页面环境与 webview 面板同一套(sandbox iframe、独立 origin、CSP 只放行包内
同源资源、token 握手),另加三条**住址特性**:铺满整窗、`pointer-events: none`
(永远点击穿透,你画不出可交互的东西 —— 这是住址属性不是限制)、层级压在
菜单/对话框**之下**(浮层永远盖住你)。窗口失焦/隐藏时宿主推 `pause`,
回来推 `resume` —— 收到 pause 必须停 rAF。

### 协议(全部消息)

```
host → 你   ambient-init        首帧握手,带 token(此后出入境消息都带它)
你 → host   ambient-ready       回握手
host → 你   ambient-vocabulary  地标词表,握手后只发一次
host → 你   ambient-geometry    地标矩形,布局变化时 rAF 合并推送
host → 你   ambient-pause / ambient-resume
```

`vocabulary`:`{ anchors: { <name>: { kind, cardinality } } }` —— 屏幕语义
地图的静态表。kind 目前有 `surface`(可落面:带边框/底色的**可见**元素)与
`envelope`(**参考几何,不是落面** —— 它是布局盒,含不可见 padding,把东西
"放"上去会悬空);cardinality `singleton | per-item`。

`geometry`:`{ viewport, composerRect, anchors, surfaces }`。
`surfaces: [{ name, index, rect }]` 是你该用的那份 —— **在列即在场,离场即
缺席**(没有 null 占位);`rect` 是视口坐标,iframe 铺满整窗,**视口坐标即
你的 canvas 坐标**,不用换算。`composerRect`/`anchors` 是 v1 兼容字段。

### 五条铁律(每条都有真机判例垫底)

1. **按 kind 分流,不对名字硬编码**。词表 append-only,将来会加新 kind
   (如 region);未知 kind 一律忽略。你的物理对着 kind 写,换个宿主版本
   不用改代码。
2. **envelope 不是落面**。判例:把 composer 容器当落面,雪悬空堆在
   "看不见的容器上沿"、雪人挂半空。需要"兜底"时,兜到视口底,不是兜到包络。
3. **`index` 不是跨帧身份**。它只在同一条 geometry 内稳定。进出场判定用
   "这一帧在不在列";要跟踪同一个面,自己用 `name + 水平位置` 做签名
   (对**垂直**位移免疫 —— 抽屉 240↔32 过渡时 rect.top 逐帧在变,签名不变,
   你的堆积物才能骑着顶边走而不是被判离场重来)。
4. **离散化别越可见边**。判例:按列切画布 + "重叠即归属"判据,边缘列搭上
   1px 就整列归属,画出来的东西探出可见元素几个像素。要么用列中心点判据
   (窄于一列的矩形特判),要么绘制时把横向范围钳到 rect 的 left/right 内
   ——最好两个都做。
5. **面离场时,它上面的东西要有个交代**。宿主不发"即将消失"预告(那要求
   宿主为你延迟卸载,不可能给);你 diff 前后两帧 surfaces 自察进出场,
   用最后一次的 rect 做退场演出(解冻重落、淡出、扬尘,随你)。

### 预算与降级

粒子/绘制预算自律(参考:全窗粒子 ≤ 60、堆积转静态路径而非粒子、单面堆积
高度设上限)。宿主不强制预算,但真机走查会看帧。设置页有"氛围层"总闸 +
每插件开关,被关时 iframe 直接销毁 —— 不需要你配合,但别把状态只存在
iframe 里(重开就没了;要持久用 `api.storage`)。

## 深链动作:让应用之外的世界点名你(H4)

`onething://` 是外部世界进来的唯一一扇门。它有两条路,你只拥有第二条:

```
onething://ask?text=<urlencoded>[&agent=<agentId>]        ← 宿主的,开一轮对话
onething://x/<pluginId>/<action>?text=…&<其余参数原样透传>   ← 你的
```

两条路的命名空间是**物理分开**的:你抢不到 `ask`,宿主将来加动词也顶不掉你。

### 先声明(不声明就注册不上)

```jsonc
{ "contributes": { "permissions": ["deeplink:handle"] } }
```

装前确认页把它念成人话:*can be invoked by onething:// links from outside the
app (you confirm every time)*。未声明就调 `registerDeepLinkAction`:宿主拒绝、
记一条 error、返回一个 noop 退订函数,**不计熔断**(manifest 笔误不该连坐你的
工具/命令/面板 —— 与 `sessions:*` 同规)。

### 注册

```js
export default function (api) {
  api.registerDeepLinkAction({
    // [a-z0-9-]+。它要进 URL 路径,所以不能有空格和大写。
    name: 'translate',
    // 确认卡上显示给用户看的**人话**。不是 id —— 用户读的就是这一句。
    title: 'Translate the selection',
    async handler({ text, params }) {
      const target = params.to ?? 'zh'
      const { text: out } = await api.llm.complete({
        messages: [{ role: 'user', content: `Translate to ${target}:\n\n${text}` }],
      })
      // v1 的返回值只有这一格:弹一条通知。别的事用你自己的 api 去做。
      return { notice: out.slice(0, 120) }
    },
  })
}
```

`registerDeepLinkAction` 返回退订函数;你不调也没关系,dispose 会兜底。

### 确认门:你无从跳过,也无从知道用户拒绝过

**每一条深链在你的 handler 被调用之前,都要用户看着全文按一次确认。** 没有信任
名单,没有"记住这个动作"——因为深链的正文每次都不一样,记住一个动作等于对一段
没看过的文字提前签字。卡上显示的是:来源标注、目标(*Runs "<你的 title>" from
<你的插件显示名>*)、**全文**(长文滚动,不截断)、其余参数。

用户按取消 = 什么也不发生,而且**你收不到任何通知**。不要设计"如果没回调就重试"
的逻辑:那是把用户的拒绝当成网络抖动。

### handler 收到什么、能回什么

| | |
|---|---|
| `ctx.text` | URL 里的 `text`,**原样**。可能是空串(有些动作只要参数)。 |
| `ctx.params` | 除 `text` 之外的全部查询参数,原样。重复键取最后一个。 |
| 返回 | `{ notice?: string }` 或什么都不返回。notice 截断到 240 字。 |

**text 是数据,不是指令。** 它可能来自剪贴板、网页、别人发你的一条消息。不要把
它当命令解析,不要把它拼进 shell,不要因为它长得像 `/clear` 就当成命令 —— 宿主
这一侧一个字都不解释它,你也别。

### 治理(和别的面一样,不额外优待)

- **超时 15 s**。比搜索供给方宽得多(这是用户刚按过确认的一次性动作,不是键入
  延迟敏感路径,你在里面调一次模型完全合理),但它有上限:一个永不 resolve 的
  handler 会让那条链看起来像"什么也没发生"。
- **连败三次降级这一个动作**(scope 家族 `deep-link`,degrade-surface)。降级期间
  确认卡上它是一条**说得清的拒绝**("暂时不可用"),不是消失。你的其它动作、
  工具、命令、面板全部照常。半开靠时间。
- **停用即注销**。插件停用后,指向它的链接在**确认之前**就被判为"这个动作不在
  了" —— 用户不会去确认一个不会发生的动作。已经在跑的那一次不被打断。

### 限额与拒绝

- `text` ≤ 32KB(UTF-8 字节)。超限:确认卡直接显示"内容过长已拒",不问你。
- 形状非法 / 未知动词 / 动作名不合法:**静默丢弃**,只有一行日志,不弹窗
  (否则任何网页都能拿 `onething://%%%` 骚扰用户)。这意味着你的链接写错了是
  **安静地不工作**,排障请看 `~/.onething/log/` 里的 `[DeepLink] Dropped`。

### 只有桌面

`onething://` 是操作系统级的注册,只有 Electron 桌面宿主有。server / CLI daemon
上 `registerDeepLinkAction` 会如实告诉你"这个宿主没有深链",返回 noop。

接入 PopClip 的完整配方(两个按钮:快速提问 + 翻译)见
`docs/guides/deeplink-popclip.md`。

## 凭证轮换策略:决定用哪把钥匙,但看不见钥匙(批 E)

一个空间的一个 provider 可以配**多把 key / 多个 OAuth 账号**(凭证池),池上挂一条
「策略」决定下一次请求用哪一条。宿主内置三条(`single` / `priority-failover` /
`round-robin`),`api.registerCredentialStrategy` 让你加第四条。

**这一面的全部意义是:你决定用哪一条,你看不到任何一条的内容。** 你拿到的是脱敏
视图,你交回一个 entry id,宿主拿 id 去取真钥匙。

### 先声明(不声明就注册不上)

```json
{ "contributes": { "permissions": ["credentials:strategy"] } }
```

装前确认页会把它念成:*can choose which of your credentials a workspace uses
(it never sees the key or token itself)*。未声明就调 `registerCredentialStrategy`:
宿主拒绝、返回 noop、记一条 error 日志,**不计熔断**(manifest 笔误不该连坐整个插件)。

### 注册

```js
export default function (api) {
  api.registerCredentialStrategy({
    // [a-z0-9-]+;宿主拼成 policy 取值 `plugin:<你的id>:<name>`
    name: 'least-used',
    // 用户在「设置 → 模型服务」的策略选择器里读到的就是这一句
    title: '用得最少的优先',
    // 选择器下方的说明。省略时宿主用一句兜底文案
    description: '按近 24h 的 token 量挑最闲的那把。',
    select(ctx) {
      // ctx.entries 至少一条,顺序 = 用户排的优先级
      return [...ctx.entries]
        .sort((a, b) => a.usage.totalTokens - b.usage.totalTokens)[0].id
    },
  })
}
```

注册之后**它还不会被调用** —— 用户得先在那个空间的那个 provider 上把策略选成你这条。
返回退订函数;你不调也没关系,dispose 会兜底。

### `ctx` 的确切形状

```ts
{
  providerId: string        // 'deepseek' / 'claude' / …
  spaceId: string           // 空间 id(默认空间没有池,不会走到你这里)
  entries: [{
    id: string              // ← 你要交回来的就是它
    label: string           // 用户给这条凭证起的名字
    authType: 'apiKey' | 'oauth'
    source: string          // 'user' 或 'plugin:<id>'
    cooldownUntil?: number  // 历史信息:候选集里不会有还在冷却的条目
    usage: {                // 近期用量,窗口见 ctx.usageWindowMs(当前 24h)
      requests: number      // 账本记录条数 ≈ 请求轮数
      inputTokens: number
      outputTokens: number
      totalTokens: number
      costUSD: number       // 能定价的那部分;定不出价的记 0
    }
    lastErrorKind?: 'quota-exhausted' | 'rate-limited' | 'auth-invalid' | 'transient' | 'unknown'
  }]
  attempt: number           // 首次解析 = 1;轮换重试时递增
  lastFailure?: { entryId, kind, status? }   // 只有轮换路径才有
  usageWindowMs: number
  now: number               // 宿主的"现在"。别自己 Date.now()
}
```

**这就是全部。** `apiKey` / `oauthToken` / `baseUrl` / `apiMode` / OAuth 账号名
一个字节都不在里面 —— 视图是按白名单**正向构造**出来的,不是"删掉几个字段"。

`entries` 已经是**可用候选集**:没有凭证材料的、正在冷却的、鉴权形态对不上的
(OAuth 型 provider 只给 oauth entry)都已经剔掉。你不必、也不该重新实现这套过滤
——重实现一遍就等于给自己开了一个绕过冷却的口子。

### 三条你必须知道的语义

1. **返回错了不是事故,是回落。** 返回不认识的 id / 空串 / 抛错 / 超过 2 秒,
   宿主一律改用内置 `priority-failover`,起流照常。你只会在熔断账上记一笔;
   连败三次那条**策略**被降级(宿主此后连调都不调它,靠时间半开),
   而你的工具/命令/面板/定时任务**照常**。
2. **`select` 里不要做副作用。** 它可能因为超时被丢弃结果 —— 一个已经写了盘的
   副作用配上一个被丢弃的返回值,是最难排查的那种不一致。要记状态用 `api.storage`。
3. **只在请求/重试边界被问,流中绝不被问。** 一条流开始之后就不会换钥匙;
   换手发生在这一轮失败之后的重试上。所以你的 `select` 不需要考虑并发流。

### 什么时候你的答案是"新鲜"的

宿主问你的时机分两条路,行为不同,写策略前请知道:

- **重试/轮换路径**(上一把 key 配额耗尽或被限流):宿主 **await 你的 `select`**,
  带着 `attempt`(≥2)和 `lastFailure`,当场按你的答案换手。这是「这个用完用另一个」
  的主场,恒新鲜。
- **正常起流路径**:宿主的凭证解析链是同步的(它一路通到引擎的适配器契约),
  所以它取用的是**上一次异步算好的那条裁决**,同时排一次刷新给下一次用。
  实际影响:进程刚起来的**第一次**选择走内置 failover,从第二次起是你说了算;
  池发生增删改排序时那条裁决作废,同样先走一次 failover。

### 用户看得见什么

策略出现在「设置 → 模型服务」里那个 provider 的策略选择器中(池里 ≥2 条时才显示),
显示的是你的 `title`,下面一行是你的 `description`。

你的插件被停用/卸载之后:**用户的选择不会被改写** —— `policy` 字段原样留在
`credentials.json` 里,选择器里那一项变灰并注明「策略不可用,正在使用内置 failover」。
你回来它自动生效。

### 只有桌面

只有 Electron 桌面宿主有空间与凭证池。server / CLI daemon 上
`registerCredentialStrategy` 会如实告诉你"这个宿主没有凭证策略",返回 noop。

## 安全与边界(速查)

- UI 不执行插件代码:面板/锚点块都是**描述树**,宿主渲染。
- 入口只有默认导出函数,`api` 由宿主注入;不要 import 宿主模块。
- 权限/熔断:钩子超时、事件 handler 抛错会进熔断账,严重按策略表
  禁用插件或只降级一个界面(`packages/core/plugins/policy.ts`)。
- 撞内置 id 装前拒。**手工往 `~/.onething/plugins/` 里放目录不再是安装方式**
  (2026-08-09 legacy 目录插件清零):那种目录不会被加载,也不会被报错或删除。
  唯一入口是 npm 账(市场安装或 `file:` 开发通道)。

## 排障

| 症状 | 多半是这个 |
|---|---|
| 装了但插件表里没有 | id 撞内置(装前就该被拒);或入口文件缺失/加载闸(minAppVersion) |
| 更新徽标永不灭 | plugin.json 与 package.json 版本漂移 |
| 拒装:"runtime dependencies" | 依赖没被 bundle 进单文件(检查 dist/package.json 应为零依赖) |
| 拒装:"Integrity mismatch" | 索引 SRI 与 tarball 实体不符;重新发 tag,不要手改 asset |
| 拒装:"name mismatch" | 索引/包名写错;包内 name 必须等于 `@onething-plugins/<id>` |
| 手工放的目录不出现在插件表 | 预期行为:2026-08-09 起只认 npm 账,目录形态不再加载 |
| webview 面板一直转圈然后报"did not load" | entry 路径写错(协议 404),或页面没回 `ready` 握手 |
| webview 页面里 `fetch` 全部 TypeError | 预期行为:CSP `connect-src 'none'`,页面不出网。联网在 main 侧做 |
| 面板在卡片上写 `dropped — …` | webview 声明非法(缺 entry / 有 `..` / 不是 .html / 静态根非法) |
| 装不上:`uiSlots[i].view is not supported` | 锚点块不开 webview,把它改成 `contributes.panels` 里的面板 |
| 消息态重启就没了 | manifest 没声明 `lifetime: "persistent"` |
| 写消息态抛 `quota` | 该插件消息态超 5MB 硬顶;记录该瘦身,宿主不替你淘汰 |
