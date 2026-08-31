import { resolveIcon } from '../../components/icons'
import { Button } from '../../ui/Button'
import { glyphOf } from '../../data/file-icons'
import { useT } from '../../i18n'
import { FileGlyphMark } from '../FileGlyph'
import s from './FileViewer.module.css'

const RevealIcon = resolveIcon('FolderOpen')

/**
 * **诚实态** —— 「这份东西这台打不开,原因是这个」。
 *
 * binary / oversize / 读失败 / 图取不到字节,四种情形共用它:它们说的话不同,
 * 但结构是同一件事 —— 一枚类型徽 + 一句人话 + (有就给的)后端原话或大小 +
 * 唯一那个还做得成的动作(去文件管理器里看它)。
 *
 * 它**不是兜底的客气话**,是这条链路的失败语义(同块系统的 source-fallback):
 * 宁可如实说「读不成文本」,也不画半屏乱码;宁可说「太大了没读」,也不把界面
 * 冻在那儿。所以四种情形各有各的话,**没有一种回退到别的那一种**。
 */
export function HonestState({
  name,
  title,
  note,
  onReveal,
}: {
  name: string
  /** 一句人话。 */
  title: string
  /** 后端原话 / 大小 / 一句补充。缺席就不画那一行。 */
  note?: string
  /** 去文件管理器。宿主给 —— 「在哪儿定位」不是文件内容的事实。 */
  onReveal?: () => void
}) {
  const t = useT()
  return (
    <div className={s.honest} data-testid="viewer-honest">
      <FileGlyphMark glyph={glyphOf(name, 'file')} className={s.honestGlyph} size="lg" />
      <p className={s.honestTitle}>{title}</p>
      {note && <p className={s.honestNote}>{note}</p>}
      {onReveal && (
        <Button onClick={onReveal}>
          <RevealIcon className={s.actionIcon} strokeWidth={1.75} aria-hidden="true" />
          {t('files.reveal')}
        </Button>
      )}
    </div>
  )
}
