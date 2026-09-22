import { Spinner } from '../../ui/Spinner'
/*
 * 状态栏那一排是**结构性交互元素**(视觉本该定制:mono、极小、无底、贴着读数站),
 * 所以它们消费的是 `ui/ButtonBase`(只清 UA、一个像素都不画),不是 `ui/Button`
 * ——套一颗 ghost 按钮进 26 高的状态栏,那一行就不再是读数带了。
 * 这正是裸钮三类判的**③类**(09-02 判例 ebc646ac 细化的 ①/③ 边界:
 * 行内微型文字动作没有自己的按钮形,换 28px 描边钮是改版不是等价迁移)。
 */
import { ButtonBase } from '../../ui/ButtonBase'
import type { TFn } from '../../i18n'
import { formatBytes } from '../../format/quantity'
import type { ViewerFile, ViewerView } from '../../data/viewer-source'
import { listKeymaps } from './registry'
import type { ViewerStatusItem } from './registry'
import s from './FileViewer.module.css'

/**
 * **脚:26 的状态栏**(09-02 批 9b 从 `FileViewer` 拆出,一行未改)。
 *
 * 三层 + 一条里的那「一条」:左 Vim 模式标 · 语言/编码/换行符;中 载入进度 /
 * 存盘读数;右 存盘 · 完成编辑 · Vim 开关 · 这一型自己的开关 · 刷新 · 检索 · 行号。
 *
 * ── 它为什么能整块搬出来 ────────────────────────────────────────────────
 * 它**只吃 props**(19 格 + 6 个回调),一个 store 都不订、一次 effect 都不起。
 * 也就是说它早就是一块纯投影,只是从前长在同一个文件里 —— 拆出来是把这件
 * 事实写进目录结构,不是一次改造。样式仍走 `FileViewer.module.css`
 * (`.status` / `.statusLink` / `.statusMid` 那一族):**皮肤是查看器这块面的,
 * 不是这条带子自己的**,拆 CSS 会让「同一块面的配方在两个文件里」。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:无。纯函数组件 —— 没有订阅、没有计时器、没有 ref,
 *     挂载即画、卸载即无,所以也不需要 HMR dispose。
 *  ② UI 生命状态:中段那一格是**唯一**会换形的地方,五档按次序判一次:
 *     读取中 → 截断(载入了百分之几 + 「读更多」)→ 冲突 → 存盘失败 → 刚存过 → 空。
 *     「还在读」压过「载入了百分之几」,因为后者说的是上一份已经到手的内容。
 *  ③ UI 交互状态(逐格,律③):
 *     · **存盘**   rest / hover / focus / **pending**(`saving` = 禁用 + 换字
 *       「正在保存…」+ `aria-busy`;忙态读自写路 `viewerSaveMutation` 的逐格
 *       pending,不是一颗共享布尔)/ disabled(= pending,这一颗没有别的禁用源);
 *     · **完成编辑 / 读更多 / 检索 / 行号** rest / hover / focus —— 它们是同步动作,
 *       没有 pending 也没有 disabled 档;
 *     · **刷新**(09-22)rest / hover / focus / **pending**(读在飞时禁用 +
 *       `aria-busy`;忙态读的是同一格 `reading`,与中段那句「正在读取…」同源);
 *     · **Vim 开关与这一型自己的开关** 另加一格 `aria-pressed`(按下去了没有),
 *       视觉上是 `.statusLinkOn`;
 *     · 整条带子没有 hover 底、没有 active 位 —— 它是读数带,不是列表。
 */
