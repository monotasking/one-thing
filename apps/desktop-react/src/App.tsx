import { AppShell } from './components/AppShell'
import { Gallery } from './dev/Gallery'
import { MusicLab } from './dev/MusicLab'
import { TodoLab } from './dev/TodoLab'
import { PerfHud, perfHudEnabled } from './dev/PerfHud'

/**
 * ?gallery 时渲染组件库规格页取代外壳。它是 dev 工具页,不是产品的一条路由 ——
 * 所以判据就一个查询参数,没有 router,也不进 Dock。
 *
 * 性能 HUD 同理是 dev 工具,但它是**叠加**而不是取代:开着的时候两种页面上都在。
 * 开关读一次 localStorage(缺省一律关,'1' 显式开),不订阅 —— 改了开关要刷新页面,
 * 这是刻意的:HUD 自己不该为了响应一个排障开关而每次渲染都去读盘。
 */
export default function App() {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined
  const gallery = params?.has('gallery') ?? false
  // ?music-lab:音乐面宽度实验台(假端口喂样本,不碰真 store)。
  const musicLab = params?.has('music-lab') ?? false
  // ?todo-lab:待办编辑器实验台(内存文档 + 一致性自测,不碰真 store)。
  const todoLab = params?.has('todo-lab') ?? false
  return (
    <>
      {todoLab ? <TodoLab /> : musicLab ? <MusicLab /> : gallery ? <Gallery /> : <AppShell />}
      {perfHudEnabled() ? <PerfHud /> : null}
    </>
  )
}
