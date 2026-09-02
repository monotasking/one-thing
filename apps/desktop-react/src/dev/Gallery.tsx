import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Copy, Search, X, resolveIcon } from '../components/icons'
import { AsyncButton } from '../ui/AsyncButton'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Field, useFieldControlProps } from '../ui/Field'
import { GroupHead } from '../ui/GroupHead'
import { StatusDot } from '../ui/StatusDot'
import { IconButton } from '../ui/IconButton'
import { Splitter } from '../ui/Splitter'
import { Checkbox } from '../ui/Checkbox'
import { ConfirmHost, Dialog, useConfirm } from '../ui/Dialog'
import { InlineEditStrip } from '../ui/InlineEditStrip'
import { Input } from '../ui/Input'
import { Kbd } from '../ui/Kbd'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { Radio, RadioGroup } from '../ui/Radio'
import { Reveal, REVEAL_SCOPE } from '../ui/Reveal'
import { SecretInput } from '../ui/SecretInput'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'
import { Spinner } from '../ui/Spinner'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { pushToast, ToastHost } from '../ui/Toast'
import { useInlineEdit } from '../ui/inline-edit'
import { useScrolledPast } from '../ui/scrolled-past'
import { useSettlePulse } from '../ui/settle-pulse'
import { createMutation } from '../data/kernel'
import { FocusScope } from '../focus/FocusScope'
import { useFocusDispatch } from '../focus/dispatch'
import { TOAST_LIFE_MS } from '../components/motion'
import { Tooltip } from '../ui/Tooltip'
import s from './Gallery.module.css'

/**
 * 组件库规格页 —— dev 工具,不进产品外壳。入口:任何 URL 加 ?gallery。
 *
 * 它踩了两条本仓铁律,都是有意的,理由写在这里而不是散在下面:
 *
 * 1. 区块标题写的是**组件专名**(Input / Switch / Select…)。专名不是界面文案:
 *    它换一门语言也不该变,按 i18n/index.ts 顶上那条判据(「换语言该不该跟着变?」)
 *    它不进字典。
 * 2. 示例里的填充文字是**内容样本**,和 expose/data.ts、data/chat-mock.ts 里的
 *    mock 会话标题同一性质 —— 是「这批样例的事实」,不是外壳文案,所以原样写英文。
 *    真正会进产品的那两句(对话框的确定 / 取消)仍然走 i18n,由组件自己取。
 *
 * 这页只做一件事:把每件组件的每档尺寸、每个状态摊平了并排放,便于肉眼比对。
 * 它不演示业务组合 —— 那是外壳的事。
 */
const PencilIcon = resolveIcon('Pencil')

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className={s.section}>
      <h2 className={s.name}>{name}</h2>
      <div className={s.row}>{children}</div>
    </section>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <span className={s.note}>{children}</span>
}

const MODELS = [
  { value: 'claude-fable-5', label: 'claude-fable-5' },
  { value: 'deepseek-chat', label: 'deepseek-chat' },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
]

const TABS = [
  { id: 'files', label: 'Files', icon: 'FolderTree' },
  { id: 'diff', label: 'Diff', icon: 'GitCompare' },
  { id: 'terminal', label: 'Terminal', icon: 'Terminal' },
]

/**
 * AsyncButton 那一格的样本。规格页不接真后端 —— 它要展示的是**三态怎么走**,
 * 所以这里给一个慢到看得清的假写口(1.2 秒),和一个必然失败的。
 * 两颗都吃同一件 mutation,忙态是读来的:这正是这件组件存在的理由。
 */
const SLOW_MS = 1200
const demoSave = createMutation<string, void>('gallery.save', {
  key: (id) => id,
  run: (id) =>
    new Promise((resolve, reject) => {
      setTimeout(() => (id === 'fail' ? reject(new Error('The host said no')) : resolve()), SLOW_MS)
    }),
})

const DENSITY = [
  { value: 'cozy' as const, label: 'Cozy' },
  { value: 'compact' as const, label: 'Compact' },
]

