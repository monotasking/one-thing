# 微抖已复现：坐标稳定，文字像素仍在移动

> **后续修复已落地：** 列尾消息退出隔离，跟随处理尺寸缩短，并补齐补偿方向边界。最终像素回放 0 次切换，相关回归检查通过；详见 [修复方案与验证](/Users/yitiansong/data/code/start-electron/docs/audit/follow-jitter-fix-2026-09-15.md)。下文保留修复前的调查过程与当时结论。

## 目前定位到哪一层

**问题已经从“没有复现”推进到“可重复捕获的绘制像素抖动”。** 回放录屏对应的真实会话，当前实现里底部提示的 DOM 坐标保持不变，但文字在两个相邻物理像素位置之间切换。在 DPR=2 的实验环境中，这相当于 **0.5 CSS 像素**，符合用户描述的量级。

第一轮 ABA 只测了 DOM 坐标，把“坐标稳定”解释得过宽了。补偿确实抵消了几何余差，但这不足以证明画面稳定。

现在的主要嫌疑是 **`useFollowBottom` 对整条消息做位移补偿，与文字最终绘制时的像素对齐发生交互**。改变补偿的应用方式，像素抖动次数显著变化；恢复原方式，现象再次出现。尚未追到 Chromium 内部具体哪一次取整，也没有得到完全消除抖动的方案，因此没有修改产品实现。

## 新对照结果

使用相同真实会话历史、相同 12,656 个回放事件、相同内容宽度 926px、高度 816px、DPR=2。每轮独立启动，回放 68 秒，比较第 24～34 秒固定区域的截图。

| 实验 | 补偿方式 | 截图数 | 标签像素位置切换 | 采样的标签 DOM 顶部 |
| --- | --- | ---: | ---: | --- |
| A：当前实现 | 整条消息 `translate` | 130 | **22 次** | 始终 691px |
| 附加诊断 | 同上，加 `will-change: transform` | 116 | **18 次** | 始终 691px |
| B：改变应用方式 | 相同计算逻辑，改为相对定位 `top` | 124 | **2 次** | 始终 691px |
| A：恢复当前实现 | 整条消息 `translate` | 132 | **22 次** | 始终 691px |

“切换”是相邻截图之间从一个像素位置变成另一个位置，往返通常计两次。截图不是显示器每一帧，采样频率和调度略有差异，表中次数不能当成精确发生率或推导百分比改善。附加诊断插在 A 与 B 之间。

三组 A/B/A 的标签图像经过 0 或 1 个物理像素的竖直平移后，灰度逐像素比较误差全部为 **0**。也就是说，捕获到的是同一段文字的真实像素位移，不只是抗锯齿颜色变化。`will-change` 组还存在额外的像素差异；该提示没有消除抖动，也不能仅凭设置它就断言实际分层方式。

恢复 A 时，提示元素、内部 span，以及文本 Range 的顶部都分别固定在 691px、691px、692.5px。坐标在每次截图前后各读一次。因此已排除“仅仅是提示容器不动、内部文字的布局坐标在动”这一简单解释；但截图与坐标读取不是同一次原子快照，仍不能排除采样间的短暂状态。

## 可直接检查的证据

当前实现 A 中，下面两张固定区域截图对应不同的像素位置；标签位移为 1 个物理像素。分析只比较不变的 `Generating` 字样，排除了变化的计时数字。

基准截图：

![基准位置](/Users/yitiansong/data/code/start-electron/output/follow-aba/recorded-pixels-A/pixels/0000.png)

另一位置（约回放第 28.26 秒，截图开始时间）：

![下移一个物理像素的位置](/Users/yitiansong/data/code/start-electron/output/follow-aba/recorded-pixels-A/pixels/0057.png)

- [像素拟合与切换明细](/Users/yitiansong/data/code/start-electron/output/follow-aba/recorded-pixel-analysis.json)
- [A 的截图时间与坐标](/Users/yitiansong/data/code/start-electron/output/follow-aba/recorded-pixels-A/pixels/index.json)
- [B 的截图时间与内部文字坐标](/Users/yitiansong/data/code/start-electron/output/follow-aba/recorded-pixels-relative/pixels/index.json)
- [恢复 A 的截图时间与内部文字坐标](/Users/yitiansong/data/code/start-electron/output/follow-aba/recorded-pixels-A-restore/pixels/index.json)

