import { useEffect, useState } from 'react'
import { MusicPanel } from '../content/MusicPanel'
import { configureMusicPort } from '../data/music-port'
import { resetMusicSource } from '../data/music-source'
import type { MusicPort } from '../data/music-port'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import { Segmented } from '../ui/Segmented'
import { useStageStore } from '../stage/store'
import s from './Gallery.module.css'

/**
 * 音乐面宽度实验台 —— dev 工具,不进产品外壳。入口:任何 URL 加 `?music-lab`。
 *
 * 为什么有它:音乐面落在架子 / 浮窗 / 舞台三种宿主里,形随面板自己的宽变
 * (`@container music` / `@container deck`)。真机上要凑出「电台开着、正在放、
 * 节目单很长、歌名很长」这一屏得真装 CLI 真登录;这里用一只假端口把那一屏
 * 直接喂出来,切宽度看排版有没有垮。数据是内容样本,原样写中文,不进字典
 * (与 Gallery 同一条判据)。
 *
 * 假端口只回读数、做法一律答 ok,不碰任何真实 store。
 */
const WIDTHS = [
  { value: '300', label: '300' },
  { value: '360', label: '360' },
  { value: '480', label: '480' },
  { value: '620', label: '620' },
  { value: '820', label: '820' },
  { value: '1000', label: '1000' },
  { value: '1280', label: '1280' },
] as const

const SAY_LONG =
  '这首底下有条热评说:「每次下雨都会想起一个没带伞的下午,公交车晚了十分钟,晚到刚好可以把那句话说完」。今晚听,刚好。'

function table(variant: string): Record<string, unknown> {
  const on = variant !== 'off'
  const entries = Array.from({ length: variant === 'many' ? 64 : 5 }, (_, i) => ({
    encryptedId: `e${i}`,
    title:
      i === 1
        ? '一首名字特别特别特别长的歌用来看看截断会不会把整行撑破 - 一位名字也很长的乐队主唱与他的朋友们'
        : ['慢车 - 林间录音', '凌晨便利店 - 霜降乐队', '潮汐表 - 北岸电台', '十二楼的风 - 苏河'][i % 4],
    say: i === 0 ? SAY_LONG : i % 3 === 2 ? undefined : '接下来,这一首。',
    note: i === 1 ? '点歌' : undefined,
  }))
  return {
    'music:radio#brief': on
      ? { active: true, intent: '下雨天,安静点的,最好是中文民谣,别太吵', programmeLength: entries.length, canResume: true, volume: 62 }
      : { active: false, intent: '下雨天,安静点的', programmeLength: 4, canResume: true },
    'music:radio#programme': { entries: on ? entries : [], onDeck: '雨棚下 - 旧电扇' },
    'music:player#nowPlaying':
      variant === 'idle'
        ? { playing: false, status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 }
        : {
            playing: true,
            status: 'playing',
            title: '雨棚下 - 旧电扇',
            position: 31,
            duration: 197,
            progress: '0:31 / 3:17',
            queueLength: 1,
            currentIndex: 0,
          },
    'music:player#lyrics': {
      title: '雨棚下 - 旧电扇',
      lines: [
        [0, '♪'],
        [22, '雨落在铁皮雨棚上 像有人在数零钱'],
        [31, '我们挤在同一块屋檐 谁也没带伞'],
        [41, '公交车晚了十分钟 真好'],
        [50, '晚到可以把这句话 说完'],
        [62, '♪'],
        [78, '你说梅雨季太长 衣服总是不干'],
        [88, '我说那就多留一天 等它晴'],
      ].map(([at, text]) => ({ at, text })),
    },
    'music:provider#state': { setupStage: 'ready', configured: true, loggedIn: true, playerBackend: 'mpv', source: 'daily' },
  }
}

function fakePort(variant: string): MusicPort {
  const data = table(variant)
  return {
    ready: async () => undefined,
    read: async (ref, name): Promise<ResourceReadView> => {
      const key = `${ref}#${name}`
      return key in data ? { kind: 'ok', value: data[key] } : { kind: 'denied', reason: `no ${key}` }
    },
    do: async (): Promise<ResourceOutcomeView> => ({ kind: 'ok', text: 'done' }),
    onResourceEvent: () => () => undefined,
  }
}

const VARIANTS = [
  { value: 'on', label: 'on air' },
  { value: 'many', label: '64 songs' },
  { value: 'off', label: 'off' },
  { value: 'idle', label: 'idle' },
] as const

export function MusicLab() {
  const [width, setWidth] = useState<string>('620')
  const [variant, setVariant] = useState<string>('on')
  const [ready, setReady] = useState(false)
  const locale = useStageStore((st) => st.locale)

  useEffect(() => {
    // 换一套样本 = 读数回出厂再装新端口,否则上一套的读数还留在格子里。
    resetMusicSource()
    configureMusicPort(fakePort(variant))
    setReady(true)
    return () => {
      setReady(false)
      configureMusicPort(undefined)
    }
  }, [variant])

  return (
    <div className={s.page} data-testid="music-lab">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Segmented label="width" options={[...WIDTHS]} value={width} onChange={setWidth} />
        <Segmented label="state" options={[...VARIANTS]} value={variant} onChange={setVariant} />
        <Segmented
          label="locale"
          options={[
            { value: 'zh', label: '中' },
            { value: 'en', label: 'EN' },
          ]}
          value={locale}
          onChange={(next) => useStageStore.setState({ locale: next })}
        />
      </div>
      <div
        data-testid="music-lab-frame"
        style={{ width: Number(width), height: 760, border: '1px solid var(--line-1)', borderRadius: 12, overflow: 'hidden' }}
      >
        {ready && <MusicPanel key={variant} />}
      </div>
    </div>
  )
}
