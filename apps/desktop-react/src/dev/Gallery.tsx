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
import { Input } from '../ui/Input'
import { Kbd } from '../ui/Kbd'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { Radio, RadioGroup } from '../ui/Radio'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'
import { Spinner } from '../ui/Spinner'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { pushToast, ToastHost } from '../ui/Toast'
import { createMutation } from '../data/kernel'
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

export function Gallery() {
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
  const confirm = useConfirm()

  return (
    /*
     * 规格页整页装进 <main>:axe 的 landmark-one-main / region 两条查的是
     * 「页面内容有没有落在地标里」—— 一张没有地标的页,读屏软件的「跳到主内容」
     * 那一手就落空了。外壳那边本来就有 <main>(AppShell),这里补齐。
     */
    <main className={s.page}>
      <h1 className={s.head}>src/ui</h1>

      <Section name="Button">
        <Button>ghost sm</Button>
        <Button size="md">ghost md</Button>
        <Button variant="primary">primary sm</Button>
        <Button variant="primary" size="md">primary md</Button>
        <Button pill variant="primary">pill</Button>
        <Button iconOnly aria-label="Search"><Search size={14} /></Button>
        <Button disabled>disabled</Button>
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
        <Note>rest / hover / active / pressed / disabled;提示走 Tooltip,禁 native title</Note>
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
          </Menu>
        )}
      </Section>

      <Section name="Tabs">
        <div className={s.wide}>
          <Tabs items={TABS} activeId={tab} onSelect={setTab} onClose={() => {}} label="Gallery tabs" />
        </div>
      </Section>

      <Section name="Segmented">
        <Segmented options={DENSITY} value={density} onChange={setDensity} label="Density" />
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
        <StatusDot tone="warn" />
        <StatusDot tone="bad" />
        <StatusDot tone="idle" />
        <StatusDot tone="off" />
        <StatusDot tone="bad" label="Auth failed" />
        <Note>ok / warn / bad / idle / off;旁边已有文字就不给 label(给了会被念两遍)</Note>
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
        <Note>空槽不渲染 DOM;卡不是控件 —— 整张可点的那一形归 ButtonBase</Note>
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
        <Note>控件经 useFieldControlProps() 拿 id / aria-describedby / aria-invalid</Note>
      </Section>

      <Section name="Kbd">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
        <Kbd>Esc</Kbd>
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
  )
}
