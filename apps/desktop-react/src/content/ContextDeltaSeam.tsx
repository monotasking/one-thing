import { useLayoutEffect, useRef, useState } from 'react'
import type { ProjectedMessage } from '../data/chat-fold'
import { useT, type MessageKey, type TFn } from '../i18n'
import { ButtonBase } from '../ui/ButtonBase'
import { Fold } from '../ui/Fold'
import { clampMeasurer } from './blocks/shell/clamp-measurer'
import { useNoteUserExpand } from './expand-intent'
import { Seam, SeamBody, SeamFoot, SeamLabel, SeamLine } from './seam/Seam'
import c from './ContextDeltaSeam.module.css'

/**
 * **上下文更新折痕**(U5,设计正本 `docs/compact-seam-2026-09.md` §3.2;
 * 09-09 用户裁定推翻了 U3 那版「气泡下的一枚 chip」)。
 *
 * ── 它说的是什么 ──────────────────────────────────────────────────────
 * 提示词的「回合通道」把会话级 / 回合级的事实写在**最新那条用户消息的
 * `<context-update>` 尾块**里(`docs/design/prompt-channels-2026-08.md`),
 * 并把这一轮真正变过的块记在消息的 `turnContext { set, removed }` 上。
 * 那是一份**已经发生的事实**:模型这一轮多看到 / 不再看到哪些块。
 *
 * ── 为什么是折痕,不是气泡下的 chip(09-09 裁定)───────────────────────
 * `turnContext` 是**宿主在这一回合开始时补给模型的上下文** —— 它是**回合**的事,
 * 不是用户说的话。数据照旧存在用户消息上(它是发给模型的那条消息的一部分,
 * 账本一个字不动),但**呈现**不该挂在用户的气泡下面:挂在那里读起来像是
 * 「用户还说了这些」。所以它与压缩折痕同属「系统在两回合之间做的事」这一族,
 * 画成同一种形 —— 一道细线 + 一枚居中的标签(基座 `content/seam/`),
 * 落在**用户那一行与下一行之间**的独立一行里(摆放在 `ChatStream.tsx`)。
 *
 * ── 出场那一下(09-09 报障一:「突然冒出来,用户自己那行事后变高」)────────
 * 这一行**必然是事后出现的**:发送那一刻它还不存在,`turnContext` 要等引擎走到
 * `buildPrompt` 之后才落账,回合一开始它就凭空多出一行。
 * **根治不在壳** —— 它在引擎写 `turnContext` 的时机(`buildPrompt` 之后);
 * 壳这一侧唯一能做的是让它**软着陆**,并按节奏表的物件档留白
 * (`data-prose="object"` 由折痕基座自带)。
 *
 * **软着陆不在这个文件里**(2026-09-12 报障一复审):从前这里是折痕自己淡入一下,
 * 而高度与行距瞬间到位 —— 淡入盖不住 32px + 一行的位移。今天是「事后出现的那一行」
 * 整行三量一起过渡,落点 `ChatStream.module.css` 的 `.rowLate`(行距 `--sp-6` 是
 * `.column` 的 gap,负 margin 要与它同产地),判词整段在那里。
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
 *    宿主:消息流里它自己那一行(`article[data-context-of]`);换会话 = 换一份
 *    `turnContext` prop。
 * ② UI 生命状态:无 empty(没有 delta 就不存在这一行)、无 loading、无 error;
 *    **超量**两处 —— 标签一行只截断不换行(结构行,归基座);正文按
 *    `--block-clamp-h` 钳住 + 展开(与内容块同一把尺,复用 `clampMeasurer`)。
 * ③ UI 交互状态:折叠头 rest / hover(`--st-hover`)/ focus(全局环)/ 展开;
 *    圈选守卫与键盘 ↵ / Space 由 `ui/Fold` 提供,本件不写第二份。
 *    没有 disabled 档 —— 它是一份已经落账的事实,不存在「此刻不能看」。
 *
 * 流式中**不做动效**:出场那一下的淡入之外,唯一的过渡是 chevron 跟着用户自己
 * 那一下点击转,它是操作的回声,不是这一行在说话。
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
 * 「这条消息后面要不要出那一行」—— `contextDeltaEntries(…).length > 0` 的**不分配**写法。
 *
 * 判据必须与 `contextDeltaEntries` 逐字一致(两处分叉 = 出一行空折痕,或者该出的
 * 不出),所以它俩挨着放、由同一组用例一起钉。**为什么不直接调那只函数**:这一句
 * 由 `ChatStream` 在 `messages.map` 里问,而那张 map 在流式期间**每帧**跑一遍整篇
 * 抄本(MessageRow 靠 memo 短路,这一句短路不了)—— 每帧给每条用户消息造一个
 * 数组是 09-01 那次 3–4fps 的同款账。
 */
