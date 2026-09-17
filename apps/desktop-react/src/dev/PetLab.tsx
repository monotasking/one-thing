import { useCallback, useRef, useState } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useFocusDispatch } from '../focus/dispatch'
import { ALU_RIG } from '@onething/runtime/pets/builtin/alu.rig'
import { findBuiltinPet } from '../pets/builtin'
import { PetRigView } from '../pets/rigs/PetRigView'
import { PetStage } from '../pets/PetStage'
import type { PetStageHandle } from '../pets/PetStage'
import type { PerchSize, PetActivity, PetGesture, PetRigSource, PetUtterance, PoseState } from '../pets/types'
import { resolveLang } from '../i18n'
import { useStageStore } from '../stage/store'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import s from './Gallery.module.css'

/**
 * **宠物实验台** —— dev 工具,不进产品外壳。入口:任何 URL 加 `?pet-lab`。
 *
 * 宠物 P0 不接后端(正本 `docs/design/pet-system-2026-09.md` §6 P0 行):活动与话语在
 * 这里用开关喂,所有姿势 × 栖位尺寸 × 栖位宽 × 中英都能一屏凑出来。样例台词是内容
 * 样本,原样写在这张页上,不进字典(与 MusicLab / Gallery 同一条判据)。
 *
 * P5 起多一段**宠物切换**(黑豆 / 阿绿)与一排**九个姿势并列**的形象(§12.6 倒数第二条)。
 * 阿绿的形象在产品里经 `pet:` 的 `roster` 读法交来;lab 不接后端,所以这里直接 import 那份
 * 声明式数据 —— 只有 dev 工具这样取,栖位与设置页都走数据源。
 *
 * ON AIR 灯由 `onSpeakingChange` 点亮(栖位宿主的职责,P1 起是唱机那一盏);手势与选择
 * 记在底下那一栏读数里。
 */

const ACTIVITIES = [
  { value: 'off', label: 'off' },
  { value: 'busy', label: 'busy' },
  { value: 'rhythm72', label: 'rhythm 72' },
  { value: 'rhythm104', label: 'rhythm 104' },
  { value: 'still', label: 'still' },
  { value: 'fault', label: 'fault' },
  { value: 'idle', label: 'idle' },
] as const

type ActivityValue = (typeof ACTIVITIES)[number]['value']

function activityOf(value: ActivityValue): PetActivity {
  if (value === 'rhythm72') return { kind: 'rhythm', bpm: 72 }
  if (value === 'rhythm104') return { kind: 'rhythm', bpm: 104 }
  return value
}

const SIZES = [
  { value: 'stage', label: 'stage' },
  { value: 'corner', label: 'corner' },
] as const

const WIDTHS = [
  { value: '240', label: '240' },
  { value: '360', label: '360' },
  { value: '520', label: '520' },
] as const

/** 样例台词(内容样本)。 */
const LINES = {
  zh: {
    speak: '雨还没停。这首我替你开大了一点。',
    mutter: '先放起来嘛。',
    ask: '今晚口味有点刁啊。要不换个方向？',
    faster: '来点快的',
    quieter: '安静点',
    sticky: '线好像被我踩松了……',
    retry: '再试一次',
    retried: '插好了。',
  },
  en: {
    speak: 'Still raining. I turned this one up a little for you.',
    mutter: 'Put something on first.',
    ask: 'You’re picky tonight. Want to try another direction?',
    faster: 'Something faster',
    quieter: 'Quieter',
    sticky: 'I think I stepped on the cable…',
    retry: 'Try again',
    retried: 'Plugged back in.',
  },
} as const

const LOG_LIMIT = 8

/** lab 能切的宠物:id → 形象来源(手画 id / 声明式数据)。 */
const LAB_PETS: ReadonlyArray<{ id: string; rig: PetRigSource }> = [
  { id: 'heidou', rig: 'heidou-svg' },
  { id: 'alu', rig: ALU_RIG },
]

const POSES: readonly PoseState[] = [
  'sitting',
  'grooving',
  'speaking',
  'busy',
  'listening',
  'dozing',
  'sleeping',
  'dizzy',
  'petted',
]

