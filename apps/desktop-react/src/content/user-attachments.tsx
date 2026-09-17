import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MessageAttachmentMetadata } from '../data/message-attachments'
import { useAttachmentImage } from '../data/attachment-image'
import { useT } from '../i18n'
import { Image as ImageGlyph } from '../components/icons'
import { ReferenceChip } from '../references/ReferenceChip'
import { attachmentReferenceKind } from '../references/kinds/attachment'
import type { AttachmentRef } from '../references/kinds/attachment'
import { ButtonBase } from '../ui/ButtonBase'
import { Tooltip } from '../ui/Tooltip'
import { layoutCardStack, useCardStackOpen } from '../ui/card-stack'
import type { CardStackGeometry } from '../ui/card-stack'
import { ZoomOverlay } from './blocks/shell/ZoomOverlay'
import type { ZoomContent } from './blocks/shell/actions'
import s from './user-attachments.module.css'

/**
 * **用户消息里的附件怎么画**(2026-09-16 比稿 A「图在气泡外」+「图多的时候折叠」;
 * 比稿页 `docs/user-image-message-proposal-2026-09-16.html`)。
 *
 * ── 两类附件,两个位置 ────────────────────────────────────────────────────
 *  · **图** → `UserImages`,站在气泡**外面**、上方、右对齐。图就是图,不再垫一层
 *    气泡的底,也不再在每张图下面挂一枚文件名 chip(文件名在悬停提示与放大层里)。
 *  · **其余文件** → `UserFiles`,照旧是气泡里的一枚引用 chip。
 *  判据是投影层给的 `attachment.image`(`data/message-attachments`),这里不再猜 mime。
 *
 * ── 图的三种排法(按张数)────────────────────────────────────────────────
 *   1 张      钉高不钉宽(`--umsg-img-single-h`),宽按比例、封顶,过宽裁边
 *   2–4 张    一排等宽方块
 *   ≥ 5 张    收成一摞 —— 最上三张错角叠放 + 计数;指针或焦点进来摊成一排横滚,
 *             离开宽限后收回。形与 composer 附件摞同源(`ui/card-stack`),两态同高。
 *
 * ── 一张图的状态表 ──────────────────────────────────────────────────────
 *   loading      占位盒(与成图同尺寸),不可点
 *   ready        图;点开 = 放大层(`blocks/shell/ZoomOverlay`,位图那一支不垫卡)
 *   unavailable  没有字节也没有路径 —— 一格诚实态:图形字 + 文件名
 *   error        `<img>` 解码失败 —— 同上一格;有落盘路径时点开 = 打开那个文件
 *   超量         五张起折叠;展开态横滚,滚轮纵转横
 * 诚实态里**文件名是看得见的字**:图画不出来的时候,名字是这一格仅剩的信息。
 */

/** `--umsg-img-thumb` 的 JS 镜像:摞的排布要累计坐标,CSS 排不了。 */
export const USER_IMG_THUMB = 88
/** 从第几张起收成一摞。四张一排还读得清,第五张起一排就开始挤。 */
export const USER_IMG_FOLD_AT = 5
/** 摞的几何。`inset` × 2 + 方块 = `--umsg-img-stack-h`。 */
export const USER_IMG_STACK: CardStackGeometry = {
  visible: 3,
  inset: 6,
  offset: 10,
  rotate: 3,
  gap: 8,
  slack: 12,
}

/** 投影层判定为图的那几件。 */
export function isImageAttachment(a: MessageAttachmentMetadata): boolean {
  return a.image !== undefined
}

/** 气泡里的文件 chip(非图附件)。 */
export function UserFiles({ attachments }: { attachments: readonly MessageAttachmentMetadata[] }) {
  if (!attachments.length) return null
  return (
    <span className={s.files} data-testid="user-attachments">
      {attachments.map((a) => (
        <ReferenceChip
          key={a.id}
          kindId={attachmentReferenceKind.id}
          value={{ kind: 'attachmentRef', name: a.fileName, path: a.filePath } satisfies AttachmentRef}
        />
      ))}
    </span>
  )
}

