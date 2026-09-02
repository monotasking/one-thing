import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, X } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Input } from '../../ui/Input'
import { useConfirm } from '../../ui/Dialog'
import { useMutation } from '../../data/kernel'
import { useT } from '../../i18n'
import { useWorkspaceStore, useWorkspaceViews, workspaceKey, workspaceMutation } from '../store'
import { useStageStore } from '../../stage/store'
import { WORKSPACE_ITEM_ID } from '../../stage/items'
import { announce } from '../../ui/a11y/live-region'
import { WORKSPACE_SWATCHES } from '../types'
import type { WorkspaceSwatch, WorkspaceView } from '../types'
import sw from '../swatch.module.css'
import s from './WorkspaceOverview.module.css'

/**
 * 工作区总览 —— 一块**普通的 Dock 内容**(id 'workspace'),所以它能上舞台 /
 * 变浮窗 / 钉到边,三种形态里长得一模一样。这正是 content/index.tsx 那张表存在的理由。
 *
 * ── 形状 ──────────────────────────────────────────────────────────────
 * 头(标题 + 注脚)/ 一排大卡 / 一张虚线新建卡。
 * 一张卡 = 色带 + 名字 + 事实行 + 一排文字键(改名 / 换色 / 删除…)。
 * 「事实行」说的是**真事实**:是不是默认空间、建于何时 —— 不写「6 家 provider ·
 * 3 个项目」那种今天问不到的数(样例上那两个数是示意,壳这一侧没有它们的产地:
 * per-space 的 provider 设置与项目要各读一次 spaces.getProviderSettings /
 * getOverlay,那是随后端批一起接的事)。宁可少说一句,不编。
 *
 * ── 三条硬规矩(08-31 拍板) ─────────────────────────────────────────────
 *  · 当前卡描 accent 边(它同时也是「我在哪」的第二处指示);
 *  · **当前卡不给删** —— 删掉脚下这块地会让「当前」当场变成幽灵;
 *  · 删除走**两段确认**:第一段说清后果,第二段要一次单独的点头。
 *    默认空间由后端拒(code=DEFAULT_SPACE),界面上照样不画那颗键 ——
 *    让人点一下再被拒,和一开始就不给,是两种尊重程度。
 */
