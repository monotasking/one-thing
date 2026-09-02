import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Field, useFieldControlProps } from '../../ui/Field'
import { IconButton } from '../../ui/IconButton'
import { InlineEditStrip } from '../../ui/InlineEditStrip'
import { Input } from '../../ui/Input'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { Reveal, REVEAL_SCOPE } from '../../ui/Reveal'
import { SecretInput } from '../../ui/SecretInput'
import { Select } from '../../ui/Select'
import { useInlineEdit } from '../../ui/inline-edit'
import { Ellipsis, Pencil } from '../../components/icons'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { ROTATION_POLICIES, cooldownFact, rotationHintFact, rotationLabelFact } from '../projection'
import type { PoolRow, PoolView } from '../projection'
import s from './CredentialPool.module.css'

/**
 * 一坑的凭证池:**顺序即优先级**的密钥列表 + 轮换策略。
 *
 * ── 这块面为什么长这样 ────────────────────────────────────────────────────
 * ① 序号是**画出来的**(1、2、3),因为「第 1 条」和「最先用的那条」在
 *    failover 策略下是同一件事。把顺序藏进一个「优先级」下拉里,就等于把
 *    列表的读法和它的语义拆成了两件要分别记住的事。
 * ② **换密钥不换条目**:每一行的编辑把新值写回**这一条**
 *    (`setCredential` 带 `entryId`)。新建一条会把这一条的用量账断掉。
 * ③ **每一条都删得动,最后一条也是**(09-02 批 11 改,用户报障「单个 key 无法
 *    删除」)。删最后一条走 `spaces.clearCredential` —— **空池 = 这一家回到
 *    「未配置」,是合法终态**,持久层本来就这么认。后端一个字没改。
 *
 * ── 09-02 批 12:行的重排(用户五条拍板)─────────────────────────────────
 * 报障是「一行里塞了太多颗钮,而最常做的那件(换密钥)还得先认出哪个是入口」。
 * 五条拍板逐条的落点:
 *  ① **编辑时旧值留屏**:改密钥那一形把旧尾号缩成左端一格前缀(`.oldPreview`),
 *     不是把它换走 —— 「我正在给哪一条换」必须一眼看得见。
 *  ② **动作多则收进 ⋯,只有一个动作则常驻**:API key 行有五个动作(换密钥 /
 *     改备注 / 上移 / 下移 / 删除)→ 收进 ⋯;OAuth 行只有一个(删除)→ 常驻
 *     画一颗钮。判据是**动作数**,不是行数、不是行的种类。
 *  ③ **添加放列表顶部**:新的那一条从哪儿来,眼睛就该在哪儿等它。
 *  ④ **改密钥用「旧值同行」形**,而且序号对齐输入条的竖中线(用户点名了 5px
 *     错位;做法见 module.css 的 `.ordinalMid`)。
 *  ⑤ **铅笔悬停 / 键盘聚焦才出现,位置预留**:休止态每行只有一颗 ⋯,
 *     浮现时 ⋯ 一个像素都不动(`ui/Reveal` 的第一条纪律)。
 * 尾号与备注名**不再是按钮** —— 「动作单产地 = 菜单」之后,一段身份文字同时
 * 是一颗按钮只会让「哪里点得动」说不清。
 *
 * ── 一次只允许一条输入条 ──────────────────────────────────────────────────
 * 改密钥 / 改备注 / 添加 / 删除确认四形共用**同一个**槽位语义(行里长出一条,
 * 右端两颗真钮,Esc 收回),所以它们共用**同一格状态**(`edit`),挂在这块面上
 * 而不是挂在行里 —— 挂在行里就只能保证「同一行互斥」,而开始添加时那一行
 * 正在编辑的条会留在屏上,变成两条并存。**收掉 = 丢草稿**(见交卷的「待拍板」)。
 *
 * ── 落定为什么等后端回话 ──────────────────────────────────────────────────
 * 输入条**不在点下 Save 的那一刻收走**:池写是逐坑的异步(`busy`),而后端可能
 * 拒(密钥不合法 / 401)。提交即收条的话,出错时那句原话落在卡底、而用户刚打的
 * 那一串已经没了 —— 只能重打一遍。所以这里跟着 `busy` 的**下降沿**判:
 * 没错 → 收条;有错 → 条留着、草稿不丢、再点一次 Save 就是重试。
 * (状态机三档 `idle / submitted / writing`,全文在 `usePoolWriteGate`。)
 *
 * ── 没有的东西 ────────────────────────────────────────────────────────────
 * **没有「测试连通」。** 全仓没有这一口(testConnection / validateApiKey 都不存在),
 * 画一颗点了只能假装的钮比不画更坏。
 *
 * ── 三张状态表(施工纪律「状态先行」)──────────────────────────────────────
 * ① 生命周期
 *    挂载   随 ModeCard 在 api / custom 坑上画出;**自己不取数**(`pool` 是
 *           父件算好的投影,摘要与忙态都由面板 store 现给)。
 *    换宿主 只有一种落点 —— 详情列里的一张 `ui/Card`,滚动归详情列、尺寸自量。
 *           **换坑 = 换一池钥匙**:`providerId` 一变,那一格 `edit` 与所有草稿
 *           当场清零(草稿跟过去就是把 A 家的 key 写进 B 家)。
 *    卸载   无订阅、无计时器、无模块级副作用 → **不需要 HMR dispose**。
 * ② UI 生命状态
 *    empty    `rows.length === 0`:列表位置一句「还没有密钥」,轮换选择器禁掉
 *             (策略无处可挂)。它是删掉最后一条之后的**合法终态**,不是错。
 *             正在添加时那一句让位给添加行 —— 此刻「还没有」已经不是实情了。
 *    loading  这块面自己没有这一档:摘要在飞时上一份**仍在屏**(律②),
 *             忙态逐坑走 `busy`,不清屏、不画骨架。
 *    ready    列表 + 轮换 + 那一档的语义说明。
 *    error    `error` 是后端那句原话,原样落在卡底;策略不可用另有一句 warn。
 *    超量     一坑十几条已是极端,列表不设最大高度(它长在详情列的滚动层里);
 *             行内每一格各自截断(尾号与副行都是省略号)。
 * ③ UI 交互状态
 *    添加钮   `ui/Button`;`aria-expanded` 报开合;busy 时 disabled。
 *    铅笔     `ui/IconButton sm` 装在 `ui/Reveal` 里:占位常驻、休止态透明,
 *             行 hover 或 `:focus-within` 时现身;OAuth 行不画;busy 时 disabled。
 *    ⋯       `ui/IconButton sm`,常驻可见;`aria-haspopup` / `aria-expanded`
 *             报菜单开合;busy 时 disabled。
 *    菜单项   到顶的「上移」/ 到底的「下移」**禁灰不消失**(菜单形状恒定)。
 *    输入条   `ui/InlineEditStrip`:↵ 落定 / Esc 收回 / **失焦不取消**
 *             (有并肩的真钮,blur 早于 click 到,失焦即取消会让钮点不到);
 *             忙态整条禁灰、主钮变「正在保存…」+ 转圈。
 *    pending  整坑一格(`busy` = `poolBusy[providerId]`)—— 池写那一口吃的是
 *             整串 id,不是某一行的事(逐坑已是律③要的粒度:A 家在写不禁 B 家)。
 */

