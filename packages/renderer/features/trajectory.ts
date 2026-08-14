/**
 * 轨迹 feature 的 renderer 半（C2，`docs/design/cordis-adoption-2026-08.md` §2）。
 *
 * 后端半在 `packages/onething-runtime/src/app/features/builtin/trajectory.ts`
 * （一个 cordis plugin，注册 `sessionEvents` RPC 域）；这一半注册它的工作区
 * 面板。两半是**同一件功能的两端**，但接的不是同一个基座 —— 下面这条纪律
 * 就是它们唯一的差别。
 *
 * ── 模块求值即注册（K1 判例，不是疏忽）───────────────────────────────────
 *
 * `@onething/app` 那一层禁止 import 副作用，因为它有一条显式装配序列
 * （`createOnethingBackend`），顺序问题必须留在那一处可读。renderer **没有**
 * 装配序列 —— 组件树自己就是装配，谁先 import 由打包器决定。所以这一层的
 * 正确语义正好相反：**import 到了就一定可用**。
 *
 * 于是 feature 模块必须被**某处**静态 import 才会求值，那个"某处"就是
 * `packages/renderer/features/index.ts` 这份名册，由启动入口 `main.ts`
 * import 一次。这是 K1 留给 K2/C2 的第一个真问题（"谁 import feature 模块"），
 * 答案是名册，不是让注册表反过来 import 各个 feature。
 *
 * ── 与后端半的不对称（差距清单 §6 有条目）─────────────────────────────
 *
 * `registerWorkspacePanel` 返回 disposer，这里**丢掉了**它：模块求值是一次性
 * 的，没人能把这个模块"再求值一遍"，导出一个没人调用的 dispose 只是死代码。
 * 代价如实记：renderer 侧的 feature **没有挂卸语义** —— 后端那半可以
 * `mountFeature` / unmount 往返 200 轮，这半不行。要它可逆需要 renderer 也有
 * 一条装配序列，那是 C4/C5 的事，不在这一期发明。
 */
import { Route } from 'lucide-vue-next'
import TrajectoryPanelContent from '@/components/TrajectoryPanelContent.vue'
import { registerWorkspacePanel } from '@/workspace/panel-registry'
import { TRAJECTORY_OPEN_WORKSPACE_EVENT } from '@/workspace/trajectory-inspect'

registerWorkspacePanel({
  id: 'trajectory',
  label: '轨迹',
  icon: Route,
  inPanelNav: true,
  // 事件名从**拥有它的模块**取，不再在注册表里抄一份字面量：聊天里的工具
  // 卡片够不着 openWorkspacePanel 的 emit 链，只能走 window 事件，而那条
  // 事件的定义位一直在 `trajectory-inspect.ts`。搬家顺手把抄件消掉。
  windowEvent: TRAJECTORY_OPEN_WORKSPACE_EVENT,
  component: TrajectoryPanelContent,
})
