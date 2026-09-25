import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type {
  DialectOption,
  ProbeCustomProviderRequest,
  ProbeCustomProviderResponse,
} from '@shared/ipc/providers'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Fold, FoldBody, FoldTrigger } from '../../ui/Fold'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { Spinner } from '../../ui/Spinner'
import { Tooltip } from '../../ui/Tooltip'
import { ChevronRight, X } from '../../components/icons'
import { isMessageKey, useT } from '../../i18n'
import type { TFn } from '../../i18n'
import {
  DEFAULT_CUSTOM_DIALECT,
  customHeadersOf,
  type CustomHeaderRow,
  type CustomProviderForm,
} from '../store'
import s from './CustomProviderDialog.module.css'

/**
 * 新建 / 改一家自定义服务商 = **这一家的 manifest 编辑器**(批 3 §6.1,
 * `docs/design/provider-settings-rework-2026-09.md`)。六格:名称✱ / 接口类型 /
 * 接口地址✱ / 密钥(可空)/ 高级 ▸(模型列表地址 + 自定义请求头)/ 默认模型。
 * **没有测试连接钮**:保存后目录区自动拉一次,拉到的结果就是反馈。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *   生命周期:随 `open` 开合;每次打开都从底本重置(上一次填了一半的不跟到下一次,
 *             尤其不把上一家的接口地址带进新一家)。无订阅 / 无计时器。
 *   UI 生命状态:
 *     · 空表单(新建):接口类型 = OpenAI 兼容,高级收起,请求头只有一条空行;
 *     · 编辑已有:底本来自盘上那一家(`customProviderFormOf`),密钥格空(渲染层
 *       手上没有原文,空 = 不动池),有请求头或模型列表地址的**高级默认展开**;
 *     · 保存失败:对话框留在屏上、表单一格不丢,表单级一句「设置没保存上」
 *       (详细原话由写口那一路的通知说)。
 *   UI 交互状态:rest / focus(全局环)/ **保存中**(主钮自己变字 + 禁用,取消仍可点)/
 *             必填在**提交时**才拦(一开就爆三条红字是在骂用户还没开始填)。
 *
 * ── 两处判断,都不是样式问题 ──────────────────────────────────────────────
 * ① 接口类型下拉**读方言注册表**(`providers.listDialects`),人话名查壳的字典
 *    `providers.dialect.<id>`;字典里没有的方言不进下拉。注册表还没问回来 / 问失败,
 *    退回两项缺省(OpenAI / Anthropic 兼容)—— 下拉不因一发没回来而空着。
 * ② 请求头是**有序的行**,不是一张表:末尾永远留一条空行(在空行里打字就长出下一条),
 *    名字空的行落盘时不算。行身份用本地序号,不用下标 —— 删中间一行时下面几行的
 *    输入框不该换人(换人 = 光标跳走)。
 *
 * ── 「自动识别」(批 4 §7.3)───────────────────────────────────────────────
 * 接口地址填了就可按(密钥可空:本地推理框架不要密钥)。跑时钮自己变忙态;结果一句话 +
 * [应用]。**应用 = 把适配表放进表单**(并把「接口类型」对到它探出来的那条线),保存才落盘 ——
 * 不点应用,盘上一格都不动。手改「接口类型」会清掉已应用的表(它是对着那条线探出来的)。
 * 结果随表单一起在每次打开时清空。
 */

type ProbeView =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; result: ProbeCustomProviderResponse; applied: boolean }

/** 结果那一句:后端给键 + 变量,这里拼(R12:后端答码不答句子)。 */
export function probeResultText(t: TFn, result: ProbeCustomProviderResponse): string {
  const summary = result.summary
  if (!result.ok || !summary) return t('providers.probeFailed')
  const wire = isMessageKey(summary.wireLabelKey) ? t(summary.wireLabelKey) : summary.dialect
  const detail = summary.reasoningPath ? t('providers.probeReasoningAt', { path: summary.reasoningPath }) : ''
  return t('providers.probeResult', { wire, detail, count: summary.modelCount })
}

/** 注册表没回来时的两项缺省:旧的两种兼容形,永远可选。 */
const FALLBACK_DIALECTS: readonly DialectOption[] = [
  { id: 'custom-openai', label: 'OpenAI compatible' },
  { id: 'custom-anthropic', label: 'Anthropic compatible' },
]