/** 此刻这块面上唯一那条输入条是谁的、是哪一形。`null` = 一条都没开。 */
type PoolEdit =
  | { kind: 'add' }
  | { kind: 'key'; id: string }
  | { kind: 'label'; id: string }
  | { kind: 'delete'; id: string }

/** 一行此刻是不是这条输入条的宿主(以及是哪一形)。 */
type RowEdit = 'key' | 'label' | 'delete' | null

export function CredentialPool({
  providerId,
  pool,
  busy,
  error,
  onAdd,
  onReplace,
  onRelabel,
  onRemove,
  onMove,
  onRotation,
}: {
  providerId: string
  pool: PoolView
  busy: boolean
  /** 后端那句原话。原样显示 —— 它是数据,不是文案。 */
  error?: string
  onAdd: (apiKey: string, label: string) => void
  onReplace: (entryId: string, apiKey: string) => void
  onRelabel: (entryId: string, label: string) => void
  onRemove: (entryId: string) => void
  onMove: (entryId: string, delta: -1 | 1) => void
  onRotation: (policy: string) => void
}) {
  const t = useT()
  const [edit, setEdit] = useState<PoolEdit | null>(null)
  /** 此刻那条输入条里的字(密钥 / 备注名共用一格 —— 一次只有一条条)。 */
  const [draft, setDraft] = useState('')
  /** 添加那一形多出来的第二格。 */
  const [addLabel, setAddLabel] = useState('')
  /** 改备注开条那一刻的现值。「没改就不发」比的是它。 */
  const [baseline, setBaseline] = useState('')

  const close = useCallback(() => {
    setEdit(null)
    setDraft('')
    setAddLabel('')
    setBaseline('')
  }, [])

  const gate = usePoolWriteGate({ busy, error, onSettled: close })
  const resetGate = gate.reset

  /*
   * 换一坑 = 换一池钥匙。没提交的草稿绝不能跟过来 —— 那会把 A 家的 key 写进 B 家。
   * **相位也一并归零**:A 家那次写的忙态与这块面此刻画的是 B 家,一格没复位的
   * `writing` 会让 B 家的行凭空禁着(复审点名的第二半)。
   */
  useEffect(() => {
    close()
    resetGate()
  }, [providerId, close, resetGate])

  function open(next: PoolEdit, seed = '') {
    setDraft(seed)
    setAddLabel('')
    setBaseline(seed)
    setEdit(next)
  }

  function commit() {
    if (!edit) return
    const value = draft.trim()
    if (edit.kind === 'add') {
      if (!value) return
      onAdd(draft, addLabel)
    } else if (edit.kind === 'key') {
      if (!value) return
      onReplace(edit.id, draft)
    } else if (edit.kind === 'label') {
      // 与现值相同(含「都是空的」)= 什么都没改,不发。清空是合法的:
      // 备注名可有可无,抹掉它不是把这一条弄坏。
      if (value === baseline.trim()) {
        close()
        return
      }
      onRelabel(edit.id, draft)
    } else {
      onRemove(edit.id)
    }
    gate.submitted()
  }

  const stripBusy = busy || gate.writing
  const rowEditOf = (row: PoolRow): RowEdit =>
    edit && edit.kind !== 'add' && edit.id === row.id ? edit.kind : null

  return (
    <Card
      title={t('providers.keyCount', { count: pool.rows.length })}
      actions={
        <Button
          size="sm"
          disabled={busy}
          aria-expanded={edit?.kind === 'add'}
          onClick={() => (edit?.kind === 'add' ? close() : open({ kind: 'add' }))}
        >
          {t('providers.keyAdd')}
        </Button>
      }
    >
      <ul className={s.list}>
        {/* ③ 添加放**列表顶部**:新的那一条从哪儿来,眼睛就在哪儿等它。 */}
        {edit?.kind === 'add' && (
          <li className={s.row}>
            {/* 序号那一格留空但占位 —— 输入条才与下面每一行从同一条竖线起笔。 */}
            <span className={s.ordinal} aria-hidden="true" />
            <span className={s.identity}>
              <InlineEditStrip
                saveLabel={t('providers.keyAddSubmit')}
                savingLabel={t('common.saving')}
                cancelLabel={t('common.cancel')}
                busy={stripBusy}
                canSave={draft.trim().length > 0}
                onCommit={commit}
                onCancel={close}
              >
                <Field
                  className={s.addKey}
                  layout="inline"
                  size="sm"
                  labelHidden
                  label={t('providers.keyAddNew')}
                >
                  <RowSecretInput
                    t={t}
                    busy={stripBusy}
                    value={draft}
                    placeholder={t('providers.keyEmpty')}
                    onChange={setDraft}
                    onCommit={commit}
                    onCancel={close}
                  />
                </Field>
                <Field
                  className={s.addLabel}
                  layout="inline"
                  size="sm"
                  labelHidden
                  label={t('providers.keyAddNote')}
                >
                  <RowInput
                    busy={stripBusy}
                    value={addLabel}
                    placeholder={t('providers.keyAddNote')}
                    focusOnMount={false}
                    onChange={setAddLabel}
                    onCommit={commit}
                    onCancel={close}
                  />
                </Field>
              </InlineEditStrip>
            </span>
          </li>
        )}

        {pool.rows.map((row) => (
          <PoolEntry
            key={row.id}
            t={t}
            row={row}
            busy={busy}
            stripBusy={stripBusy}
            editing={rowEditOf(row)}
            draft={draft}
            first={row.ordinal === 1}
            last={row.ordinal === pool.rows.length}
            onDraft={setDraft}
            onOpenKey={() => open({ kind: 'key', id: row.id })}
            onOpenLabel={() => open({ kind: 'label', id: row.id }, row.label)}
            onOpenDelete={() => open({ kind: 'delete', id: row.id })}
            onCommit={commit}
            onCancel={close}
            onMove={onMove}
          />
        ))}
      </ul>

      {/* 正在添加时这一句让位 —— 此刻「还没有」已经不是实情了。 */}
      {pool.rows.length === 0 && edit?.kind !== 'add' && (
        <p className={s.empty}>{t('providers.keyNone')}</p>
      )}

      <div className={s.rotation}>
        <span className={s.rotationLabel}>{t('providers.rotation')}</span>
        <Select
          size="sm"
          value={pool.policy}
          disabled={busy || pool.rows.length === 0}
          onChange={onRotation}
          label={t('providers.rotation')}
          options={rotationOptions(t, pool.policy)}
        />
      </div>
      {/* 每一档都要有一句语义说明 —— 三个策略名单看字面是分不出来的。
          「顺序即优先级」那句读法从卡头搬到了这里:它本来就是这几句在解释的事。 */}
      {rotationHint(t, pool.policy) && <p className={s.hint}>{rotationHint(t, pool.policy)}</p>}
      {pool.policyUnavailable && <p className={s.warn}>{t('providers.rotationUnavailable')}</p>}

      {error && <p className={s.warn}>{error}</p>}
    </Card>
  )
}

