import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from '../components/icons'
import type { ProjectedMessage } from '../data/chat-fold'
import { useT, type MessageKey, type TFn } from '../i18n'
import { ButtonBase } from '../ui/ButtonBase'
import { Fold, FoldBody, FoldFoot, FoldTrigger } from '../ui/Fold'
import { clampMeasurer } from './blocks/shell/clamp-measurer'
import s from './ChatStream.module.css'

/**
 * **上下文更新 chip**(U3,设计正本 `docs/compact-seam-2026-09.md` §3.2)。
 *
 * ── 它说的是什么 ──────────────────────────────────────────────────────
 * 提示词的「回合通道」把会话级 / 回合级的事实写在**最新那条用户消息的
 * `<context-update>` 尾块**里(`docs/design/prompt-channels-2026-08.md`),
 * 并把这一轮真正变过的块记在消息的 `turnContext { set, removed }` 上。
 * 那是一份**已经发生的事实**:模型这一轮多看到 / 不再看到哪些块。
 * 从前壳上没有任何元素说这件事 —— 用户报的「context 更新我要在页面上看得到」
 * 的另一半(前一半是读数环)。
 *
 * 这枚 chip 就是那份事实的显形:**气泡下一行、右对齐随气泡**,折叠态一行读数,
 * 展开逐块列出。**没有 delta 的消息一个像素都不占**(返回 null,不是画一个空壳)。
 *
 * ── 为什么是读数而不是徽标 ─────────────────────────────────────────────
 * 「变量 1 · 待办 1」是**文字读数**。壳的计数禁令只禁 tab / 列表 / 组头挂徽,
 * 文字读数(「已选 2/5」)一直是许可的那一档;而这里恰恰不该是徽 —— 徽是
 * 「一件东西上的标记」,这一行本身就是那件东西。
 *
 * ── 块名从哪来 ────────────────────────────────────────────────────────
 * `set` 的键是**块 id**,产地只有三处,全部是回合通道的片段 id
 * (`packages/onething-runtime/src/prompts/builder.ts` 的六个 `channel: "turn"` 片段、
 * `variable-board.ts` 的 `variables`、`plugin-context.ts` 的 `plugin:<id>/<provider>`),
 * 外加一条历史读法:老会话的整块 `contextUpdate` 被读成 `variables`
 * (`LEGACY_TURN_CONTEXT_SECTION_ID`)。映射表就在下面那个纯函数里,**未知键原样
 * 显示键名**:块 id 是数据,壳不认识的那一个照说,不报错、不吞掉。
 *
 * ── 三张状态表(施工纪律「状态先行」)──────────────────────────────────
 * ① 生命周期:纯展示件,不取数、不订阅、无模块级副作用(那只 `clampMeasurer` 是
 *    全壳共用的单例,本文件只登记 / 注销)→ **不需要 HMR dispose**。它只有一种
 *    宿主:用户消息那一行的 flex 列;换会话 = 换一份 `message` prop。
 * ② UI 生命状态:无 empty(没有 delta 就不存在)、无 loading、无 error;
 *    **超量**两处 —— 头部读数一行只截断不换行(结构行);正文按
 *    `--block-clamp-h` 钳住 + 展开(与内容块同一把尺,复用 `clampMeasurer`)。
 * ③ UI 交互状态:折叠头 rest / hover(`--st-hover`)/ focus(全局环)/ 展开;
 *    圈选守卫与键盘 ↵ / Space 由 `ui/Fold` 提供,本件不写第二份。
 *    没有 disabled 档 —— 它是一份已经落账的事实,不存在「此刻不能看」。
 *
 * 流式中**不做动效**:唯一的过渡是 chevron 跟着用户自己那一下点击转,
 * 它是操作的回声,不是这一行在说话。
 */

/** 消息上那格 delta 的形状(从投影类型上取,不另立一份)。 */
export type TurnContextDelta = NonNullable<ProjectedMessage['turnContext']>

/** 展开后的一行:一个块,以及它这一轮是被(重)发了还是被退役了。 */
export interface ContextDeltaEntry {
  /** 块 id 原样(`variables` / `todo` / `plugin:<id>/<provider>` …)。 */
  id: string
  kind: 'set' | 'removed'
  /** `set` 的正文;`removed` 没有正文(墓碑只有名字)。 */
  text?: string
}

/**
 * **块 id → 人话名**。键是回合通道片段的 id,不是这里发明的名字 —— 改名要去
 * 产地改,这张表只翻译。`plugin:` 前缀整族归「插件」(一个会话里可能有好几个
 * 提供方,它们在读数里是同一族)。
 */
const BLOCK_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  voice: 'chat.contextDeltaBlockVoice',
  'active-project': 'chat.contextDeltaBlockActiveProject',
  'known-projects': 'chat.contextDeltaBlockKnownProjects',
  skills: 'chat.contextDeltaBlockSkills',
  todo: 'chat.contextDeltaBlockTodo',
  'agents-md': 'chat.contextDeltaBlockAgentsMd',
  variables: 'chat.contextDeltaBlockVariables',
}

/** 插件提供方的块 id 前缀(产地:`prompts/plugin-context.ts` 的 `pluginPromptBlockId`)。 */
const PLUGIN_BLOCK_PREFIX = 'plugin:'

/** 这个块 id 的名字键;`undefined` = 壳不认识它,该原样显示 id。 */
export function contextDeltaBlockNameKey(id: string): MessageKey | undefined {
  if (id.startsWith(PLUGIN_BLOCK_PREFIX)) return 'chat.contextDeltaBlockPlugins'
  return BLOCK_NAME_KEYS[id]
}

/** 这个块在屏幕上叫什么。不认识就是它自己的 id —— 数据照说。 */
export function contextDeltaBlockName(t: TFn, id: string): string {
  const key = contextDeltaBlockNameKey(id)
  return key ? t(key) : id
}

