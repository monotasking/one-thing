import { useState } from 'react'
import { TriangleAlert } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Input } from '../../ui/Input'
import type { TFn } from '../../i18n'
import { useAsyncPending } from '../../data/kernel'
import { sessionMutation, useSessionsSource, workdirKey } from '../../data/sessions-source'
import s from '../FilesPanel.module.css'

/**
 * 无工作目录告知条。**一条带子,不是一块面**:它说一句事实,并给出唯一那个
 * 能改变这件事实的动作。
 *
 * 「绑定…」为什么是**一行输入**而不是一个系统目录选择器:这层壳里没有 dialog 桥
 * (`shell:invoke` 的 `dialog` 域住在 Electron 宿主里,而这块面在 web 面上也要能用)。
 * 与其画一颗点了什么都不发生的「浏览…」,不如老老实实收一条绝对路径 ——
 * 后端 `updateWorkingDirectory` 本来收的也正是一条路径。记档:有了 dialog 桥之后
 * 这里应当补一颗「浏览…」,而不是把这条输入行删掉(键盘用户仍然要它)。
 *
 * ── 两件库件量过之后**没有迁**(09-02 批 9d,逐条记规范修正)────────────────
 *  · 告知条 → `ui/Card`:**不迁**。量下来五处非零差,而且每一处都是语义差不是
 *    抄漏 —— 卡是 `flex-direction: column` + 四边 `--sp-3` 内边距 + `--r-2` 圆角 +
 *    四边边线 + `--surface-2` 底;这条带子是横排、定高 `--files-notice-h`、
 *    左右 `--sp-3` 上下 0、只有一条下边线、warn 8% 晕底。把它塞进卡里不是迁移,
 *    是把一条带子改画成一块面(这个文件头第一句话说的就是它不是一块面)。
 *  · 绑定行 → `ui/Field`:**不迁**。Field 是**竖排表单行**,`label` 是必给的
 *    可见标签;这一行今天没有可见标签(名字走 `aria-label` + placeholder),
 *    横排、错误行 `flex: 1 0 100%` 折到第二行、字号 `--fs-nano`(Field 的
 *    `.error` 是 `--fs-micro`)。迁过去要凭空造一句可见标签 —— 那是改版。
 *    **留账**:Field 真正值钱的那一格是 `aria-describedby`(把错误那句话关联到
 *    输入框上),这一行今天没有。本批**不在业务面手写它**(基础件先行:手写
 *    等于把库件职责又摊回一份),正解是给 `ui/Field` 补一档「横排 / 无可见标签」
 *    的形 —— 那要动 `src/ui`,不在本批可动面里。
 *
 * ── 三张状态表(状态先行)────────────────────────────────────────────────
 *  ① 生命周期:两形(告知条 / 绑定行)由本地 `editing` 切,**切的是同一次挂载**;
 *     绑定行一挂上就把光标放进去(`focusFieldOnMount`,理由见那个函数)。
 *     零订阅副作用、零计时器 → 不需要 HMR dispose。`sessionId` 换掉时它不重置
 *     `editing` —— 但忙态跟着换(键里带着会话 id,见 ③)。
 *  ② UI 生命状态:`empty`(没有当前会话:只说事实,不画一颗按不响的钮)/
 *     `ready`(告知条)/ `editing`(绑定行)/ `error`(绑不上,后端原话跟在后面,
 *     **输入行不收** —— 用户刚打的那条路径还在,改一个字就能重试)。
 *     没有 loading 档:这一条不读任何东西。
 *  ③ UI 交互状态:「绑定…」rest/hover(下划线)/focus(全局环);输入框
 *     rest/focus/invalid(边线转 danger);确认钮 rest/hover/focus/**pending**
 *     (`AsyncButton`:立刻 disabled + `aria-busy`,150ms 后才换字)/disabled
 *     (路径为空)。**pending 只有一个产地**:`sessionMutation` 的
 *     `workdir:<sessionId>` 那一格 —— 逐会话记账(律③要的是逐格,不是整面一颗),
 *     别处发起的那一发也照说,别的会话在飞则这里不动。
 */
