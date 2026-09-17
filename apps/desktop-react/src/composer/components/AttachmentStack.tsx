import { useRef } from 'react'
import { useT } from '../../i18n'
import { IconButton } from '../../ui/IconButton'
import { resolveIcon, X } from '../../components/icons'
import { useCardStackOpen } from '../../ui/card-stack'
import { useComposerStoreOf } from '../store'
import { useComposerSessionId } from '../session-context'
import { fileExt, layoutAttachments } from '../transitions'
import s from './Composer.module.css'

const FileIcon = resolveIcon('FolderTree')

/**
 * 拍立得附件摞。三条设计裁定照搬:
 *
 * 1. **absolute 不占布局** —— 挂在 composer 上方,composer 的几何零变化;
 * 2. **展开是状态,不是 hover 的副作用** —— 删一张卡其余就位,摞不塌
 *    (展开态删卡若跟着 hover 走,鼠标下的卡一没就整摞收回,手会追不上);
 * 3. **收拢带 200ms 宽限** —— 卡缝与删卡瞬间的出界不塌摞,再进即取消
 *    (同 Dock 留驻区判例)。
 *
 * 坐标全部由 transitions.layoutAttachments(→ `ui/card-stack`)算,这个文件只把数贴上去。
 */
export function AttachmentStack() {
  const t = useT()
  /* 这块面板对着哪条会话 —— 由 `Composer` 下发(W5-c-2)。 */
  const sessionId = useComposerSessionId()
  const attachments = useComposerStoreOf(sessionId, (st) => st.attachments)
  const open = useComposerStoreOf(sessionId, (st) => st.attOpen)
  const setOpen = useComposerStoreOf(sessionId, (st) => st.setAttOpen)
  const remove = useComposerStoreOf(sessionId, (st) => st.removeAttachment)
  const stackRef = useRef<HTMLDivElement>(null)
  // 开合手势(宽限 / 滚轮纵转横)归 `ui/card-stack`,与聊天流的图片摞同一只。
  const gesture = useCardStackOpen(stackRef, open, setOpen)

  if (attachments.length === 0) return null

  const layout = layoutAttachments(attachments, open)
  const byId = new Map(attachments.map((a) => [a.id, a]))

  return (
    <div className={s.attFloat}>
      <div
        ref={stackRef}
        className={open ? `${s.attStack} ${s.attStackOpen}` : s.attStack}
        style={{ width: layout.stackWidth === null ? '100%' : `${layout.stackWidth}px` }}
        aria-label={t('composer.attachments')}
        onMouseEnter={gesture.onMouseEnter}
        onMouseLeave={gesture.onMouseLeave}
      >
        <div className={s.attRow} style={{ width: `${layout.rowWidth}px` }}>
          {layout.cards.map((card) => {
            const a = byId.get(card.id)
            if (!a) return null
            const cls = [s.attCard, a.url ? s.attPhoto : s.attDoc, card.hidden ? s.attHidden : '']
              .filter(Boolean)
              .join(' ')
            return (
              <span
                key={card.id}
                className={cls}
                style={{
                  left: `${card.left}px`,
                  transform: `rotate(${card.rotate}deg)`,
                  zIndex: card.zIndex,
                }}
              >
                {a.url ? (
                  <span
                    className={s.attPhotoImg}
                    style={{ backgroundImage: `url(${a.url})` }}
                    role="img"
                    aria-label={a.name}
                  />
                ) : (
                  <>
                    <FileIcon className={s.attDocIcon} strokeWidth={1.7} aria-hidden="true" />
                    <span className={s.attDocName}>{a.name}</span>
                    <span className={s.attDocExt}>{fileExt(a.name)}</span>
                  </>
                )}
                {/*
                  * 卡角那颗删除钮消费 `ui/IconButton`(xs 档 18px = 旧 --att-x 逐像素),
                  * 字形从字面的 `✕` 换成 lucide 的 X —— 全壳图标钮只有一个字形产地。
                  * `tip` 关掉:卡本来就只有这一颗钮,悬停再飘一句「移除附件」会盖住
                  * 旁边的卡(与 FilesPanel 行尾 ⋯ 同一条判例)。
                  *
                  * 从前那句 `e.stopPropagation()` 随迁移去掉:整条祖先链
                  * (.attCard / .attRow / .attStack / .attFloat / composer 各层)
                  * **没有任何 click 监听**,它拦不到任何东西;而库件把 onClick 收成
                  * 无参回调(它不透传 ButtonHTMLAttributes,见交卷报告的库件缺口)。
                  */}
                <IconButton
                  icon={X}
                  size="xs"
                  tip={false}
                  className={s.attX}
                  label={t('composer.removeAttachment')}
                  onClick={() => remove(card.id)}
                />
              </span>
            )
          })}
          {/* 展开了就不再需要计数:卡都摊开在那儿了 */}
          <span className={open ? `${s.attCount} ${s.attCountHidden}` : s.attCount}>
            {attachments.length}
          </span>
        </div>
      </div>
    </div>
  )
}