export function hasContextDelta(delta: TurnContextDelta | undefined): boolean {
  if (!delta) return false
  if (delta.removed !== undefined && delta.removed.length > 0) return true
  for (const _ in delta.set ?? {}) return true
  return false
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

/**
 * ── `sweeping` 那格 prop **G 线 P1 删了**(2026-09-20)──────────────────────
 *
 * 09-15 单 A ③ 给它加过一格 `sweeping`:这一轮还在等第一个字时,这道折痕翻成
 * `running` 替 `WaitingSeam` 把光扫出来,理由是「等待与上下文更新说的是同一件事,
 * 合成一行」。**那句话今天不成立了**:用户 09-20 报的第一件就是「发送之后屏上有
 * 两处在等的动画」,而正本 `docs/stream-geometry-2026-09.md` §2 拍点 2 的裁定是
 * 「等待指示只留一处:**尾部**」—— 尾槽那一格。
 *
 * 所以这道折痕恒 `settled`:上下文更新本身是**已经发生完**的事(回合开张时一次性
 * 落的账,壳看见它的时候早已经完成了),它从来就不该说「正在做」。
 *
 * (`WaitingSeam` 本身 2026-09-21 随 P1b 裁定 B 一起删了 —— 等待不再是屏幕上的
 * 一种形态,尾槽从开张到收场只有一张脸。这里留着它的名字是为了说清这段病史。)
 */
export function ContextDeltaSeam({ turnContext }: {
  turnContext?: TurnContextDelta
}) {
  const t = useT()
  const note = useNoteUserExpand()
  const rows = contextDeltaEntries(turnContext)
  // 没有 delta 就没有这件东西 —— 不占位、不画空壳。摆它的那一层同样问一遍
  // (`hasContextDelta`),那一句省的是外面那个 `<article>`;这一句是本件自己的底。
  if (rows.length === 0) return null

  return (
    /* 用户点开的,报给流:别贴底(`content/expand-intent.ts`)。收起不报 —— 变矮
       不会把人推走。 */
    <Fold
      onOpenChange={(open) => {
        if (open) note()
      }}
    >
      {/*
        * 恒 `settled`:上下文更新本身是**已经发生完**的事(判词在上面那段
        * 「`sweeping` 那格 prop G 线 P1 删了」里)。
        */}
      <Seam data-state="settled" data-testid="context-delta-seam">
        <SeamLine />
        <SeamLabel fold data-testid="context-delta-label">
          {contextDeltaSummary(t, rows)}
        </SeamLabel>
        <SeamLine />
        <SeamBody className={c.body} data-testid="context-delta-body">
          {rows.map((row) => (
            <DeltaRow key={`${row.kind}:${row.id}`} t={t} row={row} />
          ))}
        </SeamBody>
        <SeamFoot data-testid="context-delta-foot">{t('chat.contextDeltaCollapse')}</SeamFoot>
      </Seam>
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
  const note = useNoteUserExpand()
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
    ? `${c.text} ${c.textOpen}`
    : overflows
      ? `${c.text} ${c.textClamped}`
      : c.text

  return (
    <div
      className={c.entry}
      /* 墓碑行整行划线(名字也划)—— 它说的是「这一块不在了」,不是「它的值变了」。 */
      data-removed={removed ? '' : undefined}
      data-block-id={row.id}
    >
      <span className={c.name}>{contextDeltaBlockName(t, row.id)}</span>
      <div className={c.value}>
        <div ref={outer} className={textClass}>
          <div ref={inner}>{removed ? t('chat.contextDeltaGone') : row.text}</div>
        </div>
        {overflows && (
          /* ③ 类:行内微型文字动作,皮肤本地、清 UA 归基座(与内容块的展开钮同判)。
             词表与内容块共用 `block.expand` / `block.collapse` —— 同一件事不许有两套说法。 */
          <ButtonBase
            className={c.expand}
            onClick={() => {
              // 用户点开的,报给流:别贴底(收起不报)。判据用当前 state,不放进
              // setState 的 updater —— updater 在 StrictMode 下会跑两遍。
              if (!expanded) note()
              setExpanded((open) => !open)
            }}
          >
            {t(expanded ? 'block.collapse' : 'block.expand')}
          </ButtonBase>
        )}
      </div>
    </div>
  )
}
