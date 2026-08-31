# CLAUDE.md — React 壳(apps/desktop-react)施工规范

对本目录动手前必读。这里沉淀的是**真机踩过的坑立成的法**,每条都有事故背书;违反即不过审。

## 验收四轴(每批交付必须自证,缺轴打回)

1. **Token 纪律**:组件文件零字面色值/px/ms,一切量入 `src/styles/tokens.css` 对应节(唯一例外:`--fb-*` 品牌色数据节,官方色是数据);状态色只上图标/点,永不换底;焦点一律走全局 `:focus-visible` 环(outline 形,`--focus-ring-w`+`--accent-ring`),**禁裸删 outline**。
2. **无障碍**(规范:`docs/design/react-shell-a11y-2026-08.md`):jsx-a11y 零违例;新 surface 必须追加进 `scripts/gate-a11y.mjs` 扫描屏;行为件用 `src/ui/a11y/`(focus-trap/roving/live-region),照 WAI-ARIA APG 写,不引库。
3. **交互稳定性四律**(规范:`docs/design/react-shell-2026-08.md` §8;根治原语在 `src/data/kernel/`,落地前的手写异步须注释标「临时手写」):
   - 写操作**就地更新**,重拉后台对账,禁「清空→骨架→重灌」;
   - 重拉期间**旧内容保留在屏**,骨架只许首载(`phase==='initial'`)画;
   - 异步动作**必有进行中反馈**(按钮自身变文字+disabled;有 kernel 后走 `mutation.pending`/AsyncButton);
   - 列表 key 稳定,禁整树重挂(零重挂断言:前后是同一个 DOM 节点)。
   - 病型速查:A=重拉清屏骨架闪;B=全局忙布尔把整面禁灰(粒度病);C=整份写回换行身份;E=过快往返的无意义图标闪。诊断工单见提交 495e5146。
4. **状态完备性**:交互组件过状态清单——rest/hover/focus/pending/success/error/empty/**超量**(数据 10×/100× 的形与导航后果:削量、粘头、回顶)。设计稿沉默的状态**照组件规格补齐**,「设计文档里没有」不是 pass 理由。报告带状态清单勾选表。

## 具体禁令与拍板(均有判例)

- **Spinner 只许出现在按钮内或状态栏**;列表/卡的加载态用文字或骨架。
- **复制类反馈就地**(按钮变「已复制」`COPY_FEEDBACK_MS` 后还原 + `announce()` 播报),零 Toast 零通知。
- **禁 native `title=`**,提示一律 `src/ui/Tooltip`;组件库有的件对应交互必须消费(组件消费义务)。
- **禁无上下文缩写**(「Caps/V/T/R」判例):能力类用图标+Tooltip 全名。
- 计数禁令:tab/列表/组头不挂计数徽;文字读数(「已选 2/5」)可以。
- 挤压纪律(`docs/design/react-shell-squeeze-rules-2026-08.md`):一行一个弯腰件、结构行只截断不换行、声明最小宽度下零重叠;表头与数据行 **grid 模板单产地**。
- 浮层/抽屉列表必有最大高度约束 + 选中项 scrollIntoView。
- i18n 双语成对(zh/en 同批),写字典前**现读全文精确锚点插**(多批并行);风险类警告文案(会造成扣钱的)当数据不进字典。
- 动效:`@keyframes` 唯一产地 `src/styles/motion.css`(经 `--kf-*` 表引用);JS 时长唯一镜像 `src/components/motion.ts`;手势/读认窗口(ESC_STOP/COPY_FEEDBACK)不属动画,动效档不清零。
- 树/面常驻铁律:打开查看、切换文件、开关浮层不得卸载重挂兄弟区(文件树判例)。

## 施工纪律

- 多批并行时开工先 `git status` 圈避让区,别批的脏文件一个字不碰;提交由编排者派 haiku 按清单逐个 add,禁 `-A`。
- 同名的门有两半就跑两半:真机门(`gate:squeeze`)与静态棘轮(`squeeze-gate`)判的不是一件事——真机量重叠,棘轮抓源码违例;只跑一半的判例:Dock 批真机绿却把存量豁免块抄进新文件,棘轮红留给了合树收账才发现。
- 反证纪律:每条守卫断言至少真跑一次「拆掉即红」;回滚反证用备份文件,禁 `git checkout`(冲旁改判例)。
- 闪烁/手感类报障禁纸上诊断:真机复现、量出读数(录屏抽帧 diff 是标准手法),修后同法自证。
- 读样式表源文本的门先剥注释(病历文本会让断言自红)。
- 验证不改用户状态:真机走查用隔离 store(照 gate 脚本起法),绝不连 `~/.onething`。

## 设计协作闭环

- 设计系统经 design-sync 同步(config 在 `.design-sync/`);**本文件的规范摘要同步进设计系统的 conventions**,让 claude design 出稿时自带状态/交互要求——设计稿仍沉默的状态,按第 4 轴在实现侧补齐并回灌 conventions。
- 设计稿与壳既有定稿冲突时(如引用块画左线 vs quote-C 大引号定稿),**以壳的已拍定稿为准**,出入记档回报。
