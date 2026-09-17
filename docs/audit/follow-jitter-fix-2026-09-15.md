# 跟随输出微抖：修复方案与验证

> 2026-09-16 补充：已在思考文字持续追加时复现快速滚动造成正文整片空白，仍待定位，不在下述微抖验证的覆盖范围内。之前混合阶段的旧行为对照不能用于判断这个限定场景是否由修复引入。见 [思考流式中的滚动闪烁记录](/Users/yitiansong/data/code/start-electron/docs/audit/thinking-stream-scroll-repro-2026-09-16.md)。

## 采用的方案

**保留现有跟随和像素补偿，调整尾部消息的布局隔离，并补全尺寸缩短时的处理。** 已直接修改本地代码。

1. **当前尾部消息使用 `content-visibility: visible`。** 其余历史消息继续使用 `auto` 跳过屏外排版和绘制。尾部消息在输出结束时保持同一种布局方式，等下一条消息接替后再恢复隔离。
2. **跟随状态同时处理高度增加和减少。** 原来尺寸观察器在“没有长高”时直接返回，漏掉了微小缩短后浏览器回退滚动位置的情况。现在尺寸变化都会进入已有判断；用户浏览历史时，“有新内容”的提示仍只由增长触发，恢复位置、折叠和主动展开的优先分支保留。
3. **补偿始终不向下推。** 内容缩短越过旧落点时重新选择落点，避免正补偿反过来扩大滚动范围。新增反例测试覆盖 `632.2 → 631.3 → 632.2` 的自然位置序列。

对应代码：

- [尾部消息的样式](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/ChatStream.module.css)
- [尺寸变化与跟随处理](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/ChatStream.tsx)
- [补偿边界](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/tail-snap.ts)
- [边界反例测试](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/__tests__/tail-snap.test.ts)

## 为什么这样改

`content-visibility: auto` 即使正在显示内容，也会带来布局、样式和绘制隔离。它与整条消息的 `translate` 补偿叠加时，本次真实回放出现了“DOM 坐标固定，但文字切换一个物理像素”的现象。[CSS Containment 规范](https://www.w3.org/TR/css-contain-2/#content-visibility)

关闭尾部隔离后，像素抖动消失；恢复原实现，抖动再次出现。给整条消息或读数行添加 `will-change` 均未解决问题，改为相对定位也有残余。重新加回 `contain: layout style` 后，像素抖动重新出现，因此最终没有保留它。这里确认的是应用层可以控制的触发组合，尚未追到 Chromium 内部具体的取整函数。

实现过程中还发现两个必须处理的边界：

- **不能在停止输出时立即切回 `auto`。** 首个候选方案只在 streaming 时关闭隔离，导致常态收尾出现 24px 的一帧气泡位移和约 35px 的锚点位移。原实现对照没有这些问题。改为按“是否仍在列尾”判断后，收尾大跳位消失。
- **不能只补偿增长。** 剩余反例中，`scrollTop` 从 8898.5 回到 8898，补偿值仍为 -0.75，提示位置从 605 变成 605.4921875。下一次增长才把它拉回 605。处理尺寸缩短后，这个长回复反例通过。

## 对照证据

同一录屏对应会话、同一批 12,656 个事件，固定内容宽 926px、高 816px、DPR=2；比较回放第 24～34 秒的不变文字。一次位置切换是相邻截图中的位置改变，往返通常计两次；采样不是显示器每一帧，次数不用于推导精确发生率。

| 实验阶段 | 截图数 | 像素位置切换 |
| --- | ---: | ---: |
| 原实现的恢复对照 | 171 | **20 次** |
| 关闭正在输出消息的隔离，诊断候选 | 169 | **0 次** |
| 首个代码候选，流式窗口 | 168 | **0 次** |
| 最终代码：列尾保持普通布局＋尺寸缩短处理＋补偿方向边界 | 126 | **0 次** |

首个代码候选的像素窗口通过，但收尾测试失败，因此没有停在这个版本。最终版 126 张截图中，固定标签的灰度逐像素差异全部为 0；提示顶部始终为 691.5 CSS px，文本 Range 顶部始终为 693px。每轮与自身基准比较，稳定性不要求不同运行的绝对落点完全相同。

- [原实现像素分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/fix-baseline-restore-analysis.json)
- [关闭隔离的像素分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/fix-visible-tail-analysis.json)
- [最终代码的像素分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/fix-final-analysis.json)
- [最终截图时间、坐标与布局模式](/Users/yitiansong/data/code/start-electron/output/follow-aba/fix-final/pixels/index.json)
- [先前完整定位过程](/Users/yitiansong/data/code/start-electron/docs/audit/follow-pixel-jitter-2026-09-15.md)

## 验证状态

- 57 项相关测试通过，包含新增的补偿方向反例。
- 类型检查与前端构建通过。
- 最终完整发送流程通过：常态、长回复、重试、400 条历史加 20 万字输出，所有门槛断言通过。
- 用户上翻停止跟随、点按钮回到底部、左右分屏互不抢滚动与焦点检查通过。
- 最终真实回放的像素断言通过：0 次位置切换，固定文字的像素差异为 0。
- 反证检查通过：给同一个像素断言输入旧版截图，它检测到 20 次切换并返回失败。

性能记录保留失败数据：一次完整检查在长回复中记录到 1 个 67ms 长帧，功能与几何断言均通过；这一轮不能记作测试全绿。后续复核结果另列，不能用重跑抹掉这次记录。[该轮日志](/Users/yitiansong/data/code/start-electron/output/follow-aba/send-flow-final.log)

最终完整复核中，常态、长回复、重试的 >50ms 长帧均为 0；超量场景仍记录到 7 个，最长 1175ms。超量长帧属于现有门的报告项，不属于其失败断言；原实现同样记录到 6 个、最长 1158ms。不能把“门通过”解释为超量过程完全不卡顿。

- [完整发送流程最终日志](/Users/yitiansong/data/code/start-electron/output/follow-aba/send-flow-final-verified.log)
- [原实现发送流程对照](/Users/yitiansong/data/code/start-electron/output/follow-aba/send-flow-baseline.log)
- [用户上翻、回底与分屏检查](/Users/yitiansong/data/code/start-electron/output/follow-aba/chat-follow-final.log)

## 代价与边界

每个聊天区最多有一条列尾消息退出跳渲。这样避免按整份历史持续排版，但列尾消息本身很长且处于屏外时，仍会参与布局。400 条历史和 20 万字输出用例用于检查这一改动；它不能覆盖所有机器、缩放比例和复杂内容组合。

本次目标是消除已复现的微小往返，不等于解决长会话的所有卡顿。超量用例在原实现中也有首屏和收尾长帧，报告会保留这些读数。

没有改动用户已有的其他工作区修改，没有提交或发布代码。

## 如何复核

在 `apps/desktop-react` 目录执行：

```sh
node scripts/probe-follow-recorded.mjs --label=verify-follow-fix --pixels
python3 scripts/analyze-follow-pixels.py ../../output/follow-aba/verify-follow-fix/pixels --expect-stable
npm run gate:send-flow
npm run gate:chat-follow
```

像素分析现在会在固定文字移动或像素发生变化时返回失败，不再只打印计数。回放使用隔离会话，不执行原会话中的工具和命令。完整复现需要本机原始会话日志及现有工程构建。
