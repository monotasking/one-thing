# 持续输出时手动滚动：大闪烁复现记录

> **场景更正：本篇旧实验不能直接代表用户所说的“正在输出思考时滚动”。** 旧录像主要在翻历史内容，且 50 秒附近的多张空白发生在该段思考结束之后。完整任务到 102.327 秒才结束，但“任务未结束”不足以证明“思考仍在输出”。下方旧结果仅保留为历史滚动现象记录；请以 [重新限定思考流式阶段的复现](/Users/yitiansong/data/code/start-electron/docs/audit/thinking-stream-scroll-repro-2026-09-16.md) 为当前结论。旧行为对照也不能直接用于判断新限定场景是否由上轮修复引入。

## 结论

**已重复复现：快速滚动时，聊天正文整片短暂变空，随后恢复；侧栏和输入区仍然显示。** 这与此前小于 1px 的文字位置抖动是不同的现象。

恢复上一轮修改前的三项行为后，也捕获到了空白画面。因此，目前不能认定是上一轮修复新引入的，也不能用本次少量样本判断修复前后谁更严重。具体根因尚未定位，本轮没有继续修改产品代码。

## 录像与截图

当前版本第一轮的原速片段，包含快速向上、向下滚动时的空白：

![当前版本闪烁复现录像](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-0916/manual-scroll/reproduction.mp4)

逐帧对照：[闪烁前](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-0916/manual-scroll/01353.jpg) → [正文空白](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-0916/manual-scroll/01354.jpg) → [正文恢复](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-0916/manual-scroll/01355.jpg)。

另有 [当前版本重复录像](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-repeat-0916/manual-scroll/reproduction.mp4) 和 [恢复旧行为的对照录像](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-before-0916/manual-scroll/reproduction.mp4)。三轮均人工查看了代表性空白原图。

## 如何触发

使用原录屏对应会话的真实事件，在隔离的 Electron 窗口中回放 68 秒、12,656 个事件。历史消息保留，思考及后续内容继续增长；原会话只读，不执行记录中的工具或命令，也不请求模型。

1. 开始时跟随底部；第 8 秒向上滚动，进入浏览历史状态。
2. 持续输出期间多次小幅、较大幅度上下滚动。
3. 第 44 秒连续快速上翻：每次 `deltaY=-1600`，10 次，间隔 60ms。
4. 第 50 秒连续快速下翻：每次 `deltaY=1600`，10 次，间隔 60ms。

本次空白均集中在第 3、4 步。轻微滚动阶段未捕获同类大空白；这不代表轻微滚动一定没有问题。向下翻阅也不等于实际回到底部，内容持续增长，本次这些阶段仍处于浏览状态。

每轮共 65 个浏览器输入事件，页面收到的 wheel 事件 `isTrusted=true`。窗口 1280×860、DPR=2，滚动容器内容宽 926 CSS px、高 816 CSS px；三轮使用相同回放和输入安排。

## A–B–A 结果

| 阶段 | 捕获画面数 | 空白画面数 | 回放中的空白时间 |
| --- | ---: | ---: | --- |
| A：当前实现 | 2084 | 5 | 44.20s；50.35～50.92s |
| B：恢复修改前三项行为 | 2087 | 2 | 44.25s、44.70s |
| A：当前实现重复 | 2095 | 3 | 50.28～50.63s |

B 通过测试服务器恢复：尾部消息 `content-visibility:auto`、仅增长时处理尺寸变化、旧的像素补偿保持条件。它是当前应用内的三项行为回退，并非整个应用的历史版本。

“空白画面数”是采样截图数，不是精确的闪烁发生次数或发生率。CDP 每隔若干帧捕获一次；录像按捕获时间间隔组织，编码时补重复帧，不代表完整显示器逐帧记录。数量少且受执行时序影响，不能据此比较严重程度。

## 已排查到哪一步

- **空白附近没有自动贴底。** 所有 10 张空白画面前后 ±80ms 内均没有 `stick()` 记录；距离画面约 1.4～4.7ms 的滚动判断均为 `browsing`。
- **邻近时刻仍能测到正文。** 距离空白捕获约 1.2～4.4ms 的 DOM 采样仍能命中文字节点所在块，并得到文本长度和可视区域内的矩形。这并非严格同一时刻的证明，但更值得沿绘制、合成和屏外内容恢复显示的方向查。
- **不能仅凭 `scrollTop` 突变认定整块跳位。** 历史消息尺寸重新确定时，滚动高度及偏移会一起变化；需要对齐可见文本位置和实际画面。

下一步最有价值的单变量实验：保持同一回放与滚动输入，只关闭历史消息的 `content-visibility:auto`，再次做对照。如果空白消失，再缩小到屏外消息重新进入视口的处理；若仍出现，则继续检查滚动容器的绘制/合成。此项尚未执行，不能提前当作根因。

此前验证主要检查跟随时固定文字的像素稳定性、跟随状态和滚动几何，没有覆盖这种持续输出中的快速滚动空白。原有检查通过并不能说明这个场景也通过。

## 工具、原始记录与限制

本轮只扩展复现工具，未增加产品修复：

- [真实事件回放入口](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/probe-follow-recorded.mjs)
- [滚动输入及画面采样](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/lib/probe-manual-follow.mjs)
- [空白候选分析和录像生成](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/analyze-manual-follow.py)
- [A 的分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-0916/manual-scroll/analysis.json)、[完整时间线](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-0916/manual-scroll/trace.json)
- [B 的分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-before-0916/manual-scroll/analysis.json)、[完整时间线](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-before-0916/manual-scroll/trace.json)
- [重复 A 的分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-repeat-0916/manual-scroll/analysis.json)、[完整时间线](/Users/yitiansong/data/code/start-electron/output/follow-aba/manual-scroll-current-repeat-0916/manual-scroll/trace.json)

在 `apps/desktop-react` 下顺序运行，使用新的 label 避免覆盖证据：

```sh
node scripts/probe-follow-recorded.mjs --manual-scroll --label=manual-A-new
node scripts/probe-follow-recorded.mjs --manual-scroll --before-fix --label=manual-B-new
node scripts/probe-follow-recorded.mjs --manual-scroll --label=manual-A-repeat-new
python3 scripts/analyze-manual-follow.py ../../output/follow-aba/manual-A-new/manual-scroll --video
```

分析器以正文区域内高对比水平边缘比例低于 0.05% 筛选候选，不能替代人工查看。本次三轮完成回放并清理隔离进程；采样在屏外 Electron 中进行，输入并非真实 macOS 触控板惯性手势，采样本身也可能影响时序。因此已经确认一种可重复的正文闪烁，但尚不能断言涵盖用户遇到的所有闪烁。
