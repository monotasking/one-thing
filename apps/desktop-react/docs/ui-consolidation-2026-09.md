# 组件收敛战役(2026-09)

用户令(09-01):存量手写 UI 全部收敛到 `src/ui/` 组件库,迁移=等价替换,前后真机逐态对照;战役期间不开新功能批。本文档是战役的唯一作战图;执行协议见 `apps/desktop-react/CLAUDE.md` 施工纪律区「基础件先行」与「组件收敛战役纪律」两条。

## 一、普查结论(09-01,全文 scratchpad/ui-census.md)

- 走库占比:全口径 **35.4%**(120 走库/219 自写);剔除「库里没这件」的 77 处后 45.8%;文件级 44.7%。
- **决定性事实:有门的品类 100% 合规,没门的 20~45%**——spinner/动效(gate:motion)与 tab/分段器业务面零自写;button/tooltip/键盘列表无门,过半自写。采用率的自变量是门,不是文档。
- 最健康:toast 单一产地 `services/notify.ts`;点外关 100% 走库。
- 最重灾:卡/行配方(`:hover{bg}` 48 处 25 文件,圆角+描边 43 块)= hover 屡犯判例的量化病根;tooltip 原生 `title=` 11 处(有专条禁令仍犯);徽章两套六态色表并存。
- 组件库在给自己的样例台供货:Gallery 是 Radio/AsyncButton/Checkbox/Splitter/Badge/Toast/Tabs/Select/Switch/Tooltip/IconButton 的主要(常是唯一)消费者;Radio/roving 业务面零消费(hover-intent 当时的唯一消费者是 Dock 预览泡,09-02 随泡一起删)。

## 二、库缺口(12 件,按解锁量排序)

ListRow(48 处) → Card(43) → ScrollArea(25,顺修 4 处漏 overscroll-behavior 的滚动链穿透真缺陷) → EmptyState(8) → StatusDot(合并两套色表) → Chip(8) → TruncatedText(6) → Combobox/ListBox(5 面) → Textarea(1) → Overlay+escape-chain 收编(7 面) → Skeleton → InlineNotice(可选)。

每件入库门槛(CLAUDE.md 战役纪律条):规格写全并测全三类状态——**生命状态**(挂载/首载延迟/卸载时序)、**交互状态**(rest/hover/focus/active/disabled/pending)、**页面与数据状态**(empty/loading/error/超量)。缺一类不许入库。

## 三、执行协议(每批相同)

1. 开工:`git status` 圈避让区;读本文件+CLAUDE.md。
2. 缺件先立件(带 JSDoc 指回规范画布对应板+三类状态测试),再迁移消费。
3. **迁移=等价替换**:迁前逐态真机截图(rest/hover/focus/pending/empty/error)→迁后同法→像素 diff;差异必须为零或是**列明的规范修正**(逐条报),意外漂移=打回。
4. 探针纪律:CDP 注入不动真光标;隔离 store;退出收尸零残留。
5. 测试:相关单测+反证(拆掉即红,备份回滚)+`ui:consume` 基线下降数。
6. 交编排者 review→haiku/编排者提交(逐文件清单,禁 -A,共享文件注明归属)。

## 四、分批表(9 批;√=已完成)

| 批 | 内容 | 状态 |
|---|---|---|
| 0 | **立门** `ui:consume`(9 条规则+基线,棘轮) | 在飞(select 批,含 hover≠active 原语 list-selection 与 88 处裸钮三类归档) |
| 1 | 纯净三件:EmptyState/Skeleton/ScrollArea(零历史包袱)+4 处 overscroll 真缺陷 | 待派 |
| 2 | 配方三件:ListRow/Card/StatusDot(48+43 处病根) | 待派 |
| 3 | tooltip 面:TruncatedText+迁 11 处原生 title(DockPreview 那一问 09-02 作废:用户裁定预览泡整个退役,已连同 hover-intent / 瞄准区 / 回身窗口一起删) | 待派 |
| 4 | expose 面(4 文件五品类)——打法最小闭环验证 | 待派 |
| 5 | 键盘列表品类:ListBox/Combobox+迁 SearchPanel/JumpBar/ComposerInput/DrawerModelPicker/ListView(样板 WorkspacePalette) | 待派 |
| 6 | composer 面(13 钮+最重的 Composer.module.css,手感判例密集,须真机 A/B) | 待派 |
| 7 | content 面(32 钮;拆 7a 查看器/7b 内容块;与近期批重叠最深,排最后) | 待派 |
| 8 | 收尾(components 15/workspace 8/providers 2/toc 1),基线降零,**棘轮转硬门** | 待派 |

批间依赖:0 先于一切(没门,每批战果下批就被拷回来);1/2/3 可并行;4 在 2 后;5 在 0 后;6/7 在 2/5 后;8 收口。并行度以共享文件冲突为限,编排者派工时圈避让。

## 五、验收终线

- `ui:consume` 基线 = 0,转硬门进 verify;
- 走库占比(普查口径复测)≥ 90%,余量逐条注理由;
- 每件库件三类状态规格齐 + Gallery 展示 + 至少一个业务面真消费;
- 全量 verify 绿 + 走查子集复验。

## 六、增补区(09-01 审计已并入,全文 docs/ui-design-audit-2026-09-01.md)

**新增批次**(与 §四 的 9 批并行推进):
- **批 A(快赢五件,已派)**:A1 composer 抽屉盖正文 253px 预留跟随高度/A2 unreadOf 排除 silent 一行/A4 四处焦点环换 token/A3 四处自绘搜索框补环吃 ui/Input/C4 token-gate 四条规则(轴 1 补门)。
- **批 B(梯子归一,待派)**:字号 15→11 档合并同值双名/圆角瓦梯归主梯或写理由/间距六游离值/圆点六种收敛(与战役第 2 批 StatusDot 合流)/图标三无名尺寸/按钮高度入梯(与 ListRow/Card 合流)。
- **批 C(面板骨架,C1/C2/C3/C5 拍后)**:檐-体-空态-死区的面规格 + 规格页强制态列。

**拍点存档(等用户)**:
1. A5 状态色染底两种读法:字面「永不换底」全改,还是改写法条为「淡染 ≤15% 且必须同时有点/图标承担」(审计倾向后者)。
2. C1 通知中心 silent 读数:甲 只进日志环/乙 分两区未读只数通知/丙 折叠不计未读(审计与编排均倾向乙)。
3. C2 无会话首屏形:留白+⌘N/入口卡/composer 居中。
4. C3 浮窗定高 vs 贴内容。
5. C5 规格页加强制态列(建议做,确认即派)。
6. 检索底部读数行是否常驻面板下缘(现为列表末条,25 条须滚到底)。
7. 盖层开着时顶 28px 拖拽区被盖(窗口批留账,drag 与点盖底关闭打架)。
8. CGEvent 拖拽三断言待终端辅助功能权限后补跑。
