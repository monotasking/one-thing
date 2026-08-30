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
import { startThemeSource } from './theme/theme-source'
import { installCrashHandlers } from './services/crash'
import { startPerfProbe } from './services/perf'
import { getLogger } from './services/log'

const log = getLogger('boot')

// 崩溃捕获与性能探针**在一切之前**装上:它们要能接住启动期的错与首屏的长帧。
// 两个都是幂等的,也都不依赖 core —— 连不上 core 的那条路径同样带着它们。
installCrashHandlers()
startPerfProbe()

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
  // D2:颜色从主题管道来。同样是异步的 —— 变量表到之前,palette.css 的静态值
  // 先顶着(浏览器直开 / 没连上 core 时它就是最终值,见 theme-source 文件头)。
  void startThemeSource()
  log.info('mounting shell')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
