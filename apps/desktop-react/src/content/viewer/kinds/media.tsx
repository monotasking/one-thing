import { useT } from '../../../i18n'
import { registerViewer } from '../registry'
import type { ViewerBodyProps } from '../registry'
import s from '../FileViewer.module.css'

/**
 * **media 型(视频 / 音频)—— 示例档**。
 *
 * 定稿把它标成「示例档」,这里照实兑现:一个**原生播放器**,深底,没有自绘的
 * 播放条、没有音量记忆、没有画中画。它证明的是「注册一个新型只要写一个处理器」
 * 这件事,不是「这台有一个像样的播放器」。
 *
 * 字节与图同一条路:`file://` 交给浏览器,一个字节都不读进来 —— 于是它也不吃
 * 体积闸(判据与理由都在 data/viewer-kinds.ts)。
 *
 * **留账**:`file://` 起源之外(dev 服务器 / 浏览器面)取不到本地文件,那时
 * 播放器自己画一格「无法播放」。图那一型给了诚实态,这一型没有 —— 示例档不值得
 * 为它铺一条第二路径,记在这里免得被当成漏了。
 */
function MediaBody({ file }: ViewerBodyProps) {
  const t = useT()
  if (file.kind !== 'media') return null
  return (
    <div className={s.mediaArea} data-testid="viewer-media" data-media={file.audio ? 'audio' : 'video'}>
      {file.audio ? (
        /* eslint-disable-next-line jsx-a11y/media-has-caption --
         * 字幕轨是**用户磁盘上那个文件自己的事**:我们没有第二份 .vtt,也不该
         * 凭空造一条空轨去糊弄规则。同理下面那个 <video>。 */
        <audio className={s.media} src={file.src} controls />
      ) : (
        /* eslint-disable-next-line jsx-a11y/media-has-caption -- 同上 */
        <video className={s.media} src={file.src} controls />
      )}
      <p className={s.mediaNote}>{t('viewer.mediaSample')}</p>
    </div>
  )
}

registerViewer({
  id: 'media',
  match: (file) => file.kind === 'media',
  Body: MediaBody,
  status: ({ file }) => (file.kind === 'media' ? (file.audio ? 'audio' : 'video') : undefined),
})