/**
 * **【临时手写】异步相位机** —— 「这一次写落地了没有」的三档判定(09-02 批 12)。
 *
 * 施工规范验收第 3 轴的原话:根治原语在 `src/data/kernel/`,**落地前的手写异步
 * 须注释标「临时手写」**。这一件就是那一档:凭证池的写路今天还没接
 * `createMutation`(`poolBusy` / `poolError` 是 `providers/store.ts` 自己记的两格
 * 逐坑布尔与字符串,`ui:consume` 的 `async-busy-boolean` 那条把它们记在基线里),
 * 所以这里只能从 props 上的 `busy` / `error` 反推相位。**将来由 kernel 的
 * `mutation.pending` / `mutation.error` 顶替**:那时这只 hook 整个删掉,
 * 输入条直接读那一格的 pending,连「下降沿」这个词都不需要存在。
 *
 *   idle       没有在飞的写。
 *   submitted  刚点下 Save。**只活一次渲染**,理由见下。
 *   writing    忙态在场。等它的**下降沿**:落下来的那一刻看 `error`,
 *              空 = 落定(收条),非空 = 后端拒了(条留着、草稿不丢、可重试)。
 *
 * ── `submitted` 那一档为什么只许活一次渲染(09-02 批 12 复审修的真 bug)──────
 * store 的写动作有**不置忙就返回**的路:`removeCredential` 在这条 entry 已经不在
 * 池里时直接 `return`(`providers/store.ts:881`),`addCredential` / `replaceCredential`
 * 在密钥 trim 完是空串时同样直接 `return`。首版只等「看见 busy 升起」,于是这几条
 * 路上 phase 永远停在 `submitted`、`stripBusy` 恒真 —— 输入条卡在「正在保存…」,
 * 别的行的 ⋯ 与铅笔全禁,换一坑也不复位。复现:确认条开着时这条 entry 被别处
 * 删掉(SSE 对账),再点一次删除。
 *
 * 判据成立的理由:**store 置忙与这里的 `submitted()` 落在同一次事件里**。
 * `writePool` 的第一句就是 `set({ poolBusy: … })`,而它是在点击处理器里同步跑到的
 * (`await writePool(...)` 的操作数先求值,`set` 在它自己的第一个 await 之前);
 * React 把这两次更新批进**同一次渲染**。所以「submit 之后第一次 effect 里 busy
 * 仍是 false」= **这次写根本没发出去**,当场回 idle 并按 `error` 判要不要收条。
 *
 * 为什么不看回调的返回值:`onAdd` / `onReplace` 那一族在契约上返回 `void`
 * (面板把它们绑到 store 的动作上,而那些动作自己也不报成败 —— 成败落在
 * `poolError` 那一格里)。改契约会牵动 ModeCard / 面板 / store 三层,而这块面
 * 要的信息**已经在 props 里**:`busy` 与 `error` 就是那次写的全部读数。
 */