export function WorkspaceOverview() {
  const t = useT()
  const views = useWorkspaceViews()
  const status = useWorkspaceStore((st) => st.status)
  const error = useWorkspaceStore((st) => st.error)
  const load = useWorkspaceStore((st) => st.load)
  const switchTo = useWorkspaceStore((st) => st.switchTo)
  const createWorkspace = useWorkspaceStore((st) => st.createWorkspace)
  const rename = useWorkspaceStore((st) => st.rename)
  const recolor = useWorkspaceStore((st) => st.recolor)
  const remove = useWorkspaceStore((st) => st.remove)
  const confirm = useConfirm()

  /*
   * 忙态是**逐格**读的(交互稳定律③)。从前这里读的是 store 上一颗全局 `busy`
   * 布尔,于是改 A 的名字会把 B、C 两张卡的六颗钮一起禁灰 —— 病型 B(粒度病)。
   * 现在读的是写路那只 mutation 的在飞格子表,一张卡只认自己那三格。
   *
   * 表在**渲染体外**算一次(useMemo),不在 zustand 选择器里现算:选择器每次
   * 返回新对象会让 `useSyncExternalStore` 判定「变了」而无限重渲(poolViewOf 判例)。
   * `pendingKeys` 与 `views` 都是身份稳定的快照,所以这颗 memo 真的只在写路
   * 起落或列表变化时重算。
   */
  const pendingKeys = useMutation(workspaceMutation).pendingKeys
  const cardPending = useMemo(
    () =>
      new Map(
        views.map((v) => [
          v.id,
          {
            rename: pendingKeys.has(workspaceKey.rename(v.id)),
            recolor: pendingKeys.has(workspaceKey.recolor(v.id)),
            remove: pendingKeys.has(workspaceKey.remove(v.id)),
          },
        ]),
      ),
    [views, pendingKeys],
  )

  /** 此刻正在改名的那张卡(null = 没有)。同一时刻只有一张 —— 两个输入框会打架。 */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 此刻摊开换色盘的那张卡。与改名互斥:一张卡上一次只做一件事。 */
  const [coloring, setColoring] = useState<string | null>(null)
  /** 新建那张卡此刻是不是在收名字。 */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const startRename = (view: WorkspaceView) => {
    setColoring(null)
    setDraft(view.name)
    setEditing(view.id)
  }

  const commitRename = async (id: string) => {
    const next = draft
    setEditing(null)
    await rename(id, next)
  }

  const pickColor = async (id: string, swatch: WorkspaceSwatch) => {
    setColoring(null)
    await recolor(id, swatch)
  }

  /**
   * 建一个并去那儿。**建完必须留在这块面上** —— 09-01 报障 ②(截图
   * `I-ws-after-create.png`):建完总览当场关掉、屏幕回到「No session selected yet」,
   * 用户看不到自己刚建的那张卡。
   *
   * 病根不是「建」写错了,是**「建」与「切」绑成一步,而切换会换整套家具**
   * (T-W1):一块面开着没有本身就是家具,新空间没开过总览,于是它当场关掉。
   * 那条隔离是对的,不改;要改的是这个动作对用户的承诺 —— 它说的是「去那儿看看」,
   * 就得让人看得见。
   *
   * 修法:切换之前记下这块面此刻的**落点**,建完在新空间里按同一个落点开回来。
   * 不是「禁止切换关面」那种一刀切(那会把 T-W1 的隔离撬开),而是这一个动作
   * 自己把它带过去 —— 谁承诺的谁兑现。
   *
   * 顺带两件小的:新卡滚进视野 + 播报一句。**不抢焦点** —— 当前那张卡的
   * 切换钮是 `disabled`(点了什么都不会变的钮不该存在),焦点没有合法落点,
   * 硬造一个反而会把键盘用户丢在一个说不清的地方;高亮由 `data-current` 与
   * `.cardCurrent` 画,那已经是「刚建的是哪一张」的答案。
   */
  const commitCreate = async () => {
    const name = newName
    setCreating(false)
    setNewName('')
    const placement = useStageStore.getState().placements[WORKSPACE_ITEM_ID]
    const id = await createWorkspace(name)
    if (!id) return
    if (placement) useStageStore.getState().openAs(WORKSPACE_ITEM_ID, placement)
    // 等这一帧把新卡画出来再去找它。
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-testid="workspace-card-${id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      announce(t('workspace.createdAnnounce', { name }))
    })
  }

  /**
   * 两段确认。第一段说清**后果**(这个空间的 per-space 设置与凭证会一起没),
   * 第二段只问一句「真的?」—— 两段不是仪式,是给「我是不是点错了」留的那一拍。
   */
  const askRemove = async (view: WorkspaceView) => {
    const first = await confirm({
      title: t('workspace.removeTitle', { name: view.name }),
      description: t('workspace.removeConsequence'),
      confirmLabel: t('workspace.removeNext'),
    })
    if (!first) return
    const second = await confirm({
      title: t('workspace.removeConfirmTitle', { name: view.name }),
      confirmLabel: t('workspace.removeFinal'),
    })
    if (!second) return
    await remove(view.id)
  }

  return (
    <div className={s.panel} data-testid="workspace-overview">
      <div className={s.head}>
        <h2 className={s.title}>{t('item.workspace')}</h2>
        {status === 'error' && <p className={s.headError}>{error ?? t('workspace.loadFailed')}</p>}
        {/*
          本批唯一那句注脚,也是这一批最要紧的一句实话:切换改变的是这台壳记住的
          当前工作区,引擎那一侧还没有跟着换。留账见 workspace/apply.ts 文件头。
        */}
        <p className={s.note}>{t('workspace.scopeNote')}</p>
      </div>

      <div className={s.cards}>
        {views.map((view) => {
          /** **这一张卡**此刻在飞的那几格。别人家的写一格都进不来。 */
          const flying = cardPending.get(view.id)
          return (
          <div
            key={view.id}
            className={view.isCurrent ? `${s.card} ${s.cardCurrent}` : s.card}
            data-testid={`workspace-card-${view.id}`}
            data-current={view.isCurrent ? 'true' : undefined}
          >
            <span className={`${s.band} ${sw[view.swatch]}`} aria-hidden="true" />

            <div className={s.body}>
              {editing === view.id ? (
                <RenameField
                  value={draft}
                  label={t('workspace.renameLabel')}
                  onChange={setDraft}
                  onCommit={() => void commitRename(view.id)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                /* 整张卡的主动作 = 切过去。当前那张不再是按钮:点它无事发生,
                 * 那种「按下去什么都没变」的按钮是最招人烦的一类。 */
                <ButtonBase
                  /* 卡上的名字**就是**主动作(点它 = 切过去):它是这张卡的标题
                   * 而不是一颗钮,视觉本该定制 —— 裸钮三类判第③类,`ui/ButtonBase`。 */
                  className={s.name}
                  disabled={view.isCurrent}
                  data-testid={`workspace-switch-${view.id}`}
                  onClick={() => switchTo(view.id)}
                >
                  {view.name}
                </ButtonBase>
              )}

              <p className={s.facts}>
                {view.isDefault ? t('workspace.factDefault') : t('workspace.factCreated')}
                {view.isCurrent && <span className={s.factCurrent}>{t('workspace.current')}</span>}
              </p>
            </div>

            {coloring === view.id && (
              <div className={s.swatches} role="group" aria-label={t('workspace.recolorLabel')}>
                {WORKSPACE_SWATCHES.map((swatch) => (
                  /* 色片是结构件(一枚色标,底色**就是**它的内容)→ `ui/ButtonBase`。
                   * 刻意不迁 `ui/IconButton`:那件明说底色不许从外面换。 */
                  <ButtonBase
                    key={swatch}
                    className={`${s.swatch} ${sw[swatch]}`}
                    aria-label={t(`workspace.color.${swatch}`)}
                    aria-pressed={swatch === view.swatch}
                    data-testid={`workspace-swatch-${view.id}-${swatch}`}
                    onClick={() => void pickColor(view.id, swatch)}
                  >
                    {swatch === view.swatch && (
                      <Check className={s.swatchMark} strokeWidth={2.5} aria-hidden="true" />
                    )}
                  </ButtonBase>
                ))}
              </div>
            )}

            {/* 三枚文字键全部消费 `ui/Button`(ghost);`.op` 皮肤留着当**落点**
              * ——「一排文字键」是这张卡的定稿形制(accent 字色、fs-micro、
              * 不占 28px 定高),所以本地把 height / padding / border / 字号收回,
              * 只让库件管交互态与 disabled。 */}
            <div className={s.ops}>
              <Button
                className={s.op}
                disabled={flying?.rename}
                data-testid={`workspace-rename-${view.id}`}
                onClick={() => startRename(view)}
              >
                {t('workspace.rename')}
              </Button>
              <Button
                className={s.op}
                disabled={flying?.recolor}
                data-testid={`workspace-recolor-${view.id}`}
                onClick={() => {
                  setEditing(null)
                  setColoring(coloring === view.id ? null : view.id)
                }}
              >
                {t('workspace.recolor')}
              </Button>
              {/* 当前卡与默认空间都不给这一档 —— 理由见文件头的三条硬规矩。 */}
              {!view.isCurrent && !view.isDefault && (
                <Button
                  className={`${s.op} ${s.opDanger}`}
                  disabled={flying?.remove}
                  data-testid={`workspace-remove-${view.id}`}
                  onClick={() => void askRemove(view)}
                >
                  {t('workspace.remove')}
                </Button>
              )}
            </div>
          </div>
          )
        })}

        {creating ? (
          <div className={`${s.card} ${s.cardNew}`}>
            <div className={s.body}>
              <RenameField
                value={newName}
                label={t('workspace.createLabel')}
                onChange={setNewName}
                onCommit={() => void commitCreate()}
                onCancel={() => {
                  setCreating(false)
                  setNewName('')
                }}
              />
            </div>
          </div>
        ) : (
          /*
           * 虚线新建卡。它仍然是**一张卡**(与旁边那几张同宽同高),皮肤一个像素
           * 不动 —— 但它同时是**发起「建一个工作区」那一发写的控件**,而律③要求
           * 进行中反馈长在发起它的那个控件上。所以它从 `ui/ButtonBase` 换成
           * `ui/AsyncButton`(=`ui/Button` + 逐格忙态):忙态是**读来的**
           * (`workspaceMutation` 的 create 那一格),不是本地记的一份。
           *
           * 换件带来的几何由 `.newCard` 收回(定高 / 内边距 / flex 三条),
           * 逐条理由写在 `WorkspaceOverview.module.css` 那一节 —— 与三枚文字键
           * 迁 `ui/Button` 时的做法逐字相同。
           *
           * 顺序说明:`commitCreate` 是先 `setCreating(false)` 再 `await
           * createWorkspace`,所以写在飞的那一程,屏幕上站着的正是这张卡。
           */
          <AsyncButton
            className={s.newCard}
            action={workspaceMutation}
            pendingKey={workspaceKey.create()}
            /* 零新键:复用那句通用的「正在保存…」(ModelCatalog 的手填提交也用它)。 */
            pendingLabel={t('viewer.saving')}
            data-testid="workspace-create"
            onClick={() => setCreating(true)}
          >
            <Plus className={s.newIcon} strokeWidth={1.75} aria-hidden="true" />
            {t('workspace.create')}
          </AsyncButton>
        )}
      </div>
    </div>
  )
}