/**
 * Field 那一格的样本控件。它演的正是 Field 的关联契约:
 * **消费方自己把 `useFieldControlProps()` 摊到控件上**(不是 Field 用
 * cloneElement 硬塞 —— 理由写在 ui/Field.tsx 的文件头)。
 * 摊在 value/onValueChange 之前:调用方永远保留最后一手覆盖权。
 */
function GalleryFieldInput() {
  const field = useFieldControlProps()
  const [value, setValue] = useState('')
  return <Input {...field} value={value} onValueChange={setValue} placeholder="sk-…" />
}

/**
 * Field 里装一件**标不动的控件**(09-02 批 8a)。`<label htmlFor>` 只认可标注元素,
 * 而 Segmented 的根是 `role="radiogroup"` 的 `<div>` —— 关联靠 Field 多交出来的
 * `aria-labelledby`。写法与上面那件逐字相同(一句 `{...field}`),这正是那一格
 * 走 context + 透传、而不是让 Segmented 去吃 Field 的 context 的理由。
 */
function GalleryFieldSegmented({
  value,
  onChange,
}: {
  value: 'cozy' | 'compact'
  onChange: (v: 'cozy' | 'compact') => void
}) {
  const field = useFieldControlProps()
  return <Segmented {...field} options={DENSITY} value={value} onChange={onChange} />
}

/**
 * `useScrolledPast` 那一格(09-02 批 9a)。它必须演在一个**内层滚动容器**里 ——
 * 这只件的第二条判例正是「root 取真正在滚的那一层,不是缺省的视口」,
 * 拿整页视口演恰好演不出它。哨兵零高度、不占位、不进无障碍树。
 */