function usePoolWriteGate({
  busy,
  error,
  onSettled,
}: {
  busy: boolean
  error?: string
  onSettled: () => void
}): { writing: boolean; submitted: () => void; reset: () => void } {
  const [phase, setPhase] = useState<'idle' | 'submitted' | 'writing'>('idle')
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  useEffect(() => {
    if (phase === 'idle') return
    // 忙态还在场:等它落下来。`submitted` 见到忙态就进 `writing`。
    if (busy) {
      if (phase === 'submitted') setPhase('writing')
      return
    }
    /*
     * 走到这儿只有两种:
     *  · `writing` 的下降沿 —— 那次写落地了(成或败,看 `error`);
     *  · `submitted` 却没看见忙态 —— 那次写**根本没发**(store 早返回了)。
     * 两种的收尾一模一样:回 idle,没错就收条。区别只在语义,不在动作 ——
     * 「没发」与「发了没出错」对这条输入条是同一件事:没有什么可等的了。
     */
    setPhase('idle')
    if (!error) settledRef.current()
  }, [phase, busy, error])

  /*
   * 两口都用 `useCallback` 包住 —— **身份必须跨渲染稳定**:`reset` 是
   * 「换一坑就复位」那条 effect 的依赖,现写一个箭头函数会让它每渲染都变身份、
   * 那条 effect 每渲染重跑一次,于是刚打开的输入条当场被 `close()` 收走。
   * (施工中真踩到过一次,记在这儿。)
   */
  const submitted = useCallback(() => setPhase('submitted'), [])
  const reset = useCallback(() => setPhase('idle'), [])

  return { writing: phase !== 'idle', submitted, reset }
}

