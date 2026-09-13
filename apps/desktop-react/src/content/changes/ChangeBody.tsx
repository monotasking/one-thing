import { useMemo } from 'react'
import { TriangleAlert } from '../../components/icons'
import { Button } from '../../ui/Button'
import { Diff } from '../blocks/kinds/diff/Diff'
import { parseUnifiedDiff } from '../blocks/kinds/diff/parse'
import { splitPath } from './ChangeList'
import type { GitChangedFile, GitDiffView } from '../../data/changes-source'
import type { QuerySnapshot } from '../../data/kernel'
import type { MessageKey } from '../../i18n'
import s from './ChangesPanel.module.css'

/**
 * **选中那个文件的 diff 体**(「改动」面,正本 §3.4)。
 *
 * ── 块本体原样复用,**檐不复用** ────────────────────────────────────────
 * `content/blocks/kinds/diff/Diff.tsx` 是聊天正文里那块 diff 的身子,一行都不改地
 * 用在这里 —— 「同一段 diff 在正文里和在这块面里长成两种东西」正是那只解析器头上
 * 记着要避免的事。**但那块的檐(类型词 `diff` + 文件路径 + ± 统计)不复用**:
 * 这块面自己的檐已经写了文件名与 ±,再画一条就是同一句话说两遍。
 *
 * ── 四态,每一态说一句不同的话 ──────────────────────────────────────────
 * binary(二进制,不展示)/ truncated(截断了,块尾一行)/ parsed(正常)/
 * empty(解析不出 —— 选中的那个文件在两次刷新之间被撤销了改动)。
 * **不画空卡**:`parseUnifiedDiff` 答 `undefined` 就是「这段文本不像 diff」,那时
 * 该说的是「这个文件此刻没有改动」,而不是一块画着零行的 diff 框。
 *
 * ── `content-visibility: auto` 逐块 ─────────────────────────────────────
 * 第五轴那一格(单文件两万行 diff)。`Diff` 的 DOM 是**一层平铺**(hunk 头与行
 * 并列,`Hunk` 是 Fragment),块与块之间没有任何跨块布局依赖 —— 所以「看不见的
 * 那些不排版」是安全的,而且是唯一能让一块两万行的 diff 首帧进 16ms 的手段。
 * 判据与取件口整段写在样式表的 `.diffWrap` 上;这里只负责包那一层。
 */

export interface ChangeBodyProps {
  /** 选中的那一行(没有选中 = 面板不该渲染这一块)。 */
  file: GitChangedFile
  /** 那一格 diff 的读数。 */
  snapshot: QuerySnapshot<GitDiffView>
  onRetry: () => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

export function ChangeBody({ file, snapshot, onRetry, t }: ChangeBodyProps) {
  const text = snapshot.data?.text ?? ''
  /*
   * 解析只在 `text` 真变了的时候跑一遍。两万行的 diff 解析一次是几毫秒,而这块面
   * 每一次选中 / 刷新 / 拖分栏都会重渲染 —— 不 memo 就是每一帧解一遍。
   */
  const parsed = useMemo(() => (text ? parseUnifiedDiff(text) : undefined), [text])

  return (
    <div className={s.body} data-testid="changes-body" data-change-body-path={file.path}>
      {/*
       * 体自己的第一行写**文件名**(全路径在檐上的 tip 里)。它不是第二条檐:
       * 一条 diff 铺开好几屏,滚到中间时「我在看哪个文件」必须还在屏上 ——
       * 所以它 sticky,与 `Diff` 的 hunk 头同一个层。
       */}
      <div className={s.bodyHead}>
        <span className={s.bodyPathDir}>{splitPath(file.path).dir}</span>
        <span className={s.bodyPathName}>{splitPath(file.path).name}</span>
      </div>

      {/*
       * 错误:一条通知行 + 后端原话 + 一颗重试。**旧内容不清**(律②)——
       * 上一次读到的那块 diff 留在下面,人至少还看得见刚才那一份。
       */}
      {snapshot.error && (
        <p className={s.notice} role="alert" data-testid="changes-body-error">
          <TriangleAlert className={s.noticeIcon} strokeWidth={1.75} aria-hidden="true" />
          <span className={s.noticeText}>{snapshot.error}</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {t('diff.retry')}
          </Button>
        </p>
      )}

      {snapshot.data?.binary ? (
        <p className={s.bodyNote} data-testid="changes-body-binary">
          {t('diff.binary')}
        </p>
      ) : parsed ? (
        <>
          {/* 包一层的理由(`content-visibility` 的取件口)写在样式表 `.diffWrap` 上。 */}
          <div className={s.diffWrap}>
            <Diff model={{ kind: 'diff', ...parsed }} />
          </div>
          {snapshot.data?.truncated && (
            <p className={s.bodyNote} data-testid="changes-body-truncated">
              {t('diff.truncated')}
            </p>
          )}
        </>
      ) : snapshot.phase === 'initial' ? (
        /*
         * 首载骨架:三条短横。**只在 `phase === 'initial'` 画**(律②)—— 重拉期间
         * 上面那块 diff 一动不动。
         */
        <div className={s.skel} aria-hidden="true" data-testid="changes-body-skeleton">
          <span className={`${s.skelBar} ${s.skelBar1}`} />
          <span className={`${s.skelBar} ${s.skelBar2}`} />
          <span className={`${s.skelBar} ${s.skelBar3}`} />
        </div>
      ) : (
        /*
         * 读到了、但解析不出来:这个文件此刻没有改动(在两次刷新之间被撤销了)。
         * 说出来,而不是画一块空框 —— 空框会让人以为是这块面坏了。
         */
        !snapshot.error && (
          <p className={s.bodyNote} data-testid="changes-body-empty">
            {t('diff.noDiff')}
          </p>
        )
      )}
    </div>
  )
}
