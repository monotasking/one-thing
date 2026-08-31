import { useEffect, useState } from 'react'
import { useT } from '../../../i18n'
import { registerViewer } from '../registry'
import type { ViewerBodyProps } from '../registry'
import { HonestState } from '../HonestState'
import s from '../FileViewer.module.css'

/**
 * **media 型(视频 / 音频)—— F2 从「示例档」转正**。
 *
 * F1 把它标成示例档,只证明「注册一个新型只要写一个处理器」这件事;F2 把它当
 * 一个真的型来交:音频画一条**紧凑播放条**、视频画一个**原生受控播放器**,
 * 取不到字节时落**诚实态**(F1 那条留账在这里结清)。
 *
 * ── 仍然不自绘控制条,这是取舍不是省事 ────────────────────────────────────
 * 原生 `controls` 给的是这台系统自己的播放条:进度、音量、倍速、画中画、
 * AirPlay、键盘操作、读屏标签全都是宿主实现的。自绘一条意味着把这七件事
 * 重做一遍,而且每一件都会比原生差一档。「紧凑」由**布局**兑现(音频那一格
 * 不铺满整块面、居中一行),不是靠重画一条 DOM 播放条。
 *
 * ── 诚实态:取不到字节时说人话(F1 留账结清)──────────────────────────────
 * `file://` 只在打包后的壳(file:// 起源页)上取得到;dev 服务器与浏览器面上
 * Chromium 不许 http 页面读本地文件。图那一型 F1 就有这一格,播放条当时没有 ——
 * 于是那种场合下屏幕上是一个**放不出来的黑框**,比一句实话糟得多。
 * `onError` 落 HonestState,与图那一型逐字同一副画法、同一颗「去 Finder」。
 *
 * ── 字节从哪来 ────────────────────────────────────────────────────────────
 * 与图同一条路:`src` 交给浏览器,一个字节都不读进渲染进程 —— 所以它也不吃
 * 体积闸(判据与理由都在 data/viewer-kinds.ts 那张表的 `direct` 那一格)。
 */
function MediaBody({ file, onReveal }: ViewerBodyProps) {
  const t = useT()
  const [failed, setFailed] = useState(false)
  const src = file.kind === 'media' ? file.src : ''
  // 换一个文件就把「取不到」这件事忘掉 —— 上一个取不到不代表下一个也取不到
  // (与 image 那一型逐字同一条)。
  useEffect(() => setFailed(false), [src])

  if (file.kind !== 'media') return null
  if (failed) {
    return (
      <HonestState
        name={file.name}
        title={t('viewer.mediaFailed')}
        note={file.src}
        onReveal={onReveal}
      />
    )
  }

  return (
    <div
      className={s.mediaArea}
      data-testid="viewer-media"
      data-media={file.audio ? 'audio' : 'video'}
    >
      {file.audio ? (
        /* eslint-disable-next-line jsx-a11y/media-has-caption --
         * 字幕轨是**用户磁盘上那个文件自己的事**:我们没有第二份 .vtt,也不该
         * 凭空造一条空轨去糊弄规则。同理下面那个 <video>。 */
        <audio
          className={`${s.media} ${s.mediaAudio}`}
          src={file.src}
          controls
          onError={() => setFailed(true)}
        />
      ) : (
        /* eslint-disable-next-line jsx-a11y/media-has-caption -- 同上 */
        <video
          className={s.media}
          src={file.src}
          controls
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}

registerViewer({
  id: 'media',
  match: (file) => file.kind === 'media',
  Body: MediaBody,
  // 状态栏左段那句「这是什么」。音频与视频是**事实**不是文案,所以不进字典
  // (与 code 那一型的「语言 · 编码 · 换行符」同一条口径)。
  status: ({ file }) => (file.kind === 'media' ? (file.audio ? 'audio' : 'video') : undefined),
})
