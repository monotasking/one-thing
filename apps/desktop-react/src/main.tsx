import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import App from './App'
import { whenConnected } from './platform/connection'
import { useSessionsSource } from './data/sessions-source'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// D0:挂载前先把宿主给的 `{baseUrl, token}` 灌进传输面(浏览器直开时整步跳过)。
// 连不通也照常挂载 —— 外壳不依赖数据面,错误留在 `window.__d0.error` 上,
// 会话侧则在总览里显示「没连上 core」的空态(D1:**不回退 mock**)。
void whenConnected().finally(() => {
  // D1:会话数据源在这里启动一次(拉 listMeta + 订 SSE)。放在挂载之前是因为
  // 它自己是异步的 —— 组件挂上时看到的是 'loading',数据到了自然重渲染。
  void useSessionsSource.getState().start()
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