function GalleryScrolledPast() {
  const box = useRef<HTMLDivElement>(null)
  const mark = useRef<HTMLDivElement>(null)
  const { past } = useScrolledPast(mark)
  return (
    <div
      className={s.scrollDemo}
      ref={box}
      /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex --
       * 刻意的,而且是**本批 gate:a11y 当场抓出来的**:axe 的
       * `scrollable-region-focusable`(serious)—— 一块自己会滚、里面又没有可聚焦
       * 内容的区域,键盘用户根本滚不动它(这一格静息形里那颗回顶钮还没出来,
       * 整块是死的)。静态规则说非交互元素不该可 tab,一般对;但**可滚就是一种
       * 键盘可达性义务**,两条门在这一格上要的东西正好相反,以能被人用为准。
       * 不改成 role="button":它不执行动作,报成按钮是对读屏软件说谎。
       * 产品那一层的滚动区(详情列)不需要这一句 —— 它里面全是钮与勾选框。 */
      tabIndex={0}
      role="region"
      aria-label="Scroll demo"
    >
      <div ref={mark} aria-hidden="true" />
      {Array.from({ length: 24 }, (_, i) => (
        <p key={i} className={s.note}>
          Row {i + 1}
        </p>
      ))}
      {past && (
        <div className={s.scrollFoot}>
          <Button size="sm" pill onClick={() => box.current?.scrollTo({ top: 0 })}>
            Back to top
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * `useSettlePulse` 那一格(09-02 批 9a)。按一下 = token 前进一格 = 播一遍;
 * 收尾看 `animationend`,所以动效档调到「无」时它当场回来。
 * 挂载那一次**不播** —— 屏幕上本来就在长内容,再淡一次是噪音。
 */
function GallerySettlePulse() {
  const [token, setToken] = useState(0)
  const pulse = useSettlePulse(token)
  return (
    <>
      <Button size="sm" onClick={() => setToken((n) => n + 1)}>
        Bump token
      </Button>
      <span
        className={pulse.on ? s.settled : undefined}
        onAnimationEnd={pulse.end}
        data-testid="gallery-settle"
      >
        settled #{token}
      </span>
    </>
  )
}

/** `ui/SecretInput` 那一格(09-02 批 12):密码形 + 一颗切明暗的眼睛钮。 */
function GallerySecretInput() {
  const [value, setValue] = useState('sk-live-1a2b3c4d')
  return (
    <SecretInput
      aria-label="Secret sample"
      size="sm"
      value={value}
      onValueChange={setValue}
      revealLabel="Show the key"
      hideLabel="Hide the key"
    />
  )
}

/**
 * `useInlineEdit` 那一格(09-02 批 11)。演的是**原地**:休止态是一段文字
 * (它自己就是入口),点它当场换成同一行的输入框 —— ↵ 落定 / Esc 收回 /
 * 失焦取消,进来就选中全文。
 * 这一格打开 `cancelOnBlur`,因为它**没有并肩的提交钮**;有钮的那一形(总览改名格)
 * 缺省关着它,理由是 blur 在 click 之前到 —— 两形并排看才说得清那条判据。
 */
function GalleryInlineEdit() {
  const [value, setValue] = useState('sk-live-1a2b3c4d')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!editing) {
    return (
      <Button
        size="sm"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
      >
        {value}
      </Button>
    )
  }
  return (
    <Field layout="inline" size="sm" labelHidden label="Secret">
      <GalleryInlineEditInput
        value={draft}
        onChange={setDraft}
        onCommit={() => {
          setValue(draft)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    </Field>
  )
}

function GalleryInlineEditInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel, cancelOnBlur: true })
  return <Input {...field} {...edit} size="sm" value={value} onValueChange={onChange} />
}

export function Gallery() {
  /*
   * **规格页也要那一个派发器**(09-02 R1)。浮层的 Esc / 模态的 Tab 现在是声明,
   * 真正听键盘的只有它 —— 而它挂在 `AppShell` 上,规格页是与外壳**二选一**的另一条
   * 路(App.tsx),所以这里要自己挂一份。
   *
   * `runCommand` 是空的:全局命令的落点是外壳那几个 store(开面 / 切工作区 / 新建
   * 会话),规格页上没有外壳可开。这与改前逐字相同 —— 旧的 `useKeymapDispatch`
   * 同样只挂在 `AppShell` 上,规格页从来就不响全局快捷键。
   */
  useFocusDispatch({ runCommand: () => {} })
  const [text, setText] = useState('claude-fable-5')
  const splitRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(45)
  const [on, setOn] = useState(true)
  const [checked, setChecked] = useState(true)
  const [half, setHalf] = useState(false)
  const [radio, setRadio] = useState('stage')
  const [model, setModel] = useState('deepseek-chat')
  const [tab, setTab] = useState<string | null>('files')
  const [density, setDensity] = useState<'cozy' | 'compact'>('cozy')
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [dialog, setDialog] = useState(false)
  const [answer, setAnswer] = useState<string>('—')
  // IconButton 的 ref 展位(09-02 批 8a):这一格证明 ref 真的落在那颗 <button> 上。
  const measureRef = useRef<HTMLButtonElement>(null)
  const [measured, setMeasured] = useState<number | null>(null)
  const [fieldDensity, setFieldDensity] = useState<'cozy' | 'compact'>('cozy')
  const confirm = useConfirm()

  return (
    /*
     * 规格页整页装进 <main>:axe 的 landmark-one-main / region 两条查的是
     * 「页面内容有没有落在地标里」—— 一张没有地标的页,读屏软件的「跳到主内容」
     * 那一手就落空了。外壳那边本来就有 <main>(AppShell),这里补齐。
     */
    /*
     * **规格页也有一棵响应链**(09-02 R1)。它是 `?gallery` 那条 dev 路,与外壳
     * 二选一(App.tsx),所以「一台窗口一棵树、一棵树一个 root」在这里的读法是:
     * 这一页自己有一格 root。
     *
     * 不给的话,页上那几件浮层(Dialog / Menu / Popover)登记出来的父就是 null,
     * 每一件各自成一棵树 —— 关掉时「路径缩回父、焦点回父上次所在的元素」这条
     * 结构归还(§4.5)没有父可缩,焦点会掉回 `<body>`。而规格页正是 `gate:a11y`
     * 与 `gate:focus` 验「Esc 之后焦点回没回来」的那块场地。
     */
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <main {...scopeProps} className={s.page}>
          <h1 className={s.head}>src/ui</h1>

          <Section name="Button">
            <Button>ghost sm</Button>
            <Button size="md">ghost md</Button>
            <Button variant="primary">primary sm</Button>
            <Button variant="primary" size="md">primary md</Button>
            <Button pill variant="primary">pill</Button>
            {/* danger 与 ghost 并排摆:两者几何逐字相同,差的只有字色 ——
                并排才看得出「危险色只上字、hover 才浅底、永不实底红」。 */}
            <Button variant="danger">danger sm</Button>
            <Button variant="danger" size="md">danger md</Button>
            <Button iconOnly aria-label="Search"><Search size={14} /></Button>
            <Button disabled>disabled</Button>
            <Button variant="danger" disabled>danger disabled</Button>
            <Button variant="primary" size="md"><Spinner /> loading</Button>
          </Section>

          {/* 每个输入框都得有名字 —— Input 自己**故意**不给默认 aria-label(名字是业务),
              所以规格页也要像真调用方一样给。少一个,axe 的 label 那条当场红。 */}
          {/*
           * 图标钮(第 18 件,09-01 立)。规格页把**每一档尺寸、每一个状态**摊平并排,
           * 正是这件立件的理由 —— 从前各面各画一套,谁也说不出「标准的 hover 是什么」。
           */}
          <Section name="IconButton">
            <IconButton icon={X} label="Close" size="xs" />
            <IconButton icon={X} label="Close" size="sm" />
            <IconButton icon={X} label="Close" size="md" />
            <IconButton icon={PencilIcon} label="Edit" pressed />
            <IconButton icon={X} label="Delete" tone="danger" />
            <IconButton icon={Copy} label="Copy" disabled />
            {/* ref 展位(09-02 批 8a):点它读自己的矩形 —— 从前要在外面包一格贴身
                span 才量得到。这一格演的是「口子真的通到那颗 <button>」。 */}
            <IconButton
              ref={measureRef}
              icon={Search}
              label="Measure me"
              onClick={() => setMeasured(measureRef.current?.getBoundingClientRect().width ?? null)}
            />
            <Note>rest / hover / active / pressed / disabled;提示走 Tooltip,禁 native title</Note>
            <Note>ref 落在那颗 &lt;button&gt; 上 —— 量得到 {measured == null ? '(点一下)' : `${Math.round(measured)}px`}</Note>
          </Section>

          {/* 分隔杆(第 19 件,09-01 立)。APG window splitter:←/→ 调、Home/End 到头、↵ 回默认。 */}
          <Section name="Splitter">
            <div className={s.wide} ref={splitRef} style={{ display: 'flex', height: 72 }}>
              <div style={{ width: `${split}%`, background: 'var(--surface-1)' }} id="gallery-split-a" />
              <Splitter
                containerRef={splitRef}
                value={split}
                defaultValue={45}
                label="Resize the left pane"
                controls="gallery-split-a"
                onCommit={setSplit}
              />
              <div style={{ flex: 1, background: 'var(--surface-2)' }} />
            </div>
            <Note>拖 / ←→ / Home / End / ↵ 回默认;拖拽期间零 React 重渲</Note>
          </Section>

          <Section name="Input">
            <Input size="sm" value={text} onValueChange={setText} aria-label="Input sm" />
            <Input size="md" value={text} onValueChange={setText} aria-label="Input md" />
            <Input size="lg" value={text} onValueChange={setText} aria-label="Input lg" />
            <Input value="" onValueChange={() => {}} placeholder="Placeholder" aria-label="Input placeholder" />
            <Input value={text} onValueChange={setText} prefix={<Search />} aria-label="Input with prefix" />
            <Input value={text} onValueChange={setText} invalid aria-label="Input invalid" />
            <Input value={text} onValueChange={setText} disabled aria-label="Input disabled" />
          </Section>

          <Section name="Switch">
            <Switch checked={on} onChange={setOn} label="Demo switch" />
            <Switch checked={!on} onChange={(v) => setOn(!v)} label="Mirror switch" />
            <Switch checked disabled onChange={() => {}} label="Disabled on" />
            <Switch checked={false} disabled onChange={() => {}} label="Disabled off" />
          </Section>

          <Section name="Checkbox">
            <Checkbox checked={checked} onChange={setChecked} label="Checked" />
            <Checkbox checked={false} onChange={() => {}} label="Unchecked" />
            <Checkbox checked={half} indeterminate onChange={setHalf} label="Indeterminate" />
            <Checkbox checked disabled onChange={() => {}} label="Disabled" />
          </Section>

          <Section name="Radio">
            <RadioGroup value={radio} onChange={setRadio} label="Open behaviour">
              <Radio value="stage">Stage</Radio>
              <Radio value="pinned">Pinned</Radio>
              <Radio value="none" disabled>Disabled</Radio>
            </RadioGroup>
          </Section>

          <Section name="Select">
            <div className={s.cell}>
              <Select options={MODELS} value={model} onChange={setModel} size="sm" label="Model sm" />
            </div>
            <div className={s.cell}>
              <Select options={MODELS} value={model} onChange={setModel} label="Model md" />
            </div>
            <div className={s.cell}>
              <Select options={MODELS} value={model} onChange={setModel} size="lg" label="Model lg" />
            </div>
            <div className={s.cell}>
              <Select options={MODELS} value={model} onChange={setModel} disabled label="Model disabled" />
            </div>
          </Section>

          <Section name="Tooltip">
            <Tooltip content="Anchored above, flips below near the top edge">
              <Button>hover me</Button>
            </Tooltip>
            <Tooltip content="Focus opens it too — try Tab">
              <Button>focus me</Button>
            </Tooltip>
            <Note>delay = --dur-tooltip-delay</Note>
          </Section>

          <Section name="Dialog">
            <Button onClick={() => setDialog(true)}>open dialog</Button>
            <Button
              variant="primary"
              onClick={() => {
                void confirm({
                  title: 'Discard this draft?',
                  description: 'The draft has unsaved edits. This cannot be undone.',
                }).then((ok) => setAnswer(String(ok)))
              }}
            >
              useConfirm
            </Button>
            <Note>last answer: {answer}</Note>
          </Section>

          {/* 规格页直接戳 hub —— 产品代码走 services/notify(一条入口),
              但这一页要演示的正是这个组件本身,不该经过通知中心。 */}
          <Section name="Toast">
            <Button onClick={() => pushToast({ level: 'info', title: 'Saved to this session', lifeMs: TOAST_LIFE_MS.info })}>info</Button>
            <Button onClick={() => pushToast({ level: 'success', title: 'Reconnected', body: '3 updates caught up', lifeMs: TOAST_LIFE_MS.success })}>success</Button>
            <Button onClick={() => pushToast({ level: 'warn', title: 'Running on a stale catalog', lifeMs: TOAST_LIFE_MS.warn })}>warn</Button>
            <Button onClick={() => pushToast({ level: 'error', title: 'Could not reach the model host', lifeMs: null })}>error</Button>
            <Note>hover to pause the timer · error stays until you close it · 4th one folds the stack</Note>
          </Section>

          {/* 第 17 件:忙态是**读来的**,不是调用方 useState 记的一份。
              点下去 → 立刻 disabled + aria-busy;150ms 之后才换字(极快的请求
              不该闪一记「在办了」再闪回来)。 */}
          <Section name="AsyncButton">
            <AsyncButton
              action={demoSave}
              pendingKey="ok"
              pendingLabel="Saving…"
              variant="primary"
              onClick={() => void demoSave.run('ok')}
            >
              save
            </AsyncButton>
            <AsyncButton
              action={demoSave}
              pendingKey="fail"
              pendingLabel="Saving…"
              onClick={() => void demoSave.run('fail')}
            >
              save (fails)
            </AsyncButton>
            <AsyncButton action={demoSave} pendingKey="never" pendingLabel="Saving…" disabled>
              disabled
            </AsyncButton>
            <Note>忙态逐格:点一颗,另一颗照常可点</Note>
          </Section>

          <Section name="Spinner">
            <Spinner size="sm" />
            <Spinner size="md" />
            <Note>status bar / button loading only</Note>
          </Section>

          <Section name="Menu">
            <Button onClick={(e) => setMenuAt({ x: e.clientX, y: e.clientY })}>open menu</Button>
            {menuAt && (
              <Menu x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)} label="Gallery menu">
                <MenuSection>OPEN WITH</MenuSection>
                <MenuItem checked onClick={() => setMenuAt(null)}>Stage</MenuItem>
                <MenuItem checked={false} onClick={() => setMenuAt(null)}>Pinned</MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => setMenuAt(null)}>Settings…</MenuItem>
                {/* 禁灰档:形状恒定,做不动的那一项留在原位(09-02 批 12)。 */}
                <MenuItem disabled onClick={() => setMenuAt(null)}>Move up</MenuItem>
              </Menu>
            )}
            <Note>disabled 的项禁灰**不消失** —— 菜单的形状不该随上下文变</Note>
          </Section>

          <Section name="Tabs">
            <div className={s.wide}>
              <Tabs items={TABS} activeId={tab} onSelect={setTab} onClose={() => {}} label="Gallery tabs" />
            </div>
          </Section>

          <Section name="Segmented">
            <Segmented options={DENSITY} value={density} onChange={setDensity} label="Density" />
            {/* 整组禁用(09-02):粒度只有一整组 —— 「这个问题现在轮不到你答」。
                选中的那一段照旧标着,禁掉不等于失忆。 */}
            <Segmented
              options={DENSITY}
              value={density}
              onChange={setDensity}
              label="Density (disabled)"
              disabled
            />
          </Section>

          <Section name="Badge">
            <Badge tone="danger">3</Badge>
            <Badge tone="ok">✓</Badge>
            <Badge tone="unread">12</Badge>
          </Section>

          {/*
           * ── 批 2a 立的四件「视觉词汇」(09-01)──────────────────────────────
           * 它们不是新控件,是把存量里各画各的那几个词收成一件:状态点 8 产地、
           * 卡 7 产地、组头 4 产地、表单行 2 产地(`ui:consume` 的 shared-vocab-css
           * 记着这笔账)。规格页在这里把每一档摊平并排 —— 收编(批 2b)时,
           * 这一屏就是「迁移前后该长得一模一样」的那张对照表。
           */}
          <Section name="StatusDot">
            <StatusDot tone="ok" />
            <StatusDot tone="info" />
            <StatusDot tone="warn" />
            <StatusDot tone="bad" />
            <StatusDot tone="idle" />
            <StatusDot tone="off" />
            <StatusDot tone="bad" label="Auth failed" />
            <Note>ok / info / warn / bad / idle / off;旁边已有文字就不给 label(给了会被念两遍)</Note>
            {/* 尺寸两档并排(09-02 批 8a):sm 是檐上那一颗(未保存丸),md 是列表里那一族。
                并排才看得出「档位」是什么意思 —— 它只有这两种,不是一个自由量。 */}
            <StatusDot tone="warn" size="sm" />
            <StatusDot tone="warn" size="md" />
            <Note>size:sm 5px(檐上)/ md 6px(缺省,列表与详情栏)—— 档位不是自由量</Note>
          </Section>

          <Section name="GroupHead">
            <div className={s.wide}>
              <GroupHead label="CLOUD" />
              <GroupHead label="anthropic/" note="12 models" collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
              <GroupHead label="openai/" note="filtered open — cannot collapse while searching" collapsed={false} disabled onToggle={() => {}} />
            </div>
            <Note>静态 / 可折叠(▾▸ + aria-expanded)/ 禁用;note 是文字读数,不是计数徽</Note>
          </Section>

          <Section name="Card">
            <div className={s.cell}>
              <Card>Body only — no header row is rendered at all.</Card>
            </div>
            <div className={s.cell}>
              <Card title="Usage" note="cached 3m ago">
                Body sits under the title row.
              </Card>
            </div>
            <div className={s.cell}>
              <Card title="Mode" note="Subscription mode does not use an API key." notePlacement="below">
                Body sits under the note.
              </Card>
            </div>
            <div className={s.cell}>
              <Card title="Crash" pad="lg" bordered={false} titleAs="h4">
                pad lg, no border, h4.
              </Card>
            </div>
            {/*
             * 檐动作槽(09-02 批 8a)。三格摆在一起才看得出裁定:
             * inline 注贴着标题走、动作永远靠右;below 注掉到檐外,动作**仍在檐右**。
             * 第三格是「只有动作」——檐照样画,动作不掉进卡身。
             */}
            <div className={s.cell}>
              <Card
                title="Usage"
                note="cached 3m ago"
                actions={<Button size="sm">Refresh</Button>}
              >
                actions sit at the far right of the head row.
              </Card>
            </div>
            <div className={s.cell}>
              <Card
                title="Mode"
                note="Subscription mode does not use an API key."
                notePlacement="below"
                actions={<IconButton icon={PencilIcon} label="Edit mode" />}
              >
                note drops below; actions stay on the head row.
              </Card>
            </div>
            <div className={s.cell}>
              <Card actions={<IconButton icon={X} label="Dismiss" />}>
                No title, no note — the head row still renders because actions are there.
              </Card>
            </div>
            <Note>空槽不渲染 DOM;卡不是控件 —— 整张可点的那一形归 ButtonBase</Note>
            <Note>actions 在檐右端;note 两个落点都不改它的落点</Note>
          </Section>

          <Section name="Field">
            <div className={s.cell}>
              <Field label="API key">
                <GalleryFieldInput />
              </Field>
            </div>
            <div className={s.cell}>
              <Field label="Base URL" hint="Ends with /v1">
                <GalleryFieldInput />
              </Field>
            </div>
            <div className={s.cell}>
              <Field label="Base URL" error="Not a valid URL.">
                <GalleryFieldInput />
              </Field>
            </div>
            <div className={s.cell}>
              <Field label="Base URL" hint="Ends with /v1" error="Not a valid URL.">
                <GalleryFieldInput />
              </Field>
            </div>
            {/*
             * 不可标注的控件那一格(09-02 批 8a)。radiogroup 的根是个 <div>,
             * `<label htmlFor>` 指不动它 —— 关联靠 Field 交出来的 `aria-labelledby`,
             * 消费方照旧一句 `{...field}`。这一格演的就是那条路。
             */}
            <div className={s.cell}>
              <Field label="Density" hint="Applies to lists and cards.">
                <GalleryFieldSegmented value={fieldDensity} onChange={setFieldDensity} />
              </Field>
            </div>
            {/*
             * 横排档三形(09-02 批 10)。演的是「标签与控件同一行、附注折到第二行
             * 占满宽」,以及**标签只念不看**那一格 —— 三处产地里两处正是它
             * (WorkspaceOverview 改名格 / NoWorkdirNotice 绑定行),从前它们各写
             * 一份 `aria-label` 加一份同构的横排 CSS。
             */}
            <div className={s.cell}>
              <Field layout="inline" size="sm" label="Name">
                <GalleryFieldInput />
                <Button>Save</Button>
              </Field>
            </div>
            <div className={s.cell}>
              <Field layout="inline" labelHidden label="Working directory">
                <GalleryFieldInput />
                <Button variant="primary">Bind</Button>
              </Field>
            </div>
            <div className={s.cell}>
              <Field
                layout="inline"
                labelHidden
                label="Model id"
                error="That id is not in the catalog."
              >
                <GalleryFieldInput />
                <Button variant="primary">Add</Button>
              </Field>
            </div>
            <Note>控件经 useFieldControlProps() 拿 id / aria-describedby / aria-invalid</Note>
            <Note>radiogroup 这类标不动的控件靠同一口 aria-labelledby 关联(htmlFor 指不动 div)</Note>
            <Note>inline 档:标签与控件同一行,hint / error 折第二行占满宽</Note>
            <Note>labelHidden:名字只念不看 —— 关联一格不少,不是「没有标签」</Note>
          </Section>

          <Section name="Kbd">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
            <Kbd>Esc</Kbd>
          </Section>

          <Section name="useScrolledPast">
            <div className={s.wide}>
              <GalleryScrolledPast />
            </div>
            <Note>滚过哨兵那个点才出现回顶钮;哨兵还在下面(没滚到)不算</Note>
            <Note>root 取自 overflow 祖先 —— 缺省视口那一档量的是窗口矩形,判据会恒假</Note>
          </Section>

          <Section name="useSettlePulse">
            <GallerySettlePulse />
            <Note>token 变一次播一次;挂载那一次不播;收尾看 animationend 不看计时器</Note>
          </Section>

          <Section name="SecretInput">
            <GallerySecretInput />
            <Note>挂载恒是暗的;眼睛钮 aria-pressed 报明暗,禁用跟着输入框一起禁</Note>
            <Note>那颗钮走 ui/Input 的 action 槽(可交互),不是 aria-hidden 的 suffix 槽</Note>
          </Section>

          <Section name="InlineEditStrip">
            <div className={s.wide}>
              <InlineEditStrip
                prefix={<span>sk-f44••••a477 →</span>}
                saveLabel="Save"
                savingLabel="Saving…"
                cancelLabel="Cancel"
                canSave={false}
                onCommit={() => {}}
                onCancel={() => {}}
              >
                <Input aria-label="New key" value="" onValueChange={() => {}} size="sm" />
              </InlineEditStrip>
            </div>
            <div className={s.wide}>
              <InlineEditStrip
                prefix={<span>Delete this key? Usage already attributed to it stays in the ledger.</span>}
                tone="danger"
                saveLabel="Delete"
                savingLabel="Deleting…"
                cancelLabel="Cancel"
                onCommit={() => {}}
                onCancel={() => {}}
              />
            </div>
            <div className={s.wide}>
              <InlineEditStrip
                saveLabel="Save"
                savingLabel="Saving…"
                cancelLabel="Cancel"
                busy
                onCommit={() => {}}
                onCancel={() => {}}
              >
                <Input aria-label="Busy sample" value="sk-live" onValueChange={() => {}} size="sm" />
              </InlineEditStrip>
            </div>
            <Note>三形:带前缀的编辑条 / 没有控件槽的确认条(danger)/ 忙态(转圈在钮里)</Note>
          </Section>

          <Section name="Reveal">
            <span className={s.wide} {...REVEAL_SCOPE}>
              <Button size="sm">hover this scope</Button>
              <Reveal>
                <IconButton size="sm" icon={PencilIcon} label="Ghost action" />
              </Reveal>
            </span>
            <Note>占位常驻只动 opacity;判据挂在作用域上,:focus-within 与 hover 同权</Note>
          </Section>

          <Section name="useInlineEdit">
            <GalleryInlineEdit />
            <Note>点那段文字 = 同一格换成输入框;↵ 落定 / Esc 收回 / 失焦取消</Note>
            <Note>一进来就选中全文 —— 接着打是覆盖不是追加(controlId 缺席则不自动聚焦)</Note>
            <Note>cancelOnBlur 缺省关:并肩站着提交钮时,blur 在 click 之前到会把那颗钮废掉</Note>
          </Section>

          <Dialog
            open={dialog}
            onClose={() => setDialog(false)}
            title="Plain dialog"
            footer={<Button variant="primary" onClick={() => setDialog(false)}>OK</Button>}
          >
            Scrim click and Esc both close it. Focus lands on the panel when it opens.
          </Dialog>

              <ConfirmHost />
              <ToastHost
                closeLabel="Close"
                moreText={(count) => `+${count} earlier`}
              />
        </main>
      )}
    </FocusScope>
  )
}