/**
 * 三档内置 + 「此刻存着的那个」。存着一个不认识的策略(插件注册的)时
 * **也要有一格能显示它** —— 不然选择器会画成空白,看起来像没设过。
 */
function rotationOptions(t: TFn, policy: string) {
  const options = ROTATION_POLICIES.map((value) => {
    const fact = rotationLabelFact(value)
    return { value, label: t(fact.key, fact.vars) }
  })
  if (options.some((option) => option.value === policy)) return options
  const fact = rotationLabelFact(policy)
  return [...options, { value: policy, label: t(fact.key, fact.vars) }]
}

function rotationHint(t: TFn, policy: string): string | null {
  const fact = rotationHintFact(policy)
  return fact ? t(fact.key, fact.vars) : null
}

function PoolEntry({
  t,
  row,
  busy,
  stripBusy,
  editing,
  draft,
  first,
  last,
  onDraft,
  onOpenKey,
  onOpenLabel,
  onOpenDelete,
  onCommit,
  onCancel,
  onMove,
}: {
  t: TFn
  row: PoolRow
  /** 这一坑在写。别的行的 ⋯ 与铅笔一并禁。 */
  busy: boolean
  /** 输入条自己的忙态(含「刚点下 Save、忙态还没到」那一拍)。 */
  stripBusy: boolean
  editing: RowEdit
  draft: string
  first: boolean
  last: boolean
  onDraft: (v: string) => void
  onOpenKey: () => void
  onOpenLabel: () => void
  onOpenDelete: () => void
  onCommit: () => void
  onCancel: () => void
  onMove: (entryId: string, delta: -1 | 1) => void
}) {
  const [menu, setMenu] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)

  const cooldown = cooldownFact(row.cooldownUntil)
  const oauth = row.authType === 'oauth'
  const editLabel = t('providers.keyReplaceFor', { ordinal: row.ordinal })
  const labelLabel = t('providers.keyLabelFor', { ordinal: row.ordinal })
  const deleteLabel = t('providers.keyDeleteFor', { ordinal: row.ordinal })

  return (
    /* `data-reveal-scope`(`ui/Reveal`)= 「算不算我在看这一行」的那个作用域。
       铅笔的浮现判据挂在它身上,而不是挂在铅笔自己身上。 */
    <li className={s.row} {...REVEAL_SCOPE}>
      <span
        className={[s.ordinal, editing === 'key' ? s.ordinalMid : ''].filter(Boolean).join(' ')}
        aria-hidden="true"
      >
        {row.ordinal}
      </span>

      <span className={s.identity}>
        {editing === 'key' ? (
          /* ④ 旧值同行:旧尾号缩成左端一格前缀,输入框顶替第 1 行,副行不动。 */
          <InlineEditStrip
            prefix={
              <span className={s.oldPreview}>
                {t('providers.keyReplacedFrom', { preview: row.preview ?? '' })}
              </span>
            }
            saveLabel={t('providers.keySave')}
            savingLabel={t('common.saving')}
            cancelLabel={t('common.cancel')}
            busy={stripBusy}
            canSave={draft.trim().length > 0}
            onCommit={onCommit}
            onCancel={onCancel}
          >
            <Field layout="inline" size="sm" labelHidden label={editLabel}>
              <RowSecretInput
                t={t}
                busy={stripBusy}
                value={draft}
                placeholder={t('providers.keyNewEmpty')}
                onChange={onDraft}
                onCommit={onCommit}
                onCancel={onCancel}
              />
            </Field>
          </InlineEditStrip>
        ) : (
          <span className={s.mask}>
            {oauth ? (row.oauthAccount ?? t('providers.keyOAuthEntry')) : (row.preview ?? '')}
          </span>
        )}

        {editing === 'label' ? (
          /* 改备注:输入条顶替**第 2 行**,第 1 行的尾号原样留着(改的是哪一条
             要看得见),序号因此仍然对齐第 1 行。 */
          <InlineEditStrip
            className={s.stripBelow}
            saveLabel={t('providers.keySave')}
            savingLabel={t('common.saving')}
            cancelLabel={t('common.cancel')}
            busy={stripBusy}
            onCommit={onCommit}
            onCancel={onCancel}
          >
            <Field layout="inline" size="sm" labelHidden label={labelLabel}>
              <RowInput
                busy={stripBusy}
                value={draft}
                placeholder={t('providers.keyAddNote')}
                onChange={onDraft}
                onCommit={onCommit}
                onCancel={onCancel}
              />
            </Field>
          </InlineEditStrip>
        ) : (
          <span className={s.meta}>
            {row.label}
            {row.cooling && cooldown && (
              <span className={s.cooling}>
                {row.label ? ' · ' : ''}
                {t('providers.cooling')} {t(cooldown.key, cooldown.vars)}
              </span>
            )}
          </span>
        )}

        {editing === 'delete' && (
          /* 删除确认落在第 3 行,与输入条同一个槽位:一句后果 + 危险色主钮。
             不弹窗、不在原钮上变字 —— 行的其余部分零位移。 */
          <InlineEditStrip
            className={s.stripBelow}
            prefix={<span className={s.consequence}>{t('providers.keyDeleteAsk')}</span>}
            tone="danger"
            saveLabel={t('providers.keyDelete')}
            savingLabel={t('common.saving')}
            cancelLabel={t('common.cancel')}
            busy={stripBusy}
            onCommit={onCommit}
            onCancel={onCancel}
          />
        )}
      </span>

      {/* 输入条在场时动作槽整个**不画**(不是禁):那一格此刻已经有两颗真钮了,
          再留一颗同名的等于对读屏软件把同一句话说两遍。 */}
      {editing === null && (
        <span className={s.trail}>
          {oauth ? (
            /* ② 只有一个动作(删除)→ 常驻画一颗钮,不收菜单、不画铅笔。
               它走的是与 API key 行**同一条**确认条。 */
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={deleteLabel}
              onClick={onOpenDelete}
            >
              {t('providers.keyDelete')}
            </Button>
          ) : (
            <>
              {/* ⑤ 铅笔:位置常驻、休止态透明,行 hover / 聚焦才现身。
                  换密钥是这一行最常做的一件,所以它在菜单之外还有一步直达。 */}
              <Reveal>
                <IconButton
                  size="sm"
                  icon={Pencil}
                  label={editLabel}
                  disabled={busy}
                  onClick={onOpenKey}
                />
              </Reveal>
              <IconButton
                ref={moreRef}
                size="sm"
                icon={Ellipsis}
                label={t('providers.keyMenuFor', { ordinal: row.ordinal })}
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((open) => !open)}
              />
            </>
          )}
        </span>
      )}

      {menu && (
        <Menu
          x={moreRef.current?.getBoundingClientRect().left ?? 0}
          y={moreRef.current?.getBoundingClientRect().bottom ?? 0}
          anchor={() => moreRef.current?.getBoundingClientRect() ?? null}
          /* 右对齐:⋯ 贴着这一行的右边线,左对齐会把整张菜单甩到面板外面去。 */
          anchorPlace="below-end"
          label={t('providers.keyMenuFor', { ordinal: row.ordinal })}
          onClose={() => setMenu(false)}
        >
          <MenuItem
            onClick={() => {
              setMenu(false)
              onOpenKey()
            }}
          >
            {t('providers.keyMenuReplace')}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(false)
              onOpenLabel()
            }}
          >
            {t('providers.keyMenuRename')}
          </MenuItem>
          <MenuSeparator />
          {/* 到顶 / 到底那一项**禁灰不消失**:一张菜单的形状不该随上下文变 ——
              否则同一张表在第 1 行与第 2 行长得不一样,每次打开都要重新找。 */}
          <MenuItem
            disabled={first}
            onClick={() => {
              setMenu(false)
              onMove(row.id, -1)
            }}
          >
            {t('providers.keyMoveUp')}
          </MenuItem>
          <MenuItem
            disabled={last}
            onClick={() => {
              setMenu(false)
              onMove(row.id, 1)
            }}
          >
            {t('providers.keyMoveDown')}
          </MenuItem>
          <MenuSeparator />
          {/* 不用 MenuItem 自带的两段确认:后果那句话要与**这一行**并排读
              (「删的是第 2 条」由行自己说),而菜单此刻已经盖在别的行上了。 */}
          <MenuItem
            danger
            onClick={() => {
              setMenu(false)
              onOpenDelete()
            }}
          >
            {t('providers.keyMenuDelete')}
          </MenuItem>
        </Menu>
      )}
    </li>
  )
}

