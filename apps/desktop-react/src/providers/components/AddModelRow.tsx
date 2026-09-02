import { useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Input } from '../../ui/Input'
import { useT } from '../../i18n'
import type { AsyncSource } from '../../data/kernel'
import { settingsKey } from '../store'
import s from './ModelCatalog.module.css'

/**
 * **手填一个目录里没有的模型 id**(09-02 批 9a 从 ModelCatalog.tsx 出文件,切线 D)。
 *
 * 它是目录头下面那一条**带子**:展开时才在,收起时连盒子都不留。
 * 「展不展开」不在这件里 —— 那颗开合钮长在目录的檐上(`aria-expanded` 在钮上),
 * 所以 `adding` 归 `ModelCatalog`,这件收一格 `open`。
 *
 * **收起画 `null` 而不是让父件不渲染它**:后者会把这件整个卸载,于是刚打了一半
 * 的 id 在「不小心点了一下开合钮」之后就没了。这件的实例活着、DOM 不在,
 * 草稿就还在 —— 与拆分之前(草稿住在父件里、开合只是一个布尔)逐字同行为。
 *
 * ── 三张状态表(这件那一份)──────────────────────────────────────────────
 *   生命周期:开合**不是**挂载/卸载(见上),只是画不画 DOM;每翻一次面
 *             把上一次那句错误抹掉(那句话是对上一次提交说的),抹在**渲染期**
 *             而不是 effect 里 —— effect 要等一帧,那一帧会把旧错误画出来。
 *             **换一坑 = 换宿主 = 重挂**,由父件的 `key={providerId}` 兑现:
 *             草稿与错误随之归零,且换坑那一帧不会先把上一坑的草稿画出来。
 *             无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose。
 *   UI 生命状态:空(刚展开,钮禁用)/ 填了(钮可点)/ 在写(AsyncButton 换字 +
 *             禁用,忙态**读来的**不是这里再记一份)/ 被拒(错误原文当场画出来,
 *             **且不清空输入框** —— 让人看得见自己刚打的是什么)/ 成功(清空,
 *             好接着填下一个)。
 *   UI 交互状态:输入框 rest / hover / focus / invalid(被拒时边线转 danger);
 *             提交钮 rest / hover / focus / disabled(草稿是空)/ pending。
 *
 * ── 为什么这一行**没有**消费 `ui/Field`(09-02 批 9a 记档,与派工令的出入)──
 * 派工令要求顺手迁 `ui/Field`。逐条对过之后没有迁,三条理由都是结构性的:
 *  ① **方向不对**。`ui/Field` 的根是 `flex-direction: column`(标签在上、控件
 *     居中、错误在下),而这一行是**横排**:输入框 + 提交钮并肩,错误跟在右边。
 *     照 Field 的原形装,提交钮会掉到输入框**下面**去 —— 那不是等价替换。
 *  ② **靠 className 掰方向 = 特异性赌局**。要横过来就得从消费方覆盖
 *     `flex-direction`,而两边都是单类选择器,谁赢取决于打包器把哪份
 *     module.css 排在后面 —— 本仓「特异性坑」判例簇里正是这一类。
 *  ③ **它会凭空多一个可见标签**。`Field` 的 `label` 是必填且**画出来**的,
 *     而这一行今天只有占位字与 `aria-label`。加一行可见标签是**改版**,
 *     不是迁移,归用户拍板(「行为裁定须先问」)。
 * 而 `ui/Field.module.css` 的文件头本就记过同一条判例:WorkspaceOverview 那个
 * **横排**的改名格「不是这件的形」。这一行与它同类。
 *
 * 留账:错误那一句今天**没有**跟输入框关联(没有 `aria-describedby`),
 * 读屏软件读得到边线转红(`aria-invalid`)却读不到原因。补法有两条 ——
 * 给 `ui/Field` 开一档横排,或把这一行改成竖排的真表单行 —— 两条都动到既有
 * 库件或版式,归下一批拍板;这一批不就地手写一份(那正是「基础件先行」要治的病)。
 */
export function AddModelRow({
  open,
  providerId,
  write,
  onAddManual,
}: {
  /** 檐上那颗开合钮说了算。收起时这件画 `null`,但**草稿留着**(见文件头)。 */
  open: boolean
  /** 忙态那一格的坐标:这一发写的 id 此刻还不在表里,挂不到任何一行上。 */
  providerId: string
  /** 手填提交那颗钮绑的那件异步事(设置写路那一发 mutation)。 */
  write: AsyncSource | undefined
  /** 手填一个目录里没有的 id。返回一句错误原文 = 没加上。 */
  onAddManual: (modelId: string) => string | undefined
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | undefined>(undefined)

  /*
   * 翻面就把上一次那句错误抹掉。**在渲染期就地调整**(React 文档里
   * 「props 变了就地调整 state」那一种写法,`ui/list-placement` 同一手):
   * 放进 useEffect 会晚一帧,而那一帧恰好就是带子刚打开的那一帧 ——
   * 人会看见一句对上一次提交说的错误闪一下。
   */
  const [openSeen, setOpenSeen] = useState(open)
  if (openSeen !== open) {
    setOpenSeen(open)
    setAddError(undefined)
  }

  function submitManual() {
    const id = draft.trim()
    if (!id) return
    const failure = onAddManual(id)
    setAddError(failure)
    if (failure) return
    setDraft('')
  }

  if (!open) return null

  return (
    <div className={s.addRow}>
      <div className={s.addField}>
        <Input
          size="sm"
          value={draft}
          onValueChange={(value) => {
            setDraft(value)
            setAddError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitManual()
            }
          }}
          invalid={Boolean(addError)}
          placeholder={t('providers.addModelPlaceholder')}
          aria-label={t('providers.addModelLabel')}
        />
      </div>
      {/*
        手填提交:这一发写的模型 id 此刻还不在表里,挂不到任何一行上,
        所以它自己就是那一格(`manual:<providerId>`)。忙态是**读来的**
        (AsyncButton 吃 mutation),不是这里再记一份。
      */}
      <AsyncButton
        size="sm"
        variant="primary"
        action={write}
        pendingKey={settingsKey.manual(providerId)}
        pendingLabel={t('common.saving')}
        disabled={!draft.trim()}
        onClick={submitManual}
      >
        {t('providers.addModelSubmit')}
      </AsyncButton>
      {addError && <span className={s.addError}>{addError}</span>}
    </div>
  )
}
