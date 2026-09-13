import { useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { useInlineEdit } from '../../ui/inline-edit'
import type { TFn } from '../../i18n'
import s from './SessionRow.module.css'

/**
 * **那一行的标题原地换成一只输入框**(A2;正本 §2 拍板 5 的「重命名」)。
 *
 * 手势一个字都不自己写:整件消费 `ui/inline-edit`(↵ 落定 / Esc 收回 /
 * 一进来就选中全文;失焦那一档**关着**,见下一段),形归 `ui/Field`
 * (`layout="inline"` + `labelHidden`)
 * 与 `ui/Input`。与 `providers/CredentialPool` 的密钥行、`workspace/WorkspaceOverview`
 * 的改名格是**同一形**:两件各管一半(手势 / 形),业务面不许各写一份。
 *
 * ── `cancelOnBlur` 为什么**关着**(库件的缺省档;A2 真机改过一次)────────────
 * 第一稿按「没有并肩的钮就打开它」选了 `true`(规格页那一形就是这么用的)。
 * **真机当场证伪**,读数与病根写在下一段:那一下失焦不是人点走的,是响应链的
 * 结构性归还 —— 于是「失焦即取消」把这块功能整件吃掉(点了重命名什么都没发生)。
 *
 * 所以这一形吃库件的缺省:**失焦什么都不做**,落定只有 ↵、收回只有 Esc。
 * 那两条判据在这里都还成立,而「点到别处」这一档由别的路收场:
 *  · 点另一条会话 → `enterSession` 那条迁移把 `renamingId` 清掉(形态归位);
 *  · 对另一行点「重命名…」→ `startRename` 直接换人,前一格随组件卸载。
 * 留在屏上的只有「点到空处」这一档 —— 一只还开着的框,Esc 收得回。
 * **这处与派工单「失焦取消或提交按库件既有语义」的关系:取的正是库件的既有
 * 语义(`cancelOnBlur` 缺省 false = 失焦不取消),记在 A2 的交卷报留账里。**
 *
 * ── 草稿住在这只组件里 ──────────────────────────────────────────────────
 * 它随「这一行此刻在改名」一起生死(`renamingId` 换人 → 这只组件卸载 → 草稿没)。
 * 落进 store 会多出一格「改名已经收了、草稿还留着」的状态,而它对屏幕没有任何
 * 意义(判词在 `expose/types.ts` 的 `renamingId` 上)。
 *
 * ── 真机 bug:这只框「点了重命名什么都没发生」(gate:sessions ⑦b 抓的)────────
 * jsdom 全绿(单测里这条链一路通到底),真机上读数是:2 秒里每 100ms 采一次,
 * 那只框**一次都没在过**;而同一刻从 DOM 节点摸上去读 React fiber,
 * `SessionRowView` 的 props 里 `renaming: true`、它那棵子树却是空的(一次没提交
 * 的 work-in-progress),`document.activeElement` 是**聊天输入框**。
 *
 * 病根是**三件各自都在按设计工作**、凑在一起就坏:
 *  ① 点「重命名…」→ 菜单那一层卸载 → `focus/registry.unregister` 把活动路径缩回
 *    `expose`,并排一拍微任务做**结构性归还**(§4.5 规则 5:关掉什么,焦点回
 *    打开它的地方)—— 而菜单的 `returnTo` 记的是**右键之前**焦点在哪儿,
 *    那一刻正是聊天输入框(⑦a 点过一行会话);
 *  ② 这只框挂载时 `ui/inline-edit` 按 `controlId` 自己 focus + select 一次 ——
 *    它在**同一个作用域内部**移动焦点(I3 明许的那三处之一),所以注册表那格
 *    「这一拍里别人接管了键盘 → 归还作废」的判据**不成立**(`this.focused`
 *    从头到尾都是 `expose`);
 *  ③ 于是归还照跑 → 焦点回输入框 → 这只框 blur → 第一稿的「失焦即取消」
 *    当场收回 → `renamingId` 归 null → 组件卸载。整条链在一帧里跑完,
 *    所以屏幕上什么都没有,而 100ms 的采样一格都抓不到。
 *
 * 修法两句,各治一件,都在**已有的骨架里**说话:
 *  · `cancelOnBlur` 吃库件缺省(见上一段)—— 那一下失焦不是人点走的,
 *    它不该被读成「不改了」;
 *  · 「开的人点名」(§3.5 规则 2):`store.startRename` 走
 *    `activateScopeAfterCommit('expose')`,而 `ExposeView.restingTarget` 的
 *    **第一档**就是下面那格 `data-expose-rename` —— 那副队列的 rAF 那一拍排在
 *    归还那一拍**之后**(判词在 `focus/after-commit.ts`:两个队列都是 FIFO,
 *    而归还是在 React 提交里才排上的),所以最后说话的是「焦点进那只框」。
 * **不**给归还加一句「正在改名吗」的判据:那是在响应链外面再立一套裁决,
 * 与「mouseenter 不写 active」那条判例同一个道理 —— 让这条链根本不存在。
 * 取件口的形与 `data-expose-search` 逐字同一手(不为了一个落点去改库件
 * `ui/Input` 的 props 形状)。
 *
 * ── 三格事件必须在这里截住 ──────────────────────────────────────────────
 * 这只框长在 `role="treeitem"` 那一行**里面**,而那一行身上挂着三件事:
 * `onClick` = 进这条会话、`onPointerDown` = 拖它、`onContextMenu` = 弹动作表。
 * 不截住的话:点一下输入框进了会话(框当场卸载)、按住选词变成拖一条会话、
 * 在框里右键弹出行的菜单。三格都摊在 `Field` 的透传口上(它把 `...rest` 摊到
 * 自己那只 div 上)—— 摊在库件的口上而不是自己套一层 div,免得多一层盒子
 * 影响那一行的 flex 几何。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:`renamingId === 这一行` 那一拍挂载,库件按 `controlId` 自己
 *     focus + select 一次;↵ / Esc / 失焦之后 `renamingId` 归 null,卸载。
 *     无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose;
 *  ② UI 生命状态:只有 ready 一格 —— 初值是屏幕上那个标题,不取数、不会空、
 *     不会错。**错误不在这里**:后端拒了那一下框已经收回了,原话走播报
 *     (`session-actions.commitRenameAndAnnounce`);
 *  ③ UI 交互状态:rest / hover / focus / disabled 全归 `ui/Input`。
 *     **pending 没有**:落定那一刻框就收回,律③要的反馈是行上的字换了
 *     (数据源那一笔乐观补丁),不是一只变灰的框。
 */
export function SessionRename({
  sessionId,
  title,
  t,
  onCommit,
  onCancel,
}: {
  sessionId: string
  /** 初值 = 屏幕上那个标题。 */
  title: string
  /** 父层那一只 `useT()`(与 `SessionRow` 同一格,见它的文件头病历)。 */
  t: TFn
  onCommit: (sessionId: string, newName: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(title)
  const stop = (e: ReactMouseEvent | ReactPointerEvent) => e.stopPropagation()
  return (
    <Field
      label={t('expose.renameLabel')}
      labelHidden
      layout="inline"
      size="sm"
      className={s.rename}
      onClick={stop}
      onPointerDown={stop}
      onContextMenu={stop}
    >
      <SessionRenameInput
        value={draft}
        onChange={setDraft}
        onCommit={() => onCommit(sessionId, draft)}
        onCancel={onCancel}
        testId={`session-row-rename-${sessionId}`}
        placeholder={t('expose.renameLabel')}
      />
    </Field>
  )
}

/**
 * 输入框那一件。**单独一件是因为 hook 只能在组件里调**:`useFieldControlProps()`
 * 要在 `<Field>` 的 context 之内才拿得到东西(在外面那一层调拿到的是空对象,
 * id / aria 全丢)—— 与 `WorkspaceOverview.RenameInput` / `Gallery` 那两处
 * 逐字同一条理由。
 */
function SessionRenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  testId,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
  testId: string
  placeholder: string
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel })
  return (
    <Input
      {...field}
      {...edit}
      size="sm"
      className={s.renameInput}
      value={value}
      onValueChange={onChange}
      placeholder={placeholder}
      data-testid={testId}
      /* 落点的取件口(判词在上面那段病历里)。**空属性**而不是布尔值:
       * 与 `data-expose-search` 逐字同形,选择器一律 `[data-expose-rename]`。 */
      data-expose-rename=""
    />
  )
}
