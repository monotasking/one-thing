import { useCallback, useState } from 'react'
import { X } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { IconButton } from '../../ui/IconButton'
import { useT } from '../../i18n'
import { dismissBrowserDownload, type BrowserDownloadNotice } from '../../data/browser-notices'
import { revealPath } from '../../data/reveal-path'
import s from './BrowserDownloadRow.module.css'

/**
 * **下载落地那一行**(B3-a)。一行文字读数,挂在浏览器叶的檐下。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期
 * ══════════════════════════════════════════════════════════════════════════
 * | 事件 | 这里发生什么 |
 * | --- | --- |
 * | 挂载 | 一条 `download` 事实到了(`started`),而且它是这一格 tab 最近变动的那一条 |
 * | 期间 | 同一条下载的 `done` / `failed` 就地换字。**行不换身份**(key 是落点路径) |
 * | 换宿主 | 状态按 tabId 住在 `data/browser-notices.ts`,叶重挂也不丢 |
 * | 卸载 | 人按了 ×,或者这一格 tab 关掉了 |
 * | **不会** | 它不会自己消失 —— 一条读数自己淡出,人回头就找不到那份文件在哪了 |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态(三档)
 * ══════════════════════════════════════════════════════════════════════════
 * | 态 | 屏幕上 |
 * | --- | --- |
 * | `started` | 「正在下载 x.zip…」。**禁 spinner**(禁令区第一条);没有百分比 —— 后端根本不发,画一条会自己走到 80% 再等的进度是编 |
 * | `done` | 「已下载 x.zip」+「在文件管理器中显示」+ × |
 * | `failed` | 「x.zip 没下成」+ ×。取消与中断说同一句话(判词在 `electron/browser/download.ts`) |
 * | 定位失败 | 那一句**后端原话**就地接在行尾(零 Toast),行不跳、不变色 |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ③ UI 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 交互 | 结果 |
 * | --- | --- |
 * | 「在文件管理器中显示」 | `dir:` 的 `reveal`(与 AI 同一条路,判词在 `data/reveal-path.ts`) |
 * | pending | 那颗钮按下去到回来之间自己 disabled(**逐格 pending**,不是全局忙布尔) |
 * | × | 只收这一行读数,**不动那个文件** |
 * | rest / hover / focus | `ui/ButtonBase`(行内微型文字动作那一档)与 `ui/IconButton` 各自带 |
 * | 超量 | 一格 tab 同时下五个:表里留最近 5 条,**画的永远是最近变动的那一条**(判词在 `browser-notices.ts`)。这一行不长高、不滚 |
 */
export function BrowserDownloadRow({ notice }: { notice: BrowserDownloadNotice }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const reveal = useCallback(() => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    void revealPath(notice.path)
      .then((error) => { setProblem(error) })
      .finally(() => { setBusy(false) })
  }, [busy, notice.path])

  const text =
    notice.state === 'started'
      ? t('browser.downloadStarted', { name: notice.filename })
      : notice.state === 'done'
        ? t('browser.downloadDone', { name: notice.filename })
        : t('browser.downloadFailed', { name: notice.filename })

  return (
    <div className={s.row} data-testid="browser-download" data-download-state={notice.state}>
      <span className={s.text}>{text}</span>
      {notice.state === 'done' && (
        <ButtonBase className={s.action} disabled={busy} onClick={reveal} data-testid="browser-download-reveal">
          {t('browser.downloadReveal')}
        </ButtonBase>
      )}
      {/* 定位没成:后端原话就地一句并陈,旧内容一像素不动(零 Toast)。 */}
      {problem && <span className={s.problem}>{problem}</span>}
      {notice.state !== 'started' && (
        <IconButton
          icon={X}
          label={t('browser.downloadDismiss')}
          size="xs"
          onClick={() => dismissBrowserDownload(notice.tabId, notice.path)}
          testId="browser-download-dismiss"
        />
      )}
    </div>
  )
}