export function NoWorkdirNotice({ sessionId, t }: { sessionId: string; t: TFn }) {
  const setWorkingDirectory = useSessionsSource((st) => st.setWorkingDirectory)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  /*
   * ── 忙态**读**自 mutation,不再自己记一格(7d 结掉批 6 留的那笔账)────────
   * 它护的不是一个文件操作,而是 `sessions-source` 的 `setWorkingDirectory`
   * ——「把这条会话挪到这个目录」那一口后端写,已经迁进了 `sessionMutation`
   * (键 `workdir:<sessionId>`)。这里只读,不记第二份真相。
   *
   * 钮那一侧从批 9d 起交给 `ui/AsyncButton`(它自己就吃这一格);这里留下的
   * 这一句只服务 `submit` 的**二次闸** —— 钮已经 disabled 了还要拦一道,
   * 是因为 ↵ 也走同一条路(输入框上的回车不经过那颗钮)。
   */
  const busy = useAsyncPending(sessionMutation, workdirKey(sessionId))

  const submit = async () => {
    const dir = value.trim()
    if (!dir || busy) return
    const outcome = await setWorkingDirectory(sessionId, dir)
    if (outcome.ok) {
      setEditing(false)
      setValue('')
      setError(null)
      return
    }
    // 失败**留在原地说**:输入行不收,用户刚打的那条路径还在,改一个字就能重试。
    setError(outcome.error)
  }

  if (!editing) {
    return (
      <div className={s.notice} data-testid="files-no-workdir">
        <TriangleAlert className={s.noticeIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.noticeText}>{t('files.rootFallback')}</span>
        {/* 没有当前会话就没有可绑的对象 —— 那时只说事实,不画一颗按不响的钮。 */}
        {sessionId && (
          <ButtonBase className={s.noticeAction} onClick={() => setEditing(true)}>
            {t('files.bind')}
          </ButtonBase>
        )}
      </div>
    )
  }

  return (
    <div className={s.bindRow} data-testid="files-bind-row" ref={focusFieldOnMount}>
      <Input
        size="sm"
        className={s.bindInput}
        value={value}
        onValueChange={setValue}
        invalid={Boolean(error)}
        aria-label={t('files.bindPlaceholder')}
        placeholder={t('files.bindPlaceholder')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
      {/*
       * 律③的另一半(09-02 批 9d 补齐,批 6 记的那笔账):忙起来这颗钮从前
       * 只是变灰 + `aria-busy`,**眼睛看得见的只有灰**——而灰是「不能点」,
       * 不是「在办了」。`ui/AsyncButton` 把两件事分开:disabled 与 `aria-busy`
       * 立刻(它们挡的是连点),换字等 150ms(比这更快回来的请求根本不该
       * 报告自己在忙 —— E 型闪的判例)。规范修正:忙 150ms 以上时钮上的字
       * 从「确认」变成「正在保存…」,**这是新增的可感知反馈**,不是像素漂移。
       */}
      <AsyncButton
        variant="primary"
        action={sessionMutation}
        pendingKey={workdirKey(sessionId)}
        pendingLabel={t('common.saving')}
        disabled={!value.trim()}
        onClick={() => void submit()}
      >
        {t('common.confirm')}
      </AsyncButton>
      <Button onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
      {error && (
        <span className={s.bindError}>
          {t('files.bindFailed')}
          <span className={s.noteDetail}>{error}</span>
        </span>
      )}
    </div>
  )
}

/**
 * 输入行一出现就把光标放进去。
 *
 * **不用 `autoFocus`**:那个属性是「页面一加载就抢焦点」,jsx-a11y 拦它拦得对 ——
 * 但这里的语义完全不同:用户刚**亲手点了**「绑定…」,焦点跟着那一下走是他要的结果
 * (与 Menu 开启时把焦点移进容器同一条口径)。所以走一颗回调 ref:元素挂上来的
 * 那一刻放焦点,元素卸载时(ref 收到 null)什么都不做。
 */
function focusFieldOnMount(node: HTMLDivElement | null): void {
  node?.querySelector('input')?.focus()
}