export interface ViewerStatusBarProps {
  t: TFn
  file: ViewerFile | null
  view: ViewerView
  lineCount: number | undefined
  status: string | undefined
  statusItems: ViewerStatusItem[]
  /**
   * 存盘这一格在不在飞。**它是 `viewerSaveMutation` 逐格算出来的读数**
   * (`useAsyncPending(…, saveKey)`),不是 store 上一颗共享布尔 ——
   * 门规则 `async-busy-boolean` 只扫 `.ts`,组件收一个布尔 prop 是合规的下游写法。
   */
  saving: boolean
  /** 那一格的键(`save:<path>`)。没开文件时缺席。 */
  saveKey: string | undefined
  savedAt: number | undefined
  saveError: string | undefined
  conflict: boolean
  editing: boolean
  /** 手上有没有在飞的读。**从檐上搬下来的**(09-01 裁定:头只放身份,脚放读数)。 */
  reading: boolean
  onSave: () => void
  onEditDone: () => void
  onJump: () => void
  onFind: () => void
  onKeymap: (id: string) => void
  onLoadMore: () => void
  /**
   * **刷新** —— 把盘上此刻那一份重新拿过来(09-22)。
   *
   * 它与旁边那颗「读更多」是两件事:读更多说的是**同一次阅读继续往下**(截断了的
   * 那一型才有),刷新说的是**这份东西在盘上变了**(每一型都成立 —— 图与播放条
   * 也算,它们由数据层换一条 src 来重取)。
   */
  onReload: () => void
}