/**
 * delta 摊平成行。顺序照 `set` 的键序(那是引擎写下它们的顺序),`removed` 的
 * 墓碑排在最后 —— 「这一轮新说了什么」比「退役了什么」先读。
 */
export function contextDeltaEntries(delta: TurnContextDelta | undefined): ContextDeltaEntry[] {
  if (!delta) return []
  const rows: ContextDeltaEntry[] = []
  for (const [id, text] of Object.entries(delta.set ?? {})) rows.push({ id, kind: 'set', text })
  for (const id of delta.removed ?? []) rows.push({ id, kind: 'removed' })
  return rows
}

/**
 * 折叠头那一行字:「上下文更新 · 变量 1 · 待办 1 · 移除 1」。
 *
 * 按**名字**归并计数(所以三个插件块读作「插件 3」,而不是三段各说一遍);
 * `removed` 不分族,合成一格「移除 N」—— 墓碑说的是「少了什么」,数目就够了。
 */
export function contextDeltaSummary(t: TFn, rows: readonly ContextDeltaEntry[]): string {
  const counts = new Map<string, number>()
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'removed') {
      removed += 1
      continue
    }
    const name = contextDeltaBlockName(t, row.id)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const parts = [...counts].map(([name, n]) => t('chat.contextDeltaCount', { name, n }))
  if (removed > 0) parts.push(t('chat.contextDeltaRemoved', { n: removed }))
  return [t('chat.contextDeltaTitle'), ...parts].join(' · ')
}

export function ContextDeltaChip({ turnContext }: { turnContext?: TurnContextDelta }) {
  const t = useT()
  const rows = contextDeltaEntries(turnContext)
  // 没有 delta 就没有这件东西 —— 不占位、不画空壳。绝大多数用户消息走这一支。
  if (rows.length === 0) return null

  return (
    <Fold>
      <div className={s.ctxDelta}>
        <FoldTrigger className={s.ctxDeltaHead} data-testid="context-delta-chip">
          {/* 结构行:只截断不换行(挤压纪律)。省略号由 CSS 画,不截字符串。 */}
          <span className={s.ctxDeltaSummary}>{contextDeltaSummary(t, rows)}</span>
          <ChevronDown className={s.ctxDeltaChevron} strokeWidth={1.75} aria-hidden="true" />
        </FoldTrigger>
        <FoldBody className={s.ctxDeltaBody} data-testid="context-delta-body">
          {rows.map((row) => (
            <DeltaRow key={`${row.kind}:${row.id}`} t={t} row={row} />
          ))}
        </FoldBody>
        {/* 底把手:块正文一长,收起的把手就跑到视野外了。只在展开态出场,
            与头同一副皮肤(右对齐随气泡),行为归 ui/Fold。 */}
        <FoldFoot className={`${s.ctxDeltaHead} ${s.ctxDeltaFoot}`} data-testid="context-delta-foot">
          <ChevronDown className={s.ctxDeltaFootChevron} strokeWidth={1.75} aria-hidden="true" />
          {t('chat.contextDeltaCollapse')}
        </FoldFoot>
      </div>
    </Fold>
  )
}

/**
 * 一块一行:左列块名,右列正文。
 *
 * 钳法**复用内容块那一把尺**(`blocks/shell/clamp-measurer` 的单例观察者):
 * 全壳只有一只 `ResizeObserver`、读写分两轮的理由在这里同样成立,而且真要另起
 * 一只,「这台上到底有几只 RO」就又没有答案了。`max-height` 无条件写在样式里,
 * `overflows` 只决定遮罩与展开钮 —— 所以永远不会「先铺满再被钳住」那一闪。
 */
function DeltaRow({ t, row }: { t: TFn; row: ContextDeltaEntry }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const removed = row.kind === 'removed'

  useLayoutEffect(() => {
    const el = outer.current
    const box = inner.current
    // 墓碑行只有两个字,量它是白量。
    if (!el || !box || expanded || removed) return
    // 没有 ResizeObserver(jsdom)= 量一次就走;那里两个值都是 0,本来就永不折叠。
    if (typeof ResizeObserver === 'undefined') {
      setOverflows(el.scrollHeight > el.clientHeight + 1)
      return
    }
    clampMeasurer.observe(box, el, setOverflows)
    return () => clampMeasurer.unobserve(box)
  }, [expanded, removed])

  const textClass = expanded
    ? `${s.ctxDeltaText} ${s.ctxDeltaTextOpen}`
    : overflows
      ? `${s.ctxDeltaText} ${s.ctxDeltaTextClamped}`
      : s.ctxDeltaText

  return (
    <div
      className={s.ctxDeltaEntry}
      /* 墓碑行整行划线(名字也划)—— 它说的是「这一块不在了」,不是「它的值变了」。 */
      data-removed={removed ? '' : undefined}
      data-block-id={row.id}
    >
      <span className={s.ctxDeltaName}>{contextDeltaBlockName(t, row.id)}</span>
      <div className={s.ctxDeltaValue}>
        <div ref={outer} className={textClass}>
          <div ref={inner}>{removed ? t('chat.contextDeltaGone') : row.text}</div>
        </div>
        {overflows && (
          /* ③ 类:行内微型文字动作,皮肤本地、清 UA 归基座(与内容块的展开钮同判)。
             词表与内容块共用 `block.expand` / `block.collapse` —— 同一件事不许有两套说法。 */
          <ButtonBase className={s.ctxDeltaExpand} onClick={() => setExpanded((open) => !open)}>
            {t(expanded ? 'block.collapse' : 'block.expand')}
          </ButtonBase>
        )}
      </div>
    </div>
  )
}
