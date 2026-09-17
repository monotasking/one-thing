import { useId, useState } from 'react'
import type { ReasoningProfileOverride, ThinkingEffort } from '@shared/ipc/providers'
import { Button } from '../../ui/Button'
import { Checkbox } from '../../ui/Checkbox'
import { Field } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { useT } from '../../i18n'
import { THINKING_LABEL_KEY } from '../../composer/transitions'
import s from './ModelOverridePopover.module.css'

const LEVELS: ThinkingEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => safeJson(item, depth + 1))
  return typeof value === 'object' && Object.entries(value).every(([key, item]) =>
    !UNSAFE_KEYS.has(key) && safeJson(item, depth + 1))
}

/** 表单只保存草稿；整份合法配置一次提交，避免等级和默认档在写入中途不一致。 */
export function ReasoningProfileEditor({ value, inherited, disabled, onWrite }: {
  value?: ReasoningProfileOverride
  inherited?: ReasoningProfileOverride
  disabled: boolean
  onWrite: (value: ReasoningProfileOverride | null) => void
}) {
  const t = useT()
  const errorId = useId()
  const initial: ReasoningProfileOverride = {
    efforts: ['low', 'high'], defaultEffort: 'high', defaultOn: true, toggleable: false,
    ...inherited, ...value,
    effortLabels: { ...inherited?.effortLabels, ...value?.effortLabels },
  }
  const [draft, setDraft] = useState<ReasoningProfileOverride>(initial)
  const [custom, setCustom] = useState(() => value?.custom ? JSON.stringify(value.custom, null, 2) : '')
  const [mappingMode, setMappingMode] = useState(value?.custom === null ? 'native' : value?.custom ? 'custom' : 'inherit')
  const [invalid, setInvalid] = useState(false)
  const efforts = (draft.efforts ?? []).filter((level): level is ThinkingEffort => level !== 'none')

  function save() {
    try {
      let mapping: ReasoningProfileOverride['custom'] = mappingMode === 'native' ? null : undefined
      if (mappingMode === 'custom') {
        const parsed = JSON.parse(custom)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
            typeof parsed.effortPath !== 'string' ||
            !/^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*$/.test(parsed.effortPath) ||
            parsed.effortPath.split('.').some((key: string) => UNSAFE_KEYS.has(key)) || !safeJson(parsed)) {
          throw new Error('Invalid mapping')
        }
        for (const key of ['enabledBody', 'disabledBody']) {
          if (parsed[key] !== undefined && (!parsed[key] || Array.isArray(parsed[key]) || typeof parsed[key] !== 'object')) {
            throw new Error('Invalid body')
          }
        }
        if (parsed.disabledValue !== undefined && parsed.disabledValue !== null &&
            !['string', 'number', 'boolean'].includes(typeof parsed.disabledValue)) throw new Error('Invalid disabled value')
        if (parsed.effortValues !== undefined && (
          !parsed.effortValues || Array.isArray(parsed.effortValues) || typeof parsed.effortValues !== 'object' ||
          Object.entries(parsed.effortValues).some(([key, val]) => !LEVELS.includes(key as ThinkingEffort) ||
            !(typeof val === 'string' || (typeof val === 'number' && Number.isFinite(val))))
        )) throw new Error('Invalid values')
        mapping = parsed
      }
      const defaultEffort = efforts.includes(draft.defaultEffort as ThinkingEffort)
        ? draft.defaultEffort : efforts[efforts.length - 1]
      const rest = { ...draft }
      delete rest.custom
      if (mappingMode !== 'custom' && rest.wire === 'custom') delete rest.wire
      const effortLabels = Object.fromEntries(Object.entries(draft.effortLabels ?? {})
        .map(([level, label]) => [level, label.trim()]).filter(([, label]) => label.length > 0))
      onWrite({ ...rest, effortLabels, efforts, defaultEffort, ...(mapping !== undefined ? { custom: mapping } : {}) })
      setInvalid(false)
    } catch {
      setInvalid(true)
    }
  }

  return (
    <details className={s.reasoning}>
      <summary>{t('providers.reasoningConfigure')}</summary>
      <p className={s.reasoningHint}>{t('providers.reasoningHint')}</p>
      <Field size="sm" label={t('providers.reasoningLevels')}>
        <div className={s.caps}>
          {LEVELS.map((level) => (
            <div key={level} className={s.reasoningLevel}>
              <label className={s.reasoningChoice}>
                <Checkbox checked={efforts.includes(level)} disabled={disabled} onChange={(checked) => {
                  const next = LEVELS.filter((item) => item === level ? checked : efforts.includes(item))
                  setDraft({ ...draft, efforts: next, defaultEffort: next.includes(draft.defaultEffort as ThinkingEffort)
                    ? draft.defaultEffort : next[next.length - 1] })
                }} />
                {t(THINKING_LABEL_KEY[level])}
              </label>
              <Input size="sm" maxLength={80} value={draft.effortLabels?.[level] ?? ''} disabled={disabled || !efforts.includes(level)}
                aria-label={t('providers.reasoningLevelName', { level: t(THINKING_LABEL_KEY[level]) })}
                placeholder={t(THINKING_LABEL_KEY[level])}
                onValueChange={(label) => setDraft({ ...draft, effortLabels: { ...draft.effortLabels, [level]: label } })} />
            </div>
          ))}
        </div>
      </Field>
      {efforts.length > 0 && <Field size="sm" className={s.grp} label={t('providers.reasoningDefault')}>
        <Select size="sm" disabled={disabled} label={t('providers.reasoningDefault')}
          value={draft.defaultEffort ?? efforts[efforts.length - 1]}
          options={efforts.map((level) => ({ value: level, label: draft.effortLabels?.[level] || t(THINKING_LABEL_KEY[level]) }))}
          onChange={(level) => setDraft({ ...draft, defaultEffort: level as ThinkingEffort })} />
      </Field>}
      <label className={s.reasoningChoice}>
        <Checkbox checked={draft.toggleable ?? false} disabled={disabled}
          onChange={(toggleable) => setDraft({ ...draft, toggleable, ...(!toggleable ? { defaultOn: true } : {}) })} />
        {t('providers.reasoningToggleable')}
      </label>
      {draft.toggleable && <label className={s.reasoningChoice}>
        <Checkbox checked={draft.defaultOn ?? true} disabled={disabled}
          onChange={(defaultOn) => setDraft({ ...draft, defaultOn })} />
        {t('providers.reasoningDefaultOn')}
      </label>}
      <details className={s.reasoning}>
        <summary>{t('providers.reasoningMapping')}</summary>
        <p className={s.reasoningHint}>{t('providers.reasoningMappingHint')}</p>
        <Select size="sm" value={mappingMode} disabled={disabled} label={t('providers.reasoningMappingMode')}
          options={[
            { value: 'inherit', label: t('providers.reasoningMappingInherit') },
            { value: 'native', label: t('providers.reasoningMappingNative') },
            { value: 'custom', label: t('providers.reasoningMappingCustom') },
          ]} onChange={(mode) => { setMappingMode(mode); setInvalid(false) }} />
        <textarea className={s.reasoningJson} rows={6} value={custom} disabled={disabled}
          aria-label={t('providers.reasoningMapping')} aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined} spellCheck={false}
          placeholder={'{"effortPath":"reasoning.effort","effortValues":{"low":"low","high":"high"}}'}
          onChange={(event) => { setCustom(event.target.value); setMappingMode('custom'); setInvalid(false) }} />
      </details>
      {invalid && <p id={errorId} role="alert" className={s.reasoningError}>{t('providers.reasoningInvalid')}</p>}
      <div className={s.foot}>
        <Button disabled={disabled} onClick={save}>{t('providers.reasoningSave')}</Button>
        <Button disabled={disabled || !value} onClick={() => onWrite(null)}>{t('providers.reasoningReset')}</Button>
      </div>
    </details>
  )
}
