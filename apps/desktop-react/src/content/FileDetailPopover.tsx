import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, resolveIcon } from '../components/icons'
import { COPY_FEEDBACK_MS } from '../components/motion'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { Popover } from '../ui/Popover'
import { useT, resolveLang } from '../i18n'
import type { Lang, MessageKey } from '../i18n'
import { useStageStore } from '../stage/store'
import { formatBytes } from '../format/quantity'
import { formatMtime, revealKey, revealMutation } from '../data/files-source'
import type { FileDetailState, FileFailure } from '../data/files-source'
import { useAsyncPending } from '../data/kernel'
import { glyphOf } from '../data/file-icons'
import { FileGlyphMark } from './FileGlyph'
import { copyPathAnnouncing } from './FileActionsMenu'
import { openFileInCurrentTarget } from './viewer/open-target'
import s from './FilesPanel.module.css'

/**
 * 详情 —— **附属浮层**(08-31 定稿改判,上一版是 ui/Dialog)。
 *
 * 09-01 从 FilesPanel 里搬出来自成一件,理由与 FileActionsMenu 逐字相同:
 * **它有了第二个宿主**(查看区右键菜单里的「详情」也要弹它),而一件东西
 * 在两处各画一遍必然分叉。搬家时画法一个字没改。
 *
 * 三条它比 Dialog 强的地方,正是当初选 Dialog 的三条理由的反面:
 * ① 树不被遮:回来时滚动位置、展开形状、选中行一个都没变;
 * ② 它不吃面板的宽度(浮层挂在 body 上),所以「完整路径」那一行照样站得下 ——
 *    这一条 Dialog 也做得到,不是改判的理由,记在这里免得被当成理由;
 * ③ 它不打断:`role="dialog"` 但没有 `aria-modal`,读屏软件仍然看得见那棵树。
 * 换来的代价是**没有遮罩**,所以「点别处即散」这件事必须真的成立 —— 那是
 * ui/Popover 的事(pointerdown 落在浮层外就关),不是这里的。
 *
 * 「复制」这颗钮长在**路径那一行上**而不是底部动作组里:反馈要落在被复制的
 * 那件东西旁边(⧉ 换 ✓ 一拍,COPY_FEEDBACK_MS 后还原)。
 */

/** 「在文件管理器里定位」的钮(详情浮层底部动作组)。 */
const RevealIcon = resolveIcon('FolderOpen')

/**
 * 详情面的三档失败**自己一套话**,不借查看器那一套:查看器说的是「这个文件」,
 * 而详情可能问的是一个目录 —— 借过来会当场说错话。
 */
const DETAIL_FAILURE_LABELS: Record<FileFailure, MessageKey> = {
  denied: 'files.detailDenied',
  missing: 'files.detailMissing',
  failed: 'files.detailFailed',
}

/**
 * 缺席格画的那道破折号。**它是符号不是文案**(与 formatBytes 的单位符号同一条
 * 口径):换一门语言它不该变,所以不进字典。它说的是「这台没给这一格」,
 * 不是 0 B,也不是 1970-01-01。
 */
const ABSENT = '—'