export function ViewerStatusBar({
  t,
  file,
  view,
  lineCount,
  status,
  statusItems,
  saving,
  saveKey,
  savedAt,
  saveError,
  conflict,
  editing,
  reading,
  onSave,
  onEditDone,
  onJump,
  onFind,
  onKeymap,
  onLoadMore,
  onReload,
}: ViewerStatusBarProps) {
  const vim = view.keymap === 'vim'
  const keymaps = listKeymaps()
  const truncated = file && 'truncated' in file && file.truncated ? file : null
  const percent = truncated ? Math.min(99, Math.round((truncated.loaded / truncated.size) * 100)) : 0

  return (
    <div className={s.status} data-testid="viewer-status">
      {vim && (
        <span
          className={`${s.vimMode} ${view.vimMode === 'insert' ? s.vimInsert : s.vimNormal}`}
          data-testid="viewer-vim-mode"
        >
          {view.vimMode === 'insert' ? 'INSERT' : 'NORMAL'}
        </span>
      )}
      {status && <span className={s.statusFact}>{status}</span>}

      {/* 中段:载入进度 / 存盘读数。它是这一行里唯一的弯腰件。 */}
      <span className={s.statusMid}>
        {/*
         * 「正在读取…」从檐上搬到了这里(裁定:头只放身份与关闭)。它排在最前 ——
         * 「还在读」压过「载入了百分之几」,后者说的是上一份已经到手的内容。
         * Spinner 出现在状态栏是允许的两处之一(禁令区:钮内或状态栏)。
         */}
        {reading ? (
          <span className={s.statusNote} data-testid="viewer-inflight">
            {/* ui-consume-allow: spinner-placement — 这里是查看器**底部状态栏**那条带子
                (.statusMid 是它的中段),不是内容区、不是卡:允许位的第二个。
                批 6 已经把这一面**其余四处**判掉了(首载内容区 / 详情浮层 /
                工具行 / 研究段),留下的就是这一颗。 */}
            <Spinner label={t('viewer.reading')} />
            {t('viewer.reading')}
          </span>
        ) : truncated ? (
          <>
            <span className={s.statusNote}>
              {t('viewer.loadedPercent', { percent: `${percent}`, size: formatBytes(truncated.size) })}
            </span>
            <ButtonBase className={s.statusLink} onClick={onLoadMore}>
              {t('viewer.loadMore')}
            </ButtonBase>
          </>
        ) : conflict ? (
          <span className={s.statusWarn}>{t('viewer.conflict')}</span>
        ) : saveError ? (
          <span className={s.statusWarn}>{saveError}</span>
        ) : savedAt ? (
          <span className={s.statusNote} data-testid="viewer-saved">
            {t('viewer.saved')}
          </span>
        ) : null}
      </span>

      {editing && (
        /*
         * ③ 异步钮的 pending 态:存盘在飞时禁用并换字,不给第二次机会。
         *
         * **这一颗不换 `ui/AsyncButton`**(09-02 批 6 的一处如实偏离):那件的身子
         * 是 `ui/Button`(28 高、描边、字重 600),而这一排是 26 高状态栏里的
         * mono 动作链接 —— 换过去这一行就不再是读数带了,那不是等价替换。
         * 律③要的两件(禁用 + 换字)这里一件不少;**忙态的产地**已经按批 6 的
         * 本意换成了写路逐格(`saving` 由 `useAsyncPending(mutation, saveKey)` 算),
         * 这正是这次迁移真正要治的那一格。`saveKey` 在这里不消费,但它跟着
         * 传下来一格 —— 读数是按哪一格算的,状态栏说得出口。
         */
        <ButtonBase
          className={s.statusLink}
          disabled={saving}
          aria-busy={saving || undefined}
          data-save-key={saveKey}
          data-testid="viewer-save"
          onClick={onSave}
        >
          {t(saving ? 'common.saving' : 'viewer.save')}
        </ButtonBase>
      )}
      {editing && (
        /*
         * 「完成编辑」。铅笔退役之后,**编辑框自己那一屏上得有一个出口** ——
         * 右键在编辑框里让给了文本域(粘贴 / 撤销),菜单那条路要先把指针挪出
         * 编辑区才走得通,那不该是唯一的出口。它与旁边那颗「保存」同族:
         * 状态栏上本来就有动作链接,这里不是新开一类。
         */
        <ButtonBase className={s.statusLink} data-testid="viewer-edit-done" onClick={onEditDone}>
          {t('viewer.editDone')}
        </ButtonBase>
      )}

      {/* Vim 开关。档只是一张表,换档即时生效且不重挂查看器。 */}
      {keymaps.length > 1 && (
        <ButtonBase
          className={vim ? `${s.statusLink} ${s.statusLinkOn}` : s.statusLink}
          aria-pressed={vim}
          data-testid="viewer-vim-toggle"
          onClick={() => onKeymap(vim ? 'default' : 'vim')}
        >
          {t('viewer.keymapVim')}
        </ButtonBase>
      )}

      {statusItems.map((item) => (
        <ButtonBase
          key={item.id}
          className={item.on ? `${s.statusLink} ${s.statusLinkOn}` : s.statusLink}
          aria-pressed={item.on}
          onClick={item.onToggle}
        >
          {t(item.labelKey)}
        </ButtonBase>
      ))}

      {/*
       * **刷新**。手上有一份内容才画得出来 —— 没有内容时「重读」无从谈起
       * (那一帧屏幕上本来就正在读它)。
       *
       * ③ 逐格交互状态:rest / hover / focus,外加**一格 pending** —— 读在飞时
       * 禁用并 `aria-busy`(律③)。它不换字:这一行中段此刻正写着「正在读取…」,
       * 同一句话在一行里说两遍是噪音。
       */}
      {file && (
        <ButtonBase
          className={s.statusLink}
          disabled={reading}
          aria-busy={reading || undefined}
          data-testid="viewer-reload"
          onClick={onReload}
        >
          {t('viewer.refresh')}
        </ButtonBase>
      )}

      {/*
       * 检索(⌘F)。它是**键盘那条路的鼠标口** —— 组件消费义务的同款道理:
       * 一件只有快捷键能做到的事,对不知道那个键的人等于不存在。
       * 与「行 n:1 ⌘L」同一族(两者开的是同一条跳转条,只差一个前缀)。
       */}
      {lineCount !== undefined && (
        <ButtonBase className={s.statusLink} data-testid="viewer-find" onClick={onFind}>
          {t('viewer.findReadout')}
        </ButtonBase>
      )}
      {lineCount !== undefined && (
        <ButtonBase className={s.statusLink} data-testid="viewer-jump" onClick={onJump}>
          {t('viewer.lineReadout', { line: `${view.currentLine || 1}` })}
        </ButtonBase>
      )}
    </div>
  )
}
