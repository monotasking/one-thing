# 更正：正在输出思考时滚动的闪烁复现

## 结论

**重新限定场景后，两轮均捕获到：思考仍在追加时，滚动导致正文整片短暂空白再恢复。** 这次记录了输入的思考增量、页面实际思考字数和位置，确认不是结束后的静态内容滚动。

上一轮主要展示翻历史内容，且混入了思考结束、工具参数继续输出的阶段。我把“任务还在进行”当作场景成立的充分证据，结论过早；原记录已标注更正。

## 新录像

下面只展示首段思考的第 4～16 秒；空白约在视频第 **8.15 秒**（回放第 12.15 秒）：

![思考持续输出中滚动的录像](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-current-0916/manual-scroll/reproduction.mp4)

[空白前](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-current-0916/manual-scroll/00297.jpg) → [空白](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-current-0916/manual-scroll/00298.jpg) → [恢复](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-current-0916/manual-scroll/00299.jpg)。

[第二轮录像](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-repeat-0916/manual-scroll/reproduction.mp4) 同样在约第 8.16 秒捕获空白，已人工查看原图。

## 如何确认此时仍在思考流式输出

原始事件中，首段思考在第 **1.451～16.783 秒**输出，之后才转为正文和工具输入。新实验仅回放这段思考中的事件，未进入后续阶段。

第一轮第 12.15 秒空白附近，页面中同一思考段的实际字数：

| 相对空白时间 | 已渲染思考字数 |
| --- | ---: |
| 约前 102ms | 6589 |
| 约前 2ms | 6639 |
| 约后 96ms | 6715 |
| 约后 247ms | 6817 |

空白捕获时，最近一次 `reasoning-delta` 距离约 40ms；附近 DOM 采样中，正在增长的思考段顶部 -976.8px、底部 1768.1px，覆盖聊天可视区。因此这张证据不是只在查看已完成的历史回复。

第二轮同样在第 12.16 秒捕获，最近思考增量距画面约 33ms，当前思考段也覆盖可视区。DOM 与画面采样相差约 2ms，并非严格同一时刻。

## 触发条件与范围

保持真实思考事件原节奏，先小幅上下滚动；第 11 秒较快上翻，第 12 秒连续向下滚动（每次 1600 CSS px、4 次、间隔 70ms）。本次明确空白发生在较快向下滚回正在输出的思考段时。

| 运行 | 画面采样数 | 空白候选 |
| --- | ---: | --- |
| 当前实现第一轮 | 387 | 2 张，12.06s、12.15s |
| 当前实现第二轮 | 365 | 1 张，12.16s |

第一轮 12.06s 时当前思考刚进入视口，仍混有历史内容，因此主要采用 **12.15s 的画面**作为本场景证据。较轻滚动未捕获整片空白，尚不能据此排除其他幅度或触控板手势下的闪烁。

第一轮两张空白附近 ±80ms 没有自动贴底调用，滚动判断处于浏览状态。具体根因尚未确认，本轮只纠正和收紧复现场景，没有再修改产品行为。

新场景尚未做恢复旧行为的对照，**不能沿用旧场景的结论，判断是否由上一轮修复引入。** 下一步应在这个限定窗口内做单变量对照。

## 原始证据及复跑

- [第一轮分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-current-0916/manual-scroll/analysis.json)、[第一轮逐帧状态和输入](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-current-0916/manual-scroll/trace.json)
- [第二轮分析](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-repeat-0916/manual-scroll/analysis.json)、[第二轮逐帧状态和输入](/Users/yitiansong/data/code/start-electron/output/follow-aba/thinking-scroll-repeat-0916/manual-scroll/trace.json)

在 `apps/desktop-react` 下运行：

```sh
node scripts/probe-follow-recorded.mjs --thinking-scroll --label=thinking-new
python3 scripts/analyze-manual-follow.py ../../output/follow-aba/thinking-new/manual-scroll --video --video-window 4 16
```

使用隔离 Electron、原会话事件只读回放、浏览器 wheel 输入；不是实际模型在线生成或真实触控板输入。录像按原始采样时间组织，未覆盖每个显示帧；字数增长是流式阶段的直接证据，不能仅用任务状态或回放脚本的 `done` 字段判断。完整回放测试结束只是停止采样，不代表原始会话在该时刻结束。
