import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 字体在样式之前:@font-face 得先声明,tokens.css 里的 --font-ui 才有东西可指。
// 本地 woff2,不连 fonts.googleapis.com —— 构建产物离线可用(见 assets/fonts/fonts.css)。
import './assets/fonts/fonts.css'
import './styles/global.css'
import App from './App'
import { whenConnected } from './platform/connection'
import { useSessionsSource } from './data/sessions-source'
import { useAgentsSource } from './data/agents-source'
import { useModelsSource } from './data/models-source'
import { useWorkspaceStore } from './workspace/store'
import { startThemeSource } from './theme/theme-source'
import { startReadingAxes } from './reading/apply'
import { startWorkspaceApply } from './workspace/apply'
import { installCrashHandlers } from './services/crash'
import { startPerfProbe } from './services/perf'
import { getLogger } from './services/log'

const log = getLogger('boot')

// 崩溃捕获与性能探针**在一切之前**装上:它们要能接住启动期的错与首屏的长帧。
// 两个都是幂等的,也都不依赖 core —— 连不上 core 的那条路径同样带着它们。
installCrashHandlers()
startPerfProbe()

// 阅读轴(字号 / 密度 / 列宽 / 动效)也在一切之前贴上:它读的是 localStorage,
// **不经过 core**,所以不必等连通 —— 连不上时读者调过的字号照样成立。
// 放在 createRoot 之前是为了首帧就是最终版式:先画一屏 14px 再跳成 16px 是可见的。
startReadingAxes()

// 当前工作区同理:id 与色标读的是 localStorage,不经过 core。贴在 createRoot 之前,
// 首帧的瓦面就是最终的那一格色 —— 先画一格默认紫再跳成用户的蓝同样是可见的。
// 列表本身要等连通(Dock 挂上时 load 一次),那时这条订阅会把真名字的字标补上。
startWorkspaceApply()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// D0:挂载前先把宿主给的 `{baseUrl, token}` 灌进传输面(浏览器直开时整步跳过)。
// 连不通也照常挂载 —— 外壳不依赖数据面,错误留在 `window.__d0.error` 上,
// 会话侧则在总览里显示「没连上 core」的空态(D1:**不回退 mock**)。
void whenConnected().finally(() => {
  // D1:会话数据源在这里启动一次(拉 listMeta + 订 SSE)。放在挂载之前是因为
  // 它自己是异步的 —— 组件挂上时看到的是 'loading',数据到了自然重渲染。
  void useSessionsSource.getState().start()
  // agent 名册同理:连通后拉一次(失败自己重试一次就停)。拉不到不挡任何事 ——
  // 顶栏那枚徽退成「默认助手」,菜单里一行灰字说名册不可用。
  void useAgentsSource.getState().start()
  // 模型侧同理:名册(providers)与设置各拉一次。**模型目录不在这里** ——
  // 它是每家一次 RPC 的东西,抽屉打开时才拉(见 data/models-source.ts 文件头)。
  void useModelsSource.getState().start()
  // D2:颜色从主题管道来。同样是异步的 —— 变量表到之前,palette.css 的静态值
  // 先顶着(浏览器直开 / 没连上 core 时它就是最终值,见 theme-source 文件头)。
  void startThemeSource()
  // 工作区列表同理:连通之后拉一次。拉不到不挡任何事 —— 瓦面退成兜底图标,
  // 总览上一句「读不到」加后端原话(与 agent 名册那条同一口径)。
  // **当前是哪个工作区**不在这一步:它读的是 localStorage,上面 startWorkspaceApply()
  // 早就贴好了 —— 后端没有「当前空间」这个概念(契约见 data/spaces-port.ts)。
  void useWorkspaceStore.getState().load()
  log.info('mounting shell')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