/**
 * 改名 / 新建共用的那一格。抽出来不是为了省行数,是为了让「↵ 落定、Esc 收回、
 * 一进来就选中全文」这三条**只成立一次** —— 两处各写一遍必然漂。
 */
function RenameField({
  value,
  label,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  label: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const t = useT()
  /*
   * 焦点从**外壳**上找里面那个 input:`ui/Input` 今天不转发 ref
   * (它的 props 是 InputHTMLAttributes 的子集,`ref` 不在其中)。给它加一格
   * 转发是改公共组件的形状 —— 那是组件库那一批的事,不该由一块业务面顺手改。
   * `autoFocus` 也不用:那颗 prop 在 jsx-a11y 里是有争议的一档,而这里
   * 「一进来就选中全文」本来也需要拿到元素。
   */
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current?.querySelector('input')
    el?.focus()
    el?.select()
  }, [])
  return (
    <div className={s.field} ref={box}>
      <Input
        size="sm"
        value={value}
        onValueChange={onChange}
        aria-label={label}
        data-testid="workspace-name-input"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <Button iconOnly aria-label={t('common.confirm')} onClick={onCommit}>
        <Check className={s.fieldIcon} strokeWidth={2} aria-hidden="true" />
      </Button>
      <Button iconOnly aria-label={t('common.cancel')} onClick={onCancel}>
        <X className={s.fieldIcon} strokeWidth={2} aria-hidden="true" />
      </Button>
    </div>
  )
}