B 剩余的两张偏移截图出现在回放约 29.75～29.89 秒。其中一张截图前后的消息位置和补偿值也相同，不能简单把剩余问题归为一次读数刚好跨过更新。因此 **相对定位目前只是诊断对照，不是已经验证好的修复**。

## 对原因的解释：证据与推断分开

已经证实：

1. 第一轮禁用补偿时，内容的分数高度增长与实际滚动量之间存在微小差值，补偿能消除这类 DOM 坐标余差。直接删除补偿会引入已知的几何抖动。
2. 当前补偿生效时，真实会话回放仍能捕获文字像素上下切换。旧的“只看坐标”判据漏检了它。
3. 保留补偿计算逻辑，改变它作用于布局还是变换，捕获到的抖动明显不同；恢复原实现，现象可重现。

据此推断，排查重点应放在 **消息局部坐标、滚动、位移补偿与最终像素对齐之间的关系**。当前算法锁定了消息边界的最终几何坐标，未必同时锁定内部文字最终绘制的位置。Chromium 的绘制文档说明，像素对齐会发生在多个渲染阶段；这支持该解释方向，但不能替代浏览器内部轨迹证据。[Chromium 绘制与像素对齐说明](https://chromium.googlesource.com/chromium/src/+/master/third_party/blink/renderer/core/paint/)

此次没有证明：所有正文块都以相同方式抖动、用户视频中的每次抖动都来自同一机制、某个具体 Chromium 函数存在缺陷。先前发现的正补偿边界问题也没有在这些有效跟随帧中被证实触发，不能把它冒充本次根因。

## 复现方法

在桌面 React 应用目录运行以下命令，依次生成三组新的实验结果。需要当前工程依赖、本地 Electron/后端构建，以及原始会话日志；这是本机诊断脚本，尚未整理成可移植的最小复现。

```sh
node scripts/probe-follow-recorded.mjs --label=pixel-A1-new --pixels
node scripts/probe-follow-recorded.mjs --label=pixel-B-new --pixels --relative-nudge
node scripts/probe-follow-recorded.mjs --label=pixel-A2-new --pixels
python3 scripts/analyze-follow-pixels.py ../../output/follow-aba/pixel-A1-new/pixels ../../output/follow-aba/pixel-B-new/pixels ../../output/follow-aba/pixel-A2-new/pixels
```

- [真实会话回放脚本](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/probe-follow-recorded.mjs)
- [像素分析脚本](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/analyze-follow-pixels.py)，依赖 Pillow 和 numpy。

回放读取录屏对应会话的历史，向隔离渲染器注入已记录的 UI 事件；不重新执行其中的工具或命令，也不调用真实模型。原始存储只读，临时数据与进程在结束后清理。截图可能含原会话文字，结果保留在本地。

实验使用当前源码；与用户录屏当时逐像素相同的主题、缩放和调度并未全部证明。当前运行的应用确实加载了补偿实现，但这不等于证明录屏当时加载的版本。

## 接下来如何修

先保留这份像素回归用例，再针对补偿作用的元素和坐标空间做小范围实验。优先验证能否让内部文字的绘制位置稳定，同时保留贴底能力。相对定位仍有残余，不能直接上线；简单加 `will-change` 也未通过。

验收至少同时满足：真实回放中固定文字像素不再往返、DOM 几何余差不回归、发送留白与用户向上滚动等现有行为正常。只有坐标曲线平直，不再算修复通过。

本次新增诊断脚本和报告，回放脚本语法检查通过，四轮像素实验和分析实际完成。产品 `ChatStream.tsx` 未改动，SHA-256 仍为 `95b2b520bd30d5984cc5c9235eab8342dcbd0c0eb3674e0206c01d769119add9`。未运行产品全量测试。
