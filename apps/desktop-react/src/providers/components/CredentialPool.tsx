import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Card } from '../../ui/Card'
import { Field, useFieldControlProps } from '../../ui/Field'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { useInlineEdit } from '../../ui/inline-edit'
import { Pencil } from '../../components/icons'
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
 * ③ **删除是两段就地确认**,不是弹窗:一颗钮点第一下变成「真删?」,再点才删。
 *    删除是可感知的破坏,但它不值得一个把整屏盖住的浮层。
 * ④ **每一条都删得动,最后一条也是**(09-02 批 11 改,用户报障「单个 key 无法
 *    删除」)。从前这里禁掉最后一条,理由写的是「后端本来就拒空列表」——
 *    那句话只对了一半:`spaces.setCredentialPool` 确实拒空
 *    (`runtime/spaces/ipc-operations.ts:378`),但它拒的是**用一次排序请求顺手
 *    清空一个 provider**,而不是「这一家不许回到未配置」。后端自己那句错误话
 *    就写着正路:「要清空整段请用『清除』」—— 于是删最后一条改走
 *    `spaces.clearCredential`(store 侧那一段有全文)。**空池 = 这一家回到
 *    「未配置」,是合法终态**,持久层本来就这么认(`credentials.ts:741`
 *    删空即摘掉整段,并有单测钉着)。后端一个字没改。
 *
 * ── 原地编辑(09-02 批 11,用户报障「key 的编辑 ui 很难看,不是原地编辑」)──
 * 从前点「换密钥」会在**这一行下面**另起一栏(输入框 + 保存钮 + 一句提示),
 * 于是一次改 key 要读两行、而且行高会跳。现在点掩码文本(或它旁边那颗铅笔钮)
 * 就在**同一格**把掩码换成输入框:`↵` 保存、`Esc` 取消、失焦取消,副行原样留着
 * (改的是哪一条得看得见)。手势本身收进了 `ui/inline-edit` —— 改名格与这里是
 * 同一组手势的两个产地,「基础件先行」那条法要求它只成立一次。
 * OAuth 那一条**不可编辑**:它没有「密钥」可换,换法是重新授权。
 *
 * **备注名同样原地可编**,而且是自己一格(点副行里那个名字,或者没有名字时那个
 * 「＋ 备注」入口)。写路是 `setCredential` 的「带 entryId 不带 key」那一档
 * (`@shared/ipc/spaces.ts:253`)。两格**互斥**,不是并排:失焦取消只在
 * 「这一格里只有一件控件」时才立得住 —— 两件并排时 Tab 过去会被自己的 blur
 * 吃掉(判据全文在 `ui/inline-edit` 文件头)。两格的**初值口径也不同**:
 * 密钥永不回读,所以从空开始;备注名读得回来,所以从现值开始。
 *
 * ── 没有的东西 ────────────────────────────────────────────────────────────
 * **没有「测试连通」。** 全仓没有这一口(testConnection / validateApiKey 都不存在),
 * 画一颗点了只能假装的钮比不画更坏。设计稿上那颗记在留账里。
 *
 * ── 三张状态表(施工纪律「状态先行」)──────────────────────────────────────
 * ① 生命周期
 *    挂载   随 ModeCard 在 api / custom 坑上画出;**自己不取数**(`pool` 是
 *           父件算好的投影,摘要与忙态都由面板 store 现给)。
 *    换宿主 只有一种落点 —— 详情列里的一张 `ui/Card`,滚动归详情列、尺寸自量,
 *           所以没有第二种形要回答。**换坑 = 换一池钥匙**:`providerId` 一变,
 *           添加草稿当场清零(草稿跟过去就是把 A 家的 key 写进 B 家)。
 *           行上那三格局部态(改密钥中 / 改备注中 / 删除确认)长在行里,
 *           而行的 key 是 entryId —— 换坑连节点都换了,不需要显式清。
 *    卸载   无订阅、无计时器、无模块级副作用 → **不需要 HMR dispose**。
 * ② UI 生命状态
 *    empty    `rows.length === 0`:列表不画,轮换选择器禁掉(策略无处可挂)。
 *             它是删掉最后一条之后的**合法终态**,不是错。
 *    loading  这块面自己没有这一档:摘要在飞时上一份**仍在屏**(律②),
 *             忙态逐坑走 `busy`,不清屏、不画骨架。
 *    ready    列表 + 轮换 + 那一档的语义说明。
 *    error    `error` 是后端那句原话,原样落在卡底;策略不可用另有一句 warn。
 *    超量     一坑十几条已是极端,列表不设最大高度(它长在详情列的滚动层里);
 *             行内每一格各自截断(掩码与副行都是省略号)。
 * ③ UI 交互状态
 *    添加钮   ui/Button;`aria-expanded` 报开合;busy 时 disabled。
 *    掩码     ui/ButtonBase(裸钮三类判第③类:它是这一行的身份,视觉本该定制)。
 *             hover 加下划线说明「点得动」,focus 走全局环;busy 时 disabled;
 *             OAuth 那一条不是钮(没有可编辑的东西)。
 *    铅笔钮   ui/IconButton xs + Tooltip 全名;OAuth 行不画;busy 时 disabled。
 *    备注名   同为 ui/ButtonBase(行内微型文字动作,③类);没有名字时画
 *             「＋ 备注」那一个入口,弱一档色,hover 补到正常色 + 下划线。
 *    输入框   ui/Input sm(密钥那格 password / 备注那格 text),一进来选中全文;
 *             ↵ / Esc / 失焦三条出口。
 *    ↑↓       首行禁上移、末行禁下移;busy 时禁。
 *    删除     两段就地确认,失焦回第一段;busy 时禁。**不再有「最后一条禁掉」**。
 *    pending  整坑一格(`busy` = `poolBusy[providerId]`)—— 池写那一口吃的是
 *             整串 id,不是某一行的事,所以忙态也不逐行装(逐坑已是律③要的粒度:
 *             A 家在写不禁 B 家)。
 */

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
  const [adding, setAdding] = useState(false)
  const [draftKey, setDraftKey] = useState('')
  const [draftLabel, setDraftLabel] = useState('')

  // 换一坑 = 换一池钥匙。没提交的草稿绝不能跟过来 —— 那会把 A 家的 key 写进 B 家。
  useEffect(() => {
    setAdding(false)
    setDraftKey('')
    setDraftLabel('')
  }, [providerId])

  return (
    <Card
      title={t('providers.keyCount', { count: pool.rows.length })}
      /* 「顺序即优先级」那句读法是**这张卡的一句话**,不是列表里的一行 ——
         正是 Card 的 note below 档(与本地 `.hint` 逐字同一副配方)。
         「换 key 不换条目」那句从前长在展开的换密钥栏里,09-02 批 11 挪到这儿:
         它说的是**这个池子怎么记账**,是一条常识,不是某一次编辑的注 ——
         而且真机量出来,把它塞进行内那一格会让那一行从 51px 撑到 140px,
         「原地」当场变成又一次行高跳(那正是这批要治的病)。 */
      note={`${t('providers.keyOrderHint')} ${t('providers.keyReplaceHint')}`}
      notePlacement="below"
      actions={
        <Button size="sm" disabled={busy} onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          {t('providers.keyAdd')}
        </Button>
      }
    >
      {adding && (
        <div className={s.addRow}>
          <div className={s.addKey}>
            <Input
              size="sm"
              type="password"
              value={draftKey}
              onValueChange={setDraftKey}
              disabled={busy}
              placeholder={t('providers.keyEmpty')}
              aria-label={t('providers.keyAddNew')}
            />
          </div>
          <div className={s.addLabel}>
            <Input
              size="sm"
              value={draftLabel}
              onValueChange={setDraftLabel}
              disabled={busy}
              placeholder={t('providers.keyAddNote')}
              aria-label={t('providers.keyAddNote')}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !draftKey.trim()}
            onClick={() => {
              onAdd(draftKey, draftLabel)
              setDraftKey('')
              setDraftLabel('')
              setAdding(false)
            }}
          >
            {t('providers.keySave')}
          </Button>
        </div>
      )}

      <ul className={s.list}>
        {pool.rows.map((row) => (
          <PoolEntry
            key={row.id}
            t={t}
            row={row}
            busy={busy}
            first={row.ordinal === 1}
            last={row.ordinal === pool.rows.length}
            onReplace={onReplace}
            onRelabel={onRelabel}
            onRemove={onRemove}
            onMove={onMove}
          />
        ))}
      </ul>

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
      {/* 每一档都要有一句语义说明 —— 三个策略名单看字面是分不出来的。 */}
      {rotationHint(t, pool.policy) && <p className={s.hint}>{rotationHint(t, pool.policy)}</p>}
      {pool.policyUnavailable && <p className={s.warn}>{t('providers.rotationUnavailable')}</p>}

      {error && <p className={s.warn}>{error}</p>}
    </Card>
  )
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
  first,
  last,
  onReplace,
  onRelabel,
  onRemove,
  onMove,
}: {
  t: TFn
  row: PoolRow
  busy: boolean
  first: boolean
  last: boolean
  onReplace: (entryId: string, apiKey: string) => void
  onRelabel: (entryId: string, label: string) => void
  onRemove: (entryId: string) => void
  onMove: (entryId: string, delta: -1 | 1) => void
}) {
  /** 原地编辑密钥:true = 那一格此刻是输入框,不是掩码。 */
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** 原地编辑备注名。与上面那格**互斥** —— 一行一次只做一件事。 */
  const [labeling, setLabeling] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  /** 删除的两段:false = 「删除」,true = 「真删?」。再点一下才真删。 */
  const [confirming, setConfirming] = useState(false)

  const cooldown = cooldownFact(row.cooldownUntil)
  const oauth = row.authType === 'oauth'
  const editLabel = t('providers.keyReplaceFor', { ordinal: row.ordinal })
  const labelLabel = t('providers.keyLabelFor', { ordinal: row.ordinal })

  function openEdit() {
    setLabeling(false)
    // 密钥原文永不回读,所以这一格永远从**空**开始 —— 预填一串星号只会
    // 让人以为「不改就是保持原样」,而实际上提交的就是那串星号。
    setDraft('')
    setEditing(true)
  }

  function commitEdit() {
    // 空草稿 = 什么都没打,那就是取消(空 key 后端也拒)。
    if (draft.trim()) onReplace(row.id, draft)
    setDraft('')
    setEditing(false)
  }

  function openLabel() {
    setEditing(false)
    // 备注名是**读得回来的**,所以这一格从现值开始(接着改,不是重打)。
    setLabelDraft(row.label)
    setLabeling(true)
  }

  function commitLabel() {
    // 与现值相同(含「都是空的」)= 什么都没改,不发。清空是合法的:
    // 备注名可有可无,抹掉它不是把这一条弄坏。
    if (labelDraft.trim() !== row.label.trim()) onRelabel(row.id, labelDraft)
    setLabeling(false)
  }

  return (
    <li className={s.row}>
      <span className={s.ordinal} aria-hidden="true">
        {row.ordinal}
      </span>
      <span className={s.identity}>
        {editing ? (
          /* 原地:掩码那一格**当场换成**输入框,副行留在下面(改的是哪一条要看得见)。
             **不带 hint** —— 理由与那句话搬去卡头是同一条,写在上面。 */
          <Field layout="inline" size="sm" labelHidden label={editLabel}>
            <RowInput
              secret
              busy={busy}
              value={draft}
              placeholder={t('providers.keyEmpty')}
              onChange={setDraft}
              onCommit={commitEdit}
              onCancel={() => {
                setDraft('')
                setEditing(false)
              }}
            />
          </Field>
        ) : oauth ? (
          <span className={s.mask}>{row.oauthAccount ?? t('providers.keyOAuthEntry')}</span>
        ) : (
          /* 掩码**本身**就是编辑的入口(裸钮三类判第③类:它是这一行的身份,
             视觉本该定制 —— `ui/ButtonBase` 只清 UA,皮肤仍是 `.mask` 那一份)。 */
          <ButtonBase className={s.mask} disabled={busy} aria-label={editLabel} onClick={openEdit}>
            {row.preview ?? ''}
          </ButtonBase>
        )}
        {labeling ? (
          /*
           * 备注名也是**原地**的,而且是**自己一格**:与密钥那一格分开,
           * 是因为失焦取消只在「这一格里只有一件控件」时才立得住 ——
           * 两件并排时 Tab 过去就会被自己的 blur 吃掉(判据在 ui/inline-edit)。
           *
           * 这一格**换掉整条副行**,不是塞进那条 `<span class=meta>` 里 ——
           * 真机量出来的差别:塞进去那一行从 52px 撑到 80px(+28),因为一个
           * flex 盒长在 inline 格式化上下文里会另起匿名行盒,行高白吃一份;
           * 换掉整条只 +8(就是「一行文字 15px 换成一格 sm 输入框 26px」的差)。
           * 副行那两段(产地 / 冷却)在这几秒里让位是合理的:此刻要读的是
           * 「我正在给哪一条改名字」,而那由上面的掩码与序号说得一清二楚。
           */
          <Field layout="inline" size="sm" labelHidden label={labelLabel}>
            <RowInput
              busy={busy}
              value={labelDraft}
              placeholder={t('providers.keyAddNote')}
              onChange={setLabelDraft}
              onCommit={commitLabel}
              onCancel={() => setLabeling(false)}
            />
          </Field>
        ) : (
          <span className={s.meta}>
            {row.label ? (
              <ButtonBase
                className={s.labelText}
                disabled={busy}
                aria-label={labelLabel}
                onClick={openLabel}
              >
                {row.label}
              </ButtonBase>
            ) : (
              /* 还没有备注:给一个**行内微型文字动作**当入口(裸钮三类判第③类
                 —— fs-micro、无边无底、与正文同行,走 ButtonBase 保本地皮肤)。
                 不画它就等于「这一格只能在添加的时候填一次」。 */
              <ButtonBase
                className={s.labelAdd}
                disabled={busy}
                aria-label={labelLabel}
                onClick={openLabel}
              >
                {t('providers.keyLabelAdd')}
              </ButtonBase>
            )}
            {' · '}
            {/* 产地照抄后端。今天它只写 'user',别的取值原样透出去,不替它编名字。 */}
            {row.source === 'user' ? t('providers.keySourceUser') : row.source}
            {row.cooling && cooldown
              ? ` · ${t('providers.cooling')} ${t(cooldown.key, cooldown.vars)}`
              : ''}
          </span>
        )}
      </span>

      <span className={s.actions}>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          disabled={busy || first}
          onClick={() => onMove(row.id, -1)}
          aria-label={t('providers.keyMoveUpFor', { ordinal: row.ordinal })}
        >
          ↑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          disabled={busy || last}
          onClick={() => onMove(row.id, 1)}
          aria-label={t('providers.keyMoveDownFor', { ordinal: row.ordinal })}
        >
          ↓
        </Button>
        {/* OAuth 那一条没有「密钥」可换 —— 它的换法是重新授权。
            编辑中**整颗不画**:那一格已经在屏上,再留一颗同名的钮等于对读屏软件
            说同一句话两遍(而且它此刻按下去什么都不会发生)。 */}
        {!oauth && !editing && (
          <IconButton size="xs" icon={Pencil} label={editLabel} disabled={busy} onClick={openEdit} />
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (!confirming) {
              setConfirming(true)
              return
            }
            setConfirming(false)
            onRemove(row.id)
          }}
          onBlur={() => setConfirming(false)}
          aria-label={t('providers.keyDeleteFor', { ordinal: row.ordinal })}
        >
          {confirming ? t('providers.keyDeleteConfirm') : t('providers.keyDelete')}
        </Button>
      </span>
    </li>
  )
}

/**
 * 编辑中的那一格(密钥与备注名共用)。**单独一件是因为 hook 只能在组件里调**:`useFieldControlProps()`
 * 要在 `<Field>` 的 context 之内才拿得到东西(与 `WorkspaceOverview.RenameInput`
 * 同一条理由)。手势整只交给 `ui/inline-edit`:↵ 落定 / Esc 收回 / **失焦取消**,
 * 以及一进来就选中全文。
 *
 * 失焦取消在这一形是安全的:这一格**没有并肩的提交钮**(全靠 ↵),所以没有别的
 * 落点在抢那一下点击 —— 那条判据写在 `ui/inline-edit` 的文件头里。
 */
function RowInput({
  secret = false,
  busy,
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
}: {
  /** 密钥那一格是 password;备注名是普通文字(它本来就画在屏上)。 */
  secret?: boolean
  busy: boolean
  value: string
  placeholder: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel, cancelOnBlur: true })
  return (
    <Input
      {...field}
      {...edit}
      size="sm"
      type={secret ? 'password' : 'text'}
      className={s.editInput}
      value={value}
      onValueChange={onChange}
      disabled={busy}
      placeholder={placeholder}
    />
  )
}
