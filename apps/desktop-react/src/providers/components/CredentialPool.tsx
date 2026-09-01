import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
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
 * ② **换密钥不换条目**:每一行的「换密钥」把新值写回**这一条**
 *    (`setCredential` 带 `entryId`)。新建一条会把这一条的用量账断掉。
 * ③ **删除是两段就地确认**,不是弹窗:一颗钮点第一下变成「真删?」,再点才删。
 *    删除是可感知的破坏,但它不值得一个把整屏盖住的浮层。
 * ④ **最后一条不可删**:后端本来就拒空列表。与其让人点一下再收到一句拒绝,
 *    不如把钮禁掉,并在下面说清为什么。
 *
 * ── 没有的东西 ────────────────────────────────────────────────────────────
 * **没有「测试连通」。** 全仓没有这一口(testConnection / validateApiKey 都不存在),
 * 画一颗点了只能假装的钮比不画更坏。设计稿上那颗记在留账里。
 */

export function CredentialPool({
  providerId,
  pool,
  busy,
  error,
  onAdd,
  onReplace,
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
    <Card>
      <div className={s.head}>
        <h3 className={s.title}>{t('providers.keyCount', { count: pool.rows.length })}</h3>
        <Button size="sm" disabled={busy} onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          {t('providers.keyAdd')}
        </Button>
      </div>
      <p className={s.hint}>{t('providers.keyOrderHint')}</p>

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
            canDelete={pool.canDelete}
            onReplace={onReplace}
            onRemove={onRemove}
            onMove={onMove}
          />
        ))}
      </ul>

      {/* 最后一条不可删,把理由说在列表底下 —— 禁用的钮自己不会解释自己。 */}
      {!pool.canDelete && pool.rows.length > 0 && (
        <p className={s.hint}>{t('providers.keyLastKept')}</p>
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
  canDelete,
  onReplace,
  onRemove,
  onMove,
}: {
  t: TFn
  row: PoolRow
  busy: boolean
  first: boolean
  last: boolean
  canDelete: boolean
  onReplace: (entryId: string, apiKey: string) => void
  onRemove: (entryId: string) => void
  onMove: (entryId: string, delta: -1 | 1) => void
}) {
  const [replacing, setReplacing] = useState(false)
  const [draft, setDraft] = useState('')
  /** 删除的两段:false = 「删除」,true = 「真删?」。再点一下才真删。 */
  const [confirming, setConfirming] = useState(false)

  const cooldown = cooldownFact(row.cooldownUntil)
  const oauth = row.authType === 'oauth'

  return (
    <li className={s.row}>
      <span className={s.ordinal} aria-hidden="true">
        {row.ordinal}
      </span>
      <span className={s.identity}>
        <span className={s.mask}>
          {oauth ? (row.oauthAccount ?? t('providers.keyOAuthEntry')) : (row.preview ?? '')}
        </span>
        <span className={s.meta}>
          {row.label ? `${row.label} · ` : ''}
          {/* 产地照抄后端。今天它只写 'user',别的取值原样透出去,不替它编名字。 */}
          {row.source === 'user' ? t('providers.keySourceUser') : row.source}
          {row.cooling && cooldown
            ? ` · ${t('providers.cooling')} ${t(cooldown.key, cooldown.vars)}`
            : ''}
        </span>
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
        {/* OAuth 那一条没有「密钥」可换 —— 它的换法是重新授权。 */}
        {!oauth && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setReplacing((open) => !open)}
            aria-expanded={replacing}
          >
            {t('providers.keyReplace')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !canDelete}
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

      {replacing && (
        <div className={s.replaceRow}>
          <div className={s.replaceField}>
            <Input
              size="sm"
              type="password"
              value={draft}
              onValueChange={setDraft}
              disabled={busy}
              placeholder={t('providers.keyEmpty')}
              aria-label={t('providers.keyReplaceFor', { ordinal: row.ordinal })}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !draft.trim()}
            onClick={() => {
              onReplace(row.id, draft)
              setDraft('')
              setReplacing(false)
            }}
          >
            {t('providers.keySave')}
          </Button>
          <span className={s.meta}>{t('providers.keyReplaceHint')}</span>
        </div>
      )}
    </li>
  )
}
