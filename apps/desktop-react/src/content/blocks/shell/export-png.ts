/**
 * SVG → PNG —— **壳能力,一处实现**(§3.3 末段)。
 *
 * 任何图种(今天只有 mermaid,明天 plantuml / vega)只要能交出一段 SVG,就自动
 * 拥有「下载 PNG」;它们各自不写一行导出代码。这条分界和「复制归壳」是同一条:
 * 一件横切的事有两份实现,迟早会长成两种行为(一边有 2× 像素密度、一边没有;
 * 一边带背景、一边透明)。
 *
 * ── 两半:能测的和不能测的 ────────────────────────────────────────────
 * `prepareSvgForRaster` 是**纯函数**(字符串进、字符串出),它承担全部会出错的判断:
 * 尺寸从哪来、命名空间补没补、序列化对不对。栅格化那一半(Image / canvas / toBlob)
 * 是浏览器的活,jsdom 里根本没有 —— 它因此被写成一层薄壳,失败就静默返回,
 * 一个导出没成不该把这块内容炸掉(与剪贴板同一条)。
 */

export interface RasterSvg {
  /** 补齐了命名空间与显式尺寸的 SVG 原文。 */
  markup: string
  /** 栅格化的目标像素尺寸(已乘过 scale)。 */
  width: number
  height: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 为栅格化准备一段 SVG:补命名空间、算出显式像素尺寸。
 *
 * ── 为什么必须显式写死尺寸 ────────────────────────────────────────────
 * `new Image()` 加载一段 SVG 时,尺寸只能从**文档自己**读:没有 width/height 的
 * SVG 在多数引擎里被当成 300×150(CSS 的替换元素默认尺寸),画出来的 PNG 就是
 * 一张裁掉了大半的图。所以尺寸按三档取:显式属性 → viewBox → 认输(返回
 * undefined,调用方不导出,而不是导出一张错的)。
 *
 * `scale` 是像素密度:2 是常见屏的 1:1,图贴进文档里不糊。
 */
export function prepareSvgForRaster(svg: string, scale = 2): RasterSvg | undefined {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return undefined

  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  // 解析失败时浏览器给的是一棵 <parsererror> 树,不是抛错 —— 得自己认。
  if (!root || root.nodeName === 'parsererror' || root.getElementsByTagName('parsererror').length > 0) {
    return undefined
  }
  if (root.localName !== 'svg') return undefined

  const box = readSize(root)
  if (!box) return undefined

  // 序列化前把尺寸写死:Image 只信文档里写着的那份。
  root.setAttribute('width', String(box.width))
  root.setAttribute('height', String(box.height))
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS)

  return {
    markup: new XMLSerializer().serializeToString(root),
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
  }
}

/** 尺寸三档:显式属性 → viewBox → 没有。百分比宽度(mermaid 常给 `100%`)不算显式。 */
function readSize(root: Element): { width: number; height: number } | undefined {
  const w = cssPixels(root.getAttribute('width'))
  const h = cssPixels(root.getAttribute('height'))
  if (w && h) return { width: w, height: h }

  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every((n) => Number.isFinite(n))) {
    const [, , vw, vh] = viewBox
    if (vw > 0 && vh > 0) return { width: vw, height: vh }
  }
  return undefined
}

function cssPixels(value: string | null): number | undefined {
  if (!value) return undefined
  const match = /^\s*([\d.]+)(px)?\s*$/.exec(value)
  const n = match ? Number(match[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 导出并交给浏览器下载。
 *
 * 全程 blob URL,不走 data: —— 大图的 base64 会把内存翻一倍,而且 Chromium 对
 * data: 下载有长度上限。用完当场 revoke:导出是一次性动作,留着的 URL 是内存借条。
 */
export async function exportSvgAsPng(svg: string, filename: string, scale = 2): Promise<void> {
  const prepared = prepareSvgForRaster(svg, scale)
  if (!prepared || typeof document === 'undefined' || typeof Image === 'undefined') return

  try {
    const blob = await rasterize(prepared)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename.endsWith('.png') ? filename : `${filename}.png`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch {
    // 一次导出没成不该炸掉这块内容 —— 与剪贴板同一条。真要给反馈是 Toast 的事。
  }
}

function rasterize({ markup, width, height }: RasterSvg): Promise<Blob | null> {
  return new Promise((resolve) => {
    const source = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(source)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(image, 0, 0, width, height)
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    }
    image.onerror = () => {
      URL.revokeObjectURL(source)
      resolve(null)
    }
    image.src = source
  })
}
