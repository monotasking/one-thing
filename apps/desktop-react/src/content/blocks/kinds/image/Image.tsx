import { useState, type CSSProperties } from 'react'
import { useT, type TFn } from '../../../../i18n'
import { Button } from '../../../../ui/Button'
import { Image as ImageGlyph } from '../../../../components/icons'
import type { BlockModel } from '../../../model/blocks'
import type { BlockCtx } from '../../registry'
import { resolveAssetRef } from '../../asset/resolve'
import { allowHost } from '../../asset/remote-policy'
import { knownSize, rememberSize } from '../../asset/dimensions'
import { useMediaImage } from '../../../../data/media-image'
import { displayAlt } from './alt'
import s from './Image.module.css'

type ImageModel = Extract<BlockModel, { kind: 'image' }>

/**
 * 图片块的本体 —— 檐由壳画(见 index.ts 的 chrome 声明)。
 *
 * ── 六种状态,三处诚实态落同一个形 ────────────────────────────────────
 *  · gated(远程未放行)→ 占位卡:图形字 + alt + 宿主 + 一颗「加载图片」
 *  · unresolvable       → 一行诚实态,**不挂 `<img>`**(挂了也只是等一个必然的失败)
 *  · loading            → 占位盒(尺寸表命中按 aspect-ratio,未命中按最小高),img 已挂
 *  · ready              → 图居中,自然尺寸不放大
 *  · error(onError)    → 一行诚实态「这张图没加载出来」+ 地址
 *  · 超量               → 一条消息几十张图各自 gated / 占位,不预取、不并发解码
 * 三处诚实态与 figure 的失败行同形(text-3 + mono),**不是 danger**:一张图没出来
 * 是内容的小意外,红色警报会把注意力从这条消息本身抢走。
 *
 * ── 媒体库图(`media://`,G 线 P5-a §23.3)─────────────────────────────
 * 字节不在地址里,要经 RPC 取(`useMediaImage`)。它走的仍是上面那几格:取的路上 =
 * loading(占位盒照旧,只是 `<img>` 还没挂 —— 没有 src 可挂);取到 = 同一个
 * `LoadedImage`;取不到(没有这个文件 / 没有权 / 连不上)= 「这张图没加载出来」
 * 那一行。尺寸表按 **`ref.url`** 记,不按 src:src 是一串几 MB 的 data URL,
 * 拿它当 Map 键是自找的,而 `media://<id><ext>` 本身就唯一指一个文件。
 *
 * ── 为什么解析结果不进 state ──────────────────────────────────────────
 * `resolveAssetRef` 是同步纯函数,每次渲染现算 —— 放进 state 就得维护「地址变了要
 * 重算」「放行表变了要重算」两条同步,而它们正是两处会忘的地方。state 里只留两件
 * **这次加载**才知道的事:加载完没有、失败没有。
 */
export function BlockImage({ model, ctx }: { model: ImageModel; ctx: BlockCtx }) {
  const t = useT()
  // 点「加载图片」改的是模块级放行表(远程政策只能有一处),组件这边只要一个重画信号。
  const [, bump] = useState(0)
  const resolution = resolveAssetRef(model.ref, { baseDir: ctx.baseDir })
  const src = resolution.status === 'ready' ? resolution.src : undefined
  // hook 不许条件调用:不是媒体库图就传 undefined,它什么都不读。
  const media = useMediaImage(resolution.status === 'media' ? resolution.fileName : undefined)
  const alt = displayAlt(model.alt)

  if (resolution.status === 'gated') {
    return (
      <div className={s.gate}>
        <ImageGlyph className={s.gateGlyph} strokeWidth={1.75} aria-hidden="true" />
        {alt && <span className={s.gateAlt}>{alt}</span>}
        <span className={s.gateHost}>{t('block.image.remote', { host: resolution.host })}</span>
        <Button
          onClick={() => {
            allowHost(resolution.host)
            bump((n) => n + 1)
          }}
        >
          {t('block.image.load')}
        </Button>
      </div>
    )
  }

  if (resolution.status === 'unresolvable') {
    return (
      <HonestLine
        t={t}
        alt={alt}
        address={model.ref.url}
        messageKey={resolution.reason === 'no-base' ? 'block.image.noBase' : 'block.image.badScheme'}
      />
    )
  }

  if (resolution.status === 'media') {
    if (media.status === 'unavailable') {
      return <HonestLine t={t} alt={alt} address={model.ref.url} messageKey="block.image.loadFailed" />
    }
    /*
     * key 用 `ref.url`:取的路上(src 缺席)与取到之后是**同一次挂载** —— 占位盒不换
     * 节点,`<img>` 在同一个框里长出来,中间没有一帧拆掉重建的空档。
     */
    return <LoadedImage key={model.ref.url} t={t} src={media.src} sizeKey={model.ref.url} alt={alt} address={model.ref.url} />
  }

  return <LoadedImage key={src} t={t} src={src ?? ''} sizeKey={src ?? ''} alt={alt} address={model.ref.url} />
}

