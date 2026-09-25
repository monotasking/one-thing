import { useState } from 'react'
import { TriangleAlert } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { useInlineEdit } from '../../ui/inline-edit'
import type { TFn } from '../../i18n'
import { useAsyncPending } from '../../data/kernel'
import { sessionMutation, useSessionsSource, workdirKey } from '../../data/sessions-source'
import { pickDirectoryNative } from '../../data/dialog-port'
import s from '../FilesPanel.module.css'

/**
 * 无工作目录告知条。**一条带子,不是一块面**:它说一句事实,并给出唯一那个
 * 能改变这件事实的动作。
 *
 * 「绑定…」先开**系统目录选择器**(`dialog` RPC 域,2026-09-24):挑到了直接绑;
 * 用户取消就什么都不做。这台宿主没有对话框(浏览器壳连的独立 server)才展开下面
 * 那一行路径输入 —— 后端 `updateWorkingDirectory` 本来收的就是一条路径。
 * 对话框挑的路径绑不上时也落到那一行:路径填好、错话跟在后面,改一个字就能重试。
 *
 * ── 两件库件量过之后**没有迁**(09-02 批 9d,逐条记规范修正)────────────────
 *  · 告知条 → `ui/Card`:**不迁**。量下来五处非零差,而且每一处都是语义差不是
 *    抄漏 —— 卡是 `flex-direction: column` + 四边 `--sp-3` 内边距 + `--r-2` 圆角 +
 *    四边边线 + `--surface-2` 底;这条带子是横排、定高 `--files-notice-h`、
 *    左右 `--sp-3` 上下 0、只有一条下边线、warn 8% 晕底。把它塞进卡里不是迁移,
 *    是把一条带子改画成一块面(这个文件头第一句话说的就是它不是一块面)。
 *  · 绑定行 → `ui/Field`:9d **不迁**、批 10 **迁了**。9d 记的三条(竖排 /
 *    必给可见标签 / 错误折行)说的都是库件当时缺的形;同一个缺口在
 *    WorkspaceOverview 与 AddModelRow 又各撞一次之后,编排裁定给库件开档:
 *    `layout="inline"` + `labelHidden` 正是照这一行的形立的(错误那条
 *    `flex: 1 0 100%` 逐字搬进了 `ui/Field.module.css`)。9d 留的那笔账
 *    ——「错误没有跟输入框关联」—— 随之结清:`aria-describedby` 由 error 槽给。
 *    **规范修正**:那句「绑不上」从 `--fs-nano`(10px)升到库件常规档的
 *    `--fs-micro`(11px)。库件把间距与附注字号绑在同一个 `size` 旋钮上,
 *    而这一行的间距是 `--sp-2` = 常规档;取紧凑档能拿回 10px 却要把 gap 从
 *    8px 收成 4px —— 那是把休止态整行的几何改掉,代价大得多。
 *    读下来反而更对:错误那**一句话** 11px 在前,跟在后面的路径**原文**
 *    (`.noteDetail`,仍是 10px 等宽字)在后,主次是分开的。
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

  /** 「绑定…」:系统对话框优先;没有对话框退到路径输入行。 */
  const bind = async () => {
    if (busy) return
    const picked = await pickDirectoryNative({ title: t('files.bindTitle') })
    if (picked.kind === 'canceled') return
    if (picked.kind === 'unavailable') {
      setEditing(true)
      return
    }
    const outcome = await setWorkingDirectory(sessionId, picked.path)
    if (outcome.ok) return
    setValue(picked.path)
    setError(outcome.error)
    setEditing(true)
  }

  if (!editing) {
    return (
      <div className={s.notice} data-testid="files-no-workdir">
        <TriangleAlert className={s.noticeIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.noticeText}>{t('files.rootFallback')}</span>
        {/* 没有当前会话就没有可绑的对象 —— 那时只说事实,不画一颗按不响的钮。 */}
        {sessionId && (
          <ButtonBase className={s.noticeAction} onClick={() => void bind()}>
            {t('files.bind')}
          </ButtonBase>
        )}
      </div>
    )
  }

  return (
    <Field
      layout="inline"
      labelHidden
      label={t('files.bindPlaceholder')}
      error={
        error ? (
          <span className={s.bindError}>
            {t('files.bindFailed')}
            <span className={s.noteDetail}>{error}</span>
          </span>
        ) : undefined
      }
      className={s.bindRow}
      data-testid="files-bind-row"
    >
      <BindInput
        value={value}
        invalid={Boolean(error)}
        placeholder={t('files.bindPlaceholder')}
        onValueChange={setValue}
        onSubmit={() => void submit()}
        onCancel={() => setEditing(false)}
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
    </Field>
  )
}

/**
 * 输入框那一件。**单独一件是因为 hook 只能在组件里调**:`useFieldControlProps()`
 * 拿的是 `<Field>` 往下发的 context,在 Field 外面那一层调只会拿到空对象。
 *
 * 「一出现就把光标放进去」也住在这里(从前是外壳上一颗 `querySelector('input')`
 * 的回调 ref):Field 交了一个稳定的 id 过来,直接按 id 取 —— 找的是**这一格的
 * 那个** input,不是「壳里第一个」。`data-testid` 留在外壳上,那是这一行的名牌。
 *
 * **不用 `autoFocus`**:那个属性是「页面一加载就抢焦点」,jsx-a11y 拦它拦得对 ——
 * 但这里的语义完全不同:用户刚**亲手点了**「绑定…」,焦点跟着那一下走是他要的结果
 * (与 Menu 开启时把焦点移进容器同一条口径)。
 */
function BindInput({
  value,
  invalid,
  placeholder,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  value: string
  invalid: boolean
  placeholder: string
  onValueChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  /*
   * ── 这一格就是**原地编辑**,所以它消费 `ui/inline-edit`(09-03 R2)──────────
   * 从前这里是三句手写:一条 effect 按 `controlId` 取元素 `focus()`,加 `↵ 落定`
   * 与 `Esc 收回` 两条分支 —— 而那正是 09-02 批 11 立件时点名的那组手势
   * (「基础件先行」:有件必须消费)。迁过去之后这一格一句焦点代码都没有,
   * `.focus()` 从此只在库件那一处(I3 允许的三个产地之一)。
   *
   * `cancelOnBlur` 走缺省的 `false`:这一行旁边还站着一颗「确认」钮,而 `blur`
   * 在 `click` 之前到 —— 打开它会把那颗钮变成永远点不到的(库件文件头的原话)。
   *
   * **规范修正一处**:库件「一进来就选中全文」,而手写那版只 focus 不选。
   * 可感知面只有一种走法:打了几个字 → Esc 收回 → 再点「绑定」重开,那时框里
   * 留着上次那串路径,现在会被选中(接着打就是覆盖)。这是消费库件带来的
   * 规格对齐,逐条记在交卷报里。
   */
  const edit = useInlineEdit({ controlId: field.id, onCommit: onSubmit, onCancel })
  return (
    <Input
      {...field}
      size="sm"
      className={s.bindInput}
      value={value}
      onValueChange={onValueChange}
      invalid={invalid}
      placeholder={placeholder}
      {...edit}
    />
  )
}
