import { useState } from 'react'
import type { ReactNode } from 'react'
import { Search } from '../components/icons'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
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

const DENSITY = [
  { value: 'cozy' as const, label: 'Cozy' },
  { value: 'compact' as const, label: 'Compact' },
]

export function Gallery() {
  const [text, setText] = useState('claude-fable-5')
  const [on, setOn] = useState(true)
  const [checked, setChecked] = useState(true)
  const [half, setHalf] = useState(false)
  const [radio, setRadio] = useState('stage')
  const [model, setModel] = useState('deepseek-chat')
  const [tab, setTab] = useState<string | null>('files')
  const [density, setDensity] = useState<'cozy' | 'compact'>('cozy')
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState(false)
  const [answer, setAnswer] = useState<string>('—')
  const confirm = useConfirm()

  return (
    <div className={s.page}>
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

      <Section name="Input">
        <Input size="sm" value={text} onValueChange={setText} />
        <Input size="md" value={text} onValueChange={setText} />
        <Input size="lg" value={text} onValueChange={setText} />
        <Input value="" onValueChange={() => {}} placeholder="Placeholder" />
        <Input value={text} onValueChange={setText} prefix={<Search />} />
        <Input value={text} onValueChange={setText} invalid />
        <Input value={text} onValueChange={setText} disabled />
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
    </div>
  )
}
