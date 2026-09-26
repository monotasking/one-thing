import { Select } from '../../ui/Select'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { rotationHintFact, rotationLabelFact, rotationPoliciesFor } from '../projection'
import type { RotationPoolKind } from '../projection'
import s from './RotationPolicyPicker.module.css'

/**
 * 轮换策略选择器 + 那一档的语义说明 —— **不是新基础件**:它是 `CredentialPool` 底部那一段
 * 原样搬出来的共用件(批 9,`docs/design/subscription-accounts-2026-09.md` §10),
 * 密钥池与订阅账号卡两处消费,各自把池的种类告诉它(同一档在两种池里说法不同)。
 *
 * ── 三张状态表 ─────────────────────────────────────────────────────────────
 * ① 生命周期:随宿主卡画出;自己不取数、不记状态(值与忙态都是 props);无订阅 → 不需要 HMR dispose。
 * ② UI 生命状态(条目数 × 池种类;「画不画」归宿主判,这里只管画出来之后):
 *    订阅池   0 个账号 → 宿主不画(第一屏是登录);1 个 → 宿主不画(没什么可轮);
 *             ≥2 个 → 四档全有:只用第一个 / 用完换下一个 / 轮流使用 / 余量多的优先。
 *    API 池   0 条 → 画但禁掉(策略无处可挂,旧行为);1 条 / ≥2 条 → 画、可选;
 *             三档,有余额源(`hasQuotaSource`)的家多第四档「余额多的优先」。
 *    存着一个选择器上没有的值(插件策略、或没有余额源却存着 quota-remaining)→ 追加一格显示它,
 *    不画成空白;插件策略此刻不可用 → 追加那一句 warn。不认识的策略没有说明句(不编)。
 * ③ UI 交互状态:`disabled` 时整颗禁掉(池在写 / 没有条目);换一档 = 调一次 `onChange`,
 *    落盘与回显走宿主 store(`setRotation`),这里不做乐观态。
 */
export function RotationPolicyPicker({
  kind,
  policy,
  hasQuotaSource = false,
  disabled = false,
  unavailable = false,
  onChange,
}: {
  kind: RotationPoolKind
  policy: string
  /** API 池:这家有余额源(manifest `quotaSource`)才给第四档。订阅池不看它。 */
  hasQuotaSource?: boolean
  disabled?: boolean
  /** 策略是插件给的、而此刻那个插件不在。 */
  unavailable?: boolean
  onChange: (policy: string) => void
}) {
  const t = useT()
  const hint = rotationHint(t, policy, kind)
  return (
    <>
      <div className={s.rotation}>
        <span className={s.rotationLabel}>{t('providers.rotation')}</span>
        <Select
          className={s.rotationSelect}
          size="sm"
          value={policy}
          disabled={disabled}
          onChange={onChange}
          label={t('providers.rotation')}
          options={rotationOptions(t, policy, kind, hasQuotaSource)}
        />
      </div>
      {/* 每一档都要有一句语义说明 —— 策略名单看字面是分不出来的。
          「顺序即优先级」那句读法也在这里:它本来就是这几句在解释的事。 */}
      {hint && <p className={s.hint}>{hint}</p>}
      {unavailable && <p className={s.warn}>{t('providers.rotationUnavailable')}</p>}
    </>
  )
}

/**
 * 这一池的几档 + 「此刻存着的那个」。存着一个不在表上的策略(插件注册的)时
 * **也要有一格能显示它** —— 不然选择器会画成空白,看起来像没设过。
 */
function rotationOptions(t: TFn, policy: string, kind: RotationPoolKind, hasQuotaSource: boolean) {
  const options = rotationPoliciesFor(kind, hasQuotaSource).map((value) => {
    const fact = rotationLabelFact(value, kind)
    return { value: value as string, label: t(fact.key, fact.vars) }
  })
  if (options.some((option) => option.value === policy)) return options
  const fact = rotationLabelFact(policy, kind)
  return [...options, { value: policy, label: t(fact.key, fact.vars) }]
}

function rotationHint(t: TFn, policy: string, kind: RotationPoolKind): string | null {
  const fact = rotationHintFact(policy, kind)
  return fact ? t(fact.key, fact.vars) : null
}
