import { useEffect, useState } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import { homePathFailureText, resolveHomePath } from '../../data/files-source'
import { useWorkbenchStore } from '../../workbench/store'
import { dirRef, normalizeDirPath } from '../kinds/dir-ref'
import { RootCrumbs } from './RootCrumbs'
import s from '../FilesPanel.module.css'

/**
 * **一格 key 以 `~` 起笔的目录面板:先展开,再换成绝对路径那一格**(09-24)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 用户报「reference 打开的目录,内层目录无法打开」。真机上那一格的 key 是
 * `~/Documents/data/work/lenovo/1015`(模型写的 `<ref type="dir" path="~/…/"/>`)。
 * 根那一层列得出来(后端 `listDirectory` 展 `~`),可子项回来是绝对路径,而
 * `FilesPanel` 的 `dirPaths` 用 `isUnder(子, 根)` 滤订阅表 —— `~/…` 底下永远没有
 * `/Users/…`,子层一层都进不了订阅,点开只见骨架条;面包屑画成 `/~/…`。
 *
 * 裁定:**目录面板的根永远是绝对路径,`~` 只在入口展开一次**。新打开的那一侧由
 * `content/dir-open.openDirectoryPanel` 兑现;**已经落了盘的那一格**由这里兑现 ——
 * 渲染到它的那一拍去问后端,答回来就 `rekeyRef`,把树上每一处(每一片叶、复合
 * 标签、藏着的、全屏那一格)都换成绝对 key。落定之后树里没有一格 `dir` 的 key
 * 以 `~` 起笔,`referenceRoot` / `presents` / `@` 搜索根这三处读 key 的也就不再说谎。
 *
 * **不在 `FilesPanel` 里偷偷用绝对根而让 key 留着 `~`**:那样树画对了,可 key 还是
 * 那串字,上面三处照旧读错 —— 修的是画面,不是事实。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 一格 `~` key 被渲染(水合出来的存量、从隐藏处请回来的、
 *    伴随面换回来的都走这里)→ 当场发一次 `stat`;答回来 `rekeyRef` 改树,
 *    这一格的 key 变了,内容挂载表按新 key 挂上真的 `FilesPanel`,**这只组件随之卸载**
 *    (它从来不是一个会长留的面)。卸载时手上那一发不撤:改树是对的事,与这只组件
 *    还在不在无关(被藏起来的那一份同样该改);只是不再往一只已卸载的组件里写失败。
 *    StrictMode 双挂 = 两发 `stat`,第二次 `rekeyRef` 找不到 `from`,恒等。
 *    零模块级状态、零订阅、零计时器 → 不需要 HMR dispose。
 * ② UI 生命状态:**展开中**(头上「正在确定根目录…」+ 两条骨架短横 —— 与
 *    `FilesPanel` 首载同一副形,几何逐像素相同,换过去不跳)/ **展不开**(沿用树上
 *    「This directory is gone」那一行 + 后端原话 + 「重试」)。没有 ready 档:
 *    ready 的那一刻 key 已经换了,画的是 `FilesPanel`。**不画骨架以外的任何猜测**,
 *    更不画 `/~/…` 那条面包屑(头上走 `RootCrumbs` 的 loading / error 两档,
 *    它们本来就是「根还没定 / 定不下来」的那两句话)。
 * ③ UI 交互状态:只有「重试」一颗(`ButtonBase`,与树上注行那颗逐字同一件:
 *    rest / hover 下划线 / 全局焦点环)。按下 = 回到展开中再问一次;
 *    展开中那一档没有可按的东西。
 */
export function HomeRootResolver({ root }: { root: string }) {
  const t = useT()
  /** `undefined` = 展开中;对象 = 展不开(`error` 是后端原话,可能缺席)。 */
  const [failure, setFailure] = useState<{ error: string | undefined } | undefined>(undefined)
  /** 「重试」按了几次。它是 effect 的依赖:按一下 = 再问一次。 */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    resolveHomePath(root).then(
      (abs) => {
        useWorkbenchStore.getState().rekeyRef(dirRef(root), dirRef(normalizeDirPath(abs)))
      },
      (error: unknown) => {
        if (alive) setFailure({ error: homePathFailureText(error) })
      },
    )
    return () => {
      alive = false
    }
  }, [root, attempt])

  return (
    <div className={s.panel} data-testid="files-home-root" data-state={failure ? 'failed' : 'resolving'}>
      <div className={s.head} data-panel-head="">
        <nav className={s.crumbs} aria-label={t('files.breadcrumb')}>
          <RootCrumbs root={null} status={failure ? 'error' : 'loading'} t={t} onJump={() => {}} />
        </nav>
      </div>
      {/* 与 `FilesPanel` 同一副骨架(`.split` 第一列 + `.body`):换过去时一个像素都不挪。 */}
      <div className={s.split} data-viewer="closed">
        <div className={s.body}>
          {failure ? (
            <div className={s.note}>
              <span className={s.noteFail}>{t('files.dirMissing')}</span>
              {failure.error && <span className={s.noteDetail}>{failure.error}</span>}
              <ButtonBase
                className={s.noteRetry}
                onClick={() => {
                  setFailure(undefined)
                  setAttempt((n) => n + 1)
                }}
              >
                {t('files.retry')}
              </ButtonBase>
            </div>
          ) : (
            <>
              {/* 两条短横合起来才是一句话「这一层还在读」,所以只让第一条报出来。 */}
              <div className={s.skelRow} role="status" aria-label={t('files.dirLoading')}>
                <span className={`${s.skelBar} ${s.skelBar1}`} aria-hidden="true" />
              </div>
              <div className={s.skelRow}>
                <span className={`${s.skelBar} ${s.skelBar2}`} aria-hidden="true" />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
