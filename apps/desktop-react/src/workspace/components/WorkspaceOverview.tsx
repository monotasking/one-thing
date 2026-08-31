import { useEffect, useRef, useState } from 'react'
import { Check, Plus, X } from '../../components/icons'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { useConfirm } from '../../ui/Dialog'
import { useT } from '../../i18n'
import { useWorkspaceStore, useWorkspaceViews } from '../store'
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
  const busy = useWorkspaceStore((st) => st.busy)
  const load = useWorkspaceStore((st) => st.load)
  const switchTo = useWorkspaceStore((st) => st.switchTo)
  const createWorkspace = useWorkspaceStore((st) => st.createWorkspace)
  const rename = useWorkspaceStore((st) => st.rename)
  const recolor = useWorkspaceStore((st) => st.recolor)
  const remove = useWorkspaceStore((st) => st.remove)
  const confirm = useConfirm()

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

  const commitCreate = async () => {
    const name = newName
    setCreating(false)
    setNewName('')
    await createWorkspace(name)
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
        {views.map((view) => (
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
                <button
                  type="button"
                  className={s.name}
                  disabled={view.isCurrent}
                  data-testid={`workspace-switch-${view.id}`}
                  onClick={() => switchTo(view.id)}
                >
                  {view.name}
                </button>
              )}

              <p className={s.facts}>
                {view.isDefault ? t('workspace.factDefault') : t('workspace.factCreated')}
                {view.isCurrent && <span className={s.factCurrent}>{t('workspace.current')}</span>}
              </p>
            </div>

            {coloring === view.id && (
              <div className={s.swatches} role="group" aria-label={t('workspace.recolorLabel')}>
                {WORKSPACE_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className={`${s.swatch} ${sw[swatch]}`}
                    aria-label={t(`workspace.color.${swatch}`)}
                    aria-pressed={swatch === view.swatch}
                    data-testid={`workspace-swatch-${view.id}-${swatch}`}
                    onClick={() => void pickColor(view.id, swatch)}
                  >
                    {swatch === view.swatch && (
                      <Check className={s.swatchMark} strokeWidth={2.5} aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className={s.ops}>
              <button
                type="button"
                className={s.op}
                disabled={busy}
                data-testid={`workspace-rename-${view.id}`}
                onClick={() => startRename(view)}
              >
                {t('workspace.rename')}
              </button>
              <button
                type="button"
                className={s.op}
                disabled={busy}
                data-testid={`workspace-recolor-${view.id}`}
                onClick={() => {
                  setEditing(null)
                  setColoring(coloring === view.id ? null : view.id)
                }}
              >
                {t('workspace.recolor')}
              </button>
              {/* 当前卡与默认空间都不给这一档 —— 理由见文件头的三条硬规矩。 */}
              {!view.isCurrent && !view.isDefault && (
                <button
                  type="button"
                  className={`${s.op} ${s.opDanger}`}
                  disabled={busy}
                  data-testid={`workspace-remove-${view.id}`}
                  onClick={() => void askRemove(view)}
                >
                  {t('workspace.remove')}
                </button>
              )}
            </div>
          </div>
        ))}

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
          <button
            type="button"
            className={s.newCard}
            disabled={busy}
            data-testid="workspace-create"
            onClick={() => setCreating(true)}
          >
            <Plus className={s.newIcon} strokeWidth={1.75} aria-hidden="true" />
            {t('workspace.create')}
          </button>
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
