import type { BlockModel } from '../../../model/blocks'
import { registerBlock } from '../../registry'
import { resolveAssetRef } from '../../asset/resolve'
import { knownSize } from '../../asset/dimensions'
import { BlockImage } from './Image'

type ImageModel = Extract<BlockModel, { kind: 'image' }>

/**
 * 注册:独占一段的图是 **object**,檐按图卡那一套 —— 左端身份词 + 一格 meta,
 * 右端只露一颗「放大」(`frontActions: 1`),「查看源码」收进 ⋯。
 *
 * ── 五问逐条 ──────────────────────────────────────────────────────────
 *  · `midway: 'hold'` / `settled: 'swap'`:`![alt](https://exam` 半截时 micromark
 *    把它当文字,段落照 `grow` 一行行长;右括号到了那一刻这一段原位换装成图块 ——
 *    换 kind = 换身份号 = 重挂,正是 swap 的语义。与 figure 由 `code(closed:false)`
 *    代画同构,只是这里代画的是段落。
 *  · `failure: 'honest'`:图块自己**就是**失败态的归宿(取不到地址、加载不出来都在
 *    组件里说人话),不落 source-fallback —— 它的「源码」只有一行,把那一行当一块
 *    带复制钮的代码摆出来比直接说「这张图没加载出来」糟。
 *  · `identity: 'origin'`:`ref` 那一档今天没有消费者,而同一张图在一条消息里出现
 *    两次时按内容发号会撞键。账本图片(P2)再谈。
 *  · `geometry: 'reserve'`:内容后到 —— 壳给 `scrollbar-gutter` 那几条,真正的占位
 *    由块自己的 aspect-ratio 盒完成(尺寸表,blocks/asset/dimensions.ts)。
 *
 * ── 檐上那两格与 `download` 为什么不在 ────────────────────────────────
 * `id` 是身份词 `image`;`meta` 是**宿主名(远程)或文件名(本地)** —— 一眼看得出
 * 这张图从哪儿来,而这两样都从地址本身读得出,不必等加载。`download` 本批不接:
 * 执行器只认 SVG→PNG(shell/export-png.ts),位图下载要给它一个 href 取件口,
 * 那是正本 §6 的 P4。
 */
registerBlock({
  kind: 'image',
  presentation: 'object',
  stream: { midway: 'hold', settled: 'swap', failure: 'honest', identity: 'origin', geometry: 'reserve' },
  Component: BlockImage,
  chrome: (model) => ({ id: 'image', meta: imageMeta(model) }),
  frontActions: 1,
  actions: (model, ctx) => [
    {
      verb: 'zoom',
      /*
       * 取件口:**解析得开 ∧ 已经加载过**才交得出东西。「加载过」的判据是尺寸表
       * 命中 —— 那张表只有 `onLoad` 写得进去,所以它同时也是「这张图真的到过屏幕上」
       * 的凭据。没加载完就点:取件口回 undefined,执行器什么都不做(同 figure 那条
       * 「动作在、内容还没到」的诚实中间态),而不是开一个空浮层。
       */
      image: () => {
        const resolution = resolveAssetRef(model.ref, { baseDir: ctx.baseDir })
        if (resolution.status !== 'ready') return undefined
        if (!knownSize(resolution.src)) return undefined
        return { src: resolution.src, alt: model.alt }
      },
    },
    { verb: 'view-source' },
  ],
}, import.meta.hot)

/**
 * 檐上那格 meta:远程显宿主,本地显文件名。同步、纯 —— 檐画在渲染之前,
 * 这里只看地址这一根字符串,不问放行表、不问加载到哪一步。
 */
function imageMeta(model: ImageModel): string | undefined {
  const url = model.ref.url
  if (/^https?:/i.test(url)) {
    try {
      return new URL(url).host || undefined
    } catch {
      return undefined
    }
  }
  /*
   * 别的 scheme 一律不说 —— `data:` 的「文件名」是一段 base64,`javascript:` 更没有
   * 「来源」可言。檐上宁可空着:它是身份那一格,编不出来就不编(同 diff 檐的
   * `file` 缺席时不画的判词)。`file:` 有真路径,走下面那一支。
   */
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !/^file:/i.test(url)) return undefined
  const name = url.split(/[?#]/)[0]?.split('/').filter(Boolean).pop()
  return name || undefined
}