const API_KEY_TEMPLATE = '{{apiKey}}'

const EMPTY_FORM: CustomProviderForm = {
  name: '',
  description: '',
  dialect: DEFAULT_CUSTOM_DIALECT,
  baseUrl: '',
  apiKey: '',
  model: '',
  modelsUrl: '',
  headers: [],
}

interface HeaderLine extends CustomHeaderRow {
  /** 本地身份(见文件头 ②)。 */
  key: number
}

/** 下拉选项:字典里有人话名的才进;缺省那一项排第一;底本里的方言不在表里也留着。 */
export function dialectSelectOptions(
  t: TFn,
  dialects: readonly DialectOption[] | undefined,
  current: string,
): Array<{ value: string; label: string }> {
  const source = dialects && dialects.length > 0 ? dialects : FALLBACK_DIALECTS
  const options: Array<{ value: string; label: string }> = []
  for (const dialect of source) {
    const key = `providers.dialect.${dialect.id}`
    if (!isMessageKey(key)) continue
    options.push({ value: dialect.id, label: t(key) })
  }
  options.sort((a, b) => Number(b.value === DEFAULT_CUSTOM_DIALECT) - Number(a.value === DEFAULT_CUSTOM_DIALECT))
  if (current && !options.some((option) => option.value === current)) {
    const known = source.find((dialect) => dialect.id === current)
    options.push({ value: current, label: known?.label ?? current })
  }
  return options
}

