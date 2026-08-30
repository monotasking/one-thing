import { describe, expect, it } from 'vitest'
import { prepareSvgForRaster } from '../export-png'

/**
 * PNG 导出的**可测那一半**。
 *
 * 栅格化(Image / canvas / toBlob)是浏览器的活,jsdom 里根本没有 —— 所以导出被
 * 切成两块,全部会出错的判断都在这个纯函数里:尺寸从哪来、命名空间补没补、
 * 序列化对不对。测得到的就是它。真正落一张 PNG 的验收在真机。
 */

const svg = (attrs: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`

describe('prepareSvgForRaster', () => {
  it('显式 width/height 优先,scale 只乘在目标像素上(不改文档里的尺寸)', () => {
    const out = prepareSvgForRaster(svg('width="200" height="100"'), 2)
    expect(out).toMatchObject({ width: 400, height: 200 })
    expect(out?.markup).toContain('width="200"')
    expect(out?.markup).toContain('height="100"')
  })

  it('没有显式尺寸时退到 viewBox —— 否则 Image 会按 300×150 裁掉大半张图', () => {
    expect(prepareSvgForRaster(svg('viewBox="0 0 640 480"'), 1)).toMatchObject({
      width: 640,
      height: 480,
    })
  })

  it('百分比宽度不算显式尺寸(mermaid 常给 100%),照样退到 viewBox', () => {
    expect(prepareSvgForRaster(svg('width="100%" viewBox="0 0 320 240"'), 1)).toMatchObject({
      width: 320,
      height: 240,
    })
  })

  it('px 后缀认', () => {
    expect(prepareSvgForRaster(svg('width="50px" height="25px"'), 1)).toMatchObject({
      width: 50,
      height: 25,
    })
  })

  it('序列化时把尺寸写死进文档 —— Image 只信文档里写着的那份', () => {
    const out = prepareSvgForRaster(svg('viewBox="0 0 640 480"'), 2)
    expect(out?.markup).toContain('width="640"')
    expect(out?.markup).toContain('height="480"')
  })

  it('缺命名空间时补上', () => {
    const out = prepareSvgForRaster('<svg viewBox="0 0 10 10"><rect/></svg>', 1)
    expect(out?.markup).toContain('http://www.w3.org/2000/svg')
  })

  it('尺寸一档都取不到 → undefined(不导出一张错的)', () => {
    expect(prepareSvgForRaster(svg(''), 1)).toBeUndefined()
    expect(prepareSvgForRaster(svg('viewBox="0 0 0 0"'), 1)).toBeUndefined()
  })

  it('不是 SVG / 解析不了 → undefined(解析失败给的是 parsererror 树,不是抛错)', () => {
    expect(prepareSvgForRaster('<div>不是图</div>', 1)).toBeUndefined()
    expect(prepareSvgForRaster('<svg><unclosed>', 1)).toBeUndefined()
    expect(prepareSvgForRaster('', 1)).toBeUndefined()
  })

  it('目标像素至少 1 —— 极小的图不该算出 0×0 的画布', () => {
    expect(prepareSvgForRaster(svg('viewBox="0 0 0.2 0.2"'), 1)).toMatchObject({
      width: 1,
      height: 1,
    })
  })
})