/**
 * 编辑中的那一格(密钥与备注名两形共用手势)。**单独一件是因为 hook 只能在
 * 组件里调**:`useFieldControlProps()` 要在 `<Field>` 的 context 之内才拿得到
 * 东西(与 `WorkspaceOverview.RenameInput` 同一条理由)。
 *
 * 手势整只交给 `ui/inline-edit`:↵ 落定 / Esc 收回 / 一进来选中全文。
 * **`cancelOnBlur` 关着**(09-02 批 12 从开着改成关着):这一形并肩站着 Save 与
 * Cancel 两颗真钮,而 `blur` 在 `click` 之前到 —— 失焦即取消会把那两颗钮变成
 * 永远点不到的(判据全文在 `ui/inline-edit` 的文件头)。
 */
function RowInput({
  busy,
  value,
  placeholder,
  focusOnMount = true,
  onChange,
  onCommit,
  onCancel,
}: {
  busy: boolean
  value: string
  placeholder: string
  /**
   * 一进来光标落在这一格吗。**添加那一条有两格**,而「一进来 focus」只能有
   * 一个赢家 —— 两格都要,后挂载的那一个(备注)会把光标从密钥格抢走。
   * 所以第二格明说不要:`useInlineEdit` 的自动聚焦靠 `controlId` 触发,
   * 不给它就不聚焦(那件文件头写着的那一档)。
   */
  focusOnMount?: boolean
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({
    controlId: focusOnMount ? field.id : undefined,
    onCommit,
    onCancel,
  })
  return (
    <Input
      {...field}
      {...edit}
      size="sm"
      className={s.editInput}
      value={value}
      onValueChange={onChange}
      disabled={busy}
      placeholder={placeholder}
    />
  )
}

/** 同上,密钥那一形:`ui/SecretInput`(密码形 + 一颗切明暗的眼睛钮)。 */
function RowSecretInput({
  t,
  busy,
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
}: {
  t: TFn
  busy: boolean
  value: string
  placeholder: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel })
  return (
    <SecretInput
      {...field}
      {...edit}
      size="sm"
      className={s.editInput}
      value={value}
      onValueChange={onChange}
      disabled={busy}
      placeholder={placeholder}
      revealLabel={t('providers.keyReveal')}
      hideLabel={t('providers.keyHide')}
    />
  )
}
