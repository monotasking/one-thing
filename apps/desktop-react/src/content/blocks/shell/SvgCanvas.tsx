import { useEffect, useRef } from 'react'

/**
 * 把一段 SVG 原文放进 DOM —— **不经 innerHTML**。
 *
 * 图源码是模型吐出来的任意文本,渲染器(mermaid)把它变成 SVG。哪怕渲染器自己
 * 已经净化过一道(mermaid 在 `securityLevel:'strict'` 下走 DOMPurify),把结果交给
 * `dangerouslySetInnerHTML` 也等于在聊天正文上开一条 HTML 注入路 —— 代码块当初
 * 拒绝 innerHTML 是同一条理由(见 Code.tsx 的 renderLines 注)。
 *
 * 这里走 `DOMParser` + `importNode`:XML 解析出来的 `<script>` 被规范标记为
 * **不可执行**,插进文档也不会跑。于是「显示这张图」和「执行这段图源码里夹带的
 * 东西」被彻底分开,而不是靠上游净化得够干净。
 *
 * 两处用它:图块的本体、放大浮层的大画布 —— 一段 SVG 上屏只该有一个答案。
 */
export function SvgCanvas({ svg, className }: { svg: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    el.replaceChildren()
    const node = parseSvg(svg)
    if (node) el.appendChild(node)
    return () => el.replaceChildren()
  }, [svg])

  return <div ref={host} className={className} />
}

function parseSvg(svg: string): Node | undefined {
  if (typeof DOMParser === 'undefined') return undefined
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  // 解析失败给的是 <parsererror> 树而不是抛错;把它插进去只会显示一段红字。
  if (!root || root.nodeName === 'parsererror' || root.getElementsByTagName('parsererror').length > 0) {
    return undefined
  }
  return document.importNode(root, true)
}