/** 气泡外的图。`pending` = 这条还在飞(与气泡的 `.pending` 同一档淡)。 */
export function UserImages({ sessionId, images, pending = false }: {
  sessionId: string
  images: readonly MessageAttachmentMetadata[]
  pending?: boolean
}) {
  const t = useT()
  const [zoom, setZoom] = useState<ZoomContent | null>(null)
  if (!images.length) return null

  const count = images.length
  const shape = count === 1 ? 'single' : count < USER_IMG_FOLD_AT ? 'row' : 'stack'
  const tile = (a: MessageAttachmentMetadata) => (
    <ImageTile
      sessionId={sessionId}
      attachment={a}
      shape={shape === 'single' ? 'single' : 'thumb'}
      onZoom={(src) => setZoom({ image: { src, alt: a.fileName } })}
    />
  )

  return (
    <div
      className={[s.images, pending && s.pending].filter(Boolean).join(' ')}
      data-testid="user-images"
      data-shape={shape}
      role="group"
      aria-label={t('chat.images.group', { count })}
    >
      {shape === 'stack' ? (
        <ImageStack images={images} renderTile={tile} />
      ) : (
        images.map((a) => <span key={a.id} className={s.cell}>{tile(a)}</span>)
      )}
      {zoom !== null && <ZoomOverlay content={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

function ImageStack({ images, renderTile }: {
  images: readonly MessageAttachmentMetadata[]
  renderTile: (a: MessageAttachmentMetadata) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const stackRef = useRef<HTMLDivElement>(null)
  const gesture = useCardStackOpen(stackRef, open, setOpen)
  const layout = layoutCardStack(
    images.map((a) => ({ id: a.id, width: USER_IMG_THUMB })),
    open,
    USER_IMG_STACK,
  )
  const byId = new Map(images.map((a) => [a.id, a]))

  return (
    <div
      ref={stackRef}
      className={open ? `${s.stack} ${s.stackOpen}` : s.stack}
      data-open={open || undefined}
      style={{ width: layout.stackWidth === null ? `min(${layout.rowWidth}px, 100%)` : `${layout.stackWidth}px` }}
      {...gesture}
    >
      <div className={s.stackRow} style={{ width: `${layout.rowWidth}px` }}>
        {layout.cards.map((card) => {
          const a = byId.get(card.id)
          if (!a) return null
          return (
            <span
              key={card.id}
              className={card.hidden ? `${s.stackCard} ${s.stackHidden}` : s.stackCard}
              style={{ left: `${card.left}px`, transform: `rotate(${card.rotate}deg)`, zIndex: card.zIndex }}
            >
              {renderTile(a)}
            </span>
          )
        })}
      </div>
      {/* 展开了就不再需要计数:图都摊开在那儿了(与 composer 摞同一句) */}
      <span className={open ? `${s.count} ${s.countHidden}` : s.count} aria-hidden="true">
        {images.length}
      </span>
    </div>
  )
}

function ImageTile({ sessionId, attachment, shape, onZoom }: {
  sessionId: string
  attachment: MessageAttachmentMetadata
  shape: 'single' | 'thumb'
  onZoom: (src: string) => void
}) {
  const t = useT()
  const image = useAttachmentImage(sessionId, attachment)
  const [failedSrc, setFailedSrc] = useState<string>()
  const failed = image.src !== undefined && failedSrc === image.src
  const cls = [s.tile, shape === 'single' ? s.single : s.thumb]

  if (image.status === 'loading') {
    return <span className={[...cls, s.placeholder].join(' ')} aria-busy="true" />
  }

  if (image.src && !failed) {
    const src = image.src
    return (
      <Tooltip content={attachment.fileName}>
        <ButtonBase
          className={[...cls, s.ready].join(' ')}
          aria-label={t('chat.image.view', { name: attachment.fileName })}
          onClick={() => onZoom(src)}
        >
          <img
            className={s.img}
            src={src}
            alt={attachment.fileName}
            loading="lazy"
            decoding="async"
            onError={() => setFailedSrc(src)}
          />
        </ButtonBase>
      </Tooltip>
    )
  }

  // 诚实态:图画不出来。有落盘路径就还能打开那个文件,没有就只是一格说明。
  const body = (
    <>
      <ImageGlyph className={s.glyph} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.name}>{attachment.fileName}</span>
    </>
  )
  const path = attachment.filePath
  if (path) {
    return (
      <Tooltip content={t('block.image.loadFailed')}>
        <ButtonBase
          className={[...cls, s.honest].join(' ')}
          aria-label={t('chat.ref.openFile', { path: attachment.fileName })}
          onClick={() => attachmentReferenceKind.open?.({ kind: 'attachmentRef', name: attachment.fileName, path })}
        >
          {body}
        </ButtonBase>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={t('block.image.loadFailed')}>
      <span className={[...cls, s.honest].join(' ')}>{body}</span>
    </Tooltip>
  )
}
