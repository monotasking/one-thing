import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import { useT } from '../../i18n'
import type { CustomProviderForm } from '../store'
import s from './CustomProviderDialog.module.css'

/**
 * 新建 / 改一家自定义 provider。字段与生产那张表逐格对齐
 * (`CustomProviderDialog.vue:167-175`)—— 名称✱ / 描述 / 兼容形✱ / Base URL✱ /
 * 密钥(可空)/ 默认模型。
 *
 * ── 两处判断,都不是样式问题 ──────────────────────────────────────────────
 * ① **必填在提交时才拦**,不在打字时报红:一个刚打开、三格全空的表单立刻爆三条
 *    红字,是在骂用户还没开始填。
 * ② **删除是两段就地确认**,和凭证行同一手 —— 但这一颗的确认字要说清代价
 *    (「连同它的模型勾选一起没」),因为删一家比删一把钥匙毁得多。
 */

const EMPTY_FORM: CustomProviderForm = {
  name: '',
  description: '',
  apiType: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
}

export function CustomProviderDialog({
  open,
  initial,
  editingId,
  onClose,
  onSave,
}: {
  open: boolean
  /** 改一家时的底本。缺席 = 新建。 */
  initial?: CustomProviderForm
  editingId?: string
  onClose: () => void
  onSave: (form: CustomProviderForm) => void
}) {
  const t = useT()
  const [form, setForm] = useState<CustomProviderForm>(EMPTY_FORM)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  // 每次开都从底本重置。上一次填了一半就关掉的东西不该跟到下一次 ——
  // 尤其不该把上一家的 Base URL 带进新一家。
  useEffect(() => {
    if (!open) return
    setForm(initial ?? EMPTY_FORM)
    setProblem(undefined)
  }, [open, initial])

  function patch(delta: Partial<CustomProviderForm>) {
    setForm((prev) => ({ ...prev, ...delta }))
    setProblem(undefined)
  }

  function submit() {
    if (!form.name.trim()) {
      setProblem(t('providers.customNameRequired'))
      return
    }
    if (!form.baseUrl.trim()) {
      setProblem(t('providers.customBaseUrlRequired'))
      return
    }
    onSave(form)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editingId ? t('providers.customEdit') : t('providers.customAdd')}
      label={editingId ? t('providers.customEdit') : t('providers.customAdd')}
      /*
       * ── 页脚**没有删除**(09-01「动作单产地 = 右键上下文菜单」)──────────
       * 从前那颗 ghost 「删除这一家」就长在这儿,于是删一家要先点「编辑」开出
       * 这个对话框、再去角落里找 —— 用户报障「custom provider 没有删除选项」
       * 说的就是它:有,但没人找得到。
       * 现在删除只在**行的右键菜单**里一处(`ProviderRowMenu`),两段就地确认
       * 也搬进了库件(`ui/Menu` 的 `confirmLabel`)。**单产地的意思是只有一处**,
       * 所以这里不留一个「顺手也能删」的第二入口。
       */
      footer={
        <div className={s.footer}>
          <span className={s.spacer} />
          <Button size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" onClick={submit}>
            {editingId ? t('providers.customSave') : t('providers.customSubmit')}
          </Button>
        </div>
      }
    >
      <div className={s.form}>
        <p className={s.intro}>{t('providers.customAddIntro')}</p>

        <Field label={t('providers.customName')}>
          <FieldInput
            size="sm"
            value={form.name}
            onValueChange={(name) => patch({ name })}
            aria-label={t('providers.customName')}
          />
        </Field>

        <Field label={t('providers.customDesc')}>
          <FieldInput
            size="sm"
            value={form.description}
            onValueChange={(description) => patch({ description })}
            aria-label={t('providers.customDesc')}
          />
        </Field>

        {/*
          这一格的控件是 Segmented,而 Segmented **不收 id**(它的名由自己的
          `label` prop 给成 aria-label)。所以 Field 的 `<label htmlFor>` 在这一格
          指空 —— 与迁移前逐字等价:迁移前是一个 `<label>` 裹着一个**不可标注**的
          radiogroup,同样只是视觉标签,点它一样不聚焦。要真接上得给 ui/Segmented
          加 id 透传,那是 ui/ 的改动,不在本批面上 —— 留账。
        */}
        <Field label={t('providers.customCompat')}>
          <Segmented
            value={form.apiType}
            onChange={(apiType) => patch({ apiType })}
            label={t('providers.customCompat')}
            options={[
              { value: 'openai' as const, label: t('providers.customCompatOpenai') },
              { value: 'anthropic' as const, label: t('providers.customCompatAnthropic') },
            ]}
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

        <Field label={t('providers.customModel')} hint={t('providers.customModelHint')}>
          <FieldInput
            size="sm"
            value={form.model}
            onValueChange={(model) => patch({ model })}
            aria-label={t('providers.customModel')}
          />
        </Field>

        {problem && <p className={s.problem}>{problem}</p>}
      </div>
    </Dialog>
  )
}

/**
 * 一格里的输入框。**存在的唯一理由是那一句 `useFieldControlProps()`** ——
 * `ui/Field` 走的是 context + hook 而不是 cloneElement(理由写在 Field.tsx 头:
 * 一格里常常不止一件、注入与自带的同名 props 谁赢由合并次序决定),
 * 而 hook 只能在组件里调,所以这一层薄壳是**必须的**,不是顺手包的。
 *
 * 摊在自己的 props **前面**:这里的 `aria-label` 是这一格真正的名(与迁移前
 * 逐字相同),不许被 Field 的 id / aria 关联覆盖掉。
 */
function FieldInput(props: ComponentProps<typeof Input>) {
  const field = useFieldControlProps()
  return <Input {...field} {...props} />
}
