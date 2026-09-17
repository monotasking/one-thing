# 浏览器遮挡、移动空白与尺寸变化调查

日期：2026-09-15。范围：当前源码、运行中的桌面应用、相关测试。此次仅调查，未修改产品代码。

## 结论

| 现象 | 原因与当前状态 |
| --- | --- |
| 网页盖住 tooltip、Dock | **确认仍有实现缺口。** 网页是独立原生视图，tooltip、Dock 是外壳内的 DOM；两者不共用 CSS 层级。现有遮挡处理漏掉了这两类元素。 |
| 移动标签后持续空白 | **旧原因已修复。** 过去移动后丢失“网页已被隐藏”的状态，导致新容器没有恢复网页。用户此次确认该现象似乎已消失。 |
| 调整尺寸时画面跟随不好 | 正常显示时尺寸同步存在且本次读数正确；**截图过渡仍有低频更新、裁切和异步旧图覆盖新图的问题**，能造成画面跟不上容器的观感。尚未复现正常可见网页持续停留在错误尺寸。 |

## 1. 为什么网页总在 tooltip、Dock 上面

浏览器使用 Electron 的 `WebContentsView`，由主进程加入窗口的原生视图树。外壳中的 tooltip、Dock 则绘制在另一片网页中。给 tooltip 增大 `z-index`，只会改变外壳内部的绘制顺序，无法越过这片原生网页。

代码已经为此实现了替代显示流程：检测到遮挡 → 截取网页 → 隐藏原生视图 → 在外壳里显示截图。此时外壳的弹层才可以盖在截图上面。

问题是检测范围不完整：

- `NativeViewSlot` 只识别更高浮窗的相交、焦点树中 `float/modal` 类型的作用域，以及工作区拖拽状态。
- Tooltip 使用 `createPortal(document.body)`，只登记一个处理 Escape 的瞬态回调，没有登记为检测器所需的浮层节点。该瞬态登记也不会通知焦点树订阅者重新测量。
- Dock 在焦点树中是 `region`，因此不满足 `float/modal` 条件；它也不是检测器查询的 `[data-float-body]`。

所以，tooltip 或 Dock 与网页区域相交时，网页可能仍保持原生可见状态，直接压住它们。

**Dock 另有事件问题：** 自动唤出依赖外壳 `window` 的 `pointermove`。鼠标在嵌入网页中移动时，事件属于网页自己的文档，不会冒泡到外壳。因此从网页区域靠近窗口边缘时，还可能遇到 Dock 没有被唤出的情况。这与“已经显示但被盖住”是两个不同环节。

证据：[原生视图创建](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/index.ts:236)、[遮挡判断](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/NativeViewSlot.tsx:235)、[Tooltip 登记与渲染](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/ui/Tooltip.tsx:118)、[瞬态回调](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/focus/registry.ts:542)、[Dock 自动唤出](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/components/AppShell.tsx:394)。Electron 官方也将这些组件定义为独立的原生视图，使用原生子视图顺序和矩形管理：[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[View](https://www.electronjs.org/docs/latest/api/view)。

## 2. 移动标签后持续空白的旧原因

此前的流程是：

1. 拖拽开始，旧容器请求隐藏原生网页、改用截图。
2. 标签移到另一个区域，旧容器卸载，新容器挂载。
3. 新容器把自己的遮挡初始状态设为“未遮挡”，但主进程仍记着上一任发出的“已遮挡”。
4. 新容器发现当前没有遮挡，以为状态没有变化，因此不发送恢复命令。
5. 网页继续隐藏；新容器可能先空白，随后只显示每秒更新的截图。

因此，“容器变了但网页不跟随”当时也可能是同一个问题：屏幕上显示的是隐藏网页的截图。

9 月 15 日 00:54 的提交 `781e6431c` 已将遮挡状态和最后一张截图按 `viewId` 保存，在容器之间交接；同时修复了“截图尚未完成，恢复命令先到，随后网页又被隐藏”的竞态。

**本次核对：** 当前源码和桌面主进程构建产物包含修复；相关 65 项测试通过。运行中的浏览器没有截图占位，网页报告 `visibilityState: visible`。用户随后也确认空白现象似乎已消失，因此不能再把旧缺陷当作当前未修复的问题。

证据：[跨容器状态交接](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/view-claim.ts:69)、[新容器继承状态](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/NativeViewSlot.tsx:199)、[截图期间取消遮挡的处理](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/layout.ts:165)。

## 3. 为什么尺寸变化时仍可能显得不顺

### 正常网页的尺寸同步是存在的

目前流程为：容器尺寸变化 → `ResizeObserver` → 下一动画帧测量 → IPC 通知主进程 → `setBounds` 调整原生网页。

拖动期间另有逐帧测量；它并非完全没有监听尺寸。本次对运行中的右侧浏览器读取到：

- 容器：`462 × 675` CSS 像素。
- 网页内部视口：`462 × 675`。
- 网页可见，没有截图占位。

这证明当前稳定状态下尺寸匹配，但不代表拖动过程中的每一帧都已验证。容器布局、消息传递和原生网页绘制分属不同环节，并不是同一次绘制原子完成。

证据：[测量与发送](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/NativeViewSlot.tsx:206)、[尺寸监听](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/NativeViewSlot.tsx:286)、[主进程更新矩形](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/layout.ts:141)。

### 截图阶段有三个具体缺口

**① 图像变化不等于网页重新排版。** 遮挡期间每 1000 毫秒重新截图一次；截图按 `width/height: 100%` 和 `object-fit: cover` 填满容器。容器纵横比变化时，旧图会缩放、裁切，而不是立即按新宽度重新排列文字。因此会显得内容没有正确自适应。

**② 当前代码仍可让旧尺寸截图覆盖新尺寸截图。** 本次直接执行当前 `NativeViewLayout` 源码，使用可控制完成顺序的截图替身复现：

1. 旧尺寸 `800 × 600` 发起截图 A，尚未返回。
2. 取消遮挡，调整为 `400 × 600`，再次遮挡并发起截图 B。
3. B 先返回，推送新尺寸截图。
4. A 后返回，因为当前又处于遮挡状态，仍被当作有效结果推送。

实际记录的推送顺序为：`新图 400 × 600 → 旧图 800 × 600`。代码检查了当前是否遮挡，却没有检查截图属于哪一次遮挡、哪一个尺寸版本。这是本次确认的现存时序缺陷；验证的是业务状态逻辑，未把模拟结果当作用户实际画面的复现。

**③ 截图与恢复绘制之间缺少完成确认。** 截图为空或失败时，代码仍隐藏原生视图，却没有可显示的新截图；取消遮挡后，外壳只等一个动画帧就撤图，没有等待原生网页按新尺寸完成绘制的回执。这些路径可能出现短暂底色或空白，但不能据此断言用户仍有持续空白。

证据：[每秒截图及返回检查](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/layout.ts:198)、[截图为空仍隐藏](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/layout.ts:165)、[截图裁切规则](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/NativeViewSlot.module.css:28)、[一帧后撤图](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/native-view/NativeViewSlot.tsx:271)。

## 后续修复重点

1. 让 tooltip、Dock 等覆盖元素统一参与原生视图遮挡管理，并补齐网页区域的 Dock 唤出事件。
2. 给截图请求加上遮挡与尺寸版本，丢弃过期结果；按尺寸变化及时更新截图。
3. 根据原生网页的恢复完成信号撤掉截图，处理截图失败时的显示衔接。

本次不建议再以“调高 z-index”或“补一个 ResizeObserver”作为主要修复方向：真正需要补齐的是原生网页与外壳之间的遮挡、事件和绘制同步。
