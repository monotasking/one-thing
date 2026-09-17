import { useEffect, type ComponentProps } from 'react'
import { Button } from '../../ui/Button'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { Switch } from '../../ui/Switch'
import { useMutation, useQuery } from '../../data/kernel'
import {
  editNetworkProxy,
  flushNetworkProxy,
  networkSettingsQuery,
  proxyValidation,
  saveNetworkProxyMutation,
  testNetworkProxyMutation,
  useProxyEditor,
} from '../../data/network-settings-source'
import { useT } from '../../i18n'
import shared from './Settings.module.css'
import s from './NetworkSettings.module.css'

function ProxyInput(props: ComponentProps<typeof Input>) {
  const field = useFieldControlProps()
  return <Input {...field} {...props} />
}

export function NetworkSettings() {
  const t = useT()
  const { data, error, inflight } = useQuery(networkSettingsQuery)
  const saving = useMutation(saveNetworkProxyMutation)
  const testing = useMutation(testNetworkProxyMutation)
  const { draft, testResult } = useProxyEditor()
  const proxy = draft ?? data
  const invalid = proxy && proxyValidation(proxy)

  useEffect(() => { void networkSettingsQuery.ensure() }, [])

  const status = !data
    ? t(error ? 'network.loadFailed' : 'network.loading')
    : saving.pending ? t('common.saving')
      : saving.error ? t('network.saveFailed')
        : draft ? t(invalid ? 'network.unsavedInvalid' : 'network.pending')
          : t(proxy?.enabled ? 'network.enabledStatus' : 'network.disabledStatus')

  return (
    <div className={s.content} data-testid="network-settings">
      <div className={shared.settingRow}>
        <div>
          <div className={shared.settingRowLabel}>{t('network.enable')}</div>
          <div className={shared.settingRowHint}>{t('network.hint')}</div>
        </div>
        <Switch
          label={t('network.enable')}
          checked={proxy?.enabled ?? false}
          disabled={!data}
          onChange={(enabled) => editNetworkProxy({ enabled }, true)}
        />
      </div>
      <Field label={t('network.url')} hint={t('network.urlHint')} error={invalid ? t(invalid) : undefined}>
        <ProxyInput
          value={proxy?.url ?? ''}
          disabled={!data}
          invalid={!!invalid}
          placeholder="http://127.0.0.1:7890"
          autoComplete="off"
          spellCheck={false}
          onValueChange={(url) => editNetworkProxy({ url })}
          onBlur={() => { void flushNetworkProxy() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void flushNetworkProxy()
          }}
        />
      </Field>
      <Field label={t('network.bypass')} hint={t('network.bypassHint')}>
        <ProxyInput
          value={proxy?.bypassRules ?? ''}
          disabled={!data}
          autoComplete="off"
          spellCheck={false}
          onValueChange={(bypassRules) => editNetworkProxy({ bypassRules })}
          onBlur={() => { void flushNetworkProxy() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void flushNetworkProxy()
          }}
        />
      </Field>
      <div className={s.feedback} role="status" aria-live="polite" aria-atomic="true">
        {status}
      </div>
      {error ? (
        <div className={s.feedback} role="alert">
          {t('network.loadFailed')} · {error}
          <Button disabled={inflight} onClick={() => { void networkSettingsQuery.refetch() }}>{t('network.retry')}</Button>
        </div>
      ) : null}
      {saving.error ? (
        <div className={s.feedback} role="alert">
          {saving.error}
          <Button disabled={saving.pending || !!invalid} onClick={() => { void flushNetworkProxy() }}>{t('network.retrySave')}</Button>
        </div>
      ) : null}
      <div className={s.actions}>
        <Button
          disabled={!data || !proxy?.enabled || !!invalid || !!draft || saving.pending || testing.pending}
          onClick={() => { void testNetworkProxyMutation.run() }}
        >
          {t(testing.pending ? 'network.testing' : 'network.test')}
        </Button>
        <span className={shared.sectionNote}>{t('network.testHint')}</span>
      </div>
      {testResult ? (
        <div className={s.feedback} role={testResult.success ? 'status' : 'alert'}>
          {t(testResult.success ? 'network.testSuccess' : 'network.testFailed')}
          {testResult.error ? ` · ${testResult.error}` : ''}
        </div>
      ) : null}
    </div>
  )
}
