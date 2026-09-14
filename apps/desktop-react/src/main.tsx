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
import { restoreThemeSnapshot, startThemeSource } from './theme/theme-source'
import { startShellResources } from './resources/shell-host'
import { startReadingAxes } from './reading/apply'
import { startWorkspaceApply } from './workspace/apply'
import { startPerSpaceLayout } from './workspace/layout-scope'
// 内容种类的注册 barrel。**必须排在 startWorkbench() 之前** —— 播种(出厂那片
// 聊天叶)与「未知种类剔除」两件事都要读这张表。它不在 workbench/store 里 import,
// 理由是那会造一条 import 环(病历在那只文件头上)。
import './content/kinds'
/*
 * **引用种类的注册 barrel**(09-12)。import 它**就是**「这台上认得哪几种引用」
 * —— 文件 / 目录 / 命令 / 技能 / 插件 / 提示词 / 网页。抽屉、草稿出口、气泡三处
 * 都会自己再 import 一次(「谁要查表,谁负责保证表是装好的」),这一行管的是
 * **第一帧**:composer 与消息列表挂载之前表就该是满的。
 */
import './references'
/*
 * **启动瓦的注册**(W6-a,`stage/launchers.ts`)。与上面那张表逐字同一个体例:
 * import 它**就是**「这台上哪几块瓦是启动瓦」。今天四块(目录 / 终端 / 浏览器 / 改动)。
 * 它排在这里而不是 `stage/store` 里,理由与内容种类那一句相同 —— 那会造一条
 * import 环(`stage/store` → 这只 → `workbench/store` → …)。
 */
import './content/files-launcher'
/* T1:「终端」那块瓦也是启动瓦(方案 §2.1-6)。 */
import './content/terminal-launcher'
import './content/browser-launcher'
/* 「改动」面:那块瓦也是启动瓦(正本 `docs/changes-panel-2026-09.md` §3.2)。 */
import './content/diff-launcher'
import { startWorkbench } from './workbench/store'
import { startStage } from './stage/store'
import { startSessionProjection } from './content/session-projection'
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

// 颜色同理,而且它是这几条里最刺眼的一条:主题表从前只能等连上 core、问完设置
// 与系统明暗、再等 themes.apply 整趟回来才贴,真店上半秒的暖纸闪成 one-light。
// 这一句读的是 localStorage 里**上一次 apply 成功的那张表**,不经过 core,贴在
// createRoot 之前 —— 首帧就是最终色。没快照(从没连上过 core 的 origin)什么都不
// 做,palette.css 的静态值照旧顶着。连通之后 startThemeSource() 照常真 apply 一次
// 做校正:快照只贴像素、不记判据(判词在 theme/theme-source.ts 文件头)。
restoreThemeSnapshot()

// 家具跟着工作区走(T-W1)。同样在 createRoot 之前,同样一个字节的网都不碰 ——
// 五个面的家具账全在 localStorage 里,它们的**首帧**已经由各自 persist 的 merge
// 摊开了(那是同步的);这一步接的是**此后的切换**。
//
// 为什么是在这里显式接、而不是各 store 自己在模块作用域里接:那样会撞上这台壳
// 既有的 import 环(stage/store → stage/items → stage/types → i18n → stage/store),
// 真机上表现为启动即 TDZ 崩溃。病历与判据写在 workspace/layout-scope.ts 文件头。
startPerSpaceLayout()

// 拼贴台播种 + 洗一遍存量档案(W1)。同样在 createRoot 之前、同样一个字节的网都
// 不碰:树在 localStorage 里,它的**首帧**已经由 persist 的 merge 摊开了;
// 这一步补的是「种类表此刻才装好」那一半 —— 出厂那片聊天叶、以及存量档案里
// 认不得的种类的剔除。幂等。
// 形态机接线(W4)。**排在 startWorkbench 之前**:它先把存量家具(架子 tab /
// 浮窗)折进树,`startWorkbench()` 那一遍洗存量才洗得到它们;再接上「树 → 形态机
// 那三格」的投影(判词在 stage/residency.ts 文件头)。同样一个字节的网都不碰。
// 为什么是显式一句而不是模块副作用:这只文件里那条存量 import 环会让模块作用域
// 里的接线读到 TDZ(病历写在 stage/store.ts 末尾那段与 workspace/layout-scope.ts)。
startStage()

startWorkbench()

// 「当前会话」那条投影(W5-b):树 → `expose.currentSessionId` / `envSessionId`
// + 聊天数据机器那本引用账。**排在 `startWorkbench()` 之后**:它开工那一刻要读
// 一棵已经播过种的树。同样一个字节的网都不碰;幂等。判词在
// `content/session-projection.ts`(接线为什么不在模块作用域里,那儿也写着)。
startSessionProjection()

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
  /*
   * **这扇壳把自己交给 core**(原子 K2b-2b,`docs/design/atom-2026-09.md` §5 /
   * §10.2)。它排在这里而不是模块作用域里,理由与上面几条逐字相同:登记要一个
   * 连通之后才存在的客户端。**幂等**;连不上 / 登记被拒都不挡任何事 —— 那时这台
   * 壳照常用,只是 core 那边没有 `workbench` 这个命名空间(AI 开不了面板,别的
   * 一切照旧)。拆卸(含 HMR)在 `resources/shell-host.ts` 自己那一段。
   */
  startShellResources()
  // 工作区列表同理:连通之后拉一次。拉不到不挡任何事 —— 瓦面退成兜底图标,
  // 总览上一句「读不到」加后端原话(与 agent 名册那条同一口径)。
  // **当前是哪个工作区**不在这一步:它读的是 localStorage,上面 startWorkspaceApply()
  // 早就贴好了 —— 后端没有「当前空间」这个概念(契约见 data/spaces-port.ts)。
  void useWorkspaceStore.getState().load()
  /*
   * `<StrictMode>` 是**开发构建里才有身体的东西**:模拟卸载 → 再挂载、effect 跑两遍
   * 这些检查全部由 react-dom 的 development 版实现,production 版里它是空操作
   * (S3 结案的反证读数逐字如此)。所以「让门也吃到那一串重挂」不是在这里加一个
   * 开关能办到的事 —— 它是**换一份 react-dom**。那条路走的是构建产物:
   * `npm run app:build:strict` 出一份 `dist-strict/`(development 模式的 `vite build`,
   * 不是 dev server),由 `electron/main.ts` 的 `ONETHING_GATE_DIST` 指过去。
   */
  log.info('mounting shell')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