export function PetLab() {
  // 规格页同款:dev 路没有外壳,自己挂那唯一一个派发器(Esc 才到得了栖位)。
  useFocusDispatch({ runCommand: () => {} })
  // 语言设置可以是「跟随系统」:按解析后的那一种喂样例台词、画分段器。
  const lang = resolveLang(useStageStore((st) => st.locale))
  const lines = LINES[lang]
  const [petId, setPetId] = useState<string>('heidou')
  const labPet = LAB_PETS.find((pet) => pet.id === petId) ?? LAB_PETS[0]
  const manifest = findBuiltinPet(labPet.id)

  const [activity, setActivity] = useState<ActivityValue>('rhythm72')
  const [size, setSize] = useState<PerchSize>('stage')
  const [width, setWidth] = useState<string>('360')
  const [listening, setListening] = useState(false)
  const [utterance, setUtterance] = useState<PetUtterance | null>(null)
  const [onAir, setOnAir] = useState(false)
  const [log, setLog] = useState<ReadonlyArray<{ id: number; entry: string }>>([])
  const logSeq = useRef(0)
  const stageRef = useRef<PetStageHandle | null>(null)

  const note = useCallback((entry: string) => {
    const id = ++logSeq.current
    setLog((prev) => [{ id, entry }, ...prev].slice(0, LOG_LIMIT))
  }, [])

  const onGesture = useCallback((gesture: PetGesture) => note(`gesture ${gesture.kind}`), [note])
  const onChoice = useCallback((value: string | null) => note(`choice ${value ?? 'null (Esc)'}`), [note])

  if (!manifest) return null

  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <main {...scopeProps} className={s.page} data-testid="pet-lab">
          <h1 className={s.head}>pet-lab</h1>
          <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Segmented
              label="pet"
              options={LAB_PETS.map((pet) => ({ value: pet.id, label: pet.id }))}
              value={labPet.id}
              onChange={setPetId}
            />
            <Segmented label="activity" options={[...ACTIVITIES]} value={activity} onChange={setActivity} />
            <Segmented label="size" options={[...SIZES]} value={size} onChange={setSize} />
            <Segmented label="width" options={[...WIDTHS]} value={width} onChange={setWidth} />
            <Segmented
              label="locale"
              options={[
                { value: 'zh', label: '中' },
                { value: 'en', label: 'EN' },
              ]}
              value={lang}
              onChange={(next) => useStageStore.setState({ locale: next })}
            />
            <Switch label="listening" checked={listening} onChange={setListening} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <Button onClick={() => setUtterance({ mode: 'speak', text: lines.speak })}>speak</Button>
            <Button onClick={() => setUtterance({ mode: 'mutter', text: lines.mutter })}>mutter</Button>
            <Button
              onClick={() =>
                setUtterance({
                  mode: 'speak',
                  text: lines.ask,
                  choices: [
                    { value: 'faster', label: lines.faster },
                    { value: 'quieter', label: lines.quieter },
                  ],
                })
              }
            >
              speak + choices
            </Button>
            <Button
              onClick={() =>
                setUtterance({
                  mode: 'mutter',
                  text: lines.sticky,
                  sticky: true,
                  actions: [
                    {
                      label: lines.retry,
                      onSelect: () => {
                        note('action retry')
                        setUtterance({ mode: 'mutter', text: lines.retried, holdMs: 1100 })
                      },
                    },
                  ],
                })
              }
            >
              sticky + action
            </Button>
            <Button onClick={() => setUtterance(null)}>clear</Button>
            <Button onClick={() => stageRef.current?.love()}>liked</Button>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-5)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div
              data-testid="pet-lab-frame"
              style={{
                width: Number(width),
                height: 320,
                border: 'var(--bw-1) solid var(--line-1)',
                borderRadius: 'var(--r-3)',
                background: 'var(--surface-1)',
                overflow: 'hidden',
              }}
            >
              <PetStage
                key={labPet.id}
                ref={stageRef}
                manifest={manifest}
                rig={labPet.rig}
                activity={activityOf(activity)}
                utterance={utterance}
                listening={listening}
                size={size}
                onSpeakingChange={setOnAir}
                onChoice={onChoice}
                onGesture={onGesture}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', minWidth: 0 }}>
              <span
                data-testid="pet-lab-onair"
                data-on={onAir ? 'true' : undefined}
                style={{
                  alignSelf: 'flex-start',
                  padding: 'var(--sp-1) var(--sp-2)',
                  borderRadius: 'var(--r-1)',
                  border: 'var(--bw-1) solid currentColor',
                  color: onAir ? 'var(--danger)' : 'var(--text-3)',
                  fontSize: 'var(--fs-meta)',
                  fontWeight: 600,
                }}
              >
                ON AIR
              </span>
              <ol data-testid="pet-lab-log" style={{ margin: 0, paddingLeft: 'var(--sp-4)', fontSize: 'var(--fs-meta)', color: 'var(--text-2)' }}>
                {log.map((row) => (
                  <li key={row.id}>{row.entry}</li>
                ))}
              </ol>
            </div>
          </div>
          <div data-testid="pet-lab-poses" style={{ display: 'flex', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
            {POSES.map((pose) => (
              <figure key={pose} data-pose-cell={pose} style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-1)' }}>
                <div style={{ width: 'var(--pet-stage-w)', height: 'var(--pet-stage-h)' }}>
                  <PetRigView
                    rig={labPet.rig}
                    pose={pose}
                    beat={pose === 'grooving' ? 0.6 : undefined}
                    mouth={pose === 'speaking' ? 'talking' : 'closed'}
                  />
                </div>
                <figcaption style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-2)' }}>{pose}</figcaption>
              </figure>
            ))}
          </div>
        </main>
      )}
    </FocusScope>
  )
}
