# 教学备注

## 学习进度（2026-09-16）

约定：讲过 ≠ 掌握。只有练习、复述或追问中能正确使用概念的证据，才写入 learning-records 并勾「已掌握」。

建议顺序（与文件编号不同）：0003 函数 → 0001 事件 → **0007 四层地图（本课）** → 0006 启动 → 0002 消息生命周期 → 0005 emit → 0004 embedding。

| 课 | 主题 | 状态 |
| --- | --- | --- |
| 0003 | 函数基础 | 已制作 · 待确认 |
| 0001 | 跟随一个事件 | 已制作 · 待确认 |
| 0007 | 项目四层地图 | 本课 |
| 0006 | 项目启动 | 已制作 · 待确认 |
| 0002 | 一条消息的生命周期 | 已制作 · 待确认 |
| 0005 | emit 如何到达后端 | 已制作 · 待确认 |
| 0004 | embedding 检索 | 已制作 · 待确认 |

- 2026-09-16 新会话：用户重申零基础（无 React / JS / TS / Electron）、精力有限、要求先看全貌再退步学、帮助追踪进度。保留原 MISSION（沿执行流程读懂事件驱动源码）不改；本课用四层地图回答「全貌」。学习约束见 learning-records/0002。制作 lessons/0007-project-map.html 与 reference/project-map.html，新增可复用 layer-map.css。

- 2026-09-11 第 6 课：用户调用 teach 要求梳理项目启动流程。制作 lessons/0006-project-startup.html 与 reference/project-startup.html，复用已有回放/练习组件，新增可复用 startup-map.css。以桌面开发启动、无现成 core 为主线，补充复用 core 与 dev:web 分支；突出窗口出现、HTTP 就绪、React 挂载、数据返回的不同时间点。依据当前源码静态核对，未启动或重启应用。未收到练习或复述证据，不新增已掌握记录。

- 2026-09-11 第 5 课：用户围绕 SessionCommandRoutes.emit 连续追问类型含义、方法含义和实现位置，明确用 teach 要求讲解这块逻辑。制作 lessons/0005-how-emit-reaches-backend.html 与 reference/emit-routing.html；重点是 api[method] 的动态属性、函数生成与调用、客户端请求、后端按 domain/method 查注册表，区分类型与运行时连接。尚无掌握证据，不新增学习结果记录。

- 2026-09-11 用户调用 teach，要求讲解 embedding 的用法。第 4 课以“AI 助手查询使用手册”解释资料入库、问题编码、比较取回及可选生成，承接理解 AI 应用执行流程的既有任务；未更改 MISSION.md。示例不是对 OneThing 当前实现的断言。
- 第 4 课复用 teaching.css、flow-lesson.css/js、teaching-widgets.js，附 reference/embedding.html。数字与排名为人工示意，未执行真实模型。尚无答题或复述证据，不创建“已掌握”的学习记录。

- 2026-09-10 第 2 课：用户明确选择“先建立整体认识，能向别人讲清楚”。按一条消息的生命周期讲解，源码地图供选读，不要求先追踪全部调用。
- 用户补充：“我本身对 nodejs、js 没有那么深的了解”，要求涉及基础概念。后续不假设熟悉函数/对象、回调、Promise/async/await、事件订阅、React 状态与 Node.js 运行环境；每个概念先用中文解释，再放回项目步骤。
- 第 2 课 lessons/0002-message-lifecycle.html 复用既有 teaching.css 和 teaching-widgets.js，新增通用 flow-lesson 回放组件与 reference/message-lifecycle.html 速查页。
- 尚未收到第 2 课答题或复述结果；不能记录为已掌握。自述基础信息记录在 learning-records，供后续调整教学起点。

- 用户原话：“他们不是一条线，我不能根据流程一步一步直接看出来他是怎么做的。”又明确指出事件驱动架构提高了源码阅读难度。
- 优先展示执行路线、数据变化、当前执行行；每次只展开一个隐藏连接。
- 第一课目标：区分登记与触发，并找到真实源码中的接收函数。已有用户学习动机，不需再追问为何学习。
- 2026-09-10 创建 lessons/0001-follow-an-event.html 和共享组件、速查表。
- 用户随后明确自述 JavaScript、Node.js 基础有限。详见 learning-records/0001-js-node-prerequisites.md；这不是任何概念已掌握的证据。
- 网页练习反馈只在页面内产生，不自动回传聊天或写入学习记录。用户可将两题结果和卡住的步骤发给教师。
- 后续可先用一道不展示提示的新例子检查保留情况，再决定是否讲取消订阅、多个订阅者或跨进程边界。
- 新的教学约束：先解释 JavaScript 与运行环境的区别；函数定义、参数、函数值、函数调用等不可默认已知。正文出现新语法时就地解释，不要仅扔术语表。
- 先读补充课 lessons/0003-function-before-events.html（编号按文件创建顺序，学习顺序在事件课之前），再返回 0001。复用已有 flow-lesson 和 teaching-widgets 组件。
