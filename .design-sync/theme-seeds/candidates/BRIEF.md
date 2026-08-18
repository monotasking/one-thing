# onething 重设计 · 候选方向渲染简报（2026-08-16）

## 背景（必读）
onething 是一个个人 AI 工作台：多模型对话 + Agent 工具调用 + 笔记/待办 + 音乐/练习面板。
桌面 Electron 应用，中文为主。现有 UI 是"账页画线风"（暗底、墨线分区、mono 大写小标、
⟨ WRITE ⟩ 图签框、右对齐 mono 数字、只描边不填色），用户看过后的原话：
「特别不喜欢」「完全不知道这个 UI 在表达什么」「不像一个产品，更像 Demo，甚至不像给人用的」。
用户喜欢的参照：Notion 官网风格（暖纸底 #f6f5f4 + 白卡 + 单一蓝 + 大字号 + 留白）、
Claude Design 的 Organic 系统（奶油底 #f5ead8、陶土 #c67139 + 鼠尾草 #7a8a5e 双强调、
Caprasimo/Figtree、16px 圆角、圆润有趣）。

## 硬性禁令（三个候选共同遵守）
- 不要 mono 大写 tracked kicker 当小节标题；不要 ⟨ ⟩ 图签框；不要"只靠 1px 线分区"；
  不要把整屏文字压在 10–13px；不要用机器语言当界面语言（+128 −41 可以出现在工具卡里，
  但界面标签、分组、按钮要说人话）。
- 对话是主角：用户消息、AI 回复要有真正的可读性（15–16px 正文、行高 1.6+）；
  输入框是屏幕上最想让人点的东西，不是一个暗色凹槽。
- 层级要一眼可见：一个真正的大标题、清晰的面（地/卡/浮层）、一个明确的主行动。
- 每个候选写自己的 theme.json 种子（字段沿用 Organic/Classical 的词：palette bg/surface/text/
  accent/accent2、fonts、density、radius、layoutStyle、dividers、buttonStyle、colorUse），
  然后从种子派生 styles.css（色阶、字阶到 display、间距、圆角、阴影、组件层）。

## 场景（三个候选同一场景，便于并排比较；布局允许按方向重排，但要素齐全）
三栏工作台 1400×860：
- 左：品牌、主行动「新会话」、搜索、会话列表（今天：重构会话存储驱动 14:02 [选中] / 壁纸六级分档实现 11:48 /
  插件 UI 锚点审计 09:31 / token 层级自引用排查 08:15；更早：衬线标题的中英配对 周四 / 焦点环双环方案 周二）
- 中：页签 会话/工作区/差异；会话标题「重构会话存储驱动」；用户消息「把 JSONL 的落盘改成按会话分目录，流式写入时追加，不要每次重写整文件。」；
  AI 回复「已经改成追加写。每个会话一个目录，索引单独一份，重放时按 offset 续读，不再全量解析。」
  + 一张工具调用卡（写入了 3 个文件：src/main/store/session-writer.ts +128 −41 / src/main/store/index-shard.ts +64 −0 /
  tests/session-replay.spec.ts 待运行；状态：待确认迁移；耗时 1.2s）+ 回复下的操作（复制/重试/查看差异）+ 底部输入框
- 右：面板「会话存储」（说明：每会话一个 JSONL 目录，流式写入时追加）；用量：目录数 312 / 占用 567 KB / 最近压缩 3 天前；
  保留策略：保留天数 90（超期会话仅删除正文，索引保留）；状态：迁移完成 / 索引重建中 / 2 份校验失败

## 交付（每个候选一个目录 .design-sync/theme-seeds/candidates/<name>/）
theme.json · styles.css · index.html · README.md（Organic 体，≤40 行：mood / Direction / Color / Type / Do·Don't）
截图：用 headless Chrome 渲染到 .playwright-mcp/candidate-<name>.png：
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1400,860 --virtual-time-budget=6000 --screenshot=<abs path png> file://<abs path index.html>
必须用 Read 工具看自己的截图并至少迭代一轮。中文字体：允许 Google Fonts <link>（Noto Sans SC / Noto Serif SC 等）。