export function CustomProviderDialog({
  open,
  initial,
  editingId,
  dialects,
  onClose,
  onSave,
  onProbe,
}: {
  open: boolean
  /** 改一家时的底本。缺席 = 新建。 */
  initial?: CustomProviderForm
  editingId?: string
  /** 「接口类型」下拉的选项(方言注册表)。缺席 = 用两项缺省。 */
  dialects?: readonly DialectOption[]
  onClose: () => void
  /** 答「写成了没有」。写成 = 调用方关掉对话框;没成 = 留在屏上。 */
  onSave: (form: CustomProviderForm) => Promise<boolean> | boolean
  /** 「自动识别」。缺席 = 不画那颗钮。 */
  onProbe?: (request: Omit<ProbeCustomProviderRequest, 'spaceId'>) => Promise<ProbeCustomProviderResponse>
}) {
  const t = useT()
  const [form, setForm] = useState<CustomProviderForm>(EMPTY_FORM)
  const [lines, setLines] = useState<HeaderLine[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [probe, setProbe] = useState<ProbeView>({ phase: 'idle' })
  const nextKey = useRef(0)
  /** 每次打开换一代:上一次没回来的探测结果不许落到这一次的表单上。 */
  const probeGeneration = useRef(0)

  function line(row: CustomHeaderRow): HeaderLine {
    nextKey.current += 1
    return { ...row, key: nextKey.current }
  }

  // 每次开都从底本重置。
  useEffect(() => {
    if (!open) return
    const base = initial ?? EMPTY_FORM
    setForm(base)
    setLines([...base.headers.map(line), line({ name: '', value: '' })])
    setAdvancedOpen(base.headers.length > 0 || base.modelsUrl.trim().length > 0)
    setProblem(undefined)
    setSaving(false)
    setProbe({ phase: 'idle' })
    probeGeneration.current += 1
  }, [open, initial])

  const options = useMemo(
    () => dialectSelectOptions(t, dialects, form.dialect),
    [t, dialects, form.dialect],
  )

  function patch(delta: Partial<CustomProviderForm>) {
    setForm((prev) => ({ ...prev, ...delta }))
    setProblem(undefined)
  }

  function patchLine(key: number, delta: Partial<CustomHeaderRow>) {
    setProblem(undefined)
    setLines((prev) => {
      const next = prev.map((item) => (item.key === key ? { ...item, ...delta } : item))
      // 末尾永远留一条空行:在最后一行里打了字,就长出下一条。
      const last = next[next.length - 1]
      if (last && (last.name || last.value)) next.push(line({ name: '', value: '' }))
      return next
    })
  }

  function removeLine(key: number) {
    setLines((prev) => {
      const next = prev.filter((item) => item.key !== key)
      const last = next[next.length - 1]
      return !last || last.name || last.value ? [...next, line({ name: '', value: '' })] : next
    })
  }

  async function runProbe() {
    if (!onProbe || probe.phase === 'running' || !form.baseUrl.trim()) return
    const generation = probeGeneration.current
    setProbe({ phase: 'running' })
    const headers = customHeadersOf(lines)
    const result = await onProbe({
      baseUrl: form.baseUrl.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      ...(headers ? { headers } : {}),
      ...(form.modelsUrl.trim() ? { modelsUrl: form.modelsUrl.trim() } : {}),
      ...(form.model.trim() ? { hintModel: form.model.trim() } : {}),
    })
    if (generation !== probeGeneration.current) return
    setProbe({ phase: 'done', result, applied: false })
  }

  function applyProbe() {
    if (probe.phase !== 'done' || !probe.result.ok || !probe.result.spec) return
    const { spec, summary } = probe.result
    setForm((prev) => ({ ...prev, adapter: spec, ...(summary?.dialect ? { dialect: summary.dialect } : {}) }))
    setProbe({ ...probe, applied: true })
  }

  async function submit() {
    if (saving) return
    if (!form.name.trim()) {
      setProblem(t('providers.customNameRequired'))
      return
    }
    if (!form.baseUrl.trim()) {
      setProblem(t('providers.customBaseUrlRequired'))
      return
    }
    setSaving(true)
    const ok = await onSave({
      ...form,
      headers: lines.map(({ name, value }) => ({ name, value })),
    })
    setSaving(false)
    if (!ok) setProblem(t('providers.saveFailed'))
  }

  const submitLabel = editingId ? t('providers.customSave') : t('providers.customSubmit')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editingId ? t('providers.customEdit') : t('providers.customAdd')}
      label={editingId ? t('providers.customEdit') : t('providers.customAdd')}
      /*
       * 页脚**没有删除**(09-01「动作单产地 = 右键上下文菜单」):删一家只在行的右键
       * 菜单里一处(`ProviderRowMenu`)。**单产地的意思是只有一处**。
       */
      footer={
        <div className={s.footer}>
          <span className={s.spacer} />
          <Button size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={saving}
            aria-busy={saving || undefined}
            onClick={() => void submit()}
            data-testid="custom-provider-submit"
          >
            {saving ? t('common.saving') : submitLabel}
          </Button>
        </div>
      }
    >
      <div className={s.form}>
        <Field label={t('providers.customName')}>
          <FieldInput
            size="sm"
            value={form.name}
            onValueChange={(name) => patch({ name })}
            aria-label={t('providers.customName')}
          />
        </Field>

        {/*
          接口类型:`ui/Select` 不透传 aria-labelledby,所以名字走它自己的 `label`
          (与 Field 那条 <label> 同一句话)。
        */}
        <Field label={t('providers.customDialect')}>
          <Select
            size="sm"
            options={options}
            value={form.dialect}
            onChange={(dialect) => patch({ dialect, adapter: undefined })}
            label={t('providers.customDialect')}
          />
        </Field>

        <Field label={t('providers.customBaseUrl')} hint={t('providers.customBaseUrlHint')}>
          <FieldInput
            size="sm"
            value={form.baseUrl}
            onValueChange={(baseUrl) => patch({ baseUrl })}
            placeholder="http://localhost:11434/v1"
            aria-label={t('providers.customBaseUrl')}
          />
        </Field>

        <Field label={t('providers.customKey')}>
          <FieldInput
            size="sm"
            type="password"
            value={form.apiKey}
            onValueChange={(apiKey) => patch({ apiKey })}
            aria-label={t('providers.customKey')}
          />
        </Field>

        {onProbe && (
          <div className={s.probe} data-testid="custom-provider-probe">
            <Tooltip content={t('providers.probeHint')}>
              <Button
                size="sm"
                className={s.probeRun}
                disabled={probe.phase === 'running' || !form.baseUrl.trim()}
                aria-busy={probe.phase === 'running' || undefined}
                onClick={() => void runProbe()}
                data-testid="custom-provider-probe-run"
              >
                {/* ui-consume-allow: spinner-placement — 钮内:识别跑着时钮自己转,钮外没有第二处说「在忙」 */}
                {probe.phase === 'running' ? <Spinner label={t('providers.probeRun')} /> : t('providers.probeRun')}
              </Button>
            </Tooltip>
            {probe.phase === 'done' && probe.result.ok && (
              <>
                <span className={s.probeResult} role="status" data-testid="custom-provider-probe-result">
                  {probeResultText(t, probe.result)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className={s.probeRun}
                  disabled={probe.applied}
                  onClick={applyProbe}
                  data-testid="custom-provider-probe-apply"
                >
                  {probe.applied ? t('providers.probeApplied') : t('providers.probeApply')}
                </Button>
              </>
            )}
            {probe.phase === 'done' && !probe.result.ok && (
              <Tooltip content={probe.result.error || t('providers.probeFailed')}>
                <span
                  className={`${s.probeResult} ${s.probeFailed}`}
                  role="status"
                  tabIndex={0}
                  data-testid="custom-provider-probe-result"
                >
                  {t('providers.probeFailed')}
                </span>
              </Tooltip>
            )}
          </div>
        )}

        <Fold open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <FoldTrigger className={s.advancedHead} data-testid="custom-provider-advanced">
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={advancedOpen ? `${s.chevron} ${s.chevronOpen}` : s.chevron}
            />
            <span>{t('providers.customAdvanced')}</span>
          </FoldTrigger>
          <FoldBody className={s.advancedBody}>
            <Field label={t('providers.customModelsUrl')} hint={t('providers.customModelsUrlHint')}>
              <FieldInput
                size="sm"
                value={form.modelsUrl}
                onValueChange={(modelsUrl) => patch({ modelsUrl })}
                aria-label={t('providers.customModelsUrl')}
                data-testid="custom-provider-models-url"
              />
            </Field>

            <div className={s.headers} role="group" aria-label={t('providers.customHeaders')}>
              <span className={s.headersLabel}>{t('providers.customHeaders')}</span>
              {lines.map((item, index) => (
                <div key={item.key} className={s.headerRow} data-testid={`custom-header-row-${index}`}>
                  <Input
                    size="sm"
                    className={s.headerName}
                    value={item.name}
                    onValueChange={(name) => patchLine(item.key, { name })}
                    placeholder={t('providers.customHeaderName')}
                    aria-label={t('providers.customHeaderName')}
                  />
                  <Input
                    size="sm"
                    className={s.headerValue}
                    value={item.value}
                    onValueChange={(value) => patchLine(item.key, { value })}
                    placeholder={t('providers.customHeaderValue')}
                    aria-label={t('providers.customHeaderValue')}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className={s.insertKey}
                    onClick={() => patchLine(item.key, { value: `${item.value}${API_KEY_TEMPLATE}` })}
                  >
                    {t('providers.customHeaderInsertKey')}
                  </Button>
                  {/* 末尾那条空行没有 ✕:它不是一条请求头,是「下一条」的落点。 */}
                  {item.name || item.value ? (
                    <IconButton
                      size="sm"
                      icon={X}
                      label={t('providers.customHeaderRemove')}
                      onClick={() => removeLine(item.key)}
                    />
                  ) : (
                    <span className={s.headerSlot} aria-hidden="true" />
                  )}
                </div>
              ))}
              <p className={s.headersHint}>{t('providers.customHeaderHint')}</p>
            </div>
          </FoldBody>
        </Fold>

        <Field label={t('providers.customModel')} hint={t('providers.customModelHint')}>
          <FieldInput
            size="sm"
            value={form.model}
            onValueChange={(model) => patch({ model })}
            aria-label={t('providers.customModel')}
          />
        </Field>

        {problem && (
          <p className={s.problem} role="status">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/**
 * 一格里的输入框。**存在的唯一理由是那一句 `useFieldControlProps()`** ——
 * `ui/Field` 走的是 context + hook,hook 只能在组件里调。
 * 摊在自己的 props **前面**:这里的 `aria-label` 是这一格真正的名。
 */
function FieldInput(props: ComponentProps<typeof Input>) {
  const field = useFieldControlProps()
  return <Input {...field} {...props} />
}
