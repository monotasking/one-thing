import { AppShell } from './components/AppShell'
import { Gallery } from './dev/Gallery'

/**
 * ?gallery 时渲染组件库规格页取代外壳。它是 dev 工具页,不是产品的一条路由 ——
 * 所以判据就一个查询参数,没有 router,也不进 Dock。
 */
export default function App() {
  const gallery =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('gallery')
  return gallery ? <Gallery /> : <AppShell />
}
