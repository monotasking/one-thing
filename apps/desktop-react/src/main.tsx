import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import App from './App'
import { whenConnected } from './platform/connection'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// D0:挂载前先把宿主给的 `{baseUrl, token}` 灌进传输面(浏览器直开时整步跳过)。
// 连不通也照常挂载 —— mock UI 不依赖数据面,错误留在 `window.__d0.error` 上。
void whenConnected().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