/**
 * 真正挂 `<img>` 的那一层。
 *
 * 拆出来是为了让「换了一张图 = 换一次加载」由 **key** 说了算,而不是由一条
 * 「src 变了就把两个 state 清掉」的 effect 说了算 —— 后者要跑在渲染之后,中间那一帧
 * 屏幕上是上一张图的 loaded 态配新的 src(闪一下旧尺寸)。key 换 = 重挂 = 状态本来
 * 就是新的,没有中间帧。
 */
function LoadedImage({
  t,
  src,
  sizeKey,
  alt,
  address,
}: {
  t: TFn
  /** 缺席 = 字节还在路上(媒体库图):占位盒照画,`<img>` 先不挂。 */
  src: string | undefined
  /** 尺寸表的键:远程 / 本地按解析后的 src,媒体库图按 `ref.url`(见组件头注)。 */
  sizeKey: string
  alt: string
  address: string
}) {
  /*
   * **尺寸表不参与这一格**:记得住这张图多大,说的是「占位该多高」,不是「它已经
   * 在屏幕上了」。把它当成 loaded 就等于第二次挂载时不占位 —— 而第二次起零位移
   * 正是那张表存在的全部理由(读它的是下面那个 `size`)。
   */
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  if (failed) {
    return <HonestLine t={t} alt={alt} address={address} messageKey="block.image.loadFailed" />
  }

  const size = knownSize(sizeKey)
  const reserving = !loaded
  /*
   * 占位盒的两档(正本 §2 的尺寸表兑现):记得住多大就按 `aspect-ratio` 占,记不住
   * 就占一个最小高。**第二次起零位移**靠的正是前一档 —— 第一次仍有一次位移,
   * 那是「没有元数据产地」的诚实代价,记在正本 §7 留账里。
   */
  const style =
    reserving && size
      ? ({ '--img-ratio': `${size.w} / ${size.h}`, '--img-w': `${size.w}px` } as CSSProperties)
      : undefined

  return (
    <div className={s.canvas}>
      <div
        className={s.frame}
        data-testid="block-image-frame"
        data-reserve={reserving ? (size ? 'sized' : 'blank') : undefined}
        style={style}
      >
        {src !== undefined && (
          <img
            className={s.image}
            data-testid="block-image"
            data-state={loaded ? 'ready' : 'loading'}
            src={src}
            alt={alt}
            onLoad={(e) => {
              // 自然尺寸只有加载完才知道 —— 这一下就是尺寸表唯一的产地。
              rememberSize(sizeKey, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
              setLoaded(true)
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * 一行诚实态:说一句人话,后面跟着**作者写的那个地址**(mono,长地址整段换行)。
 *
 * 地址是**事实不是文案**,所以它不进字典;alt 是作者写的字,同理。这一行不画
 * `<img>`,也不画一个破图标 —— 屏幕上那个小破图是浏览器在说「我取不到」,
 * 而我们已经知道为什么取不到了,把原因说出来比让它糊在那儿强。
 */
function HonestLine({
  t,
  alt,
  address,
  messageKey,
}: {
  t: TFn
  alt: string
  address: string
  messageKey: 'block.image.noBase' | 'block.image.badScheme' | 'block.image.loadFailed'
}) {
  return (
    <span className={s.failureLine} role="note">
      {alt && <span className={s.failureAlt}>{alt}</span>}
      {t(messageKey)}
      <span className={s.failureReason}>{address}</span>
    </span>
  )
}
