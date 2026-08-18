# 把 onething 接到 PopClip 上(`onething://` 深链)

选中一段文字 → 弹出条上多一个按钮 → 那段字进 onething。这份文档是完整配方:
两个按钮,一个不需要任何插件,一个需要一个装好的插件。

前提:onething 桌面端至少启动过一次(URL scheme 是启动时注册的)。验证方法在
最后一节。

---

## 语法速查

```
onething://ask?text=<urlencoded>[&agent=<agentId>]
onething://x/<pluginId>/<action>?text=<urlencoded>[&<其余参数>]
```

- `text` **必须 URL 编码**,上限 32KB(UTF-8 字节)。超限会得到一张"内容过长已
  拒"的卡。
- `ask` 是宿主动词:开一轮新对话。`agent` 可选;点名一个不存在的 agent 时会回落
  默认,**并在确认卡上说明**。
- `x/…` 是插件动作。`<pluginId>` 是插件 id,`<action>` 是插件用
  `api.registerDeepLinkAction({ name })` 注册的名字。
- 其余查询参数原样透传给插件的 handler(`ctx.params`)。

**每一条链接都会先弹一张确认卡**,显示全文与目标,你按确认它才发生。没有"记住
这个动作"——见下面的「为什么每次都要确认」。

---

## 按钮一:快速提问(零插件)

新建一个 `Ask onething.popclipext` 目录,里面放一个 `Config.json`:

```json
{
  "identifier": "com.onething.popclip.ask",
  "name": "Ask onething",
  "actions": [
    {
      "title": "Ask onething",
      "icon": "circle 1T",
      "url": "onething://ask?text=***"
    }
  ]
}
```

`***` 是 PopClip 的占位符,它会把选中的文本 **URL 编码**后替换进去 —— 这正是
`text` 需要的形状。

双击这个目录安装。之后选中任意文字 → 点按钮 → onething 主窗被拉到前面 → 一张
确认卡显示全文 → 按 Confirm,它作为一条**普通用户消息**进入一个新会话。

### 变体:指定一个 agent

```json
"url": "onething://ask?text=***&agent=writer"
```

`writer` 换成你的 agent id(设置 → Agents 里能看到)。查不到会回落默认,卡上会
写明"The link asked for an assistant that isn't here — using your default instead."

### 变体:带一句固定的指令前缀

想要"总结一下:<选中的字>"这种效果,把指令写死在 URL 里(记得编码空格与冒号):

```json
"url": "onething://ask?text=%E6%80%BB%E7%BB%93%E4%B8%80%E4%B8%8B%EF%BC%9A%0A%0A***"
```

`%0A%0A` 是两个换行。选中的文字仍然由 `***` 填进去。

---

## 按钮二:翻译(走插件动作)

> **省事的路(quick-translate ≥ 1.1.0)**:装好 `quick-translate` 插件后,在会话里
> 输入 `/popclip-install`(可带语言码,例 `/popclip-install zh en ja`)。插件会在自己的
> 数据目录 `~/.onething/plugins/quick-translate/` 生成一份 PopClip snippet
> `onething-translate.popcliptxt` 并 `open` 它,PopClip 弹出自己的安装确认,点 Install
> 即可。用户手抄 Config.json 的写法保留在下面,供别的插件参考。
> 卸载插件不会收回 PopClip 里的按钮 —— 去 PopClip 设置里删。

假设你装了一个 id 为 `translator` 的插件,它注册了一个名为 `translate` 的深链
动作:

```js
// 插件侧(供参考;完整写法见 docs/guides/plugin-authoring.md)
api.registerDeepLinkAction({
  name: 'translate',
  title: 'Translate the selection',
  async handler({ text, params }) { /* … */ return { notice: '…' } },
})
```

对应的 PopClip extension:

```json
{
  "identifier": "com.onething.popclip.translate",
  "name": "onething Translate",
  "actions": [
    {
      "title": "Translate → 中文",
      "icon": "circle 译",
      "url": "onething://x/translator/translate?text=***&to=zh"
    },
    {
      "title": "Translate → English",
      "icon": "circle EN",
      "url": "onething://x/translator/translate?text=***&to=en"
    }
  ]
}
```

`to=zh` / `to=en` 会原样出现在插件 handler 的 `ctx.params` 里 —— 一个动作、两个
按钮、靠参数区分,不需要注册两个动作。

确认卡上显示的是插件的**显示名**和动作的 title(`Runs "Translate the selection"
from 划词翻译`),不是 `translator/translate` 这种 id。

---

## 为什么每次都要确认

因为深链的**正文每次都不一样**。"允许 PopClip 触发翻译"这句话记住之后,你授权
的是一个动作,而实际发生的是一段你没看过的文字被送进模型或插件 —— 剪贴板里可能
是一段密钥,网页上可能是一条构造好的诱导文本。

所以:确认卡显示**全文**(长了就滚动,绝不省略号),显示来源标注和目标,你按
确认它才发生。取消 = 什么也不发生,插件永远不知道有过这一次。

v1 没有免确认档,也没有信任名单。

---

## 排障

| 症状 | 多半是这个 |
|---|---|
| 点按钮什么也没发生 | URL 形状非法或动词未知 —— 这类链接是**静默丢弃**的(不弹窗是有意的:否则任何网页都能骚扰你)。查 `~/.onething/log/` 里的 `[DeepLink] Dropped` 一行 |
| 卡上说"内容过长已拒" | 选中的文字超过 32KB。深链不是附件通道 |
| 卡上说"No plugin here handles …" | 插件没装、被停用了,或动作名拼错 |
| 卡上说"temporarily disabled after repeated failures" | 那个动作连续失败被熔断降级了,过几分钟自己恢复;插件作者该看日志 |
| macOS 没把链接给 onething | 系统里注册了别的 handler。启动一次 onething 会重新登记;日志里有 `[DeepLink] onething:// registered: true` |
| app 没在跑时点链接,启动了但没弹卡 | 正常路径是:URL 排队 → 窗口建好 → 渲染层就绪 → 补投。若确实没弹,看日志里有没有 `Cold-start queue overflow`(短时间内点了 5 条以上,最旧的会被丢) |

### 不用 PopClip 也能验证

浏览器地址栏直接敲(或 `open` 命令):

```bash
open 'onething://ask?text=hello%20from%20the%20terminal'
```

应该看到 onething 被拉到前面并弹出确认卡。

---

## 其它调用方

深链不绑 PopClip。同一套 URL 在这些地方都能用:

- **Raycast / Alfred**:script command 里 `open 'onething://ask?text=…'`
- **快捷指令(Shortcuts)**:「打开 URL」动作
- **Keyboard Maestro / Hammerspoon**:同样是 open URL
- **任何能拼 URL 的东西**

唯一的要求是它能把文本 URL 编码后拼进 `text`。