export function FileDetailPopover({
  detail,
  x,
  y,
  onClose,
}: {
  detail: FileDetailState
  x: number
  y: number
  onClose: () => void
}) {
  const t = useT()
  const lang: Lang = resolveLang(useStageStore((st) => st.locale))
  const glyph = glyphOf(detail.name, detail.type)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyPath = () => {
    void copyPathAnnouncing(detail.path, t).then((ok) => {
      setCopied(ok)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    })
  }

  const ready = detail.status === 'ready'
  const sizeText = ready && detail.size !== undefined ? formatBytes(detail.size) : ABSENT
  const mtimeText = (ready && formatMtime(detail.mtimeMs, lang)) || ABSENT
  /*
   * 「这一条路径的 reveal 此刻在飞吗」(7d,律③)。逐格 —— 键是那条路径,
   * 所以同屏两个详情浮层(树行一个、查看区一个)各禁各的。
   */
  const revealing = useAsyncPending(revealMutation, revealKey(detail.path))

  return (
    /*
     * `testId` 落在**浮层根**上(08-31 真机走查的出入):从前它挂在里面那层 div,
     * 于是 `[data-testid="files-detail"]` 取到的那个元素 `role` 是空的 ——
     * role="dialog" 一直在,只是在它的父节点(Popover 的根)上。
     * `data-file-path` 留在里面那层(它是这块**内容**的事实,不是浮层的属性),
     * 门按后代取:`[data-testid="files-detail"] [data-file-path]`。
     */
    <Popover x={x} y={y} onClose={onClose} label={detail.name} testId="files-detail">
      <div className={s.detail} data-file-path={detail.path}>
        <div className={s.detailHead}>
          <FileGlyphMark glyph={glyph} className={s.detailGlyph} size="lg" />
          <span className={s.detailName}>{detail.name}</span>
        </div>

        <div className={s.detailPathRow}>
          <span className={s.detailPath}>{detail.path}</span>
          {/*
           * 「复制路径」贴在路径那一行的右端,视觉本该定制(极小、无底、图标+字)
           * —— 所以它消费 `ui/ButtonBase`,不是 `ui/Button`(套一颗 ghost 钮会把
           * 这一行撑高一档,而反馈本该落在路径旁边而不是一颗独立的动作钮上)。
           */}
          <ButtonBase
            className={copied ? `${s.detailCopy} ${s.detailCopyDone}` : s.detailCopy}
            onClick={copyPath}
          >
            {copied ? (
              <Check className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            )}
            {t(copied ? 'common.copied' : 'files.copyPath')}
          </ButtonBase>
        </div>

        {/*
          * **这里不转圈**(09-02 批 6 兑现禁令:Spinner 只许出现在按钮内或状态栏,
          * 浮层 / 卡的加载态用文字或骨架)。从前这一格是「转圈 + 同一句话」——
          * 转圈说的话与它旁边那行字逐字相同,删掉一个字都没少;而它下面那条
          * error 分支本来就只有文字,两态从此同一副形。
          */}
        {detail.status === 'loading' && (
          <p className={s.detailNote}>
            <span className={s.noteDetail}>{t('files.detailLoading')}</span>
          </p>
        )}
        {/*
          * 判据是 `error` 在不在,**不是** `status === 'error'`(7d 规范修正):
          * 再问一次砸了而手上还有上一次那四格时,两件事同时为真 —— 值照画、
          * 那句原话也照说(律②:错误与旧答案共存)。手上一格都没有时这两个判据
          * 逐字等价,所以常态下屏幕一个像素都没变。
          */}
        {detail.error && (
          <p className={s.detailNote}>
            <span className={s.noteFail}>{t(DETAIL_FAILURE_LABELS[detail.failure ?? 'failed'])}</span>
            <span className={s.noteDetail}>{detail.error}</span>
          </p>
        )}

        <dl className={s.detailList}>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailTypeLabel')}</dt>
            <dd className={s.detailValue}>
              {t(detail.type === 'directory' ? 'files.typeDirectory' : 'files.typeFile')}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailSizeLabel')}</dt>
            <dd className={s.detailValue} data-testid="files-detail-size">
              {sizeText}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailModifiedLabel')}</dt>
            <dd className={s.detailValue} data-testid="files-detail-mtime">
              {mtimeText}
            </dd>
          </div>
        </dl>

        <div className={s.detailFoot}>
          {/*
            * **刻意不 disabled**(与 7e 总览 `+` 钮同一条):`aria-busy` 说的是
            * 「在飞」不是「不可用」,禁了会让键盘用户在往返中途掉出焦点序。
            * 连点由那道二次闸吃掉。零新像素 —— 这一格只上无障碍语义。
            */}
          <Button
            aria-busy={revealing || undefined}
            onClick={() => {
              if (revealing) return
              void revealMutation.run(detail.path)
            }}
          >
            <RevealIcon className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            {t('files.reveal')}
          </Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {/* 详情面上那颗「打开查看」—— 查看器的第三个入口(另两个:单击、右键菜单)。 */}
          {detail.type === 'file' && (
            <Button
              variant="primary"
              onClick={() => {
                onClose()
                openFileInCurrentTarget(detail.path)
              }}
            >
              <Eye className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
              {t('files.menuOpen')}
            </Button>
          )}
        </div>
      </div>
    </Popover>
  )
}

/** 详情浮层离锚点的那一点空隙。两个宿主(树行 / 查看区)共用同一个数。 */
export const DETAIL_POPOVER_GAP = 4
