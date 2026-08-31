import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../i18n'
import { registerViewer } from '../registry'
import type { ViewerBodyProps } from '../registry'
import { HonestState } from '../HonestState'
import { CodeCanvas } from './code'
import s from '../FileViewer.module.css'

/** 缩放的上下限。再小读不出内容,再大就是一屏马赛克 —— 两头都不是「看」了。 */
export const VIEWER_ZOOM_MIN = 0.1
export const VIEWER_ZOOM_MAX = 8
/** 一格滚轮走多少。乘法而不是加法:放大和缩小的手感才对称。 */
const ZOOM_STEP = 1.1

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(VIEWER_ZOOM_MAX, Math.max(VIEWER_ZOOM_MIN, value))
}

/**
 * **image 型** —— 棋盘底 + 滚轮缩放 + 两档(适应 / 1:1);svg 另有「查看源码」。
 *
 * ── 字节从哪来:`<img src="file://…">`,一个字节都不经过这层壳 ──────────────
 * 把一张位图按 utf-8 解码搬进渲染进程,得到的是一串必然乱码的字符 —— 所以图这条
 * 路不读内容(判据在 viewer-source),直接把路径交给浏览器。
 * 代价是它**只在 `file://` 起源的页面上成立**:打包后的壳是,dev 服务器与浏览器
 * 面不是(Chromium 不许 http 页面读本地文件)。取不到时 `onError` 落诚实态并
 * 说出这句话 —— 空白一片才是最坏的那一种。
 *
 * ── 棋盘底是**信息**,不是装饰 ──────────────────────────────────────────
 * 带透明通道的 png / svg 放在纯色底上,分不清「这块是白的」还是「这块是透的」。
 * 棋盘一铺,透明区域自己说话。格子用主题 token 画(两档面色),不落字面色值。
 *
 * ── 滚轮为什么要手接 ────────────────────────────────────────────────────
 * React 的 `onWheel` 在根容器上是**被动**注册的,里面 `preventDefault()` 无效 ——
 * 于是滚轮会一边缩放一边把查看区滚走。所以这里用 ref + `addEventListener`
 * 显式非被动注册。这不是风格问题,是那条 API 的事实。
 */
export function ImageCanvas({
  src,
  name,
  mode,
  scale,
  onScale,
  onReveal,
}: {
  src: string
  name: string
  mode: 'fit' | 'actual'
  scale: number
  onScale: (next: number) => void
  onReveal?: () => void
}) {
  const t = useT()
  const areaRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  // 换一个文件就把「取不到」这件事忘掉 —— 上一张取不到不代表下一张也取不到。
  useEffect(() => setFailed(false), [src])

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      onScale(clampZoom(scale * factor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, onScale])

  if (failed) {
    return (
      <HonestState name={name} title={t('viewer.imageFailed')} note={src} onReveal={onReveal} />
    )
  }

  return (
    <div className={s.imageArea} ref={areaRef} data-testid="viewer-image" data-zoom-mode={mode}>
      <img
        className={mode === 'fit' ? `${s.image} ${s.imageFit}` : s.image}
        src={src}
        alt={name}
        style={{ zoom: scale }}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function ImageBody({ file, view, onView, onReveal }: ViewerBodyProps) {
  if (file.kind !== 'image') return null
  if (view.showSource && file.svgSource !== undefined) {
    return <CodeCanvas source={file.svgSource} lang="html" wrap={view.wrap} />
  }
  return (
    <ImageCanvas
      src={file.src}
      name={file.name}
      mode={view.zoomMode}
      scale={view.scale}
      onScale={(scale) => onView({ scale })}
      onReveal={onReveal}
    />
  )
}

registerViewer({
  id: 'image',
  match: (file) => file.kind === 'image',
  Body: ImageBody,
  status: ({ file, view }) =>
    file.kind === 'image'
      ? [file.svgSource === undefined ? 'image' : 'svg', `${Math.round(view.scale * 100)}%`].join(
          ' · ',
        )
      : undefined,
})
